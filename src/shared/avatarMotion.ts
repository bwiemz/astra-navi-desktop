import { z } from "zod";
import type { Gesture } from "./gestures.ts";
import type { Mood } from "./ipc.ts";

/**
 * Avatar Motion, Idle Loops, Event Reactions & Data-Only Emote Packs.
 *
 * Shared between main-process event hooks, the companion WebGL `Stage` (`stage.ts`),
 * Workbench Avatar Studio, and unit tests. Emote packs are strictly data-only
 * (metadata + `.vrma` / `.vmd` animation references, zero executable code).
 */

export const IDLE_LOOP_PRESETS = [
  "calm-breathe",
  "curious-glance",
  "playful-sway",
  "focused-stand",
] as const;
export type IdleLoopPreset = (typeof IDLE_LOOP_PRESETS)[number];

export interface IdleLoopProfile {
  id: IdleLoopPreset;
  label: string;
  description: string;
  breathRate: number;
  breathAmp: number;
  swayRate: number;
  swayAmp: number;
  weightShiftAmp: number;
  saccadeIntervalMinSec: number;
  saccadeIntervalMaxSec: number;
  flourishIntervalMinSec: number;
  flourishIntervalMaxSec: number;
  flourishes: readonly Gesture[];
}

export const IDLE_LOOP_PROFILES: Record<IdleLoopPreset, IdleLoopProfile> = {
  "calm-breathe": {
    id: "calm-breathe",
    label: "Calm breathe",
    description: "Gentle breathing and subtle weight shifting.",
    breathRate: 1.65,
    breathAmp: 1.0,
    swayRate: 0.52,
    swayAmp: 1.0,
    weightShiftAmp: 1.35,
    saccadeIntervalMinSec: 2.2,
    saccadeIntervalMaxSec: 5.0,
    flourishIntervalMinSec: 22,
    flourishIntervalMaxSec: 38,
    flourishes: ["perk", "nod"],
  },
  "curious-glance": {
    id: "curious-glance",
    label: "Curious glance",
    description: "Livelier eye glances and occasional thoughtful head tilts.",
    breathRate: 1.85,
    breathAmp: 1.05,
    swayRate: 0.68,
    swayAmp: 1.25,
    weightShiftAmp: 1.6,
    saccadeIntervalMinSec: 1.3,
    saccadeIntervalMaxSec: 3.1,
    flourishIntervalMinSec: 15,
    flourishIntervalMaxSec: 28,
    flourishes: ["perk", "think", "nod"],
  },
  "playful-sway": {
    id: "playful-sway",
    label: "Playful sway",
    description: "Bouncy rhythm with upbeat ambient waves and cheers.",
    breathRate: 2.05,
    breathAmp: 1.15,
    swayRate: 0.88,
    swayAmp: 1.55,
    weightShiftAmp: 2.1,
    saccadeIntervalMinSec: 1.5,
    saccadeIntervalMaxSec: 3.6,
    flourishIntervalMinSec: 14,
    flourishIntervalMaxSec: 26,
    flourishes: ["perk", "wave", "nod", "shrug"],
  },
  "focused-stand": {
    id: "focused-stand",
    label: "Focused stand",
    description: "Minimal calm posture ideal while coding or gaming.",
    breathRate: 1.35,
    breathAmp: 0.72,
    swayRate: 0.36,
    swayAmp: 0.55,
    weightShiftAmp: 0.75,
    saccadeIntervalMinSec: 3.2,
    saccadeIntervalMaxSec: 6.4,
    flourishIntervalMinSec: 35,
    flourishIntervalMaxSec: 60,
    flourishes: ["nod"],
  },
};

export interface IdleLoopSample {
  breath: number;
  sway: number;
  weightShift: number;
  drift: number;
}

/** Evaluates smooth procedural idle-loop channels for `preset` at time `t` seconds. */
export function evaluateIdleLoop(
  preset: IdleLoopPreset,
  t: number,
  awake: number,
  sleep: number,
  breathingScale = 1,
  talkGestureScale = 1,
  energyScale = 1,
): IdleLoopSample {
  const profile = IDLE_LOOP_PROFILES[preset] ?? IDLE_LOOP_PROFILES["calm-breathe"];
  const breath =
    Math.sin(t * Math.max(0.5, profile.breathRate - 0.75 * sleep)) *
    (1 + 0.8 * sleep) *
    profile.breathAmp *
    breathingScale *
    energyScale;
  const sway = Math.sin(t * profile.swayRate) * profile.swayAmp * awake * talkGestureScale;
  const weightShift = Math.sin(t * 0.37 + 0.6) * profile.weightShiftAmp * awake;
  const drift = Math.sin(t * 0.31 + 1.3) * awake;
  return { breath, sway, weightShift, drift };
}

