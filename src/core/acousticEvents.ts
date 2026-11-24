import { existsSync } from "node:fs";

/**
 * Local Acoustic Environment & Sound-Event Classifier (`experimental`).
 *
 * Runs either an optional local ONNX audio event classifier (`onnxruntime-node`, CPU)
 * or a zero-dependency spectral/temporal acoustic classifier strictly over in-memory
 * `ShipEars` PCM buffers (zero disk writes).
 *
 * Classifies:
 * - `silence`
 * - `voice_call` (speech cadence on Discord / Zoom / Teams -> stay quiet!)
 * - `match_found` (short harmonic chime / queue-pop transient -> ping phone!)
 * - `music` (broad steady spectral density)
 * - `alarm` (sustained high-pitch periodic tone)
 */

export type AcousticEventLabel = "silence" | "voice_call" | "match_found" | "music" | "alarm";

export interface AcousticClassification {
  label: AcousticEventLabel;
  confidence: number;
  rms: number;
  dominantHz: number;
  backend: "onnx" | "spectral-heuristic";
}

export interface AcousticReaction {
  staySilent: boolean;
  pingPhone: boolean;
  reason: string;
}

interface OrtSessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>;
  release?: () => Promise<void>;
}

const LABELS: readonly AcousticEventLabel[] = [
  "silence",
  "voice_call",
  "match_found",
  "music",
  "alarm",
];

function estimateDominantFreqAndPeriodicity(
  samples: Float32Array,
  sampleRate: number,
): { dominantHz: number; tonality: number; zcr: number } {
  if (samples.length < 128 || sampleRate <= 0) {
    return { dominantHz: 0, tonality: 0, zcr: 0 };
  }
  const win = samples.subarray(0, Math.min(samples.length, Math.round(sampleRate * 0.5)));
  let zeroCrossings = 0;
  let power = 0;
  for (let i = 0; i < win.length; i += 1) {
    const s = win[i] ?? 0;
    power += s * s;
    if (i > 0) {
      const prev = win[i - 1] ?? 0;
      if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) zeroCrossings += 1;
    }
  }
  if (power <= 1e-8) return { dominantHz: 0, tonality: 0, zcr: 0 };

  const minLag = Math.max(4, Math.floor(sampleRate / 2800));
  const maxLag = Math.min(win.length - 2, Math.floor(sampleRate / 70));
  const corrs = new Float32Array(maxLag + 1);
  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    const limit = win.length - lag;
    for (let i = 0; i < limit; i += 1) {
      dot += (win[i] ?? 0) * (win[i + lag] ?? 0);
    }
    const corr = dot / power;
    corrs[lag] = corr;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  // Prefer the smallest lag (highest fundamental frequency) among strong local peaks to avoid subharmonics.
  const threshold = bestCorr * 0.92;
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    const c = corrs[lag] ?? 0;
    if (c >= threshold && c >= (corrs[lag - 1] ?? 0) && c >= (corrs[lag + 1] ?? 0)) {
      bestLag = lag;
      break;
    }
  }
  return {
    dominantHz: bestLag > 0 ? sampleRate / bestLag : 0,
    tonality: Math.max(0, Math.min(1, bestCorr)),
    zcr: zeroCrossings / win.length,
  };
}

export class AcousticEventClassifier {
  private readonly modelPath: string | null;
  private session: OrtSessionLike | null = null;
  private tensorCtor: (new (type: string, data: Float32Array, dims: number[]) => unknown) | null =
    null;

  constructor(options: { modelPath?: string } = {}) {
    this.modelPath = options.modelPath ?? null;
  }

