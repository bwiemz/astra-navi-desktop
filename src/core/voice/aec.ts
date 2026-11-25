import { estimateSpokenOffset } from "./visemes.ts";
import { afterWakeName } from "../wakeName.ts";

/**
 * Full-Duplex Acoustic Echo Cancellation (AEC), Sub-150ms Barge-In, and Room Wake Gating
 * (Tier 10 §7.1).
 */

export const BARGE_IN_FRAME_MS = 32;
export const BARGE_IN_TRIGGER_MS = 120;
const SAFE_AUDIO_NODE = /^[A-Za-z0-9_.:-]+$/;

export interface PipeWireAecSpec {
  program: "pactl";
  args: string[];
}

export interface BargeInEvent {
  fullText: string;
  heardText: string;
  spokenWordOffset: number;
  elapsedMs: number;
  ratio: number;
}

/** Builds fixed-arg `pactl` arguments to load PipeWire's WebRTC AEC loopback module. */
export function buildPipeWireAecArgs(
  options: { captureTarget?: string; playbackTarget?: string; nodeName?: string } = {},
): PipeWireAecSpec {
  const nodeName =
    options.nodeName && SAFE_AUDIO_NODE.test(options.nodeName)
      ? options.nodeName
      : "aichan_aec";
  const args = [
    "load-module",
    "module-echo-cancel",
    "aec_method=webrtc",
    `source_name=${nodeName}_source`,
    `sink_name=${nodeName}_sink`,
  ];
  if (options.captureTarget && SAFE_AUDIO_NODE.test(options.captureTarget)) {
    args.push(`source_master=${options.captureTarget}`);
  }
  if (options.playbackTarget && SAFE_AUDIO_NODE.test(options.playbackTarget)) {
    args.push(`sink_master=${options.playbackTarget}`);
  }
  return { program: "pactl", args };
}

/** Computes root-mean-square energy of an audio sample buffer. */
export function computeRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s = frame[i] ?? 0;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / frame.length);
}

/** Echo Return Loss Enhancement in dB between microphone signal and post-AEC residual. */
export function computeErleDb(mic: Float32Array, residual: Float32Array): number {
  const len = Math.min(mic.length, residual.length);
  if (len === 0) return 0;
  let micSq = 0;
  let resSq = 0;
  for (let i = 0; i < len; i += 1) {
    const m = mic[i] ?? 0;
    const r = residual[i] ?? 0;
    micSq += m * m;
    resSq += r * r;
  }
  return 10 * Math.log10((micSq / len + 1e-12) / (resSq / len + 1e-12));
}

/**
 * Software Normalized Least-Mean-Squares (NLMS) adaptive FIR residual echo canceller.
 */
export class NlmsEchoCanceller {
  private readonly filterLength: number;
  private readonly stepSize: number;
  private readonly eps: number;
  private readonly weights: Float32Array;
  private readonly history: Float32Array;

  constructor(options: { filterLength?: number; stepSize?: number; eps?: number } = {}) {
    this.filterLength = Math.max(8, Math.trunc(options.filterLength ?? 64));
    this.stepSize = Math.max(0.01, Math.min(1.5, options.stepSize ?? 0.4));
    this.eps = options.eps ?? 1e-6;
    this.weights = new Float32Array(this.filterLength);
    this.history = new Float32Array(this.filterLength);
  }

  reset(): void {
    this.weights.fill(0);
    this.history.fill(0);
  }

  /** Subtracts correlated speaker reference echo from `micFrame` and adapts filter weights. */
  process(micFrame: Float32Array, refFrame: Float32Array): Float32Array {
    const out = new Float32Array(micFrame.length);
    const L = this.filterLength;
    for (let i = 0; i < micFrame.length; i += 1) {
      this.history.copyWithin(1, 0, L - 1);
      this.history[0] = refFrame[i] ?? 0;

      let predicted = 0;
      let norm = this.eps;
      for (let k = 0; k < L; k += 1) {
        const h = this.history[k] ?? 0;
        predicted += (this.weights[k] ?? 0) * h;
        norm += h * h;
      }

      const err = (micFrame[i] ?? 0) - predicted;
      out[i] = err;

      const gain = (this.stepSize * err) / norm;
      for (let k = 0; k < L; k += 1) {
        this.weights[k] = (this.weights[k] ?? 0) + gain * (this.history[k] ?? 0);
      }
    }
    return out;
  }
}

