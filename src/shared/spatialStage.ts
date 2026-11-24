/**
 * Spatial Stage, Multi-Monitor Edge Docking, Procedural Room Presets,
 * Circadian / Screen-Ambient Lighting, and Opt-In Local Webcam Presence Tracking.
 *
 * Pure TypeScript shared safely between Electron main (`main/index.ts`), Chromium
 * renderer (`renderer/src/stage.ts`), and unit tests with zero `node:*` or DOM imports.
 */

export interface DisplayWorkArea {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor?: number;
  primary?: boolean;
}

export type DockEdge =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left"
  | "left-center"
  | "right-center";

export interface DockPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  displayId: string;
  edge: DockEdge;
  /** Suggested character torso/head yaw bias in degrees toward screen center. */
  facingYawDeg: number;
}

export function facingYawForEdge(edge: DockEdge): number {
  if (edge === "bottom-left" || edge === "top-left" || edge === "left-center") {
    return 14;
  }
  if (edge === "bottom-right" || edge === "top-right" || edge === "right-center") {
    return -14;
  }
  return 0;
}

/**
 * Places Astra's companion window along a specific edge or corner of any connected
 * display's work area, clamping window bounds strictly inside that monitor and
 * orienting the 3D character toward screen center.
 */
export function computeMultiMonitorDock(
  displays: readonly DisplayWorkArea[],
  targetDisplayId: string | null,
  edge: DockEdge,
  size: { width: number; height: number },
  margin = 20,
): DockPlacement {
  const chosen =
    (targetDisplayId ? displays.find((d) => d.id === targetDisplayId) : undefined) ??
    displays.find((d) => d.primary) ??
    displays[0] ?? {
      id: "default",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      primary: true,
    };

  const w = Math.min(Math.max(120, Math.round(size.width)), Math.max(120, chosen.width - margin));
  const h = Math.min(Math.max(160, Math.round(size.height)), Math.max(160, chosen.height - margin));
  const leftX = chosen.x + margin;
  const rightX = chosen.x + chosen.width - w - margin;
  const topY = chosen.y + margin;
  const bottomY = chosen.y + chosen.height - h - margin;
  const midY = chosen.y + Math.round((chosen.height - h) / 2);

  let x: number;
  let y: number;
  switch (edge) {
    case "bottom-left":
      x = leftX;
      y = bottomY;
      break;
    case "top-left":
      x = leftX;
      y = topY;
      break;
    case "top-right":
      x = rightX;
      y = topY;
      break;
    case "left-center":
      x = leftX;
      y = midY;
      break;
    case "right-center":
      x = rightX;
      y = midY;
      break;
    case "bottom-right":
    default:
      x = rightX;
      y = bottomY;
      break;
  }

  return {
    x,
    y,
    width: w,
    height: h,
    displayId: chosen.id,
    edge,
    facingYawDeg: facingYawForEdge(edge),
  };
}

/**
 * Snaps dragged window bounds to the nearest monitor corner/edge when within
 * `snapThresholdPx` across multi-monitor work areas. Returns null when far from edges.
 */
export function snapBoundsToMonitorEdge(
  bounds: { x: number; y: number; width: number; height: number },
  displays: readonly DisplayWorkArea[],
  snapThresholdPx = 36,
  margin = 16,
): DockPlacement | null {
  if (displays.length === 0) return null;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;

  let bestDisplay = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const clampedX = Math.max(d.x, Math.min(d.x + d.width, cx));
    const clampedY = Math.max(d.y, Math.min(d.y + d.height, cy));
    const dist = Math.hypot(cx - clampedX, cy - clampedY);
    if (dist < bestDist) {
      bestDist = dist;
      bestDisplay = d;
    }
  }
  if (!bestDisplay) return null;

  const nearLeft = Math.abs(bounds.x - (bestDisplay.x + margin)) <= snapThresholdPx || bounds.x < bestDisplay.x + margin;
  const nearRight =
    Math.abs(bounds.x + bounds.width - (bestDisplay.x + bestDisplay.width - margin)) <=
      snapThresholdPx || bounds.x + bounds.width > bestDisplay.x + bestDisplay.width - margin;
  const nearTop = Math.abs(bounds.y - (bestDisplay.y + margin)) <= snapThresholdPx || bounds.y < bestDisplay.y + margin;
  const nearBottom =
    Math.abs(bounds.y + bounds.height - (bestDisplay.y + bestDisplay.height - margin)) <=
      snapThresholdPx || bounds.y + bounds.height > bestDisplay.y + bestDisplay.height - margin;

  let edge: DockEdge | null = null;
  if (nearRight && nearBottom) edge = "bottom-right";
  else if (nearLeft && nearBottom) edge = "bottom-left";
  else if (nearRight && nearTop) edge = "top-right";
  else if (nearLeft && nearTop) edge = "top-left";
  else if (nearRight) edge = "right-center";
  else if (nearLeft) edge = "left-center";

  if (!edge) return null;
  return computeMultiMonitorDock(
    displays,
    bestDisplay.id,
    edge,
    { width: bounds.width, height: bounds.height },
    margin,
  );
}

