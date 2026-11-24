import type { ExpressiveCueFrame } from "../../shared/visemes.ts";

/**
 * Audio-Driven Expressive Cue Extractor (zero Python, zero external deps).
 *
 * Extracts hop-aligned RMS loudness envelopes, autocorrelation fundamental frequency (F0),
 * emphasis spikes, breath/clause pauses, and periodic laughter bursts so vocal delivery
 * drives eyebrow raises, head tilts, rhythmic nods, and posture energy in real time.
 */

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function estimateAutocorrelationF0(frame: Float32Array, sampleRate: number, rms: number): number {
  if (rms < 0.015 || frame.length < 32 || sampleRate < 4000) return 0;
  const minLag = Math.max(2, Math.floor(sampleRate / 420));
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / 85));
  if (maxLag <= minLag) return 0;

  let zeroLag = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const x = frame[i] ?? 0;
    zeroLag += x * x;
  }
  if (zeroLag <= 1e-8) return 0;

  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    const limit = frame.length - lag;
    for (let i = 0; i < limit; i += 1) {
      dot += (frame[i] ?? 0) * (frame[i + lag] ?? 0);
    }
    const corr = dot / zeroLag;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || bestCorr < 0.35) return 0;
  return sampleRate / bestLag;
}

export function extractExpressiveCues(
  samples: Float32Array,
  sampleRate: number,
  hopMs = 20,
): ExpressiveCueFrame[] {
  if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return [];
  }
  const safeHopMs = Math.max(10, Math.min(100, Math.round(hopMs)));
  const hopSamples = Math.max(64, Math.round((sampleRate * safeHopMs) / 1000));
  const winSamples = Math.max(hopSamples, Math.round((sampleRate * safeHopMs * 2) / 1000));

  const rawRms: number[] = [];
  const rawPitch: number[] = [];
  const times: number[] = [];

  for (let offset = 0; offset < samples.length; offset += hopSamples) {
    const end = Math.min(samples.length, offset + winSamples);
    const frame = samples.subarray(offset, end);
    let sq = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const s = frame[i] ?? 0;
      sq += s * s;
    }
    const rms = Math.sqrt(sq / Math.max(1, frame.length));
    const f0 = estimateAutocorrelationF0(frame, sampleRate, rms);
    rawRms.push(rms);
    rawPitch.push(f0);
    times.push((offset / sampleRate) * 1000);
  }

  // Rolling baseline for vocal energy & pitch normalization
  const activeRms = rawRms.filter((r) => r >= 0.012);
  const meanRms =
    activeRms.length > 0
      ? activeRms.reduce((sum, r) => sum + r, 0) / activeRms.length
      : 0.05;
  const activePitches = rawPitch.filter((p) => p > 0);
  const meanPitch =
    activePitches.length > 0
      ? activePitches.reduce((sum, p) => sum + p, 0) / activePitches.length
      : 190;

  const frames: ExpressiveCueFrame[] = [];
  let laughPhaseEnv = 0;

  for (let i = 0; i < rawRms.length; i += 1) {
    const rms = rawRms[i] ?? 0;
    const f0 = rawPitch[i] ?? 0;
    const pause = rms < Math.max(0.008, meanRms * 0.22);

    const pitchNorm = f0 > 0 ? clamp((f0 - 85) / (420 - 85), 0, 1) : 0;
    const pitchLift = f0 > 0 ? clamp((f0 - meanPitch) / Math.max(35, meanPitch * 0.35), 0, 1) : 0;
    const energyLift = clamp((rms - meanRms) / Math.max(0.025, meanRms * 0.8), 0, 1);
    const emphasis = pause ? 0 : clamp(energyLift * 0.65 + pitchLift * 0.35, 0, 1);

    // Laughter bursts exhibit 3-6 Hz voiced/unvoiced energy oscillation over consecutive hops (~150-330 ms cycle).
    let oscillationCount = 0;
    const lookback = Math.min(i, Math.max(4, Math.round(320 / safeHopMs)));
    if (lookback >= 4) {
      let prevSign = 0;
      for (let k = i - lookback + 1; k <= i; k += 1) {
        const diff = (rawRms[k] ?? 0) - (rawRms[k - 1] ?? 0);
        const sign = Math.abs(diff) > meanRms * 0.2 ? Math.sign(diff) : 0;
        if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
          oscillationCount += 1;
        }
        if (sign !== 0) prevSign = sign;
      }
    }
    const rawLaugh = oscillationCount >= 3 && rms >= meanRms * 0.45 ? clamp((oscillationCount - 2) / 4, 0, 1) : 0;
    laughPhaseEnv = laughPhaseEnv * 0.55 + rawLaugh * 0.45;
    const laugh = Number(clamp(laughPhaseEnv, 0, 1).toFixed(3));

    const eyebrowRaise = Number(clamp(emphasis * 0.72 + pitchLift * 0.38, 0, 1).toFixed(3));
    const tiltDirection = i > 0 && f0 > (rawPitch[i - 1] ?? f0) ? 1 : -1;
    const headTiltDeg = Number(
      clamp((pause ? 2.5 : tiltDirection * (emphasis * 6.5 + pitchLift * 4)), -12, 12).toFixed(2),
    );
    const nodDrive = Number(clamp(emphasis * 0.85 + laugh * 0.35, 0, 1).toFixed(3));
    const postureEnergy = Number(
      clamp(pause ? 0.78 : 0.9 + emphasis * 0.45 + laugh * 0.2, 0.7, 1.55).toFixed(3),
    );

    frames.push({
      timeMs: times[i] ?? i * safeHopMs,
      durationMs: safeHopMs,
      rmsEnergy: Number(rms.toFixed(4)),
      pitchHz: Number(f0.toFixed(1)),
      pitchNorm: Number(pitchNorm.toFixed(3)),
      emphasis: Number(emphasis.toFixed(3)),
      pause,
      laugh,
      eyebrowRaise,
      headTiltDeg,
      nodDrive,
      postureEnergy,
    });
  }

  return frames;
}
