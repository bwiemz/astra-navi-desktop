import type { Mood } from "../shared/ipc.ts";
import { computeRms } from "./voice/aec.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Native End-to-End Speech-to-Speech & Streaming Video-Buffer Awareness
 * (ai_chan_plan.pdf p. 16).
 */

export interface PostureHint {
  /** Forward lean in [-1, 1]; positive leans forward attentively/urgently, negative leans back/relaxed. */
  leanForward: number;
  /** Head tilt in degrees in [-12, 12]; positive tilts curiously/hesitantly. */
  headTiltDeg: number;
  /** Breathing/motion energy multiplier in [0.6, 1.6]. */
  energyScale: number;
}

export interface ParalinguisticCue {
  mood: Mood;
  urgency: "low" | "normal" | "high";
  rmsEnergy: number;
  speakingRate: number;
  hesitationRatio: number;
  pitchTrend: "rising" | "falling" | "steady";
  posture: PostureHint;
}

export interface SpeechToSpeechOutput {
  transcript: string;
  replyText: string;
  audioOut?: Float32Array;
  sampleRate?: number;
}

export interface SpeechToSpeechTransport {
  readonly name: string;
  /** Must remain unset (in-process) or a private LAN/loopback host. */
  readonly endpointHost?: string;
  processTurn(pcm16k: Float32Array, cue: ParalinguisticCue): Promise<SpeechToSpeechOutput>;
}

export interface SpeechToSpeechTurnResult extends SpeechToSpeechOutput {
  cue: ParalinguisticCue;
  latencyMs: number;
}

function zeroCrossingsRate(samples: Float32Array): number {
  if (samples.length <= 1) return 0;
  let zeroCrossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1] ?? 0;
    const curr = samples[i] ?? 0;
    if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) {
      zeroCrossings += 1;
    }
  }
  return Math.min(1, zeroCrossings / samples.length);
}

/** Extracts acoustic energy, hesitation pauses, pitch trend, and posture cues from 16 kHz PCM speech. */
export function inferParalinguisticCue(pcm16k: Float32Array): ParalinguisticCue {
  const rmsEnergy = computeRms(pcm16k);
  if (pcm16k.length === 0) {
    return {
      mood: "neutral",
      urgency: "low",
      rmsEnergy: 0,
      speakingRate: 0,
      hesitationRatio: 0,
      pitchTrend: "steady",
      posture: { leanForward: 0, headTiltDeg: 0, energyScale: 1 },
    };
  }
  const speakingRate = zeroCrossingsRate(pcm16k);
  const frameLen = 512; // 32 ms at 16 kHz
  const voicedFlags: boolean[] = [];
  const voicedZcrs: number[] = [];
  for (let offset = 0; offset + frameLen <= pcm16k.length; offset += frameLen) {
    const frame = pcm16k.subarray(offset, offset + frameLen);
    const voiced = computeRms(frame) >= 0.015;
    voicedFlags.push(voiced);
    if (voiced) voicedZcrs.push(zeroCrossingsRate(frame));
  }
  const firstVoiced = voicedFlags.indexOf(true);
  const lastVoiced = voicedFlags.lastIndexOf(true);
  let hesitationRatio = 0;
  if (firstVoiced !== -1 && lastVoiced > firstVoiced) {
    let pauses = 0;
    for (let i = firstVoiced; i <= lastVoiced; i += 1) {
      if (!voicedFlags[i]) pauses += 1;
    }
    hesitationRatio = Number((pauses / (lastVoiced - firstVoiced + 1)).toFixed(3));
  }

  let pitchTrend: ParalinguisticCue["pitchTrend"] = "steady";
  if (voicedZcrs.length >= 3) {
    const sliceLen = Math.max(1, Math.floor(voicedZcrs.length / 3));
    const firstAvg =
      voicedZcrs.slice(0, sliceLen).reduce((sum, v) => sum + v, 0) / sliceLen;
    const lastAvg =
      voicedZcrs.slice(-sliceLen).reduce((sum, v) => sum + v, 0) / sliceLen;
    const delta = lastAvg - firstAvg;
    if (delta > 0.03) pitchTrend = "rising";
    else if (delta < -0.03) pitchTrend = "falling";
  }

  if (rmsEnergy >= 0.15) {
    const mood: Mood = speakingRate >= 0.2 ? "excited" : "worried";
    return {
      mood,
      urgency: "high",
      rmsEnergy,
      speakingRate,
      hesitationRatio,
      pitchTrend,
      posture: {
        leanForward: 0.65,
        headTiltDeg: mood === "worried" ? 5 : 0,
        energyScale: 1.35,
      },
    };
  }
  if (hesitationRatio >= 0.35 && rmsEnergy >= 0.02) {
    return {
      mood: pitchTrend === "rising" ? "worried" : "thinking",
      urgency: pitchTrend === "rising" ? "normal" : "low",
      rmsEnergy,
      speakingRate,
      hesitationRatio,
      pitchTrend,
      posture: { leanForward: 0.25, headTiltDeg: 8, energyScale: 0.95 },
    };
  }
  if (rmsEnergy >= 0.04) {
    return {
      mood: pitchTrend === "rising" ? "thinking" : "neutral",
      urgency: "normal",
      rmsEnergy,
      speakingRate,
      hesitationRatio,
      pitchTrend,
      posture: {
        leanForward: 0.2,
        headTiltDeg: pitchTrend === "rising" ? 4 : 0,
        energyScale: 1,
      },
    };
  }
  return {
    mood: "neutral",
    urgency: "low",
    rmsEnergy,
    speakingRate,
    hesitationRatio,
    pitchTrend,
    posture: { leanForward: -0.15, headTiltDeg: 0, energyScale: 0.8 },
  };
}

