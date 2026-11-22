import { cosineSimilarity } from "./hygiene.ts";

/**
 * Multi-User Household Isolation (ai_chan_plan.pdf p. 16).
 *
 * Isolates memory namespaces, calendars, paired devices, and privileged desktop/fleet
 * tools between the machine owner and other household members. Defaults to single-owner
 * mode (`enabled = false`) until explicitly opted in.
 */

export type HouseholdRole = "owner" | "member";

export interface HouseholdProfile {
  userId: string;
  displayName: string;
  role: HouseholdRole;
  voiceEmbedding?: readonly number[];
  deviceIds: string[];
  memoryNamespace: string;
  calendarIds: string[];
}

export const OWNER_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "remote",
  "operate",
  "run_command",
  "start_mission",
  "plan_mission",
  "look_at_screen",
  "notifications",
  "tidy_storage",
  "listen_to_pc",
]);

export interface HouseholdAuthRequest {
  tool: string;
  targetNamespace?: string;
  targetCalendarId?: string;
  isDestructive?: boolean;
}

export interface HouseholdAuthDecision {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_MIN_SPEAKER_COSINE = 0.78;
const AMBIGUITY_MARGIN = 0.05;
const VOICEPRINT_BINS = 16;

function goertzelPower(samples: Float32Array, freqHz: number, sampleRate = 16_000): number {
  const n = samples.length;
  if (n === 0) return 0;
  const omega = (2 * Math.PI * freqHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    // Hann window broadens mainlobe to ~31 Hz on 32 ms frames so natural pitch vibrato matches cleanly.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
    const s0 = (samples[i] ?? 0) * w + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.max(0, power) / n;
}

/**
 * Extracts a deterministic, L2-normalized 24-dimensional acoustic voice-print vector
 * from 16 kHz mono PCM (16 frame-averaged log-spaced spectral Goertzel filterbank bins
 * across 100-3800 Hz, 4 temporal energy quartiles, and 4 ZCR distribution features).
 */
export function extractVoicePrint(pcm16k: Float32Array): number[] {
  if (pcm16k.length < 256) return [];
  const window = pcm16k.length > 16_000 ? pcm16k.subarray(0, 16_000) : pcm16k;
  let sumSq = 0;
  for (let i = 0; i < window.length; i += 1) {
    const s = window[i] ?? 0;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / window.length);
  if (!Number.isFinite(rms) || rms < 1e-4) return [];

  const features: number[] = [];
  const fMin = 100;
  const fMax = 3800;
  const frameSize = Math.min(512, window.length);
  const frameStep = Math.max(128, Math.floor(frameSize / 2));
  const frameStarts: number[] = [];
  for (let start = 0; start + frameSize <= window.length; start += frameStep) {
    frameStarts.push(start);
  }
  if (frameStarts.length === 0) frameStarts.push(0);

  for (let b = 0; b < VOICEPRINT_BINS; b += 1) {
    const freq = fMin * Math.pow(fMax / fMin, b / (VOICEPRINT_BINS - 1));
    let totalPower = 0;
    for (const start of frameStarts) {
      totalPower += goertzelPower(window.subarray(start, start + frameSize), freq, 16_000);
    }
    features.push(Math.log1p((totalPower / frameStarts.length) * 100));
  }

  // 4 temporal energy quartile ratios + 4 ZCR quartile ratios.
  const qLen = Math.max(1, Math.floor(window.length / 4));
  for (let q = 0; q < 4; q += 1) {
    const start = q * qLen;
    const end = q === 3 ? window.length : Math.min(window.length, start + qLen);
    let qSq = 0;
    for (let i = start; i < end; i += 1) {
      const s = window[i] ?? 0;
      qSq += s * s;
    }
    const qRms = Math.sqrt(qSq / Math.max(1, end - start));
    features.push(Math.min(2, qRms / rms) * 0.25);
  }
  for (let q = 0; q < 4; q += 1) {
    const start = q * qLen;
    const end = q === 3 ? window.length : Math.min(window.length, start + qLen);
    let zc = 0;
    for (let i = start + 1; i < end; i += 1) {
      const a = window[i - 1] ?? 0;
      const b = window[i] ?? 0;
      if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) zc += 1;
    }
    features.push((zc / Math.max(1, end - start)) * 0.5);
  }

  let normSq = 0;
  for (const val of features) normSq += val * val;
  const norm = Math.sqrt(normSq);
  if (!Number.isFinite(norm) || norm <= 0) return [];
  return features.map((val) => Number((val / norm).toFixed(6)));
}

export class HouseholdIsolationManager {
  enabled: boolean;
  private readonly profiles = new Map<string, HouseholdProfile>();

  constructor(options: { enabled?: boolean } = {}) {
    this.enabled = options.enabled ?? false;
  }

  registerProfile(profile: HouseholdProfile): void {
    this.profiles.set(profile.userId, {
      ...profile,
      deviceIds: [...profile.deviceIds],
      calendarIds: [...profile.calendarIds],
      ...(profile.voiceEmbedding ? { voiceEmbedding: [...profile.voiceEmbedding] } : {}),
    });
  }

  listProfiles(): HouseholdProfile[] {
    return [...this.profiles.values()];
  }

  /** Identifies a speaker via cosine similarity, failing closed on low confidence or ambiguity. */
  identifySpeaker(
    embedding: readonly number[],
    minCosine = DEFAULT_MIN_SPEAKER_COSINE,
  ): HouseholdProfile | null {
    if (embedding.length === 0) return null;
    const scored: { profile: HouseholdProfile; score: number }[] = [];
    for (const profile of this.profiles.values()) {
      if (!profile.voiceEmbedding || profile.voiceEmbedding.length !== embedding.length) continue;
      scored.push({
        profile,
        score: cosineSimilarity(embedding, profile.voiceEmbedding),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < minCosine) return null;
    const runnerUp = scored[1];
    if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) return null;
    return best.profile;
  }

  resolveDeviceUser(deviceId: string): HouseholdProfile | null {
    for (const profile of this.profiles.values()) {
      if (profile.deviceIds.includes(deviceId)) return profile;
    }
    return null;
  }

  authorizeAction(
    profile: HouseholdProfile | null,
    req: HouseholdAuthRequest,
  ): HouseholdAuthDecision {
    if (!this.enabled) return { allowed: true };
    if (!profile) {
      return {
        allowed: false,
        reason: "Unidentified speaker or unpaired device blocked under household isolation.",
      };
    }
    if (profile.role !== "owner" && (OWNER_ONLY_TOOLS.has(req.tool) || req.isDestructive)) {
      return {
        allowed: false,
        reason: `Tool "${req.tool}" requires owner privileges.`,
      };
    }
    if (req.targetNamespace !== undefined && req.targetNamespace !== profile.memoryNamespace) {
      return {
        allowed: false,
        reason: `Cross-user memory namespace "${req.targetNamespace}" denied for "${profile.displayName}".`,
      };
    }
    if (
      req.targetCalendarId !== undefined &&
      !profile.calendarIds.includes(req.targetCalendarId)
    ) {
      return {
        allowed: false,
        reason: `Cross-user calendar "${req.targetCalendarId}" denied for "${profile.displayName}".`,
      };
    }
    return { allowed: true };
  }
}