/** Schedules gentle ambient idle flourishes while the companion is awake and unoccupied. */
export class IdleFlourishScheduler {
  private nextAtSec: number;
  private cursor = 0;

  constructor(initialDelaySec = 18) {
    this.nextAtSec = Math.max(4, initialDelaySec);
  }

  reset(nowSec: number, preset: IdleLoopPreset, rand = Math.random): void {
    const profile = IDLE_LOOP_PROFILES[preset] ?? IDLE_LOOP_PROFILES["calm-breathe"];
    const span = Math.max(1, profile.flourishIntervalMaxSec - profile.flourishIntervalMinSec);
    this.nextAtSec = nowSec + profile.flourishIntervalMinSec + rand() * span;
  }

  poll(
    nowSec: number,
    preset: IdleLoopPreset,
    canFlourish: boolean,
    rand = Math.random,
  ): Gesture | null {
    if (!canFlourish) return null;
    if (nowSec < this.nextAtSec) return null;
    const profile = IDLE_LOOP_PROFILES[preset] ?? IDLE_LOOP_PROFILES["calm-breathe"];
    const pool = profile.flourishes;
    if (pool.length === 0) return null;
    const gesture = pool[this.cursor % pool.length] ?? "nod";
    this.cursor += 1;
    this.reset(nowSec, preset, rand);
    return gesture;
  }
}

export const AVATAR_EVENT_KINDS = [
  "reminder-fired",
  "mission-finished",
  "mission-failed",
  "wake-word",
  "error-noticed",
  "greeting",
  "game-started",
  "game-ended",
  "approval-needed",
] as const;
export type AvatarEventKind = (typeof AVATAR_EVENT_KINDS)[number];

export interface AvatarEventReaction {
  event: AvatarEventKind;
  mood: Mood;
  gesture: Gesture;
  label: string;
  holdMoodMs: number;
}

export const AVATAR_EVENT_REACTIONS: Record<AvatarEventKind, AvatarEventReaction> = {
  "reminder-fired": {
    event: "reminder-fired",
    mood: "excited",
    gesture: "perk",
    label: "Reminder alert",
    holdMoodMs: 5000,
  },
  "mission-finished": {
    event: "mission-finished",
    mood: "happy",
    gesture: "cheer",
    label: "Job finished",
    holdMoodMs: 6000,
  },
  "mission-failed": {
    event: "mission-failed",
    mood: "worried",
    gesture: "shake",
    label: "Job needs attention",
    holdMoodMs: 5500,
  },
  "wake-word": {
    event: "wake-word",
    mood: "happy",
    gesture: "perk",
    label: "Listening",
    holdMoodMs: 3000,
  },
  "error-noticed": {
    event: "error-noticed",
    mood: "surprised",
    gesture: "point",
    label: "Spotted an error",
    holdMoodMs: 5000,
  },
  greeting: {
    event: "greeting",
    mood: "happy",
    gesture: "wave",
    label: "Greeting wave",
    holdMoodMs: 4500,
  },
  "game-started": {
    event: "game-started",
    mood: "excited",
    gesture: "salute",
    label: "Game time salute",
    holdMoodMs: 4000,
  },
  "game-ended": {
    event: "game-ended",
    mood: "happy",
    gesture: "nod",
    label: "Welcome back",
    holdMoodMs: 4000,
  },
  "approval-needed": {
    event: "approval-needed",
    mood: "thinking",
    gesture: "point",
    label: "Awaiting approval",
    holdMoodMs: 4500,
  },
};

export function resolveEventReaction(kind: AvatarEventKind): AvatarEventReaction {
  return AVATAR_EVENT_REACTIONS[kind];
}

const SAFE_CLIP_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}\.(?:vrma|vmd)$/i;

export const EmoteItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,48}$/),
  label: z.string().min(1).max(40),
  category: z.enum(["greeting", "reaction", "idle", "dance", "pose"]).default("reaction"),
  mood: z
    .enum(["neutral", "happy", "excited", "thinking", "surprised", "worried", "smug", "sad"])
    .optional(),
  gesture: z
    .enum(["nod", "shake", "perk", "wave", "think", "point", "shrug", "salute", "cheer", "bow"])
    .optional(),
  /** Optional relative path inside a data-only pack to a `.vrma` (VRM) or `.vmd` (MMD) motion file. */
  clipFile: z
    .string()
    .refine((val) => SAFE_CLIP_FILE_RE.test(val) && !val.includes(".."), {
      message: "clipFile must be a safe relative .vrma or .vmd path.",
    })
    .optional(),
  loop: z.boolean().default(false),
});
export type EmoteItem = z.infer<typeof EmoteItemSchema>;

