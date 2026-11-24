import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import type { ExpressiveCueFrame } from "../../shared/visemes.ts";
import type { LanguageCode } from "../languages.ts";
import type { SpokenAudio, VoiceBackend } from "./backend.ts";
import { extractExpressiveCues } from "./expressiveAudio.ts";

const ONNX_TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export type KokoroQuantization = "q8" | "q4" | "fp32";

export interface SpokenAudioChunk extends SpokenAudio {
  chunkIndex: number;
  text: string;
  cues: ExpressiveCueFrame[];
}

export interface OnnxVoicePreset {
  id: string;
  label: string;
  kokoroVoice: string;
  speedMultiplier: number;
  languages: readonly LanguageCode[];
}

export const ONNX_VOICE_PRESETS: Record<string, OnnxVoicePreset> = {
  astra: {
    id: "astra",
    label: "Astra Clear (ONNX)",
    kokoroVoice: "af_heart",
    speedMultiplier: 1.0,
    languages: ["en"],
  },
  bright: {
    id: "bright",
    label: "Bright Navigator (ONNX)",
    kokoroVoice: "af_bella",
    speedMultiplier: 1.06,
    languages: ["en"],
  },
  calm: {
    id: "calm",
    label: "Calm Bridge (ONNX)",
    kokoroVoice: "bf_emma",
    speedMultiplier: 0.94,
    languages: ["en"],
  },
  warm: {
    id: "warm",
    label: "Warm Companion (ONNX)",
    kokoroVoice: "af_nicole",
    speedMultiplier: 0.98,
    languages: ["en"],
  },
  crisp: {
    id: "crisp",
    label: "Crisp Telemetry (ONNX)",
    kokoroVoice: "af_sky",
    speedMultiplier: 1.04,
    languages: ["en"],
  },
  narrator: {
    id: "narrator",
    label: "Station Narrator (ONNX)",
    kokoroVoice: "bm_george",
    speedMultiplier: 0.96,
    languages: ["en"],
  },
};

