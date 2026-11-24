import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExpressiveCueFrame } from "../../shared/visemes.ts";
import type { LanguageCode } from "../languages.ts";
import type { SpokenAudio, VoiceBackend } from "./backend.ts";
import { extractExpressiveCues } from "./expressiveAudio.ts";

const execFileAsync = promisify(execFile);

/**
 * Experimental Ultra-Light Zero-Python CPU Voice Backend (Apache-2.0 tier):
 *
 * 1. `kokoro-82m` (Apache 2.0): CPU quantized ONNX via `kokoro-js` (`q8` or `q4`) with
 *    optional zero-Python `sherpa-onnx` offline binary probe and clause-chunked streaming.
 * 2. `phonon-31m` (Apache 2.0, ~64 MB): lightweight native Rust/WASM runtime contract for
 *    sub-100ms CPU streaming synthesis without Python.
 */

export type UltraLightEngineKind = "kokoro-82m" | "phonon-31m";
export type KokoroQuantization = "q8" | "q4" | "fp32";

export interface SpokenAudioChunk extends SpokenAudio {
  chunkIndex: number;
  text: string;
  cues: ExpressiveCueFrame[];
}

export interface PhononRuntime {
  warm?(): Promise<void>;
  synthesizeStream(
    text: string,
    language: LanguageCode,
  ): AsyncIterable<{ samples: Float32Array; sampleRate: number }>;
  dispose?(): Promise<void>;
}

export interface UltraLightVoiceOptions {
  engine: UltraLightEngineKind;
  cacheDir: string;
  voice?: string;
  speed?: number;
  quantization?: KokoroQuantization;
  /** Optional path to Apache-2.0 `sherpa-onnx-offline-tts` native binary + model dir. */
  sherpaBinaryPath?: string;
  sherpaModelDir?: string;
  /** Optional injected or WASM/FFI Phonon 31M runtime adapter. */
  phononRuntime?: PhononRuntime;
}

