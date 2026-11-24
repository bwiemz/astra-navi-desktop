import type { Avatar2DDriveState } from "../../shared/avatar2d.ts";
import type { Mood } from "../../shared/ipc.ts";
import type { StageLightingState } from "../../shared/spatialStage.ts";
import type { QuatTuple } from "../../shared/vrma.ts";
import type { AvatarFramePose, ProceduralAvatarController } from "./avatarAnimator.ts";
import type { Canvas2DAvatarRenderer } from "./canvas2dStage.ts";
import type { StageLightingController } from "./stageLighting.ts";
import type { VrmaStageBridge, VrmPoseTargetSink } from "./vrmaStageBridge.ts";

/**
 * Modular, error-isolated layer seam onto `Stage` so experimental animation,
 * circadian/ambient lighting, VRMA clip crossfading, and 2D fallback renderers
 * plug in cleanly without bloating `stage.ts`.
 */
export interface StageLayerHost {
  readonly canvas: HTMLCanvasElement;
  readonly scene: unknown;
  readonly camera: unknown;
  readonly skyLight: unknown;
  readonly sunLight: unknown;
}

export interface StageLayerFrameContext {
  dtSec: number;
  elapsedSec: number;
  mood: Mood;
  thinking: boolean;
  listening: boolean;
  asleep: boolean;
  voiceLevel: number | null;
  mouthOpen: number;
  hasModel: boolean;
  setBoneRotation(bone: string, quat: QuatTuple): void;
  setMorphWeight(name: string, weight: number): void;
  applyLighting(state: StageLightingState): void;
}

export interface StageLayer {
  readonly id: string;
  readonly priority: number;
  enabled: boolean;
  mount?(host: StageLayerHost): void;
  update(frame: StageLayerFrameContext): void;
  dispose?(): void | Promise<void>;
}

export class StageLayerManager {
  private host: StageLayerHost | null = null;
  private layers: StageLayer[] = [];

  attachHost(host: StageLayerHost): void {
    this.host = host;
    for (const layer of this.layers) {
      this.safeMount(layer, host);
    }
  }

  register(layer: StageLayer): void {
    const existingIdx = this.layers.findIndex((item) => item.id === layer.id);
    if (existingIdx >= 0) {
      const [prev] = this.layers.splice(existingIdx, 1);
      if (prev) this.safeDispose(prev);
    }
    this.layers.push(layer);
    this.layers.sort((a, b) => a.priority - b.priority);
    if (this.host) {
      this.safeMount(layer, this.host);
    }
  }

  unregister(id: string): boolean {
    const idx = this.layers.findIndex((layer) => layer.id === id);
    if (idx < 0) return false;
    const [removed] = this.layers.splice(idx, 1);
    if (removed) this.safeDispose(removed);
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const layer = this.layers.find((item) => item.id === id);
    if (!layer) return false;
    layer.enabled = enabled;
    return true;
  }

  get(id: string): StageLayer | undefined {
    return this.layers.find((layer) => layer.id === id);
  }

  list(): readonly StageLayer[] {
    return [...this.layers];
  }

  update(frame: StageLayerFrameContext): void {
    for (const layer of this.layers) {
      if (!layer.enabled) continue;
      try {
        layer.update(frame);
      } catch (error) {
        console.warn(`[stageLayers] layer "${layer.id}" update failed:`, error);
      }
    }
  }

  dispose(): void {
    for (const layer of this.layers) {
      this.safeDispose(layer);
    }
    this.layers = [];
    this.host = null;
  }

  private safeMount(layer: StageLayer, host: StageLayerHost): void {
    if (!layer.mount) return;
    try {
      layer.mount(host);
    } catch (error) {
      console.warn(`[stageLayers] layer "${layer.id}" mount failed:`, error);
    }
  }

