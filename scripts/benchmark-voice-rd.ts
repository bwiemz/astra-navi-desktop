/**
 * Zero-Python CPU Voice R&D Benchmark:
 * Measures real `Kokoro-82M` (`q8` quantized ONNX via `kokoro-js`) cold load time,
 * clause-streaming first-audio latency, synthesis RTF, RSS memory, and expressive
 * audio cue extraction throughput on CPU without touching Python or the GPU.
 *
 * Usage:
 *   node scripts/benchmark-voice-rd.ts [--cache-dir PATH] [--quant q8|q4]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { UltraLightOnnxVoice, type KokoroQuantization } from "../src/core/voice/experimentalUltraLightVoice.ts";
import { extractExpressiveCues } from "../src/core/voice/expressiveAudio.ts";

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

const TEST_SENTENCE =
  "Systems nominal on the primary server. Next calibration window opens in twelve minutes, and everything looks steady!";

async function main(): Promise<void> {
  const backend = new UltraLightOnnxVoice({
    engine: "kokoro-82m",
    quantization,
    cacheDir,
    voice: "af_heart",
    speed: 1.0,
  });

  const tWarm0 = performance.now();
  await backend.warm();
  const coldLoadMs = performance.now() - tWarm0;

  // Warmup pass so ONNX Runtime arenas stabilize
  await backend.synthesize("Warmup check.", "en");

  const tSynth0 = performance.now();
  let firstAudioMs = 0;
  let totalSamples = 0;
  let sampleRate = 24_000;
  let chunkCount = 0;
  let totalCueMs = 0;
  let totalCues = 0;

  for await (const chunk of backend.synthesizeStream(TEST_SENTENCE, "en")) {
    if (chunkCount === 0) {
      firstAudioMs = performance.now() - tSynth0;
    }
    chunkCount += 1;
    totalSamples += chunk.samples.length;
    sampleRate = chunk.sampleRate;
    const tCue0 = performance.now();
    const cues = extractExpressiveCues(chunk.samples, chunk.sampleRate, 20);
    totalCueMs += performance.now() - tCue0;
    totalCues += cues.length;
  }
  const totalSynthMs = performance.now() - tSynth0;
  const audioMs = (totalSamples / Math.max(1, sampleRate)) * 1000;
  const rtf = audioMs > 0 ? totalSynthMs / audioMs : 0;
  const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

  await backend.dispose();

  const report = {
    engine: "kokoro-82m",
    quantization,
    cacheDir,
    pythonUsed: false,
    coldLoadMs: Number(coldLoadMs.toFixed(1)),
    firstAudioLatencyMs: Number(firstAudioMs.toFixed(1)),
    totalSynthMs: Number(totalSynthMs.toFixed(1)),
    audioDurationMs: Number(audioMs.toFixed(1)),
    realTimeFactor: Number(rtf.toFixed(3)),
    clausesStreamed: chunkCount,
    expressiveCueFrames: totalCues,
    cueExtractionMsPerSecAudio: Number(
      (audioMs > 0 ? totalCueMs / (audioMs / 1000) : 0).toFixed(3),
    ),
    processRssMb: rssMb,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err: unknown) => {
  console.error("[benchmark-voice-rd] failed:", err);
  process.exit(1);
});
