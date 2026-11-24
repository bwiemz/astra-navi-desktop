import {
  blendExpressiveGesture,
  evaluateGestureMotion,
  GESTURES,
  type Gesture,
} from "../../shared/gestures.ts";
import type { ExpressiveCueFrame } from "../../shared/visemes.ts";
import {
  sampleVrmaClip,
  slerpQuat,
  type QuatTuple,
  type Vec3Tuple,
  type VrmaClip,
} from "../../shared/vrma.ts";

/**
 * Standalone Procedural Animation, Clip Crossfader & Damped-Spring Look-At Controller.
 *
 * Designed without DOM/Babylon coupling so it can layer `.vrma` clips, breathing,
 * idle weight shifting, critically damped spring head/neck/eye look-at IK, and real-time
 * vocal expression cues cleanly in unit tests and inside `stage.ts`.
 */

export interface AvatarFramePose {
  clipActive: boolean;
  clipBlendWeight: number;
  boneRotations: Record<string, QuatTuple>;
  hipsOffset: Vec3Tuple;
  expressions: Record<string, number>;
  headYawDeg: number;
  headPitchDeg: number;
  eyeYawDeg: number;
  eyePitchDeg: number;
  eyebrowRaise: number;
  headTiltDeg: number;
  breathPhase: number;
}

export interface SpringChannel {
  value: number;
  velocity: number;
}