const DEFAULT_KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export function splitStreamingClauses(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const raw = clean
    .split(/(?<=[.!?;:。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length > 0 ? raw : [clean];
}

function parsePcm16Wav(buf: Buffer): SpokenAudio {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Invalid WAV output from native TTS binary.");
  }
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample}; expected 16-bit PCM.`);
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      const dataStart = offset + 8;
      const sampleCount = Math.floor(Math.min(size, buf.length - dataStart) / 2);
      const samples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
      }
      return { samples, sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("Missing data chunk in WAV output.");
}

export class UltraLightOnnxVoice implements VoiceBackend {
  readonly label: string;
  private readonly opts: UltraLightVoiceOptions;
  private kokoroInstance: {
    generate(
      text: string,
      opts?: { voice?: string; speed?: number },
    ): Promise<{ audio: Float32Array; sampling_rate: number }>;
  } | null = null;
  private kokoroPromise: Promise<void> | null = null;

  constructor(options: UltraLightVoiceOptions) {
    this.opts = options;
    this.label =
      options.engine === "phonon-31m"
        ? "phonon-31m (cpu stream)"
        : `kokoro-82m-${options.quantization ?? "q8"} (cpu)`;
  }

  supports(language: LanguageCode): boolean {
    if (this.opts.engine === "phonon-31m") {
      return language === "en";
    }
    return language === "en" || language === "ja";
  }

  async warm(): Promise<void> {
    if (this.opts.engine === "phonon-31m") {
      if (!this.opts.phononRuntime) {
        throw new Error(
          "Phonon 31M native/WASM runtime is not configured; provide PhononRuntime adapter.",
        );
      }
      await this.opts.phononRuntime.warm?.();
      return;
    }
    if (this.canUseSherpaCli()) return;
    await this.ensureKokoro();
  }

  private canUseSherpaCli(): boolean {
    return Boolean(
      this.opts.sherpaBinaryPath &&
        this.opts.sherpaModelDir &&
        existsSync(this.opts.sherpaBinaryPath) &&
        existsSync(this.opts.sherpaModelDir),
    );
  }

  private async ensureKokoro(): Promise<void> {
    if (this.kokoroInstance) return;
    if (!this.kokoroPromise) {
      this.kokoroPromise = (async () => {
        const [{ env }, { KokoroTTS }] = await Promise.all([
          import("@huggingface/transformers"),
          import("kokoro-js"),
        ]);
        env.cacheDir = this.opts.cacheDir;
        const dtype = this.opts.quantization ?? "q8";
        const model = await KokoroTTS.from_pretrained(DEFAULT_KOKORO_MODEL, {
          dtype,
          device: "cpu",
        });
        this.kokoroInstance = model as unknown as typeof this.kokoroInstance;
      })().catch((err) => {
        this.kokoroPromise = null;
        throw err;
      });
    }
    await this.kokoroPromise;
  }

  private async synthesizeClauseSherpa(clause: string): Promise<SpokenAudio> {
    const binPath = this.opts.sherpaBinaryPath;
    const modelDir = this.opts.sherpaModelDir;
    if (!binPath || !modelDir) {
      throw new Error("sherpa-onnx binary or model directory is not configured.");
    }
    const outFile = join(tmpdir(), `astra-sherpa-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    try {
      await execFileAsync(
        binPath,
        [
          `--kokoro-model=${join(modelDir, "model.onnx")}`,
          `--kokoro-voices=${join(modelDir, "voices.bin")}`,
          `--kokoro-tokens=${join(modelDir, "tokens.txt")}`,
          `--output-filename=${outFile}`,
          clause,
        ],
        { timeout: 30_000 },
      );
      const wav = await readFile(outFile);
      return parsePcm16Wav(wav);
    } finally {
      await unlink(outFile).catch(() => undefined);
    }
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
    const total = chunks.reduce((sum, c) => sum + c.samples.length, 0);
    const merged = new Float32Array(total);
    let cursor = 0;
    for (const c of chunks) {
      merged.set(c.samples, cursor);
      cursor += c.samples.length;
    }
    return { samples: merged, sampleRate };
  }

  async *synthesizeStream(
    sentence: string,
    language: LanguageCode,
  ): AsyncGenerator<SpokenAudioChunk> {
    if (!this.supports(language)) {
      throw new Error(`${this.label} does not support language "${language}".`);
    }
    const clauses = splitStreamingClauses(sentence);
    if (clauses.length === 0) return;

    if (this.opts.engine === "phonon-31m") {
      if (!this.opts.phononRuntime) {
        throw new Error("Phonon 31M native/WASM runtime is not configured.");
      }
      let idx = 0;
      for await (const raw of this.opts.phononRuntime.synthesizeStream(sentence, language)) {
        yield {
          chunkIndex: idx,
          text: clauses[idx] ?? sentence,
          samples: raw.samples,
          sampleRate: raw.sampleRate,
          cues: extractExpressiveCues(raw.samples, raw.sampleRate),
        };
        idx += 1;
      }
      return;
    }

    const useSherpa = this.canUseSherpaCli();
    if (!useSherpa) {
      await this.ensureKokoro();
    }

    for (let i = 0; i < clauses.length; i += 1) {
      const clause = clauses[i];
      if (!clause) continue;
      let spoken: SpokenAudio;
      if (useSherpa) {
        spoken = await this.synthesizeClauseSherpa(clause);
      } else {
        const kokoro = this.kokoroInstance;
        if (!kokoro) throw new Error("Kokoro ONNX runtime failed to initialize.");
        const res = await kokoro.generate(clause, {
          voice: this.opts.voice ?? "af_heart",
          speed: this.opts.speed ?? 1.0,
        });
        spoken = { samples: res.audio, sampleRate: res.sampling_rate };
      }
      yield {
        chunkIndex: i,
        text: clause,
        samples: spoken.samples,
        sampleRate: spoken.sampleRate,
        cues: extractExpressiveCues(spoken.samples, spoken.sampleRate),
      };
    }
  }

  async rest(): Promise<void> {
    this.kokoroInstance = null;
    this.kokoroPromise = null;
  }

  async dispose(): Promise<void> {
    await this.rest();
    await this.opts.phononRuntime?.dispose?.();
  }
}