export const EmotePackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(1).max(64),
  author: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  description: z.string().max(240).default(""),
  emotes: z.array(EmoteItemSchema).min(1).max(48),
});
export type EmotePackManifest = z.infer<typeof EmotePackManifestSchema>;

/** Built-in zero-dependency emote pack available for every VRM & MMD avatar out of the box. */
export const BUILT_IN_EMOTE_PACKS: readonly EmotePackManifest[] = [
  {
    schemaVersion: 1,
    id: "core-expressions",
    name: "Core Navigator Emotes",
    author: "Astra Navi Desktop",
    version: "1.0.0",
    description: "Built-in expressive motions and reactions compatible with both VRM and MMD rigs.",
    emotes: [
      { id: "wave", label: "Wave", category: "greeting", mood: "happy", gesture: "wave", loop: false },
      { id: "cheer", label: "Cheer", category: "reaction", mood: "excited", gesture: "cheer", loop: false },
      { id: "salute", label: "Salute", category: "greeting", mood: "smug", gesture: "salute", loop: false },
      { id: "bow", label: "Bow", category: "greeting", mood: "happy", gesture: "bow", loop: false },
      { id: "think", label: "Think", category: "pose", mood: "thinking", gesture: "think", loop: false },
      { id: "shrug", label: "Shrug", category: "reaction", mood: "neutral", gesture: "shrug", loop: false },
      { id: "point", label: "Point", category: "reaction", mood: "surprised", gesture: "point", loop: false },
      { id: "nod", label: "Nod", category: "reaction", mood: "happy", gesture: "nod", loop: false },
      { id: "shake", label: "No / Shake", category: "reaction", mood: "worried", gesture: "shake", loop: false },
      { id: "perk", label: "Perk up", category: "reaction", mood: "excited", gesture: "perk", loop: false },
    ],
  },
];

export function parseEmotePackJson(raw: unknown): EmotePackManifest {
  return EmotePackManifestSchema.parse(raw);
}

export interface VmdHeaderInfo {
  version: "0002" | "0001";
  modelName: string;
  boneKeyFrameCount: number;
}

const MAX_MOTION_CLIP_BYTES = 24 * 1024 * 1024;

/** Validates binary VMD header bytes (`Vocaloid Motion Data 0002` / legacy `file`) safely. */
export function inspectVmdHeader(bytes: Uint8Array): VmdHeaderInfo {
  if (bytes.byteLength < 54) {
    throw new Error("VMD file is too short to contain a valid header.");
  }
  if (bytes.byteLength > MAX_MOTION_CLIP_BYTES) {
    throw new Error("VMD file exceeds the 24 MB safety limit.");
  }
  const sig = new TextDecoder("ascii").decode(bytes.subarray(0, 30)).replace(/\0+$/, "");
  let version: "0002" | "0001";
  let modelNameBytes: number;
  if (sig === "Vocaloid Motion Data 0002") {
    version = "0002";
    modelNameBytes = 20;
  } else if (sig === "Vocaloid Motion Data file") {
    version = "0001";
    modelNameBytes = 10;
  } else {
    throw new Error("File is not a valid MikuMikuDance (.vmd) motion file.");
  }
  const nameSlice = bytes.subarray(30, 30 + modelNameBytes);
  const zeroIdx = nameSlice.indexOf(0);
  const rawName = zeroIdx >= 0 ? nameSlice.subarray(0, zeroIdx) : nameSlice;
  const modelName = new TextDecoder("utf-8", { fatal: false }).decode(rawName).trim();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boneKeyFrameCount = view.getUint32(30 + modelNameBytes, true);
  return { version, modelName, boneKeyFrameCount };
}

/** Detects whether a binary animation buffer is a `.vrma` (glTF/GLB) or `.vmd` (MMD) clip. */
export function detectMotionClipFormat(
  bytes: Uint8Array,
  fileName = "",
): "vrma" | "vmd" | "unknown" {
  if (bytes.byteLength >= 4) {
    const magic =
      (bytes[0] ?? 0) |
      ((bytes[1] ?? 0) << 8) |
      ((bytes[2] ?? 0) << 16) |
      ((bytes[3] ?? 0) << 24);
    if (magic === 0x46546c67) return "vrma"; // "glTF"
  }
  if (bytes.byteLength >= 30) {
    const sig = new TextDecoder("ascii").decode(bytes.subarray(0, 25));
    if (sig.startsWith("Vocaloid Motion Data ")) return "vmd";
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".vrma")) return "vrma";
  if (lower.endsWith(".vmd")) return "vmd";
  return "unknown";
}