// --- Procedural 3D Desk / Room Scene Presets ------------------------------

export type RoomScenePreset = "none" | "cozy-desk" | "command-bridge" | "minimal-studio";

export interface RoomSceneSpec {
  id: RoomScenePreset;
  label: string;
  backdropColor: readonly [number, number, number, number];
  floorColor: readonly [number, number, number];
  deskColor: readonly [number, number, number];
  accentColor: readonly [number, number, number];
}

export const ROOM_SCENE_SPECS: Record<RoomScenePreset, RoomSceneSpec> = {
  none: {
    id: "none",
    label: "Transparent Overlay (No Room)",
    backdropColor: [0, 0, 0, 0],
    floorColor: [0.1, 0.1, 0.12],
    deskColor: [0.2, 0.18, 0.16],
    accentColor: [0.35, 0.78, 0.96],
  },
  "cozy-desk": {
    id: "cozy-desk",
    label: "Cozy Study Desk",
    backdropColor: [0.11, 0.1, 0.14, 1],
    floorColor: [0.22, 0.17, 0.14],
    deskColor: [0.46, 0.31, 0.21],
    accentColor: [0.98, 0.76, 0.42],
  },
  "command-bridge": {
    id: "command-bridge",
    label: "Orbital Command Bridge",
    backdropColor: [0.06, 0.09, 0.16, 1],
    floorColor: [0.1, 0.14, 0.22],
    deskColor: [0.18, 0.22, 0.31],
    accentColor: [0.26, 0.82, 0.98],
  },
  "minimal-studio": {
    id: "minimal-studio",
    label: "Soft Minimal Studio",
    backdropColor: [0.16, 0.18, 0.24, 1],
    floorColor: [0.24, 0.26, 0.32],
    deskColor: [0.74, 0.75, 0.78],
    accentColor: [0.95, 0.56, 0.72],
  },
};

// --- Circadian Time-of-Day & Screen-Ambient Dynamic Lighting -------------

export type DayPeriod =
  | "night"
  | "dawn"
  | "morning"
  | "midday"
  | "golden-hour"
  | "dusk"
  | "evening";

export interface StageLightingState {
  skyColor: [number, number, number];
  groundColor: [number, number, number];
  sunColor: [number, number, number];
  sunDirection: [number, number, number];
  skyIntensity: number;
  sunIntensity: number;
  ambientColor: [number, number, number];
  period: DayPeriod;
}

interface LightingKeyframe {
  hour: number;
  period: DayPeriod;
  skyColor: readonly [number, number, number];
  groundColor: readonly [number, number, number];
  sunColor: readonly [number, number, number];
  sunDirection: readonly [number, number, number];
  skyIntensity: number;
  sunIntensity: number;
  ambientColor: readonly [number, number, number];
}

