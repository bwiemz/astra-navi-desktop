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