export interface KokoroLikeEngine {
  generate(
    text: string,
    options: { voice: string; speed?: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

/** Resolves an Astra voice design name or custom raw Kokoro voice ID to an ONNX voice profile. */
export function resolveOnnxVoicePreset(
  voiceOrDesign: string,
  language: LanguageCode = "en",
): { kokoroVoice: string; speedMultiplier: number } {
  void language;
  const key = voiceOrDesign.trim().toLowerCase();
  const preset = ONNX_VOICE_PRESETS[key];
  if (preset) {
    return { kokoroVoice: preset.kokoroVoice, speedMultiplier: preset.speedMultiplier };
  }
  return {
    kokoroVoice: voiceOrDesign.trim() || "af_heart",
    speedMultiplier: 1.0,
  };
}

/** Splits input text along sentence/clause boundaries for low-latency CPU audio streaming. */
export function splitStreamingClauses(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const raw = clean
    .split(/(?<=[.!?;:。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length > 0 ? raw : [clean];
}

/**
 * Embedded Zero-Python Multi-Voice ONNX TTS Backend (`kokoro-js`).
 *
 * Lightweight CPU streaming winner: runs quantized ONNX Runtime inference (`0 MB` VRAM)
 * with clause-chunked audio streaming and expressive prosody/viseme cue extraction.
 */
export class OnnxVoice implements VoiceBackend {
  readonly label: string;
  private readonly cacheDir: string;
  private readonly voice: string;
  private readonly speed: number;
  private readonly quantization: KokoroQuantization;
  private readonly loadEngine: (cacheDir: string) => Promise<KokoroLikeEngine>;
  private engine: Promise<KokoroLikeEngine> | null = null;
  private synthesizing = false;

  constructor(options: {
    cacheDir: string;
    voice: string;
    speed: number;
    quantization?: KokoroQuantization;
    loadEngine?: (cacheDir: string) => Promise<KokoroLikeEngine>;
  }) {
    this.cacheDir = options.cacheDir;
    this.voice = options.voice;
    this.speed = options.speed;
    this.quantization = options.quantization ?? "q8";
    this.label = `embedded ONNX voice (${this.quantization})`;
    const quant = this.quantization;
    this.loadEngine =
      options.loadEngine ??
      (async (dir) => {
        env.cacheDir = dir;
        const tts = await KokoroTTS.from_pretrained(ONNX_TTS_MODEL, {
          dtype: quant,
          device: "cpu",
        });
        return tts as unknown as KokoroLikeEngine;
      });
  }

  supports(language: LanguageCode): boolean {
    const key = this.voice.trim().toLowerCase();
    const preset = ONNX_VOICE_PRESETS[key];
    if (preset) return preset.languages.includes(language);
    return (
      language === "en" ||
      (language === "ja" && key.startsWith("jf_")) ||
      (language === "zh" && key.startsWith("zf_"))
    );
  }

  warm(): Promise<void> {
    return this.getEngine().then(() => undefined);
  }

  async synthesize(sentence: string, language: LanguageCode): Promise<SpokenAudio> {
    const chunks: SpokenAudio[] = [];
    for await (const chunk of this.synthesizeStream(sentence, language)) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) {
      return { samples: new Float32Array(0), sampleRate: 24_000 };
    }
    const first = chunks[0];
    if (chunks.length === 1 && first) {
      return { samples: first.samples, sampleRate: first.sampleRate };
    }
    const sampleRate = first?.sampleRate ?? 24_000;
    const total = chunks.reduce((sum, chunk) => sum + chunk.samples.length, 0);
    const merged = new Float32Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      merged.set(chunk.samples, cursor);
      cursor += chunk.samples.length;
    }
    return { samples: merged, sampleRate };
  }

  async *synthesizeStream(
    sentence: string,
    language: LanguageCode,
  ): AsyncGenerator<SpokenAudioChunk> {
    if (!this.supports(language)) {
      throw new Error(
        `${this.label} does not bundle voices for "${language}"; route JA/ZH to Qwen3StreamingTtsBackend or FullVoice.`,
      );
    }
    const clauses = splitStreamingClauses(sentence);
    if (clauses.length === 0) return;
    this.synthesizing = true;
    try {
      const tts = await this.getEngine();
      const resolved = resolveOnnxVoicePreset(this.voice, language);
      const speed = Math.max(0.5, Math.min(2.0, this.speed * resolved.speedMultiplier));
      for (let i = 0; i < clauses.length; i += 1) {
        const clause = clauses[i];
        if (!clause) continue;
        const audio = await tts.generate(clause, {
          voice: resolved.kokoroVoice,
          speed,
        });
        yield {
          chunkIndex: i,
          text: clause,
          samples: audio.audio,
          sampleRate: audio.sampling_rate,
          cues: extractExpressiveCues(audio.audio, audio.sampling_rate),
        };
      }
    } finally {
      this.synthesizing = false;
    }
  }

  rest(): Promise<void> {
    this.engine = null;
    return Promise.resolve();
  }

  restIfIdle(): Promise<void> {
    if (this.synthesizing) return Promise.resolve();
    return this.rest();
  }

  dispose(): Promise<void> {
    return this.rest();
  }

  private getEngine(): Promise<KokoroLikeEngine> {
    if (!this.engine) {
      const pending = this.loadEngine(this.cacheDir);
      this.engine = pending;
      pending.catch(() => {
        if (this.engine === pending) this.engine = null;
      });
    }
    return this.engine;
  }
}

export interface VoiceShootoutEntry {
  id: "kokoro-82m" | "qwen3-tts-0.6b";
  tier: "lightweight-cpu" | "multilingual-streaming";
  license: "Apache-2.0";
  pythonRequired: false;
  languages: readonly LanguageCode[];
  approxFootprintMb: number;
  strengths: string;
}

/** Winning zero-Python local TTS backends retained after real-hardware shootout pruning. */
export const ONNX_SHOOTOUT_CATALOG: readonly VoiceShootoutEntry[] = [
  {
    id: "kokoro-82m",
    tier: "lightweight-cpu",
    license: "Apache-2.0",
    pythonRequired: false,
    languages: ["en"],
    approxFootprintMb: 88,
    strengths: "In-process quantized CPU ONNX via kokoro-js (0 MB VRAM, clause streaming, EN).",
  },
  {
    id: "qwen3-tts-0.6b",
    tier: "multilingual-streaming",
    license: "Apache-2.0",
    pythonRequired: false,
    languages: ["en", "ja", "zh"],
    approxFootprintMb: 620,
    strengths: "LAN-gated chunked PCM streaming + native EN/JA/ZH code-switching + 3s zero-shot clone.",
  },
];