const LIGHTING_KEYFRAMES: readonly LightingKeyframe[] = [
  {
    hour: 0,
    period: "night",
    skyColor: [0.42, 0.52, 0.82],
    groundColor: [0.14, 0.16, 0.28],
    sunColor: [0.58, 0.7, 0.98],
    sunDirection: [-0.3, -0.8, 0.8],
    skyIntensity: 0.28,
    sunIntensity: 0.45,
    ambientColor: [0.3, 0.36, 0.5],
  },
  {
    hour: 6,
    period: "dawn",
    skyColor: [0.95, 0.68, 0.62],
    groundColor: [0.32, 0.24, 0.28],
    sunColor: [1.0, 0.74, 0.54],
    sunDirection: [-0.8, -0.45, 0.75],
    skyIntensity: 0.36,
    sunIntensity: 0.72,
    ambientColor: [0.48, 0.42, 0.44],
  },
  {
    hour: 9,
    period: "morning",
    skyColor: [0.88, 0.94, 1.0],
    groundColor: [0.36, 0.38, 0.42],
    sunColor: [1.0, 0.95, 0.88],
    sunDirection: [-0.4, -0.9, 0.85],
    skyIntensity: 0.42,
    sunIntensity: 0.88,
    ambientColor: [0.52, 0.54, 0.56],
  },
  {
    hour: 13,
    period: "midday",
    skyColor: [0.96, 0.98, 1.0],
    groundColor: [0.42, 0.44, 0.46],
    sunColor: [1.0, 0.99, 0.96],
    sunDirection: [0.15, -1.0, 0.9],
    skyIntensity: 0.46,
    sunIntensity: 0.94,
    ambientColor: [0.56, 0.57, 0.58],
  },
  {
    hour: 17.5,
    period: "golden-hour",
    skyColor: [1.0, 0.78, 0.56],
    groundColor: [0.38, 0.27, 0.24],
    sunColor: [1.0, 0.68, 0.42],
    sunDirection: [0.75, -0.5, 0.8],
    skyIntensity: 0.38,
    sunIntensity: 0.82,
    ambientColor: [0.52, 0.44, 0.38],
  },
  {
    hour: 20,
    period: "dusk",
    skyColor: [0.62, 0.54, 0.86],
    groundColor: [0.22, 0.18, 0.3],
    sunColor: [0.76, 0.66, 0.96],
    sunDirection: [0.6, -0.65, 0.85],
    skyIntensity: 0.32,
    sunIntensity: 0.6,
    ambientColor: [0.38, 0.36, 0.48],
  },
  {
    hour: 22.5,
    period: "evening",
    skyColor: [0.46, 0.54, 0.82],
    groundColor: [0.16, 0.18, 0.28],
    sunColor: [0.62, 0.72, 0.98],
    sunDirection: [0.3, -0.8, 0.85],
    skyIntensity: 0.29,
    sunIntensity: 0.5,
    ambientColor: [0.32, 0.36, 0.48],
  },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Computes smooth circadian lighting parameters from a `Date` or fractional hour `[0..24)`. */
export function computeTimeOfDayLighting(hourOrDate: number | Date = new Date()): StageLightingState {
  const rawHour =
    hourOrDate instanceof Date
      ? hourOrDate.getHours() + hourOrDate.getMinutes() / 60
      : hourOrDate;
  const hour = ((rawHour % 24) + 24) % 24;

  let prev = LIGHTING_KEYFRAMES[LIGHTING_KEYFRAMES.length - 1] ?? LIGHTING_KEYFRAMES[0];
  let next = LIGHTING_KEYFRAMES[0];
  let span = 24 - (prev?.hour ?? 0) + (next?.hour ?? 0);
  let offset = hour >= (prev?.hour ?? 0) ? hour - (prev?.hour ?? 0) : 24 - (prev?.hour ?? 0) + hour;

  for (let i = 0; i < LIGHTING_KEYFRAMES.length - 1; i += 1) {
    const a = LIGHTING_KEYFRAMES[i];
    const b = LIGHTING_KEYFRAMES[i + 1];
    if (a && b && hour >= a.hour && hour < b.hour) {
      prev = a;
      next = b;
      span = b.hour - a.hour;
      offset = hour - a.hour;
      break;
    }
  }
  const t = span > 0 ? Math.max(0, Math.min(1, offset / span)) : 0;
  const p = prev ?? LIGHTING_KEYFRAMES[0];
  const n = next ?? LIGHTING_KEYFRAMES[0];
  if (!p || !n) {
    return {
      skyColor: [1, 1, 1],
      groundColor: [0.3, 0.3, 0.3],
      sunColor: [1, 1, 1],
      sunDirection: [0.4, -1, 1],
      skyIntensity: 0.35,
      sunIntensity: 0.85,
      ambientColor: [0.5, 0.5, 0.5],
      period: "midday",
    };
  }

  return {
    skyColor: lerp3(p.skyColor, n.skyColor, t),
    groundColor: lerp3(p.groundColor, n.groundColor, t),
    sunColor: lerp3(p.sunColor, n.sunColor, t),
    sunDirection: lerp3(p.sunDirection, n.sunDirection, t),
    skyIntensity: lerp(p.skyIntensity, n.skyIntensity, t),
    sunIntensity: lerp(p.sunIntensity, n.sunIntensity, t),
    ambientColor: lerp3(p.ambientColor, n.ambientColor, t),
    period: t < 0.65 ? p.period : n.period,
  };
}

/** Computes perceptually normalized average RGB `[0..1]` from downscaled RGB/RGBA screen buffer. */
export function sampleAmbientScreenColor(
  pixels: Uint8Array,
  channels: 3 | 4 = 4,
): [number, number, number] {
  if (pixels.length < channels) return [0.5, 0.5, 0.5];
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let i = 0; i + channels - 1 < pixels.length; i += channels) {
    rSum += pixels[i] ?? 0;
    gSum += pixels[i + 1] ?? 0;
    bSum += pixels[i + 2] ?? 0;
    count += 1;
  }
  if (count === 0) return [0.5, 0.5, 0.5];
  return [
    Math.min(1, Math.max(0, rSum / (count * 255))),
    Math.min(1, Math.max(0, gSum / (count * 255))),
    Math.min(1, Math.max(0, bSum / (count * 255))),
  ];
}

