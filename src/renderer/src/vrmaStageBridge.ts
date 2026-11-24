import type { Gesture } from "../../shared/gestures.ts";
import type { ExpressiveCueFrame } from "../../shared/visemes.ts";
import { parseVrmaBinary, type QuatTuple, type Vec3Tuple, type VrmaClip } from "../../shared/vrma.ts";
import { ProceduralAvatarController, type AvatarFramePose } from "./avatarAnimator.ts";

/**
 * Isolated VRM Animation & Upper-Body IK Stage Bridge (`experimental`).
 *
 * Connects `.vrma` binary animation buffers, cursor/window gaze tracking, and vocal
 * expressive cues through `ProceduralAvatarController` onto generic bone/expression
 * sinks so `stage.ts` or standalone preview canvases can drive VRM rigs without touching `main.ts`.
 */

export interface VrmPoseTargetSink {
  setBoneRotation(boneName: string, quat: QuatTuple): void;
  setHipsTranslation(offset: Vec3Tuple): void;
  setExpressionWeight(name: string, weight: number): void;
  setEyeGaze(yawDeg: number, pitchDeg: number): void;
}

export class VrmaStageBridge {
  readonly controller: ProceduralAvatarController;
  private lastPose: AvatarFramePose | null = null;

  constructor(controller = new ProceduralAvatarController()) {
    this.controller = controller;
  }

  loadVrmaBytes(bytes: Uint8Array, options: { fadeSec?: number; loop?: boolean } = {}): VrmaClip {
    const clip = parseVrmaBinary(bytes);
    this.controller.playClip(clip, options);
    return clip;
  }

  clearClip(fadeSec = 0.25): void {
    this.controller.stopClip(fadeSec);
  }

  /** Converts normalized cursor/active-window coords (`[-1, 1]`) into anatomical gaze angles. */
  lookAtNormalized(normX: number, normY: number): void {
    const cx = Math.max(-1, Math.min(1, Number.isFinite(normX) ? normX : 0));
    const cy = Math.max(-1, Math.min(1, Number.isFinite(normY) ? normY : 0));
    this.controller.setLookTarget(cx * 36, cy * 22);
  }

  triggerGesture(kind: Gesture): void {
    this.controller.triggerGesture(kind);
  }

  applyExpressiveCue(
    cue: Pick<
      ExpressiveCueFrame,
      "emphasis" | "pause" | "laugh" | "eyebrowRaise" | "headTiltDeg" | "nodDrive" | "postureEnergy"
    >,
  ): void {
    this.controller.setExpressiveCue(cue);
  }

  step(dtSec: number, sink?: VrmPoseTargetSink): AvatarFramePose {
    const pose = this.controller.step(dtSec);
    this.lastPose = pose;
    if (sink) {
      for (const [bone, quat] of Object.entries(pose.boneRotations)) {
        sink.setBoneRotation(bone, quat);
      }
      sink.setHipsTranslation(pose.hipsOffset);
      for (const [expr, val] of Object.entries(pose.expressions)) {
        sink.setExpressionWeight(expr, val);
      }
      sink.setEyeGaze(pose.eyeYawDeg, pose.eyePitchDeg);
    }
    return pose;
  }

  currentPose(): AvatarFramePose | null {
    return this.lastPose;
  }
}