export class LocalSpeechToSpeechSession {
  enabled: boolean;
  private readonly transport: SpeechToSpeechTransport;
  private readonly onMood?: (mood: Mood) => void;
  private readonly onCue?: (cue: ParalinguisticCue) => void;

  constructor(options: {
    enabled?: boolean;
    transport: SpeechToSpeechTransport;
    onMood?: (mood: Mood) => void;
    onCue?: (cue: ParalinguisticCue) => void;
  }) {
    this.enabled = options.enabled ?? false;
    if (options.transport.endpointHost && !isPrivateLanHost(options.transport.endpointHost)) {
      throw new Error(
        `Refused non-local speech-to-speech transport endpoint "${options.transport.endpointHost}".`,
      );
    }
    this.transport = options.transport;
    this.onMood = options.onMood;
    this.onCue = options.onCue;
  }

  async handleTurn(pcm16k: Float32Array): Promise<SpeechToSpeechTurnResult> {
    if (!this.enabled) {
      throw new Error("Native speech-to-speech is disabled in Tier 10 settings.");
    }
    const started = performance.now();
    const cue = inferParalinguisticCue(pcm16k);
    this.onMood?.(cue.mood);
    this.onCue?.(cue);
    const out = await this.transport.processTurn(pcm16k, cue);
    return {
      ...out,
      cue,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}

export interface VideoFrameInput {
  atMs: number;
  width: number;
  height: number;
  luma: Uint8Array;
  app: string;
  title: string;
  isPrivate?: boolean;
}

export interface VideoPushResult {
  buffered: boolean;
  droppedPrivate: boolean;
  changed: boolean;
  changeScore: number;
}

/** Normalized Mean Absolute Difference in [0, 1] between two grayscale frames. */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / (a.length * 255);
}

/**
 * In-memory bounded rolling frame ring buffer with scene-change detection.
 * Private/incognito/password-manager frames are dropped unconditionally and never buffered.
 */
export class VideoBufferWatch {
  private readonly maxFrames: number;
  private readonly changeThreshold: number;
  private readonly onSignificantChange?: (event: {
    frame: VideoFrameInput;
    changeScore: number;
  }) => void;
  private readonly buffer: VideoFrameInput[] = [];

  constructor(
    options: {
      maxFrames?: number;
      changeThreshold?: number;
      onSignificantChange?: (event: { frame: VideoFrameInput; changeScore: number }) => void;
    } = {},
  ) {
    this.maxFrames = Math.max(1, options.maxFrames ?? 12);
    this.changeThreshold = Math.max(0, Math.min(1, options.changeThreshold ?? 0.08));
    this.onSignificantChange = options.onSignificantChange;
  }

  get size(): number {
    return this.buffer.length;
  }

  pushFrame(frame: VideoFrameInput): VideoPushResult {
    if (frame.isPrivate) {
      return { buffered: false, droppedPrivate: true, changed: false, changeScore: 0 };
    }
    const prev = this.buffer.at(-1);
    const changeScore = prev ? frameDifference(prev.luma, frame.luma) : 1;
    const changed = changeScore >= this.changeThreshold;

    const stored: VideoFrameInput = {
      ...frame,
      luma: new Uint8Array(frame.luma),
    };
    this.buffer.push(stored);
    if (this.buffer.length > this.maxFrames) {
      this.buffer.shift();
    }
    if (changed && prev) {
      this.onSignificantChange?.({ frame: stored, changeScore });
    }
    return { buffered: true, droppedPrivate: false, changed, changeScore };
  }

  recent(count = this.maxFrames): VideoFrameInput[] {
    return this.buffer.slice(-Math.max(0, count));
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