/** Blends sampled desktop screen ambient color gently onto a base lighting state without washing out skin tones. */
export function blendAmbientScreenLighting(
  base: StageLightingState,
  screenRgb: readonly [number, number, number],
  strength = 0.45,
): StageLightingState {
  const s = Math.max(0, Math.min(0.8, strength));
  const clampRgb = (v: number): number => Math.max(0.18, Math.min(1, v));
  const tint: [number, number, number] = [
    clampRgb(screenRgb[0]),
    clampRgb(screenRgb[1]),
    clampRgb(screenRgb[2]),
  ];
  return {
    ...base,
    skyColor: lerp3(base.skyColor, tint, s * 0.7),
    sunColor: lerp3(base.sunColor, tint, s * 0.55),
    ambientColor: lerp3(base.ambientColor, tint, s * 0.8),
  };
}

// --- Opt-In Local Webcam Presence & Gaze Detection -----------------------

export interface WebcamPresenceSample {
  brightness: number;
  motionScore: number;
  detected: boolean;
  /** Estimated user head/activity direction on screen in `[-1, 1]`. */
  gazeTarget: { x: number; y: number } | null;
}

/**
 * Analyzes a tiny downscaled grayscale webcam frame strictly in memory.
 * Detects user presence and computes a smooth gaze target centroid without
 * ever storing images or invoking external cloud vision services.
 */
export function analyzeWebcamPresenceFrame(
  currLuma: Uint8Array,
  prevLuma: Uint8Array | null,
  width: number,
  height: number,
  motionThreshold = 0.035,
): WebcamPresenceSample {
  const total = Math.min(currLuma.length, width * height);
  if (total <= 0 || width <= 0 || height <= 0) {
    return { brightness: 0, motionScore: 0, detected: false, gazeTarget: null };
  }

  let lumaSum = 0;
  let diffSum = 0;
  let weightSum = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (let i = 0; i < total; i += 1) {
    const val = currLuma[i] ?? 0;
    lumaSum += val;
    if (prevLuma && prevLuma.length === currLuma.length) {
      const diff = Math.abs(val - (prevLuma[i] ?? val)) / 255;
      diffSum += diff;
      if (diff > motionThreshold) {
        const px = i % width;
        const py = Math.floor(i / width);
        weightSum += diff;
        weightedX += (width > 1 ? (px / (width - 1)) * 2 - 1 : 0) * diff;
        weightedY += (height > 1 ? 1 - (py / (height - 1)) * 2 : 0) * diff;
      }
    }
  }

  const brightness = lumaSum / (total * 255);
  const motionScore = prevLuma && prevLuma.length === currLuma.length ? diffSum / total : 0;

  // Fallback silhouette centroid when user sits still in well-lit desk frame.
  let gazeTarget: { x: number; y: number } | null = null;
  if (weightSum > 0.05) {
    // Mirror X because typical webcams face the user (motion on camera right is user left).
    gazeTarget = {
      x: Math.max(-1, Math.min(1, -(weightedX / weightSum))),
      y: Math.max(-1, Math.min(1, weightedY / weightSum)),
    };
  }

  const detected = brightness >= 0.06 && (motionScore >= motionThreshold * 0.5 || prevLuma === null);
  return { brightness, motionScore, detected, gazeTarget };
}

