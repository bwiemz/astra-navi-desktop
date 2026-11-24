import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import type { Brain } from "../core/brain.ts";
import type { ConfigStore } from "../core/config.ts";
import { LANGUAGES, type LanguageCode } from "../core/languages.ts";
import { modelsDir, resolveBundledRoot, voiceEnvPython } from "../core/paths.ts";
import type { VoiceBackend } from "../core/voice/backend.ts";
import { Qwen3StreamingTtsBackend } from "../core/voice/experimentalMultilingualVoice.ts";
import { FullVoice } from "../core/voice/fullVoice.ts";
import { Listener } from "../core/voice/listener.ts";
import { OnnxVoice } from "../core/voice/onnxVoice.ts";
import { Speaker } from "../core/voice/speaker.ts";
import { afterWakeName } from "../core/wakeName.ts";
import type { BrainEvent, VoiceEvent } from "../shared/ipc.ts";

/**
 * Everything about speaking and listening in the main process: the voice backends,
 * wake-word windowing, interruption (barge-in), and audio frames from the renderer.
 */

const CONVERSATION_WINDOW_MS = 25_000;
/**
 * With her name required, how long a conversation may run on follow-ups alone. Without a
 * limit, a television talking after one exchange would keep being answered for ever.
 */
const NAMELESS_FOLLOW_UPS_MS = 90_000;

/** What she says when only her name is called. */
const WAKE_REPLIES: Record<LanguageCode, string> = {
  en: "Yes, Captain?",
  ja: "はい、艦長？",
  zh: "在呢，舰长？",
};

const VOICE_SAMPLES: Record<LanguageCode, string> = {
  en: "Captain! This is how Astra sounds now. What do you think?",
  ja: "艦長！アストラの声はこんな感じだよ。どうかな？",
  zh: "舰长！阿斯特拉现在的声音是这样的。你觉得怎么样？",
};

export function toSamples(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value;
  // Depending on how the message was carried, a typed array can arrive as raw bytes.
  // Copied rather than viewed in place, because the bytes may not start on a 4-byte boundary.
  if (value instanceof Uint8Array && value.byteLength % 4 === 0) {
    return new Float32Array(value.slice().buffer);
  }
  return null;
}

export interface VoiceControllerDeps {
  config: ConfigStore;
  mainWindow(): BrowserWindow | null;
  brain(): Brain | null;
  sendToWindow(channel: string, payload?: unknown): void;
  interruptBrain(): void;
  rebuildTrayMenu(): void;
  /** Records per-sentence TTS synthesis time for the active reply's turn trace. */
  onTtsMs?(ms: number): void;
}

export interface VoiceController {
  setListening(on: boolean): void;
  stopSpeaking(): void;
  sendVoice(event: VoiceEvent): void;
  createVoice(): Promise<void>;
  chooseVoice(engine: "full" | "light", design: string): void;
  feedAudio(payload: unknown): void;
  setSpeakerPlaying(speaking: boolean): void;
  onBrainEvent(event: BrainEvent): void;
  nameRequired(): boolean;
  listening(): boolean;
  audioBlocks(): number;
  speaker(): Speaker | null;
  voiceBackend(): VoiceBackend | null;
  designedVoices(): string[];
  fullVoiceReady(): boolean;
  beginShutdown(): void;
  releaseIdleMemory(): Promise<void>;
  yieldForGame(game: string): Promise<void>;
  resumeAfterGame(): Promise<void>;
  dispose(): Promise<void>;
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  let speaker: Speaker | null = null;
  let listener: Listener | null = null;
  let voiceBackend: VoiceBackend | null = null;
  let designedVoices: string[] = [];
  let fullVoiceReady = false;
  let rebuildingVoice = false;
  let listening = false;
  let speakThisReply = false;
  let trackTts = false;
  let speakerPlaying = false;
  let conversationOpenUntil = 0;
  let lastNamedAt = 0;
  let replyWasInitiated = false;
  let debugAudioBlocks = 0;
  /** Rebuilds of the voice wait their turn here, so two never overlap and leave a server behind. */
  let voiceRebuild: Promise<void> = Promise.resolve();

