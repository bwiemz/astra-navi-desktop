import type { ExpressiveCueFrame } from "../../shared/visemes.ts";
import { LANGUAGES, type LanguageCode } from "../languages.ts";
import { isPrivateLanHost } from "../workerMesh.ts";
import type { SpokenAudio, VoiceBackend } from "./backend.ts";
import { extractExpressiveCues } from "./expressiveAudio.ts";

/**
 * Experimental Multilingual Streaming GPU Voice R&D Backend (Apache-2.0 tier):
 *
 * - `Qwen3-TTS` (0.6B / 1.7B, Apache 2.0): sub-100ms chunked PCM streaming over
 *   localhost or private LAN worker endpoints, with optional 3-second zero-shot voice cloning.
 * - `Qwen3-ASR-0.6B` (Apache 2.0): multilingual EN / JA / ZH streaming ASR + code-switch span tagger.
 *
 * All remote HTTP endpoints are strictly constrained to loopback/private LAN hosts via
 * `isPrivateLanHost()` to prevent SSRF or unintended external voice exfiltration.
 */

export type Qwen3TtsTier = "qwen3-tts-0.6b" | "qwen3-tts-1.7b";

export interface Qwen3VoiceCloneReference {
  audioPcm16Base64: string;
  sampleRate: number;
  transcript: string;
}

export interface Qwen3StreamingTtsOptions {
  endpointUrl: string;
  tier?: Qwen3TtsTier;
  speaker?: string;
  sampleRate?: number;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export interface Qwen3StreamChunk extends SpokenAudio {
  chunkIndex: number;
  cues: ExpressiveCueFrame[];
}

export interface CodeSwitchSpan {
  language: "en" | "ja" | "zh";
  text: string;
}

function assertPrivateEndpoint(endpointUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new Error(`Invalid voice service URL "${endpointUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported voice service scheme "${parsed.protocol}".`);
  }
  if (!isPrivateLanHost(parsed.hostname)) {
    throw new Error(
      `Refusing non-LAN voice endpoint host "${parsed.hostname}"; only loopback/private LAN hosts are allowed.`,
    );
  }
  return parsed;
}

function encodePcm16Base64(samples: Float32Array): string {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf.toString("base64");
}