export interface PresenceUpdate {
  enabled: boolean;
  present: boolean;
  action: "wake" | "sleep" | "none";
  gazeTarget: { x: number; y: number } | null;
  motionScore: number;
}

/**
 * Stateful hysteresis tracker for opt-in local webcam presence detection (`enabled: false` default).
 * Wakes the companion when active presence resumes and sleeps cleanly after sustained absence.
 */
export class PresenceTracker {
  private _enabled = false;
  private _present = false;
  private prevLuma: Uint8Array | null = null;
  private lastMotionAtMs = 0;
  private firstDetectedAtMs: number | null = null;
  private readonly presentConfirmMs: number;
  private readonly awayTimeoutMs: number;
  private readonly motionThreshold: number;

  constructor(
    options: {
      enabled?: boolean;
      presentConfirmMs?: number;
      awayTimeoutMs?: number;
      motionThreshold?: number;
    } = {},
  ) {
    this._enabled = options.enabled ?? false;
    this.presentConfirmMs = Math.max(0, options.presentConfirmMs ?? 400);
    this.awayTimeoutMs = Math.max(500, options.awayTimeoutMs ?? 45_000);
    this.motionThreshold = Math.max(0.005, options.motionThreshold ?? 0.035);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get present(): boolean {
    return this._present;
  }

  setEnabled(on: boolean): void {
    this._enabled = on;
    if (!on) {
      this._present = false;
      this.prevLuma = null;
      this.lastMotionAtMs = 0;
      this.firstDetectedAtMs = null;
    }
  }

  processFrame(
    luma: Uint8Array,
    width: number,
    height: number,
    nowMs = Date.now(),
  ): PresenceUpdate {
    if (!this._enabled) {
      return {
        enabled: false,
        present: false,
        action: "none",
        gazeTarget: null,
        motionScore: 0,
      };
    }

    const sample = analyzeWebcamPresenceFrame(
      luma,
      this.prevLuma,
      width,
      height,
      this.motionThreshold,
    );
    this.prevLuma = new Uint8Array(luma);

    let action: PresenceUpdate["action"] = "none";
    const activeMotion = sample.brightness >= 0.06 && sample.motionScore >= this.motionThreshold * 0.5;
    if (activeMotion) {
      this.lastMotionAtMs = nowMs;
      if (this.firstDetectedAtMs === null) {
        this.firstDetectedAtMs = nowMs;
      }
      if (!this._present && nowMs - this.firstDetectedAtMs >= this.presentConfirmMs) {
        this._present = true;
        action = "wake";
      }
    } else if (sample.brightness < 0.05 || (this.lastMotionAtMs > 0 && nowMs - this.lastMotionAtMs >= this.awayTimeoutMs)) {
      this.firstDetectedAtMs = null;
      if (this._present) {
        this._present = false;
        action = "sleep";
      }
    }

    return {
      enabled: true,
      present: this._present,
      action,
      gazeTarget: this._present ? sample.gazeTarget : null,
      motionScore: sample.motionScore,
    };
  }
}

// --- Per-Model Avatar Framing, Ergonomics & Multi-Monitor Visibility ---

export interface ModelFraming {
  scale: number;
  offsetX: number;
  offsetY: number;
  rimLight: number;
  outlineThickness: number;
}

export const DEFAULT_MODEL_FRAMING: Readonly<ModelFraming> = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rimLight: 1,
  outlineThickness: 1,
};

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** Clamps untrusted/stored per-model framing overrides to ergonomic bounds. */
export function clampModelFraming(raw: Partial<ModelFraming> | null | undefined): ModelFraming {
  return {
    scale: clampFinite(raw?.scale, 0.45, 2.2, DEFAULT_MODEL_FRAMING.scale),
    offsetX: clampFinite(raw?.offsetX, -0.6, 0.6, DEFAULT_MODEL_FRAMING.offsetX),
    offsetY: clampFinite(raw?.offsetY, -0.6, 0.6, DEFAULT_MODEL_FRAMING.offsetY),
    rimLight: clampFinite(raw?.rimLight, 0.4, 1.8, DEFAULT_MODEL_FRAMING.rimLight),
    outlineThickness: clampFinite(
      raw?.outlineThickness,
      0,
      2.5,
      DEFAULT_MODEL_FRAMING.outlineThickness,
    ),
  };
}