  private safeDispose(layer: StageLayer): void {
    if (!layer.dispose) return;
    try {
      void Promise.resolve(layer.dispose()).catch((error) => {
        console.warn(`[stageLayers] layer "${layer.id}" dispose failed:`, error);
      });
    } catch (error) {
      console.warn(`[stageLayers] layer "${layer.id}" dispose failed:`, error);
    }
  }
}

/** Adapter mounting `ProceduralAvatarController` onto `StageLayerManager`. */
export function createAvatarAnimatorLayer(
  controller: ProceduralAvatarController,
  options: {
    priority?: number;
    enabled?: boolean;
    onPose?: (pose: AvatarFramePose, frame: StageLayerFrameContext) => void;
  } = {},
): StageLayer {
  return {
    id: "avatar-animator",
    priority: options.priority ?? 10,
    enabled: options.enabled ?? true,
    update(frame) {
      const pose = controller.step(frame.dtSec);
      if (options.onPose) {
        options.onPose(pose, frame);
        return;
      }
      if (!frame.hasModel) return;
      for (const [bone, quat] of Object.entries(pose.boneRotations)) {
        frame.setBoneRotation(bone, quat);
      }
      for (const [expr, weight] of Object.entries(pose.expressions)) {
        frame.setMorphWeight(expr, weight);
      }
    },
  };
}

/** Adapter mounting `VrmaStageBridge` onto `StageLayerManager`. */
export function createVrmaBridgeLayer(
  bridge: VrmaStageBridge,
  options: {
    priority?: number;
    enabled?: boolean;
    resolveSink?: (frame: StageLayerFrameContext) => VrmPoseTargetSink | undefined;
  } = {},
): StageLayer {
  return {
    id: "vrma-bridge",
    priority: options.priority ?? 20,
    enabled: options.enabled ?? true,
    update(frame) {
      const sink: VrmPoseTargetSink | undefined = options.resolveSink
        ? options.resolveSink(frame)
        : frame.hasModel
          ? {
              setBoneRotation: (boneName, quat) => frame.setBoneRotation(boneName, quat),
              setHipsTranslation: () => undefined,
              setExpressionWeight: (name, weight) => frame.setMorphWeight(name, weight),
              setEyeGaze: () => undefined,
            }
          : undefined;
      bridge.step(frame.dtSec, sink);
    },
  };
}

/** Adapter mounting `StageLightingController` onto `StageLayerManager`. */
export function createStageLightingLayer(
  controller: StageLightingController,
  sampleInput: (frame: StageLayerFrameContext) => Parameters<StageLightingController["step"]>[0] = () => ({}),
  options: { priority?: number; enabled?: boolean } = {},
): StageLayer {
  return {
    id: "stage-lighting",
    priority: options.priority ?? 30,
    enabled: options.enabled ?? true,
    update(frame) {
      const lighting = controller.step(sampleInput(frame));
      frame.applyLighting(lighting);
    },
  };
}

/** Adapter mounting `Canvas2DAvatarRenderer` onto `StageLayerManager`. */
export function createCanvas2DLayer(
  renderer: Canvas2DAvatarRenderer,
  buildDriveState?: (frame: StageLayerFrameContext) => Avatar2DDriveState,
  options: { priority?: number; enabled?: boolean } = {},
): StageLayer {
  return {
    id: "canvas-2d",
    priority: options.priority ?? 40,
    enabled: options.enabled ?? true,
    update(frame) {
      const state: Avatar2DDriveState = buildDriveState
        ? buildDriveState(frame)
        : {
            mood: frame.mood,
            visemes: {
              A: Math.min(1, frame.mouthOpen * 0.85),
              I: 0,
              U: 0,
              E: 0,
              O: Math.min(1, frame.mouthOpen * 0.45),
            },
            blink: frame.asleep ? 1 : 0,
            gazeX: 0,
            gazeY: 0,
          };
      renderer.renderFrame(state);
    },
    dispose() {
      return renderer.dispose();
    },
  };
}
