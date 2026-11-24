import type { Mood } from "../shared/ipc.ts";
import { computeRms } from "./voice/aec.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Native End-to-End Speech-to-Speech & Streaming Video-Buffer Awareness
 * (ai_chan_plan.pdf p. 16).
 */

export interface PostureHint {
  /** Forward lean in [-1, 1]; positive leans forward attentively/urgently, negative leans back/relaxed. */
  leanForward: number;
  /** Head tilt in degrees in [-12, 12]; positive tilts curiously/hesitantly. */
  headTiltDeg: number;
  /** Breathing/motion energy multiplier in [0.6, 1.6]. */
  energyScale: number;
}

export interface ParalinguisticCue {
  mood: Mood;
  urgency: "low" | "normal" | "high";
  rmsEnergy: number;
  speakingRate: number;
  hesitationRatio: number;
  pitchTrend: "rising" | "falling" | "steady";
  posture: PostureHint;
}

export interface SpeechToSpeechOutput {
  transcript: string;
  replyText: string;
  audioOut?: Float32Array;
  sampleRate?: number;
}

export interface SpeechToSpeechTransport {
  readonly name: string;
  /** Must remain unset (in-process) or a private LAN/loopback host. */
  readonly endpointHost?: string;
  processTurn(pcm16k: Float32Array, cue: ParalinguisticCue): Promise<SpeechToSpeechOutput>;
}

export interface SpeechToSpeechTurnResult extends SpeechToSpeechOutput {
  cue: ParalinguisticCue;
  latencyMs: number;
}

function zeroCrossingsRate(samples: Float32Array): number {
  if (samples.length <= 1) return 0;
  let zeroCrossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1] ?? 0;
    const curr = samples[i] ?? 0;
    if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) {
      zeroCrossings += 1;
    }
  }
  return Math.min(1, zeroCrossings / samples.length);
}

/** Extracts acoustic energy, hesitation pauses, pitch trend, and posture cues from 16 kHz PCM speech. */
export function inferParalinguisticCue(pcm16k: Float32Array): ParalinguisticCue {
  const rmsEnergy = computeRms(pcm16k);
  if (pcm16k.length === 0) {
    return {
      mood: "neutral",
      urgency: "low",
      rmsEnergy: 0,
      speakingRate: 0,
      hesitationRatio: 0,
      pitchTrend: "steady",
      posture: { leanForward: 0, headTiltDeg: 0, energyScale: 1 },
    };
  }
  const speakingRate = zeroCrossingsRate(pcm16k);
  const frameLen = 512; // 32 ms at 16 kHz
  const voicedFlags: boolean[] = [];
  const voicedZcrs: number[] = [];
  for (let offset = 0; offset + frameLen <= pcm16k.length; offset += frameLen) {
    const frame = pcm16k.subarray(offset, offset + frameLen);
    const voiced = computeRms(frame) >= 0.015;
    voicedFlags.push(voiced);
    if (voiced) voicedZcrs.push(zeroCrossingsRate(frame));
  }
  const firstVoiced = voicedFlags.indexOf(true);
  const lastVoiced = voicedFlags.lastIndexOf(true);
  let hesitationRatio = 0;
  if (firstVoiced !== -1 && lastVoiced > firstVoiced) {
    let pauses = 0;
    for (let i = firstVoiced; i <= lastVoiced; i += 1) {
      if (!voicedFlags[i]) pauses += 1;
    }
    hesitationRatio = Number((pauses / (lastVoiced - firstVoiced + 1)).toFixed(3));
  }

  let pitchTrend: ParalinguisticCue["pitchTrend"] = "steady";
  if (voicedZcrs.length >= 3) {
    const sliceLen = Math.max(1, Math.floor(voicedZcrs.length / 3));
    const firstAvg =
      voicedZcrs.slice(0, sliceLen).reduce((sum, v) => sum + v, 0) / sliceLen;
    const lastAvg =
      voicedZcrs.slice(-sliceLen).reduce((sum, v) => sum + v, 0) / sliceLen;
    const delta = lastAvg - firstAvg;
    if (delta > 0.03) pitchTrend = "rising";
    else if (delta < -0.03) pitchTrend = "falling";
  }

  if (rmsEnergy >= 0.15) {
    const mood: Mood = speakingRate >= 0.2 ? "excited" : "worried";
    return {
      mood,
      urgency: "high",
      rmsEnergy,
      speakingRate,
      hesitationRatio,
      pitchTrend,
      posture: {
        leanForward: 0.65,
        headTiltDeg: mood === "worried" ? 5 : 0,
        energyScale: 1.35,
      },
    };
  }
  if (hesitationRatio >= 0.35 && rmsEnergy >= 0.02) {
    return {
      mood: pitchTrend === "rising" ? "worried" : "thinking",
      urgency: pitchTrend === "rising" ? "normal" : "low",
      rmsEnergy,
      speakingRate,
      hesitationRatio,
      pitchTrend,
      posture: { leanForward: 0.25, headTiltDeg: 8, energyScale: 0.95 },
    };
  }
  if (rmsEnergy >= 0.04) {
    return {
      mood: pitchTrend === "rising" ? "thinking" : "neutral",
      urgency: "normal",
      rmsEnergy,
      speakingRate,
      hesitationRatio,
      pitchTrend,
      posture: {
        leanForward: 0.2,
        headTiltDeg: pitchTrend === "rising" ? 4 : 0,
        energyScale: 1,
      },
    };
  }
  return {
    mood: "neutral",
    urgency: "low",
    rmsEnergy,
    speakingRate,
    hesitationRatio,
    pitchTrend,
    posture: { leanForward: -0.15, headTiltDeg: 0, energyScale: 0.8 },
  };
}