/** Computes next zoom scale from a mouse-wheel event (scrolling up zooms in). */
export function computeWheelZoom(currentScale: number, deltaY: number): number {
  const safeScale = clampFinite(currentScale, 0.45, 2.2, 1);
  if (!Number.isFinite(deltaY) || deltaY === 0) return safeScale;
  const clampedDelta = Math.max(-240, Math.min(240, deltaY));
  const factor = Math.exp(-clampedDelta * 0.0016);
  return Math.max(0.45, Math.min(2.2, safeScale * factor));
}

/** Computes next normalized framing offset from pointer drag pixel deltas. */
export function computeDragPan(
  current: { offsetX: number; offsetY: number },
  dxPx: number,
  dyPx: number,
  canvasHeight: number,
  scale: number,
): { offsetX: number; offsetY: number } {
  const h = Math.max(120, Number.isFinite(canvasHeight) ? canvasHeight : 430);
  const s = clampFinite(scale, 0.45, 2.2, 1);
  const stepX = (Number.isFinite(dxPx) ? dxPx : 0) / (h * s);
  const stepY = -(Number.isFinite(dyPx) ? dyPx : 0) / (h * s);
  return {
    offsetX: clampFinite(current.offsetX + stepX, -0.6, 0.6, 0),
    offsetY: clampFinite(current.offsetY + stepY, -0.6, 0.6, 0),
  };
}

/** Computes camera position/target for any bounding box and per-model framing overrides. */
export function computeFramedCamera(
  bounds: { centerX: number; centerY: number; height: number },
  fovRad: number,
  framing: ModelFraming,
): { position: [number, number, number]; target: [number, number, number]; maxZ: number } {
  const safeFraming = clampModelFraming(framing);
  const safeHeight = Math.max(1, Number.isFinite(bounds.height) ? bounds.height : 20);
  const safeFov = Math.max(0.05, Number.isFinite(fovRad) ? fovRad : (20 * Math.PI) / 180);
  const baseDistance = (safeHeight * 0.56) / Math.tan(safeFov / 2);
  const distance = baseDistance / safeFraming.scale;
  const targetX = (Number.isFinite(bounds.centerX) ? bounds.centerX : 0) - safeFraming.offsetX * safeHeight;
  const targetY = (Number.isFinite(bounds.centerY) ? bounds.centerY : 10) - safeFraming.offsetY * safeHeight;
  return {
    position: [targetX, targetY, -distance],
    target: [targetX, targetY, 0],
    maxZ: Math.max(200, distance * 4),
  };
}

/**
 * True when a reasonable portion (>= 48px wide and tall) of `bounds` intersects
 * at least one active monitor workArea, catching windows stranded on unplugged monitors.
 */
export function isBoundsOnAnyDisplay(
  bounds: { x: number; y: number; width: number; height: number },
  displays: readonly DisplayWorkArea[],
  minVisiblePx = 48,
): boolean {
  if (displays.length === 0) return false;
  return displays.some((d) => {
    const overlapW = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x);
    const overlapH = Math.min(bounds.y + bounds.height, d.y + d.height) - Math.max(bounds.y, d.y);
    return overlapW >= Math.min(minVisiblePx, bounds.width) && overlapH >= Math.min(minVisiblePx, bounds.height);
  });
}
