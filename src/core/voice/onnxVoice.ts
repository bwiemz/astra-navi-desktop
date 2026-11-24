import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import type { LanguageCode } from "../languages.ts";
import type { SpokenAudio, VoiceBackend } from "./backend.ts";

const ONNX_TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

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
    languages: ["en", "ja", "zh"],
  },
  bright: {
    id: "bright",
    label: "Bright Navigator (ONNX)",
    kokoroVoice: "af_bella",
    speedMultiplier: 1.06,
    languages: ["en", "ja", "zh"],
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
    languages: ["en", "ja"],
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

/** Resolves an Astra voice design name or raw Kokoro voice ID to an ONNX voice profile. */
export function resolveOnnxVoicePreset(
  voiceOrDesign: string,
  language: LanguageCode = "en",
): { kokoroVoice: string; speedMultiplier: number } {
  const key = voiceOrDesign.trim().toLowerCase();
  const preset = ONNX_VOICE_PRESETS[key];
  if (preset) {
    if (language === "ja" && preset.id === "astra") {
      return { kokoroVoice: "jf_alpha", speedMultiplier: preset.speedMultiplier };
    }
    if (language === "zh" && preset.id === "astra") {
      return { kokoroVoice: "zf_xiaobei", speedMultiplier: preset.speedMultiplier };
    }
    return { kokoroVoice: preset.kokoroVoice, speedMultiplier: preset.speedMultiplier };
  }
  return {
    kokoroVoice: voiceOrDesign.trim() || "af_heart",
    speedMultiplier: 1.0,
  };
}

/**
 * Embedded Zero-Python Multi-Voice ONNX TTS Backend (`kokoro-js`).
 *
 * Replaces the legacy Python `voice-server/server.py` runtime dependency for day-to-day
 * desktop speech synthesis using in-process ONNX Runtime inference.
 */
export class OnnxVoice implements VoiceBackend {
  readonly label = "embedded ONNX voice";
  private readonly cacheDir: string;
  private readonly voice: string;
  private readonly speed: number;
  private readonly loadEngine: (cacheDir: string) => Promise<KokoroLikeEngine>;
  private engine: Promise<KokoroLikeEngine> | null = null;
  private synthesizing = false;

  constructor(options: {
    cacheDir: string;
    voice: string;
    speed: number;
    loadEngine?: (cacheDir: string) => Promise<KokoroLikeEngine>;
  }) {
    this.cacheDir = options.cacheDir;
    this.voice = options.voice;
    this.speed = options.speed;
    this.loadEngine =
      options.loadEngine ??
      (async (dir) => {
        env.cacheDir = dir;
        const tts = await KokoroTTS.from_pretrained(ONNX_TTS_MODEL, {
          dtype: "q8",
          device: "cpu",
        });
        return tts as unknown as KokoroLikeEngine;
      });
  }

  supports(language: LanguageCode): boolean {
    const key = this.voice.trim().toLowerCase();
    const preset = ONNX_VOICE_PRESETS[key];
    if (preset) return preset.languages.includes(language);
    return language === "en" || (language === "ja" && key.startsWith("jf_")) || (language === "zh" && key.startsWith("zf_"));
  }

  warm(): Promise<void> {
    return this.getEngine().then(() => undefined);
  }

  async synthesize(sentence: string, language: LanguageCode): Promise<SpokenAudio> {
    this.synthesizing = true;
    try {
      const tts = await this.getEngine();
      const resolved = resolveOnnxVoicePreset(this.voice, language);
      const speed = Math.max(0.5, Math.min(2.0, this.speed * resolved.speedMultiplier));
      const audio = await tts.generate(sentence, {
        voice: resolved.kokoroVoice,
        speed,
      });
      return {
        samples: audio.audio,
        sampleRate: audio.sampling_rate,
      };
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
  id: "kokoro-82m" | "chatterbox-nano" | "qwen3-tts-0.6b" | "llama-cpp-speech";
  license: "Apache-2.0" | "MIT";
  pythonRequired: false;
  languages: readonly LanguageCode[];
  approxFootprintMb: number;
  strengths: string;
}

/** Reference catalog for zero-Python local TTS backends evaluated behind `VoiceBackend`. */
export const ONNX_SHOOTOUT_CATALOG: readonly VoiceShootoutEntry[] = [
  {
    id: "kokoro-82m",
    license: "Apache-2.0",
    pythonRequired: false,
    languages: ["en", "ja", "zh"],
    approxFootprintMb: 88,
    strengths: "In-process quantized CPU ONNX via kokoro-js (0 MB VRAM, ~0.58 RTF).",
  },
  {
    id: "chatterbox-nano",
    license: "MIT",
    pythonRequired: false,
    languages: ["en"],
    approxFootprintMb: 180,
    strengths: "Expressive exaggeration control and compact reference cloning.",
  },
  {
    id: "qwen3-tts-0.6b",
    license: "Apache-2.0",
    pythonRequired: false,
    languages: ["en", "ja", "zh"],
    approxFootprintMb: 620,
    strengths: "Native EN/JA/ZH code-switching streaming + 3s zero-shot clone.",
  },
  {
    id: "llama-cpp-speech",
    license: "MIT",
    pythonRequired: false,
    languages: ["en", "ja", "zh"],
    approxFootprintMb: 120,
    strengths: "Unified local llama.cpp 1.0.0 `/v1/audio/speech` server binary.",
  },
];
