import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  packSignedCharacterBundle,
  type CharacterBundleManifest,
} from "./characterBundle.ts";
import { scrubSecretsForSync } from "./peerSync.ts";

/**
 * Opt-In 10-Second Voice Cloning Studio (`experimental`).
 *
 * Inspects a user-provided 4–15s reference audio sample for duration, noise floor,
 * clipping ratio, and SNR, encodes clean mono 16-bit PCM WAV, and packages the
 * verified reference directly inside a signed `.bundle` character archive.
 */

export interface VoiceReferenceQualityReport {
  ok: boolean;
  durationSec: number;
  rmsDbFs: number;
  noiseFloorDbFs: number;
  snrDb: number;
  clippingRatio: number;
  issues: string[];
}

function toDb(linear: number): number {
  return 20 * Math.log10(Math.max(1e-6, linear));
}

export function analyzeVoiceReferenceClip(
  samples: Float32Array,
  sampleRate: number,
): VoiceReferenceQualityReport {
  const issues: string[] = [];
  if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    return {
      ok: false,
      durationSec: 0,
      rmsDbFs: -96,
      noiseFloorDbFs: -96,
      snrDb: 0,
      clippingRatio: 0,
      issues: ["Empty or invalid sample rate (expected 8–192 kHz PCM audio)."],
    };
  }

  const durationSec = samples.length / sampleRate;
  if (durationSec < 4) issues.push(`Clip too short (${durationSec.toFixed(1)}s < 4.0s minimum).`);
  if (durationSec > 16) issues.push(`Clip too long (${durationSec.toFixed(1)}s > 16.0s maximum).`);

  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (s === undefined || !Number.isFinite(s)) {
      return {
        ok: false,
        durationSec,
        rmsDbFs: -96,
        noiseFloorDbFs: -96,
        snrDb: 0,
        clippingRatio: 0,
        issues: ["Non-finite PCM sample detected (NaN/Infinity)."],
      };
    }
    sumSq += s * s;
    if (Math.abs(s) >= 0.985) clipped += 1;
  }
  const overallRms = Math.sqrt(sumSq / samples.length);
  const clippingRatio = clipped / samples.length;

  // Compute block RMS values (50ms blocks) to estimate noise floor (15th percentile) vs speech (85th)
  const blockSamples = Math.max(64, Math.round(sampleRate * 0.05));
  const blockRms: number[] = [];
  for (let off = 0; off + blockSamples <= samples.length; off += blockSamples) {
    let bSq = 0;
    for (let i = off; i < off + blockSamples; i += 1) {
      const v = samples[i] ?? 0;
      bSq += v * v;
    }
    blockRms.push(Math.sqrt(bSq / blockSamples));
  }
  blockRms.sort((a, b) => a - b);
  const noiseFloor = blockRms[Math.floor(blockRms.length * 0.15)] ?? overallRms;
  const activeLevel = blockRms[Math.floor(blockRms.length * 0.85)] ?? overallRms;
  const snrDb = toDb(activeLevel) - toDb(noiseFloor);

  if (clippingRatio > 0.01) {
    issues.push(`Audio clipping detected (${(clippingRatio * 100).toFixed(2)}% >= 1.0% peak limit).`);
  }
  if (overallRms < 0.008) {
    issues.push("Recording level too quiet; speak closer to the microphone.");
  }
  if (snrDb < 12) {
    issues.push(`Background noise floor too high (SNR ${snrDb.toFixed(1)} dB < 12 dB minimum).`);
  }

  return {
    ok: issues.length === 0,
    durationSec: Number(durationSec.toFixed(2)),
    rmsDbFs: Number(toDb(overallRms).toFixed(1)),
    noiseFloorDbFs: Number(toDb(noiseFloor).toFixed(1)),
    snrDb: Number(snrDb.toFixed(1)),
    clippingRatio: Number(clippingRatio.toFixed(4)),
    issues,
  };
}

/** Encodes normalized `[-1, 1]` mono Float32Array samples into a standard RIFF 16-bit PCM WAV buffer. */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM subchunk size
  buf.writeUInt16LE(1, 20); // PCM linear
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(Math.round(sampleRate), 24);
  buf.writeUInt32LE(Math.round(sampleRate) * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** Validates a reference clip, saves `voice-ref.wav` into `bundleDir`, and packs a `.bundle`. */
export async function packageClonedVoiceArchive(options: {
  samples: Float32Array;
  sampleRate: number;
  transcript: string;
  bundleDir: string;
  manifest: CharacterBundleManifest;
  outBundleFile: string;
  privateKeyPem?: string;
  consentConfirmed?: boolean;
}): Promise<{
  quality: VoiceReferenceQualityReport;
  packed: { files: number; bytes: number };
}> {
  if (options.consentConfirmed === false) {
    throw new Error("Explicit speaker consent is required for voice cloning.");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.manifest.id)) {
    throw new Error(`Unsafe character manifest id "${options.manifest.id}".`);
  }
  const quality = analyzeVoiceReferenceClip(options.samples, options.sampleRate);
  if (!quality.ok) {
    throw new Error(`Voice reference failed quality gate: ${quality.issues.join("; ")}`);
  }
  await mkdir(options.bundleDir, { recursive: true, mode: 0o700 });
  const wavRel = "voice-ref.wav";
  const txtRel = "voice-ref.txt";
  await writeFile(join(options.bundleDir, wavRel), encodePcm16Wav(options.samples, options.sampleRate));
  await writeFile(join(options.bundleDir, txtRel), scrubSecretsForSync(options.transcript).trim().slice(0, 2000), "utf8");

  const nextManifest: CharacterBundleManifest = {
    ...options.manifest,
    voice: {
      engine: options.manifest.voice?.engine ?? "full",
      design: options.manifest.voice?.design ?? options.manifest.id,
      ...(options.manifest.voice?.speed !== undefined ? { speed: options.manifest.voice.speed } : {}),
      ...(options.manifest.voice?.checkpointEntry
        ? { checkpointEntry: options.manifest.voice.checkpointEntry }
        : {}),
      speakerRefEntry: wavRel,
    },
  };
  await writeFile(
    join(options.bundleDir, "manifest.json"),
    JSON.stringify(nextManifest, null, 2),
    "utf8",
  );

  const packed = await packSignedCharacterBundle(options.bundleDir, options.outBundleFile, {
    ...(options.privateKeyPem ? { privateKeyPem: options.privateKeyPem } : {}),
  });
  return { quality, packed };
}
