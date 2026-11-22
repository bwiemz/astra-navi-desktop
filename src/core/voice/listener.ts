import { AutoModel, env, pipeline, Tensor } from "@huggingface/transformers";
import {
  extractVoicePrint,
  type HouseholdIsolationManager,
  type HouseholdProfile,
} from "../household.ts";

const VAD_MODEL = "onnx-community/silero-vad";
/** Fast, English only. */
export const ENGLISH_STT_MODEL = "onnx-community/moonshine-base-ONNX";
/** Slower, understands many languages. */
export const MULTILINGUAL_STT_MODEL = "onnx-community/whisper-small";

const SAMPLE_RATE = 16_000;
const FRAME = 512; // 32 ms, the size the voice detector expects
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;
/** Audio kept from just before speech was detected, so first syllables are not clipped. */
const PRE_ROLL_FRAMES = 10;
const END_SILENCE_MS = 700;
const MIN_SPEECH_MS = 250;
const MAX_UTTERANCE_MS = 30_000;
/** About ten seconds of microphone audio waiting to be looked at. */
const MAX_QUEUED_BLOCKS = 80;

export type ListenState = "listening" | "hearing" | "transcribing";

export interface ListenerOptions {
  cacheDir: string;
  /**
   * The language to expect, by the recogniser's name for it ("japanese", "chinese"), or
   * null for English, which uses the faster English-only recogniser.
   */
  language: string | null;
  onState(state: ListenState): void;
  /** Someone has clearly started talking (used to interrupt her mid-sentence). */
  onSpeechStart(): void;
  /**
   * Optional native end-to-end speech-to-speech handler receiving raw 16 kHz utterance PCM.
   * Return `true` to handle the turn natively and skip cascaded STT transcription.
   */
  onUtteranceAudio?: (audio16k: Float32Array) => Promise<boolean>;
  /**
   * Optional household speaker isolation manager. When enabled, identifies the speaker's
   * voice-print locally and forwards the matched `HouseholdProfile` (or null) to `onUtterance`.
   */
  household?: HouseholdIsolationManager;
  onUtterance(text: string, sttMs?: number, speaker?: HouseholdProfile | null): void;
  onError(message: string): void;
}

interface VadModel {
  (inputs: Record<string, Tensor>): Promise<{ output: Tensor; stateN: Tensor }>;
}
type Transcriber = (
  audio: Float32Array,
  options?: { language: string; task: "transcribe" },
) => Promise<{ text: string } | { text: string }[]>;

/**
 * Hears the user. Microphone audio comes in as a stream; a voice detector finds where
 * speech starts and stops, and each finished utterance is turned into text. Everything
 * runs on this computer.
 */
export class Listener {
  private readonly options: ListenerOptions;
  private models: Promise<{ vad: VadModel; transcribe: Transcriber }> | null = null;
  private vadState = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  private readonly sampleRateTensor = new Tensor(
    "int64",
    BigInt64Array.from([BigInt(SAMPLE_RATE)]),
    [],
  );
  private leftover = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private recording = false;
  private speechMs = 0;
  private silenceMs = 0;
  private announcedStart = false;
  /** While she is talking, her own voice may leak into the microphone: be harder to trigger. */
  private guarded = false;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private epoch = 0;

  constructor(options: ListenerOptions) {
    this.options = options;
  }

  warm(): Promise<void> {
    return this.load().then(() => undefined);
  }

  /** Tells the listener whether the assistant is currently speaking through the speakers. */
  setGuarded(guarded: boolean): void {
    this.guarded = guarded;
  }

  /** Feeds microphone audio: mono, 16 kHz, any length. */
  feed(samples: Float32Array): void {
    // If recognition falls behind the microphone, drop audio rather than queue it without end.
    if (this.queued >= MAX_QUEUED_BLOCKS) return;
    this.queued += 1;
    const epoch = this.epoch;
    this.chain = this.chain
      .then(() => (epoch === this.epoch ? this.process(samples, epoch) : undefined))
      .finally(() => {
        this.queued -= 1;
      })
      .catch((error: unknown) => {
        this.options.onError(error instanceof Error ? error.message : String(error));
      });
  }

  /** Drops anything half-heard, for when the microphone is switched off. */
  reset(): void {
    this.epoch += 1;
    this.leftover = new Float32Array(0);
    this.preRoll = [];
    this.utterance = [];
    this.recording = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.announcedStart = false;
    this.vadState = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  }

