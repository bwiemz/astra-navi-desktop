import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import type { LanguageCode } from "../languages.ts";
import type { SpokenAudio, VoiceBackend } from "./backend.ts";

const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * The light voice: the small Kokoro model, running on the processor. It needs no
 * graphics card and no extra set-up, but it only speaks English and its built-in
 * voices are ordinary speaking voices, not character voices.
 */
export class LightVoice implements VoiceBackend {
  readonly label = "light voice";
  private readonly cacheDir: string;
  private readonly voice: string;
  private readonly speed: number;
  private tts: Promise<KokoroTTS> | null = null;

  constructor(options: { cacheDir: string; voice: string; speed: number }) {
    this.cacheDir = options.cacheDir;
    this.voice = options.voice;
    this.speed = options.speed;
  }

  supports(language: LanguageCode): boolean {
    return language === "en";
  }

  warm(): Promise<void> {
    return this.model().then(() => undefined);
  }

  async synthesize(sentence: string): Promise<SpokenAudio> {
    const tts = await this.model();
    const audio = await tts.generate(sentence, {
      // The library types voices as a fixed list; an unknown name fails inside generate.
      voice: this.voice as NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"],
      speed: this.speed,
    });
    return { samples: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
  }

  rest(): Promise<void> {
    this.tts = null;
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return this.rest();
  }

  private model(): Promise<KokoroTTS> {
    if (!this.tts) {
      env.cacheDir = this.cacheDir;
      const loading = KokoroTTS.from_pretrained(TTS_MODEL, { dtype: "q8", device: "cpu" });
      this.tts = loading;
      // A failed load (no network on first use) should be retried next time, not remembered.
      loading.catch(() => {
        if (this.tts === loading) this.tts = null;
      });
    }
    return this.tts;
  }
}
