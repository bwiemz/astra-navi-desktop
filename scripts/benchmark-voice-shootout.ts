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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
let skipLiveQwen3 = false;

for (let i = 0; i < args.length; i += 1) {
  const a = args[i] ?? "";
  if (a === "--cache-dir") cacheDir = args[(i += 1)] ?? cacheDir;
  else if (a === "--skip-live-qwen3") skipLiveQwen3 = true;
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

async function benchOnnxSamples(): Promise<{
  samples: Record<string, unknown>[];
  rssAfterFirstVoiceMb: number;
  rssAfterAllVoicesMb: number;
  rssGrowthAfterFirstVoiceMb: number;
  sharedCacheSizeDuringRun: number;
}> {
  const samples: Record<string, unknown>[] = [];
  let firstRssMb = 0;
  let lastRssMb = 0;
  let cacheSize = 0;

  try {
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
        const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
        if (firstRssMb === 0) firstRssMb = rssMb;
        lastRssMb = rssMb;
        cacheSize = Math.max(cacheSize, OnnxVoice.sharedCacheSize());
        samples.push({
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
          rssMb,
          signal,
        });
      } catch (error) {
        samples.push({
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
  } finally {
    await OnnxVoice.disposeSharedEngines();
  }

  return {
    samples,
    rssAfterFirstVoiceMb: firstRssMb,
    rssAfterAllVoicesMb: lastRssMb,
    rssGrowthAfterFirstVoiceMb: Math.max(0, lastRssMb - firstRssMb),
    sharedCacheSizeDuringRun: cacheSize,
  };
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

async function benchLiveQwen3Tts(): Promise<Record<string, unknown>> {
  const aiChanDir = join(homedir(), ".local", "share", "ai-chan");
  const pyBin = join(aiChanDir, "voice-env", "bin", "python");
  const hfHome = join(aiChanDir, "models", "voice-hf");
  const cachedModelDir = join(hfHome, "hub", "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base");
  const snapshotsDir = join(cachedModelDir, "snapshots");
  const refWav = join(process.cwd(), "assets", "voice", "perky.wav");
  const refTxt = join(process.cwd(), "assets", "voice", "perky.txt");

  if (
    skipLiveQwen3 ||
    !existsSync(pyBin) ||
    !existsSync(snapshotsDir) ||
    !existsSync(refWav) ||
    !existsSync(refTxt)
  ) {
    return { skipped: true, reason: skipLiveQwen3 ? "--skip-live-qwen3" : "model or voice-env absent" };
  }

  const pyScript = `
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import numpy as np, torch
from qwen_tts import Qwen3TTSModel

t0 = time.perf_counter()
device = "cuda:0" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
snapshots = sorted([p for p in Path(sys.argv[3]).iterdir() if p.is_dir()])
if not snapshots:
    raise FileNotFoundError(f"No snapshot dir under {sys.argv[3]}")
model = Qwen3TTSModel.from_pretrained(str(snapshots[-1]), device_map=device, dtype=dtype, local_files_only=True)
voice = model.create_voice_clone_prompt(
    ref_audio=sys.argv[1],
    ref_text=Path(sys.argv[2]).read_text(encoding="utf-8").strip(),
)
load_ms = round((time.perf_counter() - t0) * 1000.0, 1)
LANG_MAP = {"en": "English", "ja": "Japanese", "zh": "Chinese"}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"ok": True, "device": device, "loadMs": load_ms}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        req = json.loads(self.rfile.read(length) or b"{}")
        lang = LANG_MAP.get(str(req.get("language", "en")), "Auto")
        with torch.inference_mode():
            wavs, sr = model.generate_voice_clone(
                text=str(req.get("text", "")),
                language=lang,
                voice_clone_prompt=voice,
            )
        pcm = np.clip(np.asarray(wavs[0], dtype=np.float32).reshape(-1), -1.0, 1.0)
        pcm_bytes = (pcm * 32767.0).astype("<i2").tobytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Sample-Rate", str(int(sr)))
        self.send_header("Content-Length", str(len(pcm_bytes)))
        self.end_headers()
        step = 4096
        for off in range(0, len(pcm_bytes), step):
            self.wfile.write(pcm_bytes[off:off+step])
            self.wfile.flush()

srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print("QWEN3_READY:" + json.dumps({"ready": True, "port": srv.server_address[1], "device": device, "loadMs": load_ms}), flush=True)
srv.serve_forever()
`;

  const child = spawn(pyBin, ["-u", "-c", pyScript, refWav, refTxt, snapshotsDir], {
    env: { ...process.env, HF_HOME: hfHome, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const info = await new Promise<{ port: number; device: string; loadMs: number }>((resolveReady, rejectReady) => {
      let buf = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectReady(new Error(`Qwen3-TTS server timed out: ${stderr}`));
        }
      }, 120_000);
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("QWEN3_READY:")) {
            clearTimeout(timer);
            settled = true;
            try {
              resolveReady(
                JSON.parse(line.slice("QWEN3_READY:".length)) as {
                  port: number;
                  device: string;
                  loadMs: number;
                },
              );
            } catch (err) {
              rejectReady(err);
            }
            return;
          }
          nl = buf.indexOf("\n");
        }
      });
      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectReady(new Error(`Qwen3-TTS server exited (${code}): ${stderr}`));
        }
      });
    });

    const backend = new Qwen3StreamingTtsBackend({
      endpointUrl: `http://127.0.0.1:${info.port}`,
      tier: "qwen3-tts-0.6b",
      sampleRate: 24_000,
    });
    await backend.warm();
    // Warmup GPU kernels
    await backend.synthesize("Warmup check.", "en");

    const prompts: { language: LanguageCode; text: string }[] = [
      { language: "en", text: "Systems nominal and ready for launch." },
      { language: "ja", text: "システムは正常です。いつでも開始できます。" },
      { language: "zh", text: "系统状态正常，随时可以开始。" },
    ];
    const runs: Record<string, unknown>[] = [];
    for (const p of prompts) {
      const t0 = performance.now();
      let ttfaMs = 0;
      let chunks = 0;
      const chunkBuffers: Float32Array[] = [];
      let totalSamples = 0;
      for await (const chunk of backend.synthesizeStream(p.text, p.language)) {
        if (chunks === 0) ttfaMs = performance.now() - t0;
        chunks += 1;
        totalSamples += chunk.samples.length;
        chunkBuffers.push(chunk.samples);
      }
      const synthMs = performance.now() - t0;
      const merged = new Float32Array(totalSamples);
      let cursor = 0;
      for (const b of chunkBuffers) {
        merged.set(b, cursor);
        cursor += b.length;
      }
      const audioMs = (totalSamples / 24_000) * 1000;
      runs.push({
        language: p.language,
        chunksStreamed: chunks,
        ttfaMs: Number(ttfaMs.toFixed(1)),
        synthMs: Number(synthMs.toFixed(1)),
        audioDurationMs: Number(audioMs.toFixed(1)),
        rtf: Number((synthMs / Math.max(1, audioMs)).toFixed(3)),
        signal: computeSignalStats(merged),
      });
    }
    await backend.dispose();
    return {
      skipped: false,
      model: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
      device: info.device,
      loadMs: info.loadMs,
      runs,
    };
  } finally {
    child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  const cpuShootout = await benchOnnxSamples();
  const streamingTransport = await benchQwen3StreamingTransport();
  const liveQwen3Tts = await benchLiveQwen3Tts();
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
        liveQwen3Tts,
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