/**
 * Continuous voice barge-in detector: triggers playback interruption once residual human speech
 * persists >= 120ms (`<= 150ms` response target) and records exact spoken word offset heard.
 */
export class BargeInController {
  private readonly frameMs: number;
  private readonly triggerMs: number;
  private readonly speechThreshold: number;
  private readonly minResidualRms: number;
  private readonly onBargeIn?: (event: BargeInEvent) => void;
  private active: { text: string; durationMs: number; startedAtMs: number } | null = null;
  private consecutiveSpeechMs = 0;

  constructor(
    options: {
      frameMs?: number;
      triggerMs?: number;
      speechThreshold?: number;
      minResidualRms?: number;
      onBargeIn?: (event: BargeInEvent) => void;
    } = {},
  ) {
    this.frameMs = options.frameMs ?? BARGE_IN_FRAME_MS;
    this.triggerMs = options.triggerMs ?? BARGE_IN_TRIGGER_MS;
    this.speechThreshold = options.speechThreshold ?? 0.65;
    this.minResidualRms = options.minResidualRms ?? 0.015;
    this.onBargeIn = options.onBargeIn;
  }

  get speaking(): boolean {
    return this.active !== null;
  }

  beginSpeaking(text: string, durationMs: number, startedAtMs = Date.now()): void {
    this.active = { text, durationMs: Math.max(1, durationMs), startedAtMs };
    this.consecutiveSpeechMs = 0;
  }

  endSpeaking(): void {
    this.active = null;
    this.consecutiveSpeechMs = 0;
  }

  processFrame(frame: {
    speechProbability: number;
    residualRms: number;
    nowMs?: number;
  }): BargeInEvent | null {
    if (!this.active) return null;
    if (
      frame.speechProbability >= this.speechThreshold &&
      frame.residualRms >= this.minResidualRms
    ) {
      this.consecutiveSpeechMs += this.frameMs;
    } else {
      this.consecutiveSpeechMs = 0;
      return null;
    }

    if (this.consecutiveSpeechMs < this.triggerMs) return null;

    const current = this.active;
    this.endSpeaking();
    const elapsedMs = Math.max(0, (frame.nowMs ?? Date.now()) - current.startedAtMs);
    const offset = estimateSpokenOffset(current.text, elapsedMs, current.durationMs);
    const event: BargeInEvent = {
      fullText: current.text,
      heardText: offset.heardText,
      spokenWordOffset: offset.spokenWordOffset,
      elapsedMs,
      ratio: offset.ratio,
    };
    this.onBargeIn?.(event);
    return event;
  }
}

export interface WakeRoomGateInput {
  text: string;
  otherNames?: readonly string[];
  signalRms: number;
  noiseFloorRms: number;
  speakerCosine?: number;
  minSnrDb?: number;
  minSpeakerCosine?: number;
}

export interface WakeRoomGateResult {
  accepted: boolean;
  remainder: string | null;
  snrDb: number;
  reason?: string;
}

/**
 * Live-room wake-word gate combining noise-floor SNR check, optional speaker cosine verification,
 * and `afterWakeName()` matching so ambient media/game dialogue does not misfire.
 */
export function evaluateWakeRoomGate(input: WakeRoomGateInput): WakeRoomGateResult {
  const minSnrDb = input.minSnrDb ?? 6;
  const minSpeakerCosine = input.minSpeakerCosine ?? 0.72;
  const snrDb =
    20 *
    Math.log10(Math.max(input.signalRms, 1e-9) / Math.max(input.noiseFloorRms, 1e-9));

  if (snrDb < minSnrDb) {
    return {
      accepted: false,
      remainder: null,
      snrDb,
      reason: `Speech SNR (${snrDb.toFixed(1)} dB) is below minimum (${minSnrDb} dB).`,
    };
  }
  if (input.speakerCosine !== undefined && input.speakerCosine < minSpeakerCosine) {
    return {
      accepted: false,
      remainder: null,
      snrDb,
      reason: `Speaker cosine similarity (${input.speakerCosine.toFixed(2)}) is below threshold (${minSpeakerCosine}).`,
    };
  }
  const remainder = afterWakeName(input.text, input.otherNames ?? []);
  if (remainder === null) {
    return {
      accepted: false,
      remainder: null,
      snrDb,
      reason: "Transcript did not open with assistant wake name.",
    };
  }
  return { accepted: true, remainder, snrDb };
}

export interface WakeCalibrationSample {
  phrase: string;
  expectedWake: boolean;
  signalRms?: number;
  speakerCosine?: number;
}