  function sendVoice(event: VoiceEvent): void {
    if (process.env["AI_CHAN_DEBUG"] && event.type !== "audio") {
      console.log("[voice]", JSON.stringify(event));
    }
    deps.sendToWindow("voice:event", event);
  }

  /** Whether speech has to start with her name to count as meant for her. */
  function nameRequired(): boolean {
    return deps.config.value.voice.needsName || deps.config.value.voice.alwaysListening;
  }

  /** True while speech that does not start with her name still counts as said to her. */
  function conversationOpen(): boolean {
    const now = Date.now();
    if (now > conversationOpenUntil) return false;
    return !nameRequired() || now - lastNamedAt < NAMELESS_FOLLOW_UPS_MS;
  }

  function stopSpeaking(): void {
    // Also for the rest of this reply: text still arriving after a stop must stay unspoken.
    speakThisReply = false;
    trackTts = false;
    speaker?.stop();
    sendVoice({ type: "stop" });
  }

  function setListening(on: boolean): void {
    if (!listener || !speaker || on === listening) return;
    if (rebuildingVoice && on) {
      // Asked for while the voice is being swapped: do it once the swap is done.
      void voiceRebuild.then(() => setListening(true));
      return;
    }
    listening = on;
    if (!on) {
      listener.reset();
      stopSpeaking();
      sendVoice({ type: "state", state: "off" });
      if (deps.config.value.voice.speak === "never") {
        void OnnxVoice.disposeSharedEngines().catch(() => undefined);
      }
      return;
    }
    sendVoice({ type: "state", state: "starting" });
    // The speech models download on first use, then load in a second or two.
    const canSpeak = speaker.canSpeak;
    Promise.all([listener.warm(), speaker.warm()])
      .then(() => {
        if (!listening) return;
        sendVoice({ type: "state", state: "listening" });
        if (!canSpeak) {
          sendVoice({
            type: "error",
            message: `She can hear you, but the light voice only speaks English, so her ${LANGUAGES[deps.config.value.language].label} replies will be text only. The designed voices speak every language: run "npm run setup-voice" once, then pick one under "Her voice" in the tray menu.`,
          });
        }
      })
      .catch((error: unknown) => {
        listening = false;
        sendVoice({ type: "state", state: "off" });
        sendVoice({
          type: "error",
          message: `Voice could not start: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }

  async function buildVoice(): Promise<void> {
    const { voice, language } = deps.config.value;
    const bundledRoot = resolveBundledRoot(app.getAppPath());
    const cacheDir = join(modelsDir(), "speech");
    const voiceDir = join(bundledRoot, "assets", "voice");
    try {
      designedVoices = (await readdir(voiceDir))
        .filter((name) => name.endsWith(".wav"))
        .map((name) => name.slice(0, -".wav".length))
        .sort();
    } catch {
      designedVoices = [];
    }
    const design = designedVoices.includes(voice.design) ? voice.design : designedVoices[0];
    const full = design
      ? {
          python: voiceEnvPython(),
          serverScript: join(bundledRoot, "voice-server", "server.py"),
          referenceAudio: join(voiceDir, `${design}.wav`),
          referenceText: join(voiceDir, `${design}.txt`),
          modelCache: join(modelsDir(), "voice-hf"),
          idleStopMs: deps.config.value.idleUnloadMinutes * 60_000,
        }
      : null;
    fullVoiceReady = full !== null && (await FullVoice.isSetUp(full));
    const useLegacyPython =
      full !== null &&
      fullVoiceReady &&
      voice.engine === "full" &&
      process.env["ASTRA_NAVI_LEGACY_PYTHON_VOICE"] === "1";
    const qwenTtsUrl = process.env["ASTRA_NAVI_QWEN3_TTS_URL"]?.trim();
    voiceBackend = useLegacyPython
      ? new FullVoice(full)
      : qwenTtsUrl && voice.engine === "full"
        ? new Qwen3StreamingTtsBackend({
            endpointUrl: qwenTtsUrl,
            speaker: voice.design || voice.name,
            yieldFallbackBackend: new OnnxVoice({
              cacheDir,
              voice: voice.design || voice.name,
              speed: voice.speed,
            }),
          })
        : new OnnxVoice({ cacheDir, voice: voice.design || voice.name, speed: voice.speed });

    speaker = new Speaker({
      backend: voiceBackend,
      language,
      onAudio: (samples, sampleRate) => sendVoice({ type: "audio", samples, sampleRate }),
      onSynthesized: (ms) => {
        if (trackTts) deps.onTtsMs?.(ms);
      },
      onError: (message) => sendVoice({ type: "error", message: `She could not speak: ${message}` }),
    });
    listener = new Listener({
      cacheDir,
      language: LANGUAGES[language].recognise,
      onState: (state) => {
        if (listening) sendVoice({ type: "state", state });
      },
      onSpeechStart: () => {
        // Talking over her while she is speaking interrupts her, the way it would with a
        // person. While she is silently working, speech is just the next thing to answer:
        // a noise in the room must not cancel a running task or an approval question.
        if (!speakerPlaying) return;
        // Waiting for her name: a voice from the television must not be able to cut her off.
        if (nameRequired() && !conversationOpen()) return;
        deps.interruptBrain();
        stopSpeaking();
      },
      onUtterance: (text, sttMs) => {
        if (!listening) return;
        if (process.env["AI_CHAN_DEBUG"]) console.log(`[debug] heard: ${JSON.stringify(text)}`);
        let said = text;
        if (nameRequired()) {
          const rest = afterWakeName(text, deps.config.value.voice.otherNames);
          // Not addressed to her, and not a follow-up to what she just said: not for her.
          if (rest === null && !conversationOpen()) return;
          if (rest !== null) {
            // Her name was said: come forward, wherever she was.
            const window = deps.mainWindow();
            if (window && !window.isVisible()) window.showInactive();
            lastNamedAt = Date.now();
            conversationOpenUntil = Date.now() + CONVERSATION_WINDOW_MS;
            if (rest.length === 0) {
              // Just her name. Answer at once, without waiting on a whole reply, and listen.
              sendVoice({ type: "heard", text, noReply: true });
              if (speaker?.canSpeak) speaker.say(WAKE_REPLIES[deps.config.value.language]);
              return;
            }
            said = rest;
          }
        }
        conversationOpenUntil = Date.now() + CONVERSATION_WINDOW_MS;
        sendVoice({ type: "heard", text: said });
        deps.brain()?.send(said, { spoken: true, ...(sttMs === undefined ? {} : { sttMs }) });
      },
      onError: (message) => sendVoice({ type: "error", message: `Listening failed: ${message}` }),
    });
  }

  async function rebuildVoice(): Promise<void> {
    const wasListening = listening;
    const prevWasOnnx = voiceBackend instanceof OnnxVoice;
    if (wasListening) setListening(false);
    stopSpeaking();
    rebuildingVoice = true;
    try {
      await voiceBackend?.dispose();
      await buildVoice();
      if ((prevWasOnnx && !(voiceBackend instanceof OnnxVoice)) || deps.config.value.voice.speak === "never") {
        await OnnxVoice.disposeSharedEngines();
      }
    } finally {
      rebuildingVoice = false;
    }
    if (wasListening) setListening(true);
  }

  /** Builds the voice and the listener for the current settings, replacing any earlier ones. */
  function createVoice(): Promise<void> {
    voiceRebuild = voiceRebuild.catch(() => undefined).then(rebuildVoice);
    return voiceRebuild;
  }

  function chooseVoice(engine: "full" | "light", design: string): void {
    void (async () => {
      await deps.config.update({ voice: { ...deps.config.value.voice, engine, design } });
      await createVoice();
      deps.rebuildTrayMenu();
      // Let the new voice introduce itself, so it can be judged by ear straight away.
      if (speaker?.canSpeak) speaker.say(VOICE_SAMPLES[deps.config.value.language]);
    })().catch((error: unknown) => console.error(error));
  }

  function feedAudio(payload: unknown): void {
    const samples = toSamples(payload);
    // A second of audio at most per message; anything larger is not from our capture code.
    if (!listening || !samples || samples.length > 16_000) return;
    debugAudioBlocks += 1;
    listener?.feed(samples);
  }

  function setSpeakerPlaying(speaking: boolean): void {
    speakerPlaying = speaking;
    listener?.setGuarded(speaking);
    // The follow-up window starts when she stops talking, not when she started.
    if (!speaking && !replyWasInitiated) {
      conversationOpenUntil = Date.now() + CONVERSATION_WINDOW_MS;
    }
  }

  function onBrainEvent(event: BrainEvent): void {
    switch (event.type) {
      case "status":
        if (event.state === "thinking") {
          stopSpeaking(); // a new reply replaces whatever she was still saying
          const policy = deps.config.value.voice.speak;
          // When she speaks first, she says it aloud if a voice conversation is going on.
          speakThisReply =
            policy === "always" ||
            (policy === "when-spoken-to" && (event.spoken || (event.initiated && listening)));
          trackTts = speakThisReply;
          // Something to tell: make sure she can be seen, without taking the keyboard away.
          const window = deps.mainWindow();
          if (event.initiated && window && !window.isVisible()) window.showInactive();
          replyWasInitiated = event.initiated;
        } else {
          if (speakThisReply) speaker?.end();
          // After she spoke first, speech in the room is not a reply to her until her name is said.
          if (!replyWasInitiated) conversationOpenUntil = Date.now() + CONVERSATION_WINDOW_MS;
        }
        break;
      case "text":
        if (speakThisReply) speaker?.push(event.delta);
        break;
      case "activity":
        // A tool is about to run: say what she has written so far instead of waiting for the end.
        if (speakThisReply) speaker?.end();
        break;
      default:
        break;
    }
  }

  function beginShutdown(): void {
    stopSpeaking();
    listening = false;
  }

  async function releaseIdleMemory(): Promise<void> {
    if (speaker && !speaker.quiet) return;
    await speaker?.restIfQuiet().catch(() => undefined);
    if (voiceBackend instanceof OnnxVoice) {
      await OnnxVoice.disposeSharedEngines();
    } else if (voiceBackend instanceof Qwen3StreamingTtsBackend) {
      await voiceBackend.yieldGpu();
    }
  }

  async function yieldForGame(): Promise<void> {
    stopSpeaking();
    if (voiceBackend instanceof Qwen3StreamingTtsBackend) {
      await voiceBackend.yieldGpu();
    } else if (voiceBackend instanceof FullVoice) {
      await voiceBackend.rest().catch(() => undefined);
    }
  }

  async function resumeAfterGame(): Promise<void> {
    if (voiceBackend instanceof Qwen3StreamingTtsBackend) {
      voiceBackend.resumeGpu();
    }
  }

  async function dispose(): Promise<void> {
    await voiceRebuild.catch(() => undefined);
    await voiceBackend?.dispose();
    await OnnxVoice.disposeSharedEngines();
  }

  return {
    setListening,
    stopSpeaking,
    sendVoice,
    createVoice,
    chooseVoice,
    feedAudio,
    setSpeakerPlaying,
    onBrainEvent,
    nameRequired,
    listening: () => listening,
    audioBlocks: () => debugAudioBlocks,
    speaker: () => speaker,
    voiceBackend: () => voiceBackend,
    designedVoices: () => designedVoices,
    fullVoiceReady: () => fullVoiceReady,
    beginShutdown,
    releaseIdleMemory,
    yieldForGame,
    resumeAfterGame,
    dispose,
  };
}
