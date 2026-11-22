import { env, pipeline, Tensor } from "@huggingface/transformers";
import { MULTILINGUAL_STT_MODEL } from "./voice/listener.ts";

/**
 * Turns a stretch of recorded sound into words, in whatever language it is in. Used for
 * what the PC played, which need not be the language she and the user speak. The model
 * (the same multilingual one her ears use for Japanese and Chinese) is loaded when first
 * needed and let go after a few quiet minutes.
 */

interface Recogniser {
  (
    audio: Float32Array,
    options: {
      chunk_length_s: number;
      stride_length_s: number;
      task: "transcribe";
      language?: string;
    },
  ): Promise<{ text: string } | { text: string }[]>;
  processor(audio: Float32Array): Promise<{ input_features: unknown }>;
  tokenizer: { model: { convert_tokens_to_ids(tokens: string[]): number[] } };
  model(
    inputs: Record<string, unknown>,
  ): Promise<{ logits: { dims: number[]; data: Float32Array } }>;
}

/**
 * The languages she tells apart by ear. The recogniser knows about a hundred; these are
 * the ones a stream, a game or a call is most likely to be in.
 */
const LANGUAGES_BY_EAR = [
  "en", "ja", "zh", "ko", "es", "fr", "de", "ru", "pt", "it", "id", "vi", "th", "hi", "ar", "tr", "pl", "nl", "uk",
] as const; // prettier-ignore
const RATE = 16_000;

const REST_AFTER_MS = 5 * 60_000;

/** Recognisers label silence and noise with bracketed tags; those are not words. */
export function withoutSoundTags(text: string): string {
  return text
    .replace(/\[[^\]]{0,40}\]|\([^)]{0,40}\)|♪+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The stretch of the given length with the most sound in it: speech rather than a lead-in of silence. */
export function loudestStretch(samples: Float32Array, length: number): Float32Array {
  if (samples.length <= length) return samples;
  const block = RATE; // compared second by second
  let bestStart = 0;
  let bestEnergy = -1;
  for (let start = 0; start + length <= samples.length; start += block) {
    let energy = 0;
    for (let index = start; index < start + length; index += 16) {
      const value = samples[index] ?? 0;
      energy += value * value;
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }
  return samples.subarray(bestStart, bestStart + length);
}

export class ClipTranscriber {
  private readonly cacheDir: string;
  private model: Promise<Recogniser> | null = null;
  private restTimer: NodeJS.Timeout | null = null;
  private busy = 0;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  /** The words in the clip (16 kHz, one channel), or "" when there are none. */
  async transcribe(samples: Float32Array): Promise<string> {
    this.busy += 1;
    if (this.restTimer) clearTimeout(this.restTimer);
    try {
      const recognise = await this.load();
      const language = await this.languageOf(recognise, samples);
      const result = await recognise(samples, {
        chunk_length_s: 30,
        stride_length_s: 5,
        task: "transcribe",
        ...(language ? { language } : {}),
      });
      return withoutSoundTags(Array.isArray(result) ? (result[0]?.text ?? "") : result.text);
    } finally {
      this.busy -= 1;
      if (this.busy === 0) {
        this.restTimer = setTimeout(() => void this.rest(), REST_AFTER_MS);
        this.restTimer.unref();
      }
    }
  }

  /**
   * Which language the clip is spoken in, by the recogniser's own first guess: it is
   * shown the loudest stretch and asked which language mark it would begin with. Left
   * unsaid, it would hear everything as English.
   */
  private async languageOf(recognise: Recogniser, samples: Float32Array): Promise<string | null> {
    try {
      const marks = LANGUAGES_BY_EAR.map((code) => `<|${code}|>`);
      const ids = recognise.tokenizer.model.convert_tokens_to_ids(marks);
      const [start] = recognise.tokenizer.model.convert_tokens_to_ids(["<|startoftranscript|>"]);
      if (start === undefined) return null;
      const { input_features } = await recognise.processor(loudestStretch(samples, 20 * RATE));
      const { logits } = await recognise.model({
        input_features,
        decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(start)]), [1, 1]),
      });
      const vocabulary = logits.dims[logits.dims.length - 1] ?? 0;
      let best: string | null = null;
      let bestScore = -Infinity;
      ids.forEach((id, index) => {
        const score = id < vocabulary ? (logits.data[id] ?? -Infinity) : -Infinity;
        if (score > bestScore) {
          bestScore = score;
          best = LANGUAGES_BY_EAR[index] ?? null;
        }
      });
      return best;
    } catch (error) {
      console.warn("[transcriber] the language could not be told:", error);
      return null;
    }
  }

  async rest(): Promise<void> {
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    if (this.busy > 0 || !this.model) return;
    const loaded = this.model;
    this.model = null;
    await loaded
      .then((recognise) => (recognise as unknown as { dispose?(): Promise<void> }).dispose?.())
      .catch(() => undefined);
  }

  private load(): Promise<Recogniser> {
    if (!this.model) {
      env.cacheDir = this.cacheDir;
      const loading = pipeline("automatic-speech-recognition", MULTILINGUAL_STT_MODEL, {
        device: "cpu",
        dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
      }) as unknown as Promise<Recogniser>;
      this.model = loading;
      loading.catch(() => {
        if (this.model === loading) this.model = null;
      });
    }
    return this.model;
  }
}