export interface WakeCalibrationResult {
  phrase: string;
  expectedWake: boolean;
  accepted: boolean;
  passed: boolean;
  remainder: string | null;
  snrDb: number;
  reason?: string;
}

export type CouplingStatus = "coupled" | "isolated";
export type BargeInStatus = "ready_aec" | "ready_isolated" | "needs_aec";

export interface RoomCalibrationReport {
  sampleRate: number;
  samplesAnalyzed: number;
  rawMicRms: number;
  residualRms: number;
  erleDb: number;
  noiseFloorRms: number;
  recommendedMinSnrDb: number;
  recommendedMinResidualRms: number;
  pipewireAecCommand: string;
  couplingStatus: CouplingStatus;
  bargeInStatus: BargeInStatus;
  estimatedLagMs: number;
  peakCorrelation: number;
  bargeInReady: boolean;
  wakeChecks: WakeCalibrationResult[];
  wakePassRate: number;
  notes: string[];
}

export const DEFAULT_WAKE_CALIBRATION_SAMPLES: readonly WakeCalibrationSample[] = [
  { phrase: "Hey Astra, check my agenda", expectedWake: true },
  { phrase: "アストラナビ、今日の予定は？", expectedWake: true },
  { phrase: "星航，打开音乐", expectedWake: true },
  { phrase: "The TV news anchor said hello", expectedWake: false },
  { phrase: "Astra, pause the music", expectedWake: true },
];

/**
 * Generates a swept multi-band formant + chirp calibration probe for live-room AEC testing.
 * Keeps amplitude bounded inside `[-0.55, 0.55]` with 20ms raised-cosine fades to avoid speaker clipping.
 */
export function generateCalibrationTone(sampleRate = 16_000, durationSec = 1.2): Float32Array {
  const sr = Math.max(8_000, Math.min(48_000, Math.round(sampleRate)));
  const dur = Math.max(0.2, Math.min(5, durationSec));
  const length = Math.round(sr * dur);
  const out = new Float32Array(length);
  const fadeSamples = Math.min(Math.floor(length / 4), Math.round(sr * 0.02));
  const f0 = 180;
  const f1 = 1650;
  let chirpPhase = 0;

  for (let i = 0; i < length; i += 1) {
    const t = i / sr;
    const progress = length > 1 ? i / (length - 1) : 0;
    const instFreq = f0 * Math.pow(f1 / f0, progress);
    chirpPhase += (2 * Math.PI * instFreq) / sr;
    const voiceHarmonics =
      0.55 * Math.sin(chirpPhase) +
      0.28 * Math.sin(2 * Math.PI * 220 * t) +
      0.17 * Math.sin(2 * Math.PI * 520 * t);

    let env = 0.5;
    if (fadeSamples > 0 && i < fadeSamples) {
      env *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    } else if (fadeSamples > 0 && i >= length - fadeSamples) {
      env *= 0.5 * (1 - Math.cos((Math.PI * (length - 1 - i)) / fadeSamples));
    }
    out[i] = voiceHarmonics * env;
  }
  return out;
}

