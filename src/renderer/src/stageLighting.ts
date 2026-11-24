import {
  blendAmbientScreenLighting,
  computeTimeOfDayLighting,
  sampleEdgeAmbientColor,
  type StageLightingState,
} from "../../shared/spatialStage.ts";

/**
 * Smooth EMA Screen-Ambient & Circadian Stage Lighting Controller.
 *
 * Samples low-resolution edge strips from desktop frames + local clock time and
 * smoothly blends rim/fill lighting so the 3D avatar adapts naturally to bright IDEs,
 * dark code editors, or warm evening games without jarring color pops.
 */

export class StageLightingController {
  private current: StageLightingState;
  private readonly smoothingAlpha: number;
  private readonly screenStrength: number;

  constructor(options: { smoothingAlpha?: number; screenStrength?: number } = {}) {
    this.smoothingAlpha = Math.max(0.02, Math.min(1, options.smoothingAlpha ?? 0.2));
    this.screenStrength = Math.max(0, Math.min(0.8, options.screenStrength ?? 0.45));
    this.current = computeTimeOfDayLighting();
  }

  step(input: {
    now?: Date;
    edgePixels?: Uint8Array;
    width?: number;
    height?: number;
    channels?: 3 | 4;
  }): StageLightingState {
    const base = computeTimeOfDayLighting(input.now ?? new Date());
    const target =
      input.edgePixels && input.width && input.height
        ? blendAmbientScreenLighting(
            base,
            sampleEdgeAmbientColor(
              input.edgePixels,
              input.width,
              input.height,
              input.channels ?? 4,
            ),
            this.screenStrength,
          )
        : base;

    const a = this.smoothingAlpha;
    const mix3 = (
      x: readonly [number, number, number],
      y: readonly [number, number, number],
    ): [number, number, number] => [
      x[0] + (y[0] - x[0]) * a,
      x[1] + (y[1] - x[1]) * a,
      x[2] + (y[2] - x[2]) * a,
    ];

    this.current = {
      skyColor: mix3(this.current.skyColor, target.skyColor),
      groundColor: mix3(this.current.groundColor, target.groundColor),
      sunColor: mix3(this.current.sunColor, target.sunColor),
      sunDirection: mix3(this.current.sunDirection, target.sunDirection),
      skyIntensity: this.current.skyIntensity + (target.skyIntensity - this.current.skyIntensity) * a,
      sunIntensity: this.current.sunIntensity + (target.sunIntensity - this.current.sunIntensity) * a,
      ambientColor: mix3(this.current.ambientColor, target.ambientColor),
      period: target.period,
    };
    return this.current;
  }

  state(): StageLightingState {
    return this.current;
  }
}
