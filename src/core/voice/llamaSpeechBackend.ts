import type { LanguageCode } from "../languages.ts";
import { isPrivateLanHost } from "../workerMesh.ts";
import type { SpokenAudio, VoiceBackend } from "./backend.ts";

/**
 * Zero-Python Speech Backends for the TTS Engine Shootout behind `VoiceBackend`:
 *
 * 1. `LlamaCppSpeechBackend`: Consumes `llama.cpp 1.0.0` `/v1/audio/speech` on localhost
 *    or private LAN so text generation & speech synthesis can share one local binary.
 * 2. `ChatterboxNanoVoice`: Compact expressive local TTS contract (`exaggeration` control
 *    for cheerful/soft prosody) with pluggable local ONNX/native runtime.
 */

function assertPrivateSpeechUrl(endpointUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new Error(`Invalid speech endpoint URL "${endpointUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported speech endpoint scheme "${parsed.protocol}".`);
  }
  if (!isPrivateLanHost(parsed.hostname)) {
    throw new Error(
      `Refusing non-LAN speech endpoint "${parsed.hostname}"; only loopback/private LAN hosts are allowed.`,
    );
  }
  return parsed;
}

/** Parses standard 16-bit PCM RIFF/WAV response bytes into normalized `Float32Array` samples. */
export function decodeWavPcm16(wavBytes: Uint8Array): SpokenAudio {
  const buf = Buffer.from(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Expected RIFF WAV audio payload.");
  }
  const channels = Math.max(1, buf.readUInt16LE(22));
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample} (expected 16).`);
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const start = offset + 8;
      const available = Math.min(chunkSize, buf.length - start);
      const totalSamples = Math.floor(available / 2);
      const frameCount = Math.floor(totalSamples / channels);
      const out = new Float32Array(frameCount);
      for (let i = 0; i < frameCount; i += 1) {
        let sum = 0;
        for (let c = 0; c < channels; c += 1) {
          sum += buf.readInt16LE(start + (i * channels + c) * 2) / 32768;
        }
        out[i] = sum / channels;
      }
      return { samples: out, sampleRate };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("Missing data chunk inside WAV audio response.");
}

export class LlamaCppSpeechBackend implements VoiceBackend {
  readonly label = "llama.cpp 1.0.0 /v1/audio/speech";
  private readonly baseUrl: URL;
  private readonly model: string;
  private readonly voice: string;
  private readonly speed: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    endpointUrl: string;
    model?: string;
    voice?: string;
    speed?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = assertPrivateSpeechUrl(options.endpointUrl);
    this.model = options.model ?? "kokoro-82m";
    this.voice = options.voice ?? "af_heart";
    this.speed = Math.max(0.5, Math.min(2.0, options.speed ?? 1.0));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(language: LanguageCode): boolean {
    return language === "en" || language === "ja" || language === "zh";
  }

  async warm(): Promise<void> {
    const url = new URL("/health", this.baseUrl);
    const res = await this.fetchImpl(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`${this.label} health probe failed (HTTP ${res.status}).`);
    }
  }

  async synthesize(sentence: string, language: LanguageCode): Promise<SpokenAudio> {
    const clean = sentence.trim();
    if (!clean) return { samples: new Float32Array(0), sampleRate: 24_000 };
    const url = new URL("/v1/audio/speech", this.baseUrl);
    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: clean,
        voice: this.voice,
        speed: this.speed,
        language,
        response_format: "wav",
      }),
    });
    if (!res.ok) {
      throw new Error(`${this.label} request failed (HTTP ${res.status}).`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return decodeWavPcm16(bytes);
  }

  async rest(): Promise<void> {
    // Inference server owns memory lifecycle.
  }

  async dispose(): Promise<void> {
    // No local resources held.
  }
}

export interface ChatterboxNanoRuntime {
  warm?(): Promise<void>;
  synthesize(input: {
    text: string;
    language: LanguageCode;
    exaggeration: number;
    speakerRefSamples?: Float32Array;
  }): Promise<SpokenAudio>;
  dispose?(): Promise<void>;
}

export class ChatterboxNanoVoice implements VoiceBackend {
  readonly label = "chatterbox-nano (expressive local)";
  private exaggeration: number;
  private speakerRef: Float32Array | undefined;
  private readonly runtime: ChatterboxNanoRuntime | null;

  constructor(
    options: {
      exaggeration?: number;
      speakerRefSamples?: Float32Array;
      runtime?: ChatterboxNanoRuntime;
    } = {},
  ) {
    this.exaggeration = Math.max(0, Math.min(1, options.exaggeration ?? 0.45));
    this.speakerRef = options.speakerRefSamples;
    this.runtime = options.runtime ?? null;
  }

  setExaggeration(value: number): void {
    this.exaggeration = Math.max(0, Math.min(1, value));
  }

  supports(language: LanguageCode): boolean {
    return language === "en";
  }

  async warm(): Promise<void> {
    if (!this.runtime) {
      throw new Error(
        "Chatterbox-Nano local runtime is not installed; provide ChatterboxNanoRuntime adapter.",
      );
    }
    await this.runtime.warm?.();
  }

  async synthesize(sentence: string, language: LanguageCode): Promise<SpokenAudio> {
    if (!this.runtime) {
      throw new Error(
        "Chatterbox-Nano local runtime is not installed; provide ChatterboxNanoRuntime adapter.",
      );
    }
    return await this.runtime.synthesize({
      text: sentence,
      language,
      exaggeration: this.exaggeration,
      ...(this.speakerRef ? { speakerRefSamples: this.speakerRef } : {}),
    });
  }

  async rest(): Promise<void> {
    this.speakerRef = undefined;
  }

  async dispose(): Promise<void> {
    await this.rest();
    await this.runtime?.dispose?.();
  }
}
