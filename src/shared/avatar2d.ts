import { z } from "zod";
import type { Mood } from "./ipc.ts";
import type { ExpressiveCueFrame, VisemeWeights } from "./visemes.ts";

/**
 * Sandboxed Open Layered-Sprite 2D Rig Protocol & Renderer Interface.
 *
 * MIT-clean alternative to proprietary Live2D Cubism SDK binaries: renders layered PNG/WebP
 * rigs with blink, vowel viseme frame swapping, head tilt/nod springs, and expression
 * overlays, while rejecting path traversal or remote URLs in layer asset references.
 */

const SAFE_RELATIVE_ASSET_RE = /^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^:\0<>|"?*]+\.(?:png|webp|svg)$/i;

export const SafeAssetPathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((val) => !/^(?:https?:|file:|data:|javascript:)/i.test(val.trim()), {
    message: "Remote or inline URLs are forbidden in 2D rig manifests.",
  })
  .refine((val) => SAFE_RELATIVE_ASSET_RE.test(val.trim().replace(/\\/g, "/")), {
    message: "Rig layer path must be a safe relative .png/.webp/.svg path without '..' traversal.",
  });

export const SpriteLayerSchema = z.object({
  id: z.string().min(1).max(64),
  asset: SafeAssetPathSchema,
  zIndex: z.number().int().min(-100).max(100),
  anchorX: z.number().min(0).max(1).default(0.5),
  anchorY: z.number().min(0).max(1).default(0.5),
  opacity: z.number().min(0).max(1).default(1),
  role: z.enum(["base", "body", "eyes", "mouth", "brows", "overlay"]).default("overlay"),
});
export type SpriteLayerSpec = z.infer<typeof SpriteLayerSchema>;

export const LayeredSpriteRigManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(80),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  layers: z.array(SpriteLayerSchema).min(1).max(64),
  visemeAssets: z
    .object({
      closed: SafeAssetPathSchema.optional(),
      A: SafeAssetPathSchema.optional(),
      I: SafeAssetPathSchema.optional(),
      U: SafeAssetPathSchema.optional(),
      E: SafeAssetPathSchema.optional(),
      O: SafeAssetPathSchema.optional(),
    })
    .default({}),
  blinkEyeAsset: SafeAssetPathSchema.optional(),
  moodOverlays: z
    .object({
      neutral: SafeAssetPathSchema.optional(),
      happy: SafeAssetPathSchema.optional(),
      thinking: SafeAssetPathSchema.optional(),
      worried: SafeAssetPathSchema.optional(),
      excited: SafeAssetPathSchema.optional(),
      smug: SafeAssetPathSchema.optional(),
      surprised: SafeAssetPathSchema.optional(),
      sad: SafeAssetPathSchema.optional(),
    })
    .default({}),
});
export type LayeredSpriteRigManifest = z.infer<typeof LayeredSpriteRigManifestSchema>;

export interface Avatar2DDriveState {
  mood: Mood;
  visemes: VisemeWeights;
  blink: number; // 0..1
  gazeX: number; // -1..1
  gazeY: number; // -1..1
  cue?: Pick<
    ExpressiveCueFrame,
    "eyebrowRaise" | "headTiltDeg" | "nodDrive" | "emphasis" | "postureEnergy"
  >;
}

export interface EvaluatedSpriteLayer {
  id: string;
  asset: string;
  zIndex: number;
  translateX: number;
  translateY: number;
  rotateDeg: number;
  scale: number;
  opacity: number;
}

export interface Avatar2DRenderer {
  readonly kind: "layered-sprite" | "byo-external-bridge";
  load(manifest: LayeredSpriteRigManifest): Promise<void>;
  renderFrame(state: Avatar2DDriveState): void;
  dispose(): Promise<void>;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function dominantViseme(weights: VisemeWeights): keyof VisemeWeights | "closed" {
  let best: keyof VisemeWeights = "A";
  let bestVal = 0.08;
  for (const key of ["A", "I", "U", "E", "O"] as const) {
    if (weights[key] > bestVal) {
      bestVal = weights[key];
      best = key;
    }
  }
  return bestVal > 0.08 ? best : "closed";
}

/** Evaluates sorted 2D sprite layer transforms, viseme swaps, blink, and expressive motion. */
export function evaluateLayeredSpritePose(
  manifest: LayeredSpriteRigManifest,
  state: Avatar2DDriveState,
): EvaluatedSpriteLayer[] {
  const activeViseme = dominantViseme(state.visemes);
  const blinking = state.blink >= 0.55;
  const gx = clamp(state.gazeX, -1, 1);
  const gy = clamp(state.gazeY, -1, 1);
  const headTiltDeg = clamp(state.cue?.headTiltDeg ?? 0, -15, 15);
  const eyebrowRaise = clamp(state.cue?.eyebrowRaise ?? 0, 0, 1);
  const nodDrive = clamp(state.cue?.nodDrive ?? 0, 0, 1);
  const energy = clamp(state.cue?.postureEnergy ?? 1, 0.6, 1.5);
  const moodAsset = manifest.moodOverlays[state.mood];

  const sorted = [...manifest.layers].sort((a, b) => a.zIndex - b.zIndex);
  return sorted.map((layer) => {
    let asset = layer.asset;
    const translateX = gx * (layer.role === "eyes" ? 6 : layer.role === "base" ? 0 : 2.5);
    let translateY = -gy * (layer.role === "eyes" ? 4 : 1.5) + nodDrive * 3;
    let rotateDeg = layer.role === "body" || layer.role === "base" ? headTiltDeg * 0.25 : headTiltDeg;
    const scale = 1 + (layer.role === "body" ? (energy - 1) * 0.02 : 0);
    let opacity = layer.opacity;

    if (layer.role === "eyes" && blinking && manifest.blinkEyeAsset) {
      asset = manifest.blinkEyeAsset;
    } else if (layer.role === "mouth") {
      const swap = manifest.visemeAssets[activeViseme];
      if (swap) asset = swap;
    } else if (layer.role === "brows") {
      translateY -= eyebrowRaise * 5;
      rotateDeg += eyebrowRaise * -2;
    } else if (layer.role === "overlay" && moodAsset && layer.id === "mood-overlay") {
      asset = moodAsset;
      opacity = clamp(layer.opacity, 0.2, 1);
    }

    return {
      id: layer.id,
      asset,
      zIndex: layer.zIndex,
      translateX: Number(translateX.toFixed(2)),
      translateY: Number(translateY.toFixed(2)),
      rotateDeg: Number(rotateDeg.toFixed(2)),
      scale: Number(scale.toFixed(4)),
      opacity: Number(opacity.toFixed(3)),
    };
  });
}
