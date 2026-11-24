/**
 * Expanded catalog of mocap-inspired conversation gestures and kinematic evaluation curves
 * shared between the 3D WebGL stage (`renderer/src/stage.ts`), plugins, and unit tests.
 */
import type { ExpressiveCueFrame } from "./visemes.ts";

export const GESTURES = {
  nod: 0.9,
  shake: 1.0,
  perk: 0.7,
  wave: 2.0,
  think: 1.8,
  point: 1.4,
  shrug: 1.3,
  salute: 1.5,
  cheer: 1.7,
  bow: 1.5,
} as const;

export type Gesture = keyof typeof GESTURES;

export interface GestureMotionSample {
  nod: number;
  shake: number;
  perk: number;
  wave: number;
  waveSwing: number;
  think: number;
  point: number;
  shrug: number;
  salute: number;
  cheer: number;
  bow: number;
}

function easeInOutCubic(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Evaluates normalized gesture kinematic channels at progress `phase` in `[0, 1]`. */
export function evaluateGestureMotion(kind: Gesture, phase: number): GestureMotionSample {
  const out: GestureMotionSample = {
    nod: 0,
    shake: 0,
    perk: 0,
    wave: 0,
    waveSwing: 0,
    think: 0,
    point: 0,
    shrug: 0,
    salute: 0,
    cheer: 0,
    bow: 0,
  };
  if (phase <= 0 || phase >= 1) return out;
  const bell = Math.sin(phase * Math.PI);
  const ramp = Math.min(
    1,
    easeInOutCubic(Math.min(1, phase * 4.2)),
    easeInOutCubic(Math.min(1, (1 - phase) * 4.2)),
  );

  switch (kind) {
    case "nod":
      out.nod = Math.sin(phase * Math.PI * 4) * bell;
      break;
    case "shake":
      out.shake = Math.sin(phase * Math.PI * 5) * bell;
      break;
    case "perk":
      out.perk = bell;
      break;
    case "wave":
      out.wave = Math.min(1, phase * 5, (1 - phase) * 5);
      out.waveSwing = Math.sin(phase * Math.PI * 7) * out.wave;
      break;
    case "think":
      out.think = ramp;
      break;
    case "point":
      out.point = ramp;
      break;
    case "shrug":
      out.shrug = ramp;
      break;
    case "salute":
      out.salute = ramp;
      break;
    case "cheer":
      out.cheer = ramp;
      out.waveSwing = Math.sin(phase * Math.PI * 6) * ramp;
      break;
    case "bow":
      out.bow = easeInOutCubic(Math.sin(phase * Math.PI));
      break;
  }
  return out;
}

export interface ExpressiveGestureBlend extends GestureMotionSample {
  eyebrowRaise: number;
  headTiltDeg: number;
  emphasis: number;
  laughBounce: number;
  postureEnergy: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Merges real-time vocal cue envelopes into the base procedural gesture motion sample. */
export function blendExpressiveGesture(
  base: GestureMotionSample,
  cue: Pick<
    ExpressiveCueFrame,
    "emphasis" | "pause" | "laugh" | "eyebrowRaise" | "headTiltDeg" | "nodDrive" | "postureEnergy"
  >,
): ExpressiveGestureBlend {
  const nodAdd = cue.pause ? 0 : cue.nodDrive * 0.45;
  const perkAdd = clamp01(cue.emphasis * 0.35 + cue.laugh * 0.4);
  return {
    ...base,
    nod: Math.max(-1, Math.min(1, base.nod + nodAdd)),
    perk: clamp01(base.perk + perkAdd),
    eyebrowRaise: clamp01(cue.eyebrowRaise),
    headTiltDeg: Math.max(-15, Math.min(15, cue.headTiltDeg)),
    emphasis: clamp01(cue.emphasis),
    laughBounce: clamp01(cue.laugh),
    postureEnergy: Math.max(0.5, Math.min(1.6, cue.postureEnergy)),
  };
}