export class LocalSpeechToSpeechSession {
  enabled: boolean;
  private readonly transport: SpeechToSpeechTransport;
  private readonly onMood?: (mood: Mood) => void;
  private readonly onCue?: (cue: ParalinguisticCue) => void;

  constructor(options: {
    enabled?: boolean;
    transport: SpeechToSpeechTransport;
    onMood?: (mood: Mood) => void;
    onCue?: (cue: ParalinguisticCue) => void;
  }) {
    this.enabled = options.enabled ?? false;
    if (options.transport.endpointHost && !isPrivateLanHost(options.transport.endpointHost)) {
      throw new Error(
        `Refused non-local speech-to-speech transport endpoint "${options.transport.endpointHost}".`,
      );
    }
    this.transport = options.transport;
    this.onMood = options.onMood;
    this.onCue = options.onCue;
  }

  async handleTurn(pcm16k: Float32Array): Promise<SpeechToSpeechTurnResult> {
    if (!this.enabled) {
      throw new Error("Native speech-to-speech is disabled in Experimental options.");
    }
    const started = performance.now();
    const cue = inferParalinguisticCue(pcm16k);
    this.onMood?.(cue.mood);
    this.onCue?.(cue);
    const out = await this.transport.processTurn(pcm16k, cue);
    return {
      ...out,
      cue,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}

export interface VideoFrameInput {
  atMs: number;
  width: number;
  height: number;
  luma: Uint8Array;
  app: string;
  title: string;
  isPrivate?: boolean;
}

export interface VideoPushResult {
  buffered: boolean;
  droppedPrivate: boolean;
  changed: boolean;
  changeScore: number;
}

/** Normalized Mean Absolute Difference in [0, 1] between two grayscale frames. */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / (a.length * 255);
}

/**
 * In-memory bounded rolling frame ring buffer with scene-change detection.
 * Private/incognito/password-manager frames are dropped unconditionally and never buffered.
 */
export class VideoBufferWatch {
  private readonly maxFrames: number;
  private readonly changeThreshold: number;
  private readonly onSignificantChange?: (event: {
    frame: VideoFrameInput;
    changeScore: number;
  }) => void;
  private readonly buffer: VideoFrameInput[] = [];

  constructor(
    options: {
      maxFrames?: number;
      changeThreshold?: number;
      onSignificantChange?: (event: { frame: VideoFrameInput; changeScore: number }) => void;
    } = {},
  ) {
    this.maxFrames = Math.max(1, options.maxFrames ?? 12);
    this.changeThreshold = Math.max(0, Math.min(1, options.changeThreshold ?? 0.08));
    this.onSignificantChange = options.onSignificantChange;
  }

  get size(): number {
    return this.buffer.length;
  }

  pushFrame(frame: VideoFrameInput): VideoPushResult {
    if (frame.isPrivate) {
      return { buffered: false, droppedPrivate: true, changed: false, changeScore: 0 };
    }
    const prev = this.buffer.at(-1);
    const changeScore = prev ? frameDifference(prev.luma, frame.luma) : 1;
    const changed = changeScore >= this.changeThreshold;

    const stored: VideoFrameInput = {
      ...frame,
      luma: new Uint8Array(frame.luma),
    };
    this.buffer.push(stored);
    if (this.buffer.length > this.maxFrames) {
      this.buffer.shift();
    }
    if (changed && prev) {
      this.onSignificantChange?.({ frame: stored, changeScore });
    }
    return { buffered: true, droppedPrivate: false, changed, changeScore };
  }