function decodePcm16Bytes(raw: Uint8Array): Float32Array {
  const count = Math.floor(raw.byteLength / 2);
  const view = new DataView(raw.buffer, raw.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

/** Segments mixed-script text into English (`en`), Japanese (`ja`), and Chinese (`zh`) runs. */
export function detectCodeSwitchSpans(text: string): CodeSwitchSpan[] {
  const spans: CodeSwitchSpan[] = [];
  const kanaRe = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
  const hanRe = /\p{Script=Han}/u;
  const hasKanaOverall = kanaRe.test(text);

  let currentLang: "en" | "ja" | "zh" | null = null;
  let buf = "";

  for (const ch of text) {
    let lang: "en" | "ja" | "zh" | null = currentLang;
    if (kanaRe.test(ch)) {
      lang = "ja";
    } else if (hanRe.test(ch)) {
      lang = currentLang === "ja" || hasKanaOverall ? "ja" : "zh";
    } else if (/[A-Za-z0-9]/.test(ch)) {
      lang = "en";
    } else if (currentLang === null) {
      lang = "en";
    }

    if (lang !== currentLang && buf.trim()) {
      if (currentLang) spans.push({ language: currentLang, text: buf.trim() });
      buf = ch;
      currentLang = lang;
    } else {
      buf += ch;
      if (currentLang === null) currentLang = lang;
    }
  }
  if (buf.trim() && currentLang) {
    spans.push({ language: currentLang, text: buf.trim() });
  }
  return spans;
}

export class Qwen3StreamingTtsBackend implements VoiceBackend {
  readonly label: string;
  private readonly baseUrl: URL;
  private readonly tier: Qwen3TtsTier;
  private readonly speaker: string;
  private readonly sampleRate: number;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;
  private referenceVoice: Qwen3VoiceCloneReference | null = null;

  constructor(options: Qwen3StreamingTtsOptions) {
    this.baseUrl = assertPrivateEndpoint(options.endpointUrl);
    this.tier = options.tier ?? "qwen3-tts-0.6b";
    this.label = `${this.tier} (stream)`;
    this.speaker = options.speaker ?? "astra";
    this.sampleRate = options.sampleRate ?? 24_000;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(language: LanguageCode): boolean {
    return language in LANGUAGES;
  }

  /** Registers an up-to-3-second reference clip for zero-shot Qwen3-TTS voice cloning. */
  setReferenceVoice(samples: Float32Array, sampleRate: number, transcript: string): void {
    const maxSamples = Math.min(samples.length, Math.max(1, Math.round(sampleRate * 3.5)));
    const clipped = samples.subarray(0, maxSamples);
    this.referenceVoice = {
      audioPcm16Base64: encodePcm16Base64(clipped),
      sampleRate,
      transcript: transcript.trim().slice(0, 300),
    };
  }

  clearReferenceVoice(): void {
    this.referenceVoice = null;
  }

  async warm(): Promise<void> {
    const url = new URL("/health", this.baseUrl);
    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`${this.label} warmup failed with HTTP ${res.status}.`);
    }
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
    return headers;
  }

  async synthesize(sentence: string, language: LanguageCode): Promise<SpokenAudio> {
    const chunks: Qwen3StreamChunk[] = [];
    for await (const chunk of this.synthesizeStream(sentence, language)) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((acc, c) => acc + c.samples.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk.samples, offset);
      offset += chunk.samples.length;
    }
    return {
      samples: merged,
      sampleRate: chunks[0]?.sampleRate ?? this.sampleRate,
    };
  }

  async *synthesizeStream(
    sentence: string,
    language: LanguageCode,
  ): AsyncGenerator<Qwen3StreamChunk> {
    const clean = sentence.trim();
    if (!clean) return;
    const url = new URL("/v1/tts/stream", this.baseUrl);
    const spans = detectCodeSwitchSpans(clean);
    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        model: this.tier,
        text: clean,
        language,
        spans,
        speaker: this.speaker,
        sample_rate: this.sampleRate,
        format: "pcm_s16le",
        ...(this.referenceVoice ? { reference_voice: this.referenceVoice } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`${this.label} synthesis failed with HTTP ${res.status}.`);
    }

    if (!res.body) {
      const ab = await res.arrayBuffer();
      const samples = decodePcm16Bytes(new Uint8Array(ab));
      yield {
        chunkIndex: 0,
        samples,
        sampleRate: this.sampleRate,
        cues: extractExpressiveCues(samples, this.sampleRate),
      };
      return;
    }

    const reader = res.body.getReader();
    let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let chunkIndex = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const combined = new Uint8Array(carry.byteLength + value.byteLength);
      combined.set(carry, 0);
      combined.set(value, carry.byteLength);

      const evenLen = combined.byteLength - (combined.byteLength % 2);
      carry = combined.slice(evenLen);
      if (evenLen === 0) continue;

      const samples = decodePcm16Bytes(combined.subarray(0, evenLen));
      yield {
        chunkIndex,
        samples,
        sampleRate: this.sampleRate,
        cues: extractExpressiveCues(samples, this.sampleRate),
      };
      chunkIndex += 1;
    }
  }

  async rest(): Promise<void> {
    // Stateless HTTP streaming client; worker manages model memory on LAN host.
  }

  async dispose(): Promise<void> {
    this.referenceVoice = null;
  }
}

export interface Qwen3AsrResult {
  text: string;
  language: string;
  spans: CodeSwitchSpan[];
}

export class Qwen3AsrMultilingualClient {
  private readonly baseUrl: URL;
  private readonly model: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    endpointUrl: string;
    model?: string;
    authToken?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = assertPrivateEndpoint(options.endpointUrl);
    this.model = options.model ?? "Qwen3-ASR-0.6B";
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribePcm(
    samples: Float32Array,
    sampleRate = 16_000,
    hintLanguages: readonly ("en" | "ja" | "zh")[] = ["en", "ja", "zh"],
  ): Promise<Qwen3AsrResult> {
    const url = new URL("/v1/asr/transcribe", this.baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        sample_rate: sampleRate,
        languages: hintLanguages,
        pcm_s16le_base64: encodePcm16Base64(samples),
      }),
    });
    if (!res.ok) {
      throw new Error(`Qwen3-ASR HTTP ${res.status}.`);
    }
    const data = (await res.json()) as { text?: string; language?: string };
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return {
      text,
      language: typeof data.language === "string" ? data.language : "auto",
      spans: detectCodeSwitchSpans(text),
    };
  }
}