function estimateCoarseCausalLag(
  reference: Float32Array,
  recorded: Float32Array,
  sampleRate: number,
): { lagOffset: number; rawLagSamples: number; peakCorrelation: number } {
  const minOverlap = Math.min(reference.length, recorded.length, Math.max(512, Math.round(sampleRate * 0.25)));
  const maxLagByLen =
    recorded.length > reference.length
      ? Math.max(0, recorded.length - minOverlap)
      : Math.max(0, Math.min(reference.length, recorded.length) - 512);
  const maxLag = Math.min(maxLagByLen, Math.round(sampleRate * 0.42));
  if (maxLag <= 0 || computeRms(reference) < 1e-5) {
    return { lagOffset: 0, rawLagSamples: 0, peakCorrelation: 0 };
  }

  const stride = 4;
  let bestCoarseLag = 0;
  let bestScore = -1;
  for (let lag = 0; lag <= maxLag; lag += stride) {
    const overlapEnd = Math.min(reference.length, recorded.length - lag);
    if (overlapEnd < 256) continue;
    let dot = 0;
    let refEnergy = 0;
    let micEnergy = 0;
    for (let i = 0; i < overlapEnd; i += stride) {
      const r = reference[i] ?? 0;
      const m = recorded[i + lag] ?? 0;
      dot += r * m;
      refEnergy += r * r;
      micEnergy += m * m;
    }
    const score = Math.abs(dot) / (Math.sqrt(refEnergy * micEnergy) + 1e-9);
    if (score > bestScore) {
      bestScore = score;
      bestCoarseLag = lag;
    }
  }

  let bestLag = bestCoarseLag;
  let refinedBest = -1;
  const start = Math.max(0, bestCoarseLag - 16);
  const end = Math.min(maxLag, bestCoarseLag + 16);
  for (let lag = start; lag <= end; lag += 1) {
    const overlapEnd = Math.min(reference.length, recorded.length - lag);
    if (overlapEnd < 256) continue;
    let dot = 0;
    let refEnergy = 0;
    let micEnergy = 0;
    for (let i = 0; i < overlapEnd; i += 2) {
      const r = reference[i] ?? 0;
      const m = recorded[i + lag] ?? 0;
      dot += r * m;
      refEnergy += r * r;
      micEnergy += m * m;
    }
    const score = Math.abs(dot) / (Math.sqrt(refEnergy * micEnergy) + 1e-9);
    if (score > refinedBest) {
      refinedBest = score;
      bestLag = lag;
    }
  }

  const clampedCorr = Number(Math.max(0, Math.min(1, refinedBest)).toFixed(4));
  return {
    lagOffset: Math.max(0, bestLag - 8),
    rawLagSamples: bestLag,
    peakCorrelation: clampedCorr,
  };
}

/**
 * Runs software NLMS residual echo cancellation and multilingual wake-word gate validation
 * against recorded + reference room audio, returning recommended barge-in & SNR thresholds.
 */
