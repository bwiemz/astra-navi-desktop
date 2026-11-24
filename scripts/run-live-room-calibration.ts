/**
 * Live-Room Physical Acoustic & Wake-Word Calibration (`scripts/run-live-room-calibration.ts`):
 * Exercises real PipeWire playback + microphone capture (`paplay` / `parec`), local
 * cached Kokoro-82M TTS (`OnnxVoice`), local cached `moonshine-base-ONNX` STT, and
 * `evaluateRoomCalibration` / `evaluateWakeRoomGate` (`src/core/voice/aec.ts`).
 *
 * Usage:
 *   node scripts/run-live-room-calibration.ts [--json] [--cache-dir PATH] [--gain 0.35]
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { env, pipeline } from "@huggingface/transformers";
import {
  computeRms,
  evaluateRoomCalibration,
  evaluateWakeRoomGate,
  generateCalibrationTone,
} from "../src/core/voice/aec.ts";
import { OnnxVoice } from "../src/core/voice/onnxVoice.ts";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
let cacheDir = join(homedir(), ".local/share/ai-chan/models/speech");
let sweepGain = 0.35;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] ?? "";
  if (arg === "--cache-dir") cacheDir = args[(i += 1)] ?? cacheDir;
  else if (arg === "--gain") {
    const parsed = Number(args[(i += 1)]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 0.8) sweepGain = parsed;
  }
}

type AsrCallable = ((
  audio: Float32Array,
) => Promise<{ text: string } | { text: string }[]>) & {
  dispose?: () => Promise<void> | void;
};

function encodeWav16Mono(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

function decodeS16LeMono(pcm: Buffer): Float32Array {
  const count = Math.floor(pcm.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

function resampleLinear(samples: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate || samples.length === 0) return samples;
  const outLen = Math.max(1, Math.round((samples.length * dstRate) / srcRate));
  const out = new Float32Array(outLen);
  const ratio = (samples.length - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(samples.length - 1, lo + 1);
    const frac = pos - lo;
    out[i] = (samples[lo] ?? 0) * (1 - frac) + (samples[hi] ?? 0) * frac;
  }
  return out;
}

async function queryPipewireDefaults(): Promise<{
  serverName: string;
  defaultSink: string;
  defaultSource: string;
}> {
  const { stdout } = await execFileAsync("pactl", ["info"], { timeout: 5000 });
  const pick = (prefix: string): string =>
    stdout
      .split("\n")
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() ?? "unknown";
  return {
    serverName: pick("Server Name:"),
    defaultSink: pick("Default Sink:"),
    defaultSource: pick("Default Source:"),
  };
}

async function captureMic16k(durationMs: number, whileRecording?: () => Promise<void>): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  const rec = spawn(
    "parec",
    [
      "--format=s16le",
      "--rate=16000",
      "--channels=1",
      "--latency-msec=20",
      "--raw",
      "--device=@DEFAULT_SOURCE@",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  rec.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

  const stderrChunks: Buffer[] = [];
  rec.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitPromise = new Promise<void>((resolve, reject) => {
    rec.on("error", reject);
    rec.on("close", (code) => {
      if (code !== null && code !== 0 && !rec.killed) {
        reject(new Error(`parec exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`));
      } else {
        resolve();
      }
    });
  });

  try {
    if (whileRecording) {
      await whileRecording();
    } else {
      await new Promise((r) => setTimeout(r, durationMs));
    }
  } finally {
    rec.kill("SIGTERM");
    await exitPromise.catch(() => undefined);
  }
  return decodeS16LeMono(Buffer.concat(chunks));
}

async function playWav(wavPath: string): Promise<void> {
  await execFileAsync("paplay", ["--device=@DEFAULT_SINK@", wavPath], { timeout: 15_000 });
}

function estimateDeviceLagSamples(
  ref: Float32Array,
  mic: Float32Array,
  sampleRate: number,
): { lagSamples: number; normalizedCorrelation: number } {
  const maxLag = Math.min(mic.length - ref.length, Math.round(sampleRate * 1.0));
  if (maxLag <= 0) return { lagSamples: 0, normalizedCorrelation: 0 };

  let refEnergy = 0;
  for (let j = 0; j < ref.length; j += 1) refEnergy += (ref[j] ?? 0) ** 2;

  let bestLag = 0;
  let bestCorr = 0;
  for (let lag = 0; lag <= maxLag; lag += 16) {
    let dot = 0;
    let micEnergy = 0;
    for (let j = 0; j < ref.length; j += 4) {
      const r = ref[j] ?? 0;
      const m = mic[lag + j] ?? 0;
      dot += r * m;
      micEnergy += m * m;
    }
    const corr = Math.abs(dot) / (Math.sqrt((refEnergy / 4) * micEnergy) + 1e-9);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  let refinedLag = bestLag;
  let refinedCorr = bestCorr;
  for (let lag = Math.max(0, bestLag - 24); lag <= Math.min(maxLag, bestLag + 24); lag += 1) {
    let dot = 0;
    let micEnergy = 0;
    for (let j = 0; j < ref.length; j += 2) {
      const r = ref[j] ?? 0;
      const m = mic[lag + j] ?? 0;
      dot += r * m;
      micEnergy += m * m;
    }
    const corr = Math.abs(dot) / (Math.sqrt((refEnergy / 2) * micEnergy) + 1e-9);
    if (corr > refinedCorr) {
      refinedCorr = corr;
      refinedLag = lag;
    }
  }
  return {
    lagSamples: refinedLag,
    normalizedCorrelation: Number(refinedCorr.toFixed(4)),
  };
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "astra-live-cal-"));
  try {
    const pw = await queryPipewireDefaults();

    // Step A: Ambient room floor
    const ambient = await captureMic16k(1500);
    const ambientRms = Number(computeRms(ambient).toFixed(5));
    const ambientDb = Number((20 * Math.log10(Math.max(1e-6, ambientRms))).toFixed(2));

    // Step B: Physical speaker playback -> mic capture calibration tone sweep
    const rawReference = generateCalibrationTone(16_000, 1.2);
    const playbackTone = new Float32Array(rawReference.length);
    for (let i = 0; i < rawReference.length; i += 1) {
      playbackTone[i] = (rawReference[i] ?? 0) * sweepGain;
    }
    const sweepWav = join(tempDir, "sweep.wav");
    writeFileSync(sweepWav, encodeWav16Mono(playbackTone, 16_000));

    const sweepCapture = await captureMic16k(2400, async () => {
      await new Promise((r) => setTimeout(r, 250));
      await playWav(sweepWav);
      await new Promise((r) => setTimeout(r, 450));
    });

    const lagEstimate = estimateDeviceLagSamples(playbackTone, sweepCapture, 16_000);
    const alignedSlice = new Float32Array(playbackTone.length);
    const avail = Math.min(playbackTone.length, Math.max(0, sweepCapture.length - lagEstimate.lagSamples));
    if (avail > 0) {
      alignedSlice.set(sweepCapture.subarray(lagEstimate.lagSamples, lagEstimate.lagSamples + avail));
    }

    const roomReport = evaluateRoomCalibration({
      reference: playbackTone,
      recorded: alignedSlice,
      sampleRate: 16_000,
      otherNames: ["Computer"],
    });
    const physicalCouplingDetected =
      roomReport.rawMicRms > ambientRms * 1.5 && lagEstimate.normalizedCorrelation >= 0.15;

    // Step C: Real Kokoro-82M playback -> physical mic -> moonshine-base-ONNX STT
    env.cacheDir = cacheDir;
    env.allowRemoteModels = false;

    const voice = new OnnxVoice({
      cacheDir,
      voice: "astra",
      speed: 1.0,
      quantization: "q8",
    });
    const transcriber = (await pipeline(
      "automatic-speech-recognition",
      "onnx-community/moonshine-base-ONNX",
      {
        device: "cpu",
        dtype: "q8",
        local_files_only: true,
      },
    )) as unknown as AsrCallable;

    const probePhrases = [
      { phrase: "Astra Navi, check the disk space", expectedWake: true },
      { phrase: "Astra, what time is it", expectedWake: true },
      { phrase: "The weather forecast calls for rain this weekend", expectedWake: false },
      { phrase: "Breaking TV news from downtown tonight", expectedWake: false },
    ] as const;

    const sttResults: {
      phrase: string;
      expectedWake: boolean;
      kokoroSamples: number;
      kokoroRate: number;
      micCapturedRms: number;
      directTranscript: string;
      directGateAccepted: boolean;
      micTranscript: string;
      micGateAccepted: boolean;
      micGateReason?: string;
    }[] = [];

    try {
      for (let i = 0; i < probePhrases.length; i += 1) {
        const item = probePhrases[i];
        if (!item) continue;
        const spoken = await voice.synthesize(item.phrase, "en");
        const direct16k = resampleLinear(spoken.samples, spoken.sampleRate, 16_000);
        const directOut = await transcriber(direct16k);
        const directTranscript = (
          Array.isArray(directOut) ? (directOut[0]?.text ?? "") : directOut.text
        ).trim();
        const directGate = evaluateWakeRoomGate({
          text: directTranscript,
          otherNames: ["Computer"],
          signalRms: computeRms(direct16k),
          noiseFloorRms: Math.max(1e-5, ambientRms),
          minSnrDb: roomReport.recommendedMinSnrDb,
        });

        const clipWav = join(tempDir, `clip-${i}.wav`);
        writeFileSync(clipWav, encodeWav16Mono(spoken.samples, spoken.sampleRate));
        const micAudio = await captureMic16k(3000, async () => {
          await new Promise((r) => setTimeout(r, 150));
          await playWav(clipWav);
          await new Promise((r) => setTimeout(r, 450));
        });
        const micCapturedRms = Number(computeRms(micAudio).toFixed(5));
        const micOut = await transcriber(micAudio);
        const micTranscript = (
          Array.isArray(micOut) ? (micOut[0]?.text ?? "") : micOut.text
        ).trim();
        const micGate = evaluateWakeRoomGate({
          text: micTranscript,
          otherNames: ["Computer"],
          signalRms: micCapturedRms,
          noiseFloorRms: Math.max(1e-5, ambientRms),
          minSnrDb: roomReport.recommendedMinSnrDb,
        });

        sttResults.push({
          phrase: item.phrase,
          expectedWake: item.expectedWake,
          kokoroSamples: spoken.samples.length,
          kokoroRate: spoken.sampleRate,
          micCapturedRms,
          directTranscript,
          directGateAccepted: directGate.accepted,
          micTranscript,
          micGateAccepted: micGate.accepted,
          ...(micGate.reason ? { micGateReason: micGate.reason } : {}),
        });
      }
    } finally {
      await voice.dispose();
      await OnnxVoice.disposeSharedEngines();
      await transcriber.dispose?.();
    }

    const payload = {
      pipewire: pw,
      ambient: {
        samplesCaptured: ambient.length,
        ambientRms,
        ambientDb,
      },
      physicalSweep: {
        sweepGain,
        captureSamples: sweepCapture.length,
        deviceLagSamples: lagEstimate.lagSamples,
        deviceLagMs: Number(((lagEstimate.lagSamples / 16_000) * 1000).toFixed(1)),
        normalizedCorrelation: lagEstimate.normalizedCorrelation,
        physicalCouplingDetected,
        rawMicRms: roomReport.rawMicRms,
        residualRms: roomReport.residualRms,
        erleDb: roomReport.erleDb,
        noiseFloorRms: roomReport.noiseFloorRms,
        recommendedMinSnrDb: roomReport.recommendedMinSnrDb,
        recommendedMinResidualRms: roomReport.recommendedMinResidualRms,
        bargeInReady: roomReport.bargeInReady,
        notes: roomReport.notes,
      },
      sttWakeProbe: {
        directMatchesExpected: sttResults.filter((r) => r.directGateAccepted === r.expectedWake).length,
        micMatchesExpected: sttResults.filter((r) => r.micGateAccepted === r.expectedWake).length,
        totalPhrases: sttResults.length,
        results: sttResults,
      },
    };

    if (jsonOut) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Live PipeWire Devices: ${pw.serverName} | sink=${pw.defaultSink} | source=${pw.defaultSource}`);
      console.log(`Ambient Floor (${ambient.length} samples @ 16 kHz): RMS=${ambientRms} (${ambientDb} dBFS)`);
      console.log(
        `Physical Sweep (gain=${sweepGain}): lag=${payload.physicalSweep.deviceLagMs} ms, corr=${lagEstimate.normalizedCorrelation}, coupling=${physicalCouplingDetected}, rawMicRms=${roomReport.rawMicRms}, residualRms=${roomReport.residualRms}, ERLE=${roomReport.erleDb} dB, bargeInReady=${roomReport.bargeInReady}, minSnrDb=${roomReport.recommendedMinSnrDb}, minResRms=${roomReport.recommendedMinResidualRms}`,
      );
      if (!physicalCouplingDetected) {
        console.log(
          "  Note: Physical speaker-to-mic acoustic coupling was below threshold (monitors/headphone/mic gain likely isolated in analog stage); reported metrics reflect real room capture honestly.",
        );
      }
      console.log(
        `Kokoro-82M + moonshine-base-ONNX Wake Probe: direct=${payload.sttWakeProbe.directMatchesExpected}/${sttResults.length}, liveMic=${payload.sttWakeProbe.micMatchesExpected}/${sttResults.length}`,
      );
      for (const r of sttResults) {
        console.log(
          `  expected=${r.expectedWake} | direct="${r.directTranscript}" (${r.directGateAccepted}) | mic(rms=${r.micCapturedRms})="${r.micTranscript}" (${r.micGateAccepted}${r.micGateReason ? `:${r.micGateReason}` : ""})`,
        );
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