const DEG_TO_RAD = Math.PI / 180;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function eulerDegToQuat(pitchDeg: number, yawDeg: number, rollDeg: number): QuatTuple {
  const hx = (pitchDeg * DEG_TO_RAD) / 2;
  const hy = (yawDeg * DEG_TO_RAD) / 2;
  const hz = (rollDeg * DEG_TO_RAD) / 2;
  const cx = Math.cos(hx);
  const sx = Math.sin(hx);
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cz = Math.cos(hz);
  const sz = Math.sin(hz);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function mulQuat(a: QuatTuple, b: QuatTuple): QuatTuple {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Unconditionally stable critically damped spring step (`zeta = 1.0`, exact exponential
 * formulation), keeping head/neck/eye transitions organic without overshoot.
 */
export function stepDampedSpring(
  state: SpringChannel,
  target: number,
  omegaRadSec: number,
  dtSec: number,
): SpringChannel {
  const dt = clamp(Number.isFinite(dtSec) ? dtSec : 0, 0, 0.25);
  const omega = Math.max(0.5, omegaRadSec);
  const diff = state.value - target;
  const temp = (state.velocity + omega * diff) * dt;
  const decay = Math.exp(-omega * dt);
  return {
    value: target + (diff + temp) * decay,
    velocity: (state.velocity - omega * temp) * decay,
  };
}

interface ActiveClipSlot {
  clip: VrmaClip;
  timeSec: number;
  loop: boolean;
}

export class ProceduralAvatarController {
  private elapsedSec = 0;
  private activeClip: ActiveClipSlot | null = null;
  private prevClip: ActiveClipSlot | null = null;
  private fadeElapsedSec = 0;
  private fadeDurationSec = 0.25;
  private fadeOutOnly = false;

  private targetYawDeg = 0;
  private targetPitchDeg = 0;
  private headYaw: SpringChannel = { value: 0, velocity: 0 };
  private headPitch: SpringChannel = { value: 0, velocity: 0 };
  private eyeYaw: SpringChannel = { value: 0, velocity: 0 };
  private eyePitch: SpringChannel = { value: 0, velocity: 0 };

  private gestureKind: Gesture | null = null;
  private gestureElapsedSec = 0;
  private gestureDurationSec = 1;

  private cue: Pick<
    ExpressiveCueFrame,
    "emphasis" | "pause" | "laugh" | "eyebrowRaise" | "headTiltDeg" | "nodDrive" | "postureEnergy"
  > = {
    emphasis: 0,
    pause: true,
    laugh: 0,
    eyebrowRaise: 0,
    headTiltDeg: 0,
    nodDrive: 0,
    postureEnergy: 1,
  };

  readonly maxHeadYawDeg = 38;
  readonly maxHeadPitchDeg = 24;
  readonly maxEyeYawDeg = 16;
  readonly maxEyePitchDeg = 12;

  playClip(clip: VrmaClip, options: { fadeSec?: number; loop?: boolean } = {}): void {
    const fadeSec = Math.max(0, options.fadeSec ?? 0.25);
    this.prevClip = this.activeClip ? { ...this.activeClip } : null;
    this.activeClip = {
      clip,
      timeSec: 0,
      loop: options.loop ?? true,
    };
    this.fadeElapsedSec = 0;
    this.fadeDurationSec = fadeSec;
    this.fadeOutOnly = false;
  }

  stopClip(fadeSec = 0.25): void {
    if (!this.activeClip) return;
    this.prevClip = { ...this.activeClip };
    this.activeClip = null;
    this.fadeElapsedSec = 0;
    this.fadeDurationSec = Math.max(0.01, fadeSec);
    this.fadeOutOnly = true;
  }

  setLookTarget(yawDeg: number, pitchDeg: number): void {
    this.targetYawDeg = Number.isFinite(yawDeg) ? clamp(yawDeg, -75, 75) : 0;
    this.targetPitchDeg = Number.isFinite(pitchDeg) ? clamp(pitchDeg, -45, 45) : 0;
  }

  triggerGesture(kind: Gesture): void {
    this.gestureKind = kind;
    this.gestureElapsedSec = 0;
    this.gestureDurationSec = GESTURES[kind];
  }

  setExpressiveCue(
    cue: Pick<
      ExpressiveCueFrame,
      "emphasis" | "pause" | "laugh" | "eyebrowRaise" | "headTiltDeg" | "nodDrive" | "postureEnergy"
    >,
  ): void {
    this.cue = { ...cue };
  }

  step(rawDtSec: number): AvatarFramePose {
    const dt = clamp(Number.isFinite(rawDtSec) ? rawDtSec : 0, 0, 0.25);
    this.elapsedSec += dt;

    if (this.activeClip) {
      this.activeClip.timeSec += dt;
      if (!this.activeClip.loop && this.activeClip.timeSec >= this.activeClip.clip.durationSec) {
        this.activeClip.timeSec = this.activeClip.clip.durationSec;
      }
    }
    if (this.prevClip) {
      this.prevClip.timeSec += dt;
    }

    this.fadeElapsedSec += dt;
    const fadeProgress =
      this.fadeDurationSec > 1e-4 ? clamp(this.fadeElapsedSec / this.fadeDurationSec, 0, 1) : 1;
    if (fadeProgress >= 1) {
      this.prevClip = null;
      this.fadeOutOnly = false;
    }

    const headGoalYaw = clamp(this.targetYawDeg * 0.72, -this.maxHeadYawDeg, this.maxHeadYawDeg);
    const headGoalPitch = clamp(
      this.targetPitchDeg * 0.7,
      -this.maxHeadPitchDeg,
      this.maxHeadPitchDeg,
    );
    const eyeGoalYaw = clamp(
      this.targetYawDeg - headGoalYaw * 0.65,
      -this.maxEyeYawDeg,
      this.maxEyeYawDeg,
    );
    const eyeGoalPitch = clamp(
      this.targetPitchDeg - headGoalPitch * 0.65,
      -this.maxEyePitchDeg,
      this.maxEyePitchDeg,
    );

    this.headYaw = stepDampedSpring(this.headYaw, headGoalYaw, 9.5, dt);
    this.headPitch = stepDampedSpring(this.headPitch, headGoalPitch, 9.5, dt);
    this.eyeYaw = stepDampedSpring(this.eyeYaw, eyeGoalYaw, 22, dt);
    this.eyePitch = stepDampedSpring(this.eyePitch, eyeGoalPitch, 22, dt);

    let gestureSample = evaluateGestureMotion("nod", 0);
    if (this.gestureKind) {
      this.gestureElapsedSec += dt;
      const phase = this.gestureElapsedSec / Math.max(0.1, this.gestureDurationSec);
      if (phase >= 1) {
        this.gestureKind = null;
      } else {
        gestureSample = evaluateGestureMotion(this.gestureKind, phase);
      }
    }
    const blendedCue = blendExpressiveGesture(gestureSample, this.cue);

    const energy = blendedCue.postureEnergy;
    const breathPhase = this.elapsedSec * 1.45 * (0.85 + 0.15 * energy);
    const breathSin = Math.sin(breathPhase);
    const weightShiftX = Math.sin(this.elapsedSec * 0.42) * 0.014 * energy;
    const weightShiftY = Math.abs(Math.sin(breathPhase * 0.5)) * 0.006 * energy;

    const boneRotations: Record<string, QuatTuple> = {
      hips: eulerDegToQuat(0, Math.sin(this.elapsedSec * 0.42) * 1.8, 0),
      spine: eulerDegToQuat(breathSin * 1.6, this.headYaw.value * 0.18, 0),
      chest: eulerDegToQuat(breathSin * 2.1, this.headYaw.value * 0.16, 0),
      neck: eulerDegToQuat(
        this.headPitch.value * 0.35 + blendedCue.nod * 6,
        this.headYaw.value * 0.35,
        blendedCue.headTiltDeg * 0.35,
      ),
      head: eulerDegToQuat(
        this.headPitch.value * 0.65 + blendedCue.nod * 10,
        this.headYaw.value * 0.65 + blendedCue.shake * 14,
        blendedCue.headTiltDeg * 0.65,
      ),
    };
    const hipsOffset: Vec3Tuple = [weightShiftX, weightShiftY, 0];
    const expressions: Record<string, number> = {};

    const sampleA = this.activeClip
      ? sampleVrmaClip(this.activeClip.clip, this.activeClip.timeSec, this.activeClip.loop)
      : null;
    const sampleP = this.prevClip
      ? sampleVrmaClip(this.prevClip.clip, this.prevClip.timeSec, this.prevClip.loop)
      : null;

    let clipBlendWeight = 0;
    if (sampleA) {
      clipBlendWeight = sampleP ? fadeProgress : 1;
      for (const bone of new Set([
        ...Object.keys(sampleA.humanoidRotations),
        ...(sampleP ? Object.keys(sampleP.humanoidRotations) : []),
      ])) {
        const qa = sampleA.humanoidRotations[bone] ?? boneRotations[bone] ?? [0, 0, 0, 1];
        const qp = sampleP?.humanoidRotations[bone];
        const clipQ = qp ? slerpQuat(qp, qa, fadeProgress) : qa;
        const proc = boneRotations[bone];
        boneRotations[bone] =
          bone === "head" || bone === "neck"
            ? mulQuat(clipQ, proc ?? [0, 0, 0, 1])
            : clipQ;
      }
      if (sampleA.hipsTranslation) {
        hipsOffset[0] += sampleA.hipsTranslation[0];
        hipsOffset[1] += sampleA.hipsTranslation[1];
        hipsOffset[2] += sampleA.hipsTranslation[2];
      }
      for (const [k, v] of Object.entries(sampleA.expressions)) {
        const prevV = sampleP?.expressions[k] ?? 0;
        expressions[k] = sampleP ? prevV * (1 - fadeProgress) + v * fadeProgress : v;
      }
    } else if (sampleP && this.fadeOutOnly) {
      clipBlendWeight = 1 - fadeProgress;
      for (const [bone, qp] of Object.entries(sampleP.humanoidRotations)) {
        const proc = boneRotations[bone] ?? [0, 0, 0, 1];
        boneRotations[bone] = slerpQuat(qp, proc, fadeProgress);
      }
    }

    return {
      clipActive: Boolean(this.activeClip),
      clipBlendWeight: Number(clipBlendWeight.toFixed(4)),
      boneRotations,
      hipsOffset,
      expressions,
      headYawDeg: Number(clamp(this.headYaw.value, -this.maxHeadYawDeg, this.maxHeadYawDeg).toFixed(2)),
      headPitchDeg: Number(
        clamp(this.headPitch.value, -this.maxHeadPitchDeg, this.maxHeadPitchDeg).toFixed(2),
      ),
      eyeYawDeg: Number(clamp(this.eyeYaw.value, -this.maxEyeYawDeg, this.maxEyeYawDeg).toFixed(2)),
      eyePitchDeg: Number(
        clamp(this.eyePitch.value, -this.maxEyePitchDeg, this.maxEyePitchDeg).toFixed(2),
      ),
      eyebrowRaise: blendedCue.eyebrowRaise,
      headTiltDeg: blendedCue.headTiltDeg,
      breathPhase,
    };
  }
}