export function evaluateRoomCalibration(input: {
  reference: Float32Array;
  recorded: Float32Array;
  sampleRate?: number;
  otherNames?: readonly string[];
  wakeSamples?: readonly WakeCalibrationSample[];
}): RoomCalibrationReport {
  const sampleRate = Math.max(8_000, Math.min(48_000, Math.round(input.sampleRate ?? 16_000)));
  const { lagOffset, rawLagSamples, peakCorrelation } = estimateCoarseCausalLag(
    input.reference,
    input.recorded,
    sampleRate,
  );

  let mic: Float32Array;
  let alignedRef: Float32Array;
  let activeStart = 0;

  if (input.recorded.length > input.reference.length && lagOffset > 0) {
    const overlapLen = Math.min(input.reference.length, input.recorded.length - lagOffset);
    mic = input.recorded.subarray(lagOffset, lagOffset + overlapLen);
    alignedRef = input.reference.subarray(0, overlapLen);
  } else {
    const len = Math.min(input.reference.length, input.recorded.length);
    mic = input.recorded.subarray(0, len);
    const ref = input.reference.subarray(0, len);
    alignedRef = new Float32Array(len);
    for (let i = lagOffset; i < len; i += 1) {
      alignedRef[i] = ref[i - lagOffset] ?? 0;
    }
    activeStart = lagOffset;
  }

  const len = mic.length;
  const aec = new NlmsEchoCanceller({ filterLength: 128, stepSize: 0.45 });
  const residual = new Float32Array(len);
  const frameSize = 512;
  for (let offset = 0; offset < len; offset += frameSize) {
    const end = Math.min(len, offset + frameSize);
    const out = aec.process(mic.subarray(offset, end), alignedRef.subarray(offset, end));
    residual.set(out, offset);
  }

  const activeLen = Math.max(0, len - activeStart);
  const settleStart = Math.min(Math.max(0, len - 1), activeStart + Math.floor(activeLen * 0.35));
  const micEval = len > 64 ? mic.subarray(settleStart) : mic;
  const resEval = len > 64 ? residual.subarray(settleStart) : residual;
  const rawMicRms = Number(computeRms(micEval).toFixed(5));
  const residualRms = Number(computeRms(resEval).toFixed(5));
  const erleDb = Number(computeErleDb(micEval, resEval).toFixed(2));
  const estimatedLagMs = Number(((rawLagSamples / sampleRate) * 1000).toFixed(1));

  const couplingStatus: CouplingStatus =
    len > 0 && rawMicRms <= 0.008 && peakCorrelation < 0.15 ? "isolated" : "coupled";

  const frameRmsList: number[] = [];
  for (let offset = 0; offset < residual.length; offset += frameSize) {
    const slice = residual.subarray(offset, Math.min(residual.length, offset + frameSize));
    if (slice.length > 0) frameRmsList.push(computeRms(slice));
  }
  frameRmsList.sort((a, b) => a - b);
  const p15 = frameRmsList[Math.floor(frameRmsList.length * 0.15)] ?? residualRms;
  const noiseFloorRms = Number(Math.max(1e-4, p15).toFixed(5));

  const baseSnr =
    couplingStatus === "isolated" ? 8 : erleDb >= 12 ? 7 : erleDb >= 8 ? 9 : 12;
  const noisyPenalty = noiseFloorRms >= 0.03 ? 2 : 0;
  const recommendedMinSnrDb = Math.max(6, Math.min(18, baseSnr + noisyPenalty));
  const recommendedMinResidualRms = Number(
    Math.max(0.01, Math.min(0.08, residualRms * 1.6 + 0.008)).toFixed(4),
  );
  const bargeInStatus: BargeInStatus =
    len === 0
      ? "needs_aec"
      : couplingStatus === "isolated"
        ? "ready_isolated"
        : erleDb >= 6
          ? "ready_aec"
          : "needs_aec";
  const bargeInReady = bargeInStatus !== "needs_aec";
  const pipewireAec = buildPipeWireAecArgs();
  const pipewireAecCommand = `${pipewireAec.program} ${pipewireAec.args.join(" ")}`;

  const wakeInput =
    input.wakeSamples && input.wakeSamples.length > 0
      ? input.wakeSamples
      : DEFAULT_WAKE_CALIBRATION_SAMPLES;
  const defaultSignalRms = Math.min(0.9, Math.max(0.08, noiseFloorRms * 4.5));
  const wakeChecks: WakeCalibrationResult[] = wakeInput.map((sample) => {
    const res = evaluateWakeRoomGate({
      text: sample.phrase,
      otherNames: input.otherNames ?? [],
      signalRms: sample.signalRms ?? defaultSignalRms,
      noiseFloorRms,
      speakerCosine: sample.speakerCosine,
      minSnrDb: recommendedMinSnrDb,
    });
    return {
      phrase: sample.phrase,
      expectedWake: sample.expectedWake,
      accepted: res.accepted,
      passed: res.accepted === sample.expectedWake,
      remainder: res.remainder,
      snrDb: Number(res.snrDb.toFixed(2)),
      ...(res.reason ? { reason: res.reason } : {}),
    };
  });

  const passedCount = wakeChecks.filter((w) => w.passed).length;
  const wakePassRate =
    wakeChecks.length > 0 ? Number((passedCount / wakeChecks.length).toFixed(4)) : 1;

  const notes: string[] = [];
  if (len === 0) {
    notes.push("No audio samples provided; run live speaker/mic probe or synthetic self-test.");
  } else if (bargeInStatus === "ready_isolated") {
    notes.push(
      `No Speaker Coupling / Headphones Detected (Barge-In Safe): negligible speaker bleed (RMS ${rawMicRms.toFixed(5)}, corr ${peakCorrelation.toFixed(3)}); no echo cancellation required.`,
    );
  } else if (erleDb >= 12) {
    notes.push(
      `Strong echo suppression (${erleDb.toFixed(1)} dB ERLE, aligned lag ${estimatedLagMs.toFixed(1)} ms); full-duplex barge-in ready.`,
    );
  } else if (erleDb >= 6) {
    notes.push(
      `Moderate echo suppression (${erleDb.toFixed(1)} dB ERLE, lag ${estimatedLagMs.toFixed(1)} ms); barge-in usable, consider lowering speaker volume or loading PipeWire WebRTC AEC.`,
    );
  } else {
    notes.push(
      `Low ERLE (${erleDb.toFixed(1)} dB at lag ${estimatedLagMs.toFixed(1)} ms); load PipeWire module-echo-cancel before unattended hands-free barge-in.`,
    );
  }
  if (passedCount < wakeChecks.length) {
    notes.push(
      `${wakeChecks.length - passedCount} wake calibration check(s) did not match expectation; inspect room SNR or wake aliases.`,
    );
  }

  return {
    sampleRate,
    samplesAnalyzed: len,
    rawMicRms,
    residualRms,
    erleDb,
    noiseFloorRms,
    recommendedMinSnrDb,
    recommendedMinResidualRms,
    pipewireAecCommand,
    couplingStatus,
    bargeInStatus,
    estimatedLagMs,
    peakCorrelation,
    bargeInReady,
    wakeChecks,
    wakePassRate,
    notes,
  };
}