  recent(count = this.maxFrames): VideoFrameInput[] {
    return this.buffer.slice(-Math.max(0, count));
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

// --- Full-Duplex Native Speech-to-Speech Streaming Pipeline ---------------

export interface S2sStreamChunk {
  textDelta?: string;
  audioOut?: Float32Array;
  sampleRate?: number;
  done?: boolean;
}

export interface StreamingS2sTransport {
  readonly name: string;
  /** Must remain unset (in-process) or a private LAN/loopback host. */
  readonly endpointHost?: string;
  streamTurn(
    pcm16k: Float32Array,
    cue: ParalinguisticCue,
    signal: AbortSignal,
  ): AsyncIterable<S2sStreamChunk>;
}

export interface CascadeS2sFallback {
  transcribe(pcm16k: Float32Array, signal: AbortSignal): Promise<string>;
  respond(transcript: string, cue: ParalinguisticCue, signal: AbortSignal): Promise<string>;
  synthesize?(
    text: string,
    signal: AbortSignal,
  ): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export interface TurnLatencyMetrics {
  vadEndpointMs: number;
  firstTextMs: number | null;
  firstAudioMs: number | null;
  totalTurnMs: number;
  usedNativeS2s: boolean;
  bargeInTriggered: boolean;
}

export type DuplexState =
  | "idle"
  | "listening"
  | "user_speaking"
  | "turn_yielding"
  | "assistant_speaking";

export interface DuplexTurnOutcome {
  transcript: string;
  replyText: string;
  cue: ParalinguisticCue;
  metrics: TurnLatencyMetrics;
}

/**
 * Full-duplex local Speech-to-Speech pipeline supporting continuous 20-32ms 16 kHz PCM
 * ingestion, pre-roll buffering, natural silence endpointing, instant barge-in abort
 * during assistant speech, streaming text+audio output, and cascade STT->LLM->TTS fallback.
 */
export class DuplexSpeechToSpeechPipeline {
  enabled: boolean;
  private _state: DuplexState = "idle";
  private readonly transport: StreamingS2sTransport | null;
  private readonly fallback: CascadeS2sFallback | null;
  private readonly speechRmsThreshold: number;
  private readonly silenceEndpointMs: number;
  private readonly preRollMaxSamples: number;
  private readonly onMood?: (mood: Mood) => void;
  private readonly onCue?: (cue: ParalinguisticCue) => void;
  private readonly onTextDelta?: (delta: string) => void;
  private readonly onAudioChunk?: (samples: Float32Array, sampleRate: number) => void;
  private readonly onBargeIn?: () => void;

  private readonly preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  private utteranceChunks: Float32Array[] = [];
  private lastVoicedAtMs = 0;
  private activeAbort: AbortController | null = null;
  private activeTurnPromise: Promise<DuplexTurnOutcome | null> | null = null;
  private _bargeInCount = 0;

  constructor(
    options: {
      enabled?: boolean;
      transport?: StreamingS2sTransport | null;
      fallback?: CascadeS2sFallback | null;
      speechRmsThreshold?: number;
      silenceEndpointMs?: number;
      preRollMs?: number;
      onMood?: (mood: Mood) => void;
      onCue?: (cue: ParalinguisticCue) => void;
      onTextDelta?: (delta: string) => void;
      onAudioChunk?: (samples: Float32Array, sampleRate: number) => void;
      onBargeIn?: () => void;
    } = {},
  ) {
    this.enabled = options.enabled ?? true;
    if (options.transport?.endpointHost && !isPrivateLanHost(options.transport.endpointHost)) {
      throw new Error(
        `Refused non-local streaming S2S transport endpoint "${options.transport.endpointHost}".`,
      );
    }
    this.transport = options.transport ?? null;
    this.fallback = options.fallback ?? null;
    this.speechRmsThreshold = Math.max(0.005, options.speechRmsThreshold ?? 0.02);
    this.silenceEndpointMs = Math.max(80, options.silenceEndpointMs ?? 280);
    this.preRollMaxSamples = Math.max(320, Math.round((options.preRollMs ?? 160) * 16));
    this.onMood = options.onMood;
    this.onCue = options.onCue;
    this.onTextDelta = options.onTextDelta;
    this.onAudioChunk = options.onAudioChunk;
    this.onBargeIn = options.onBargeIn;
    if (this.enabled) this._state = "listening";
  }

  get state(): DuplexState {
    return this._state;
  }

  get bargeInCount(): number {
    return this._bargeInCount;
  }

  /** Cancels any in-flight assistant audio/generation cleanly on user barge-in. */
  triggerBargeIn(): void {
    if (this._state === "assistant_speaking" || this.activeAbort) {
      this._bargeInCount += 1;
      this.activeAbort?.abort();
      this.activeAbort = null;
      this._state = "user_speaking";
      this.onBargeIn?.();
    }
  }

  /**
   * Ingests a 16 kHz mono frame. Returns an awaited `DuplexTurnOutcome` when silence
   * endpoints an utterance, or `null` while buffering / listening.
   */
  async pushAudioFrame(
    frame: Float32Array,
    atMs = Date.now(),
  ): Promise<DuplexTurnOutcome | null> {
    if (!this.enabled) return null;
    if (this._state === "idle") this._state = "listening";

    const rms = computeRms(frame);
    const voiced = rms >= this.speechRmsThreshold;

    if (voiced) {
      if (this._state === "assistant_speaking" || this._state === "turn_yielding") {
        this.triggerBargeIn();
      }
      if (this._state !== "user_speaking") {
        this._state = "user_speaking";
        this.utteranceChunks = [...this.preRoll, new Float32Array(frame)];
      } else {
        this.utteranceChunks.push(new Float32Array(frame));
      }
      this.lastVoicedAtMs = atMs;
      return null;
    }

    if (this._state === "user_speaking") {
      this.utteranceChunks.push(new Float32Array(frame));
      if (atMs - this.lastVoicedAtMs >= this.silenceEndpointMs) {
        return this.flushUtterance();
      }
      return null;
    }

    // Keep bounded pre-roll ring so syllable onsets are never clipped.
    this.preRoll.push(new Float32Array(frame));
    this.preRollSamples += frame.length;
    while (this.preRollSamples > this.preRollMaxSamples && this.preRoll.length > 0) {
      const removed = this.preRoll.shift();
      this.preRollSamples -= removed?.length ?? 0;
    }
    return null;
  }

  async flushUtterance(): Promise<DuplexTurnOutcome | null> {
    if (this.utteranceChunks.length === 0) return null;
    const totalLen = this.utteranceChunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLen);
    let cursor = 0;
    for (const chunk of this.utteranceChunks) {
      merged.set(chunk, cursor);
      cursor += chunk.length;
    }
    this.utteranceChunks = [];
    return this.runStreamTurn(merged);
  }

  private async runStreamTurn(pcm16k: Float32Array): Promise<DuplexTurnOutcome> {
    this._state = "turn_yielding";
    const started = performance.now();
    const cue = inferParalinguisticCue(pcm16k);
    this.onMood?.(cue.mood);
    this.onCue?.(cue);

    const controller = new AbortController();
    this.activeAbort = controller;
    let firstTextMs: number | null = null;
    let firstAudioMs: number | null = null;
    let replyText = "";
    let usedNativeS2s = false;
    let bargedIn = false;

    const task = (async (): Promise<DuplexTurnOutcome> => {
      if (this.transport) {
        try {
          usedNativeS2s = true;
          this._state = "assistant_speaking";
          for await (const chunk of this.transport.streamTurn(pcm16k, cue, controller.signal)) {
            if (controller.signal.aborted) {
              bargedIn = true;
              break;
            }
            if (chunk.textDelta) {
              if (firstTextMs === null) firstTextMs = Math.max(0, Math.round(performance.now() - started));
              replyText += chunk.textDelta;
              this.onTextDelta?.(chunk.textDelta);
            }
            if (chunk.audioOut && chunk.audioOut.length > 0) {
              if (firstAudioMs === null) {
                firstAudioMs = Math.max(0, Math.round(performance.now() - started));
              }
              this.onAudioChunk?.(chunk.audioOut, chunk.sampleRate ?? 24_000);
            }
            if (chunk.done) break;
          }
          if (!controller.signal.aborted && this._state === "assistant_speaking") {
            this._state = "listening";
          }
          return {
            transcript: "",
            replyText,
            cue,
            metrics: {
              vadEndpointMs: this.silenceEndpointMs,
              firstTextMs,
              firstAudioMs,
              totalTurnMs: Math.max(0, Math.round(performance.now() - started)),
              usedNativeS2s: true,
              bargeInTriggered: bargedIn || controller.signal.aborted,
            },
          };
        } catch (err) {
          if (controller.signal.aborted || !this.fallback) {
            throw err instanceof Error ? err : new Error(String(err), { cause: err });
          }
          usedNativeS2s = false;
        }
      }

      if (!this.fallback) {
        throw new Error("Neither native S2S transport nor cascade fallback is configured.");
      }
      this._state = "assistant_speaking";
      const transcript = await this.fallback.transcribe(pcm16k, controller.signal);
      if (controller.signal.aborted) bargedIn = true;
      else {
        replyText = await this.fallback.respond(transcript, cue, controller.signal);
        if (replyText) {
          firstTextMs = Math.max(0, Math.round(performance.now() - started));
          this.onTextDelta?.(replyText);
        }
        if (this.fallback.synthesize && !controller.signal.aborted) {
          const synth = await this.fallback.synthesize(replyText, controller.signal);
          firstAudioMs = Math.max(0, Math.round(performance.now() - started));
          this.onAudioChunk?.(synth.samples, synth.sampleRate);
        }
      }
      if (!controller.signal.aborted && this._state === "assistant_speaking") {
        this._state = "listening";
      }
      return {
        transcript,
        replyText,
        cue,
        metrics: {
          vadEndpointMs: this.silenceEndpointMs,
          firstTextMs,
          firstAudioMs,
          totalTurnMs: Math.max(0, Math.round(performance.now() - started)),
          usedNativeS2s,
          bargeInTriggered: bargedIn || controller.signal.aborted,
        },
      };
    })();

    this.activeTurnPromise = task;
    try {
      return await task;
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null;
      if (this.activeTurnPromise === task) this.activeTurnPromise = null;
    }
  }
}

// --- Continuous Lightweight Streaming Vision ------------------------------

export type VisionStreamMode = "idle" | "active" | "coaching";

const VISION_MODE_FPS: Record<VisionStreamMode, number> = {
  idle: 0.5,
  active: 2,
  coaching: 4,
};

export const SENSITIVE_WINDOW_RE =
  /\b(?:keepass(?:xc)?|1password|bitwarden|lastpass|private\s+browsing|incognito|inprivate|password|passkey)\b/i;

/** Downsamples a grayscale frame into an `8x8` (or `cols x rows`) average luminance grid. */
export function computeBlockGridLuma(
  luma: Uint8Array,
  width: number,
  height: number,
  cols = 8,
  rows = 8,
): Uint8Array {
  const safeCols = Math.max(1, cols);
  const safeRows = Math.max(1, rows);
  const out = new Uint8Array(safeCols * safeRows);
  if (width <= 0 || height <= 0 || luma.length === 0) return out;

  for (let r = 0; r < safeRows; r += 1) {
    const y0 = Math.floor((r * height) / safeRows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / safeRows));
    for (let c = 0; c < safeCols; c += 1) {
      const x0 = Math.floor((c * width) / safeCols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / safeCols));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y += 1) {
        for (let x = x0; x < x1 && x < width; x += 1) {
          sum += luma[y * width + x] ?? 0;
          count += 1;
        }
      }
      out[r * safeCols + c] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
  return out;
}

/** Returns indices of spatial grid blocks whose luminance shifted past `threshold` (`[0..1]`). */
export function changedBlockIndices(
  prevGrid: Uint8Array,
  currGrid: Uint8Array,
  threshold = 0.1,
): number[] {
  const n = Math.min(prevGrid.length, currGrid.length);
  const changed: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (Math.abs((prevGrid[i] ?? 0) - (currGrid[i] ?? 0)) / 255 >= threshold) {
      changed.push(i);
    }
  }
  return changed;
}

export interface VisionKeyframe {
  atMs: number;
  app: string;
  title: string;
  changeScore: number;
  changedRegions: number[];
  gridLuma: Uint8Array;
}

export interface VisionCoachingCue {
  atMs: number;
  app: string;
  title: string;
  changeScore: number;
  changedRegions: number[];
  summary: string;
}

/**
 * Lightweight continuous screen encoder for live app/game coaching without pausing
 * for screenshots: adaptive FPS throttling, 8x8 spatial block deltas, bounded token-budgeted
 * keyframes, debounced coaching cues, and unconditional privacy/hands-off filtering.
 */
export class ContinuousVisionStreamer {
  mode: VisionStreamMode = "active";
  paused = false;
  private readonly changeThreshold: number;
  private readonly tokensPerKeyframe: number;
  private readonly maxTokenBudget: number;
  private readonly coachingCooldownMs: number;
  private readonly onCoachingCue?: (cue: VisionCoachingCue) => void;
  private readonly keyframes: VisionKeyframe[] = [];
  private lastSampledAtMs = -Infinity;
  private lastCoachingAtMs = -Infinity;

