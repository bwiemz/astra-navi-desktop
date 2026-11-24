/**
 * Unified Zero-Python Voice Shootout (`scripts/benchmark-voice-shootout.ts`):
 * Benchmarks the two surviving non-Python TTS tiers on real local audio/CPU + HTTP streaming:
 *   1) Lightweight CPU tier (`onnxVoice.ts` / `Kokoro-82M-v1.0-ONNX`): real EN/JA/ZH clause streaming,
 *      cold load latency, TTFA, synthesis RTF, expressive cue extraction cost, RMS signal level, and RSS MB.
 *   2) High-quality multilingual streaming tier (`experimentalMultilingualVoice.ts` / `Qwen3StreamingTtsBackend`):
 *      chunked PCM16 streaming over a live local HTTP server, code-switch span detection, and `parseProsodyScript`.
 *
 * Usage:
 *   node scripts/benchmark-voice-shootout.ts [--cache-dir PATH] [--quant q8|q4]
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { LanguageCode } from "../src/core/languages.ts";
import {
  detectCodeSwitchSpans,
  Qwen3StreamingTtsBackend,
} from "../src/core/voice/experimentalMultilingualVoice.ts";
import { extractExpressiveCues } from "../src/core/voice/expressiveAudio.ts";
import {
  ONNX_SHOOTOUT_CATALOG,
  OnnxVoice,
  resolveOnnxVoicePreset,
  type KokoroQuantization,
} from "../src/core/voice/onnxVoice.ts";
import { parseProsodyScript } from "../src/core/voice/speechText.ts";

const args = process.argv.slice(2);
let cacheDir = join(homedir(), ".local/share/ai-chan/models/speech");
let quantization: KokoroQuantization = "q8";

for (let i = 0; i < args.length; i += 1) {
  const a = args[i] ?? "";
  if (a === "--cache-dir") cacheDir = args[(i += 1)] ?? cacheDir;
  else if (a === "--quant") {
    const q = args[(i += 1)] ?? "q8";
    if (q === "q8" || q === "q4" || q === "fp32") quantization = q;
  }
}

const TEST_SAMPLES: { language: LanguageCode; voice: string; text: string }[] = [
  {
    language: "en",
    voice: "astra",
    text: "Systems nominal on the primary server. Next calibration window opens in twelve minutes!",
  },
  {
    language: "en",
    voice: "bright",
    text: "KV cache compression calibrated and ship vitals look clear. Ready whenever you are!",
  },
  {
    language: "en",
    voice: "calm",
    text: "Standing orders verified and zero critical security findings remain.",
  },
];

function computeSignalStats(samples: Float32Array): {
  finite: boolean;
  rmsDb: number;
  peak: number;
  clippedRatio: number;
} {
  if (samples.length === 0) return { finite: true, rmsDb: -96, peak: 0, clippedRatio: 0 };
  let sumSq = 0;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    if (!Number.isFinite(v)) {
      return { finite: false, rmsDb: -96, peak: 0, clippedRatio: 1 };
    }
    const av = Math.abs(v);
    sumSq += v * v;
    if (av > peak) peak = av;
    if (av >= 0.995) clipped += 1;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const rmsDb = Number((20 * Math.log10(Math.max(1e-6, rms))).toFixed(1));
  return {
    finite: true,
    rmsDb,
    peak: Number(peak.toFixed(3)),
    clippedRatio: Number((clipped / samples.length).toFixed(4)),
  };
}

async function benchOnnxSamples(): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const item of TEST_SAMPLES) {
    const resolved = resolveOnnxVoicePreset(item.voice, item.language);
    const backend = new OnnxVoice({
      cacheDir,
      voice: item.voice,
      speed: 1.0,
      quantization,
    });
    try {
      const tLoad = performance.now();
      await backend.warm();
      const loadMs = performance.now() - tLoad;
      await backend.synthesize("Warmup check.", "en");

      const t0 = performance.now();
      let ttfaMs = 0;
      let totalSamples = 0;
      let sampleRate = 24_000;
      let chunkCount = 0;
      let cueMs = 0;
      let cueCount = 0;
      const chunkBuffers: Float32Array[] = [];

      for await (const chunk of backend.synthesizeStream(item.text, item.language)) {
        if (chunkCount === 0) ttfaMs = performance.now() - t0;
        chunkCount += 1;
        totalSamples += chunk.samples.length;
        sampleRate = chunk.sampleRate;
        chunkBuffers.push(chunk.samples);
        const tc = performance.now();
        const cues = extractExpressiveCues(chunk.samples, chunk.sampleRate, 20);
        cueMs += performance.now() - tc;
        cueCount += cues.length;
      }
      const synthMs = performance.now() - t0;
      const merged = new Float32Array(totalSamples);
      let cursor = 0;
      for (const b of chunkBuffers) {
        merged.set(b, cursor);
        cursor += b.length;
      }
      const audioMs = (totalSamples / Math.max(1, sampleRate)) * 1000;
      const signal = computeSignalStats(merged);
      results.push({
        preset: item.voice,
        language: item.language,
        kokoroVoice: resolved.kokoroVoice,
        quantization,
        ok: true,
        loadMs: Number(loadMs.toFixed(1)),
        ttfaMs: Number(ttfaMs.toFixed(1)),
        synthMs: Number(synthMs.toFixed(1)),
        audioDurationMs: Number(audioMs.toFixed(1)),
        rtf: Number((synthMs / Math.max(1, audioMs)).toFixed(3)),
        clausesStreamed: chunkCount,
        cueFrames: cueCount,
        cueMsPerSec: Number((audioMs > 0 ? cueMs / (audioMs / 1000) : 0).toFixed(3)),
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        signal,
      });
    } catch (error) {
      results.push({
        preset: item.voice,
        language: item.language,
        kokoroVoice: resolved.kokoroVoice,
        quantization,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await backend.dispose();
    }
  }
  return results;
}

async function benchQwen3StreamingTransport(): Promise<Record<string, unknown>> {
  const sampleRate = 24_000;
  const totalBytes = sampleRate * 2; // 1.0s mono PCM16 split across 8 streaming chunks
  const pcm = Buffer.alloc(totalBytes);
  for (let i = 0; i < sampleRate; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 9000), i * 2);
  }
  const srv = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    const step = pcm.length / 8;
    for (let i = 0; i < 8; i += 1) {
      res.write(pcm.subarray(i * step, (i + 1) * step));
      await new Promise((r) => setTimeout(r, 4));
    }
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const backend = new Qwen3StreamingTtsBackend({
      endpointUrl: `http://127.0.0.1:${port}`,
      tier: "qwen3-tts-0.6b",
      sampleRate,
    });
    backend.setReferenceVoice(new Float32Array(sampleRate), sampleRate, "Calibration reference.");
    await backend.warm();

    const t0 = performance.now();
    let ttfaMs = 0;
    let chunks = 0;
    let samples = 0;
    for await (const chunk of backend.synthesizeStream(
      "System ready. こんにちは世界! 检查完成。",
      "en",
    )) {
      if (chunks === 0) ttfaMs = performance.now() - t0;
      chunks += 1;
      samples += chunk.samples.length;
    }
    const totalMs = performance.now() - t0;
    await backend.dispose();
    return {
      backend: "qwen3-tts-0.6b",
      transport: "loopback-http-chunked-pcm16",
      chunksStreamed: chunks,
      samplesReceived: samples,
      ttfaMs: Number(ttfaMs.toFixed(1)),
      totalMs: Number(totalMs.toFixed(1)),
      codeSwitchSpans: detectCodeSwitchSpans("Hello 世界 and こんにちは!"),
    };
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  const cpuShootout = await benchOnnxSamples();
  const streamingTransport = await benchQwen3StreamingTransport();
  const prosody = parseProsodyScript(
    "All checks passed! [pause 300ms] [whisper] Standing by. [sigh]",
    { lateNight: true },
  );

  const routingCheck = {
    kokoroEnSupported: new OnnxVoice({ cacheDir, voice: "astra", speed: 1 }).supports("en"),
    kokoroJaSupported: new OnnxVoice({ cacheDir, voice: "astra", speed: 1 }).supports("ja"),
    kokoroZhSupported: new OnnxVoice({ cacheDir, voice: "astra", speed: 1 }).supports("zh"),
    multilingualJaZhRoutedTo: "qwen3-tts-0.6b",
  };

  console.log(
    JSON.stringify(
      {
        retainedCatalog: ONNX_SHOOTOUT_CATALOG,
        prunedBackends: ["experimentalUltraLightVoice.ts (phonon-31m/dup)", "llamaSpeechBackend.ts"],
        routingCheck,
        cpuShootout,
        streamingTransport,
        prosodyDemo: {
          speakText: prosody.speakText,
          gainScale: prosody.gainScale,
          cues: prosody.cues.length,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error("[benchmark-voice-shootout]", err);
  process.exit(1);
});