  async warm(): Promise<boolean> {
    if (!this.modelPath || !existsSync(this.modelPath)) return false;
    try {
      const ort = (await import(/* @vite-ignore */ "onnxruntime-node")) as unknown as {
        InferenceSession: { create(path: string, opts?: unknown): Promise<OrtSessionLike> };
        Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
      };
      this.tensorCtor = ort.Tensor;
      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ["cpu"],
      });
      return true;
    } catch {
      this.session = null;
      return false;
    }
  }

  async classify(samples: Float32Array, sampleRate = 16_000): Promise<AcousticClassification> {
    let sq = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i] ?? 0;
      sq += s * s;
    }
    const rms = samples.length > 0 ? Math.sqrt(sq / samples.length) : 0;

    if (rms < 0.004 || samples.length < 256) {
      return {
        label: "silence",
        confidence: 0.96,
        rms: Number(rms.toFixed(4)),
        dominantHz: 0,
        backend: "spectral-heuristic",
      };
    }

    if (this.session && this.tensorCtor) {
      const fixedLen = Math.min(samples.length, sampleRate);
      const frame = new Float32Array(sampleRate);
      frame.set(samples.subarray(0, fixedLen));
      const inputName = this.session.inputNames[0] ?? "waveform";
      const outName = this.session.outputNames[0] ?? "logits";
      const tensor = new this.tensorCtor("float32", frame, [1, sampleRate]);
      const outputs = await this.session.run({ [inputName]: tensor });
      const rawScores = outputs[outName]?.data;
      frame.fill(0);
      if (rawScores && rawScores.length >= LABELS.length) {
        let bestIdx = 0;
        let bestVal = -Infinity;
        for (let i = 0; i < LABELS.length; i += 1) {
          const val = Number(rawScores[i]) || 0;
          if (val > bestVal) {
            bestVal = val;
            bestIdx = i;
          }
        }
        return {
          label: LABELS[bestIdx] ?? "music",
          confidence: Number(Math.max(0.5, Math.min(0.99, bestVal)).toFixed(3)),
          rms: Number(rms.toFixed(4)),
          dominantHz: 0,
          backend: "onnx",
        };
      }
    }

    // Zero-dependency spectral/temporal fallback in RAM
    const { dominantHz, tonality, zcr } = estimateDominantFreqAndPeriodicity(samples, sampleRate);
    const frameLen = Math.max(128, Math.round(sampleRate * 0.04));
    const energies: number[] = [];
    for (let off = 0; off + frameLen <= samples.length; off += frameLen) {
      let ssq = 0;
      for (let i = off; i < off + frameLen; i += 1) {
        const v = samples[i] ?? 0;
        ssq += v * v;
      }
      energies.push(Math.sqrt(ssq / frameLen));
    }
    const loudFrames = energies.filter((e) => e >= 0.025).length;
    const silentFrames = energies.filter((e) => e < 0.012).length;
    const dutyCycle = energies.length > 0 ? loudFrames / energies.length : 1;

    // Sharp transient / match chime: high tonality chime above 650Hz with low duty cycle
    if (tonality >= 0.65 && dominantHz >= 650 && dutyCycle <= 0.45 && energies.length >= 4) {
      return {
        label: "match_found",
        confidence: 0.84,
        rms: Number(rms.toFixed(4)),
        dominantHz: Math.round(dominantHz),
        backend: "spectral-heuristic",
      };
    }

    // Sustained pure high-frequency alarm (> 800Hz, high duty cycle, strong periodicity)
    if (tonality >= 0.72 && dominantHz >= 800 && dutyCycle > 0.55) {
      return {
        label: "alarm",
        confidence: 0.88,
        rms: Number(rms.toFixed(4)),
        dominantHz: Math.round(dominantHz),
        backend: "spectral-heuristic",
      };
    }

    // Conversational call: alternating speech & gaps (silentFrames >= 20%) + speech fundamental range
    if (
      silentFrames >= Math.max(1, Math.floor(energies.length * 0.2)) &&
      ((dominantHz >= 85 && dominantHz <= 350) || (zcr >= 0.03 && zcr <= 0.25))
    ) {
      return {
        label: "voice_call",
        confidence: 0.8,
        rms: Number(rms.toFixed(4)),
        dominantHz: Math.round(dominantHz),
        backend: "spectral-heuristic",
      };
    }

    return {
      label: "music",
      confidence: 0.74,
      rms: Number(rms.toFixed(4)),
      dominantHz: Math.round(dominantHz),
      backend: "spectral-heuristic",
    };
  }

  async dispose(): Promise<void> {
    await this.session?.release?.();
    this.session = null;
  }
}

/** Translates an acoustic environment classification into quiet/notification policy actions. */
export function decideAcousticReaction(result: AcousticClassification): AcousticReaction {
  switch (result.label) {
    case "voice_call":
      return {
        staySilent: true,
        pingPhone: false,
        reason: "Active voice/video call detected on PC audio; holding non-urgent speech.",
      };
    case "match_found":
      return {
        staySilent: false,
        pingPhone: true,
        reason: "Queue/match-found audio chime detected; alerting mobile companion.",
      };
    case "alarm":
      return {
        staySilent: false,
        pingPhone: true,
        reason: "Sustained high-pitch system alarm detected; escalating to phone.",
      };
    case "music":
      return {
        staySilent: false,
        pingPhone: false,
        reason: "Continuous music playback detected.",
      };
    case "silence":
    default:
      return {
        staySilent: false,
        pingPhone: false,
        reason: "PC audio quiet.",
      };
  }
}