  constructor(
    options: {
      mode?: VisionStreamMode;
      changeThreshold?: number;
      tokensPerKeyframe?: number;
      maxTokenBudget?: number;
      coachingCooldownMs?: number;
      onCoachingCue?: (cue: VisionCoachingCue) => void;
    } = {},
  ) {
    this.mode = options.mode ?? "active";
    this.changeThreshold = Math.max(0.01, Math.min(1, options.changeThreshold ?? 0.08));
    this.tokensPerKeyframe = Math.max(16, options.tokensPerKeyframe ?? 85);
    this.maxTokenBudget = Math.max(this.tokensPerKeyframe, options.maxTokenBudget ?? 512);
    this.coachingCooldownMs = Math.max(0, options.coachingCooldownMs ?? 1_500);
    this.onCoachingCue = options.onCoachingCue;
  }

  get keyframeCount(): number {
    return this.keyframes.length;
  }

  get estimatedTokens(): number {
    return this.keyframes.length * this.tokensPerKeyframe;
  }

  ingestFrame(
    frame: VideoFrameInput,
    policy: { handsOff?: boolean; away?: boolean } = {},
  ): {
    accepted: boolean;
    reason: "paused" | "private" | "throttled" | "static" | "keyframe";
    changeScore: number;
    changedRegions: number[];
  } {
    if (this.paused || policy.handsOff || policy.away) {
      return { accepted: false, reason: "paused", changeScore: 0, changedRegions: [] };
    }
    if (
      frame.isPrivate ||
      SENSITIVE_WINDOW_RE.test(frame.app) ||
      SENSITIVE_WINDOW_RE.test(frame.title)
    ) {
      return { accepted: false, reason: "private", changeScore: 0, changedRegions: [] };
    }

    const minIntervalMs = 1000 / VISION_MODE_FPS[this.mode];
    if (frame.atMs - this.lastSampledAtMs < minIntervalMs) {
      return { accepted: false, reason: "throttled", changeScore: 0, changedRegions: [] };
    }
    this.lastSampledAtMs = frame.atMs;

    const gridLuma = computeBlockGridLuma(frame.luma, frame.width, frame.height, 8, 8);
    const prev = this.keyframes.at(-1);
    const changeScore = prev ? frameDifference(prev.gridLuma, gridLuma) : 1;
    const changedRegions = prev ? changedBlockIndices(prev.gridLuma, gridLuma, this.changeThreshold) : [];

    if (prev && changeScore < this.changeThreshold && changedRegions.length === 0) {
      return { accepted: false, reason: "static", changeScore, changedRegions };
    }

    this.keyframes.push({
      atMs: frame.atMs,
      app: frame.app,
      title: frame.title,
      changeScore,
      changedRegions,
      gridLuma,
    });
    const maxFramesForBudget = Math.max(1, Math.floor(this.maxTokenBudget / this.tokensPerKeyframe));
    while (this.keyframes.length > maxFramesForBudget) {
      this.keyframes.shift();
    }

    if (
      this.mode === "coaching" &&
      this.onCoachingCue &&
      frame.atMs - this.lastCoachingAtMs >= this.coachingCooldownMs
    ) {
      this.lastCoachingAtMs = frame.atMs;
      this.onCoachingCue({
        atMs: frame.atMs,
        app: frame.app,
        title: frame.title,
        changeScore,
        changedRegions,
        summary: `Active view ${frame.app} (${frame.title}): ${changedRegions.length} regions updated (delta ${changeScore.toFixed(2)}).`,
      });
    }

    return { accepted: true, reason: "keyframe", changeScore, changedRegions };
  }

  getContextSummary(): string {
    if (this.keyframes.length === 0) return "";
    const lines = this.keyframes.map(
      (kf) =>
        `[${kf.app}] ${kf.title} (delta=${kf.changeScore.toFixed(2)}, regions=${kf.changedRegions.length})`,
    );
    return `Continuous vision (${this.keyframes.length} keyframes, ~${this.estimatedTokens} tok):\n${lines.join("\n")}`;
  }

  clear(): void {
    this.keyframes.length = 0;
  }
}