  private load(): Promise<{ vad: VadModel; transcribe: Transcriber }> {
    if (!this.models) {
      env.cacheDir = this.options.cacheDir;
      const stt = this.options.language === null ? ENGLISH_STT_MODEL : MULTILINGUAL_STT_MODEL;
      this.models = (async () => {
        const vad = (await AutoModel.from_pretrained(VAD_MODEL, {
          // The detector is a plain ONNX graph with no model class of its own.
          config: { model_type: "custom" } as never,
          dtype: "fp32",
        })) as unknown as VadModel;
        const transcribe = (await pipeline("automatic-speech-recognition", stt, {
          device: "cpu",
          dtype: stt.includes("moonshine")
            ? "q8"
            : { encoder_model: "fp32", decoder_model_merged: "q8" },
        })) as unknown as Transcriber;
        return { vad, transcribe };
      })();
      this.models.catch(() => {
        this.models = null;
      });
    }
    return this.models;
  }

  private async process(samples: Float32Array, epoch: number): Promise<void> {
    const { vad } = await this.load();
    if (epoch !== this.epoch) return; // the microphone was switched off meanwhile
    const joined = new Float32Array(this.leftover.length + samples.length);
    joined.set(this.leftover);
    joined.set(samples, this.leftover.length);

    let offset = 0;
    for (; offset + FRAME <= joined.length; offset += FRAME) {
      const frame = joined.slice(offset, offset + FRAME);
      const result = await vad({
        input: new Tensor("float32", frame, [1, FRAME]),
        sr: this.sampleRateTensor,
        state: this.vadState,
      });
      if (epoch !== this.epoch) return;
      this.vadState = result.stateN;
      await this.onFrame(frame, Number(result.output.data[0]), epoch);
      if (epoch !== this.epoch) return;
    }
    this.leftover = joined.slice(offset);
  }

  private async onFrame(
    frame: Float32Array,
    speechProbability: number,
    epoch: number,
  ): Promise<void> {
    const startAt = this.guarded ? 0.85 : 0.5;
    const stayAbove = this.guarded ? 0.6 : 0.35;

    if (!this.recording) {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      if (speechProbability < startAt) return;
      this.recording = true;
      this.utterance = [...this.preRoll];
      this.preRoll = [];
      this.speechMs = FRAME_MS;
      this.silenceMs = 0;
      this.announcedStart = false;
      return;
    }

    this.utterance.push(frame);
    if (speechProbability >= stayAbove) {
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
      // Only once it is clearly speech, not a click or a cough, does it count as talking.
      if (!this.announcedStart && this.speechMs >= (this.guarded ? 480 : MIN_SPEECH_MS)) {
        this.announcedStart = true;
        this.options.onState("hearing");
        this.options.onSpeechStart();
      }
    } else {
      this.silenceMs += FRAME_MS;
    }

    const tooLong = this.utterance.length * FRAME_MS >= MAX_UTTERANCE_MS;
    if (this.silenceMs < END_SILENCE_MS && !tooLong) return;

    const frames = this.utterance;
    const wasSpeech = this.announcedStart;
    this.recording = false;
    this.utterance = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.announcedStart = false;
    if (!wasSpeech) return;

    this.options.onState("transcribing");
    const audio = new Float32Array(frames.length * FRAME);
    frames.forEach((part, index) => audio.set(part, index * FRAME));
    let text: string;
    let sttMs: number;
    try {
      if (this.options.onUtteranceAudio && (await this.options.onUtteranceAudio(audio))) {
        return;
      }
      const { transcribe } = await this.load();
      const { language } = this.options;
      const sttStart = Date.now();
      // Naming the language stops the recogniser guessing, which it does badly on short phrases.
      const result = await (language === null
        ? transcribe(audio)
        : transcribe(audio, { language, task: "transcribe" }));
      sttMs = Date.now() - sttStart;
      text = (Array.isArray(result) ? (result[0]?.text ?? "") : result.text).trim();
    } finally {
      // Whatever happened, she is listening again; the window must not stay on "working it out".
      if (epoch === this.epoch) this.options.onState("listening");
    }
    if (epoch !== this.epoch) return;
    // Recognisers label silence and noise with bracketed tags; those are not words.
    if (/[\p{L}\p{N}]{2,}/u.test(text.replace(/[[(][^\])]*[\])]/g, ""))) {
      const speaker = this.options.household?.enabled
        ? this.options.household.identifySpeaker(extractVoicePrint(audio))
        : undefined;
      this.options.onUtterance(text, sttMs, speaker);
    }
  }
}
