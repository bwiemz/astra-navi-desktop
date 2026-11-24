import {
  evaluateLayeredSpritePose,
  type Avatar2DDriveState,
  type Avatar2DRenderer,
  type EvaluatedSpriteLayer,
  type LayeredSpriteRigManifest,
} from "../../shared/avatar2d.ts";

/**
 * Zero-WebGL 2D Canvas Layered-Sprite / PNGTuber Renderer (`Avatar2DRenderer`).
 *
 * Designed for low-power laptops, virtual machines, or users who disable WebGL 3D.
 * Evaluates deterministic layer transforms/visemes via `evaluateLayeredSpritePose()`
 * and draws cached local sprite assets onto any `CanvasRenderingContext2D`-like surface.
 */

export interface Canvas2DContextLike {
  clearRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angleRad: number): void;
  scale(x: number, y: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  globalAlpha: number;
}

export class Canvas2DAvatarRenderer implements Avatar2DRenderer {
  readonly kind = "layered-sprite" as const;
  private manifest: LayeredSpriteRigManifest | null = null;
  private readonly ctx: Canvas2DContextLike | null;
  private readonly assetCache = new Map<string, unknown>();
  private readonly loadAsset: (assetPath: string) => Promise<unknown>;
  private lastLayers: EvaluatedSpriteLayer[] = [];

  constructor(
    options: {
      ctx?: Canvas2DContextLike | null;
      loadAsset?: (assetPath: string) => Promise<unknown>;
    } = {},
  ) {
    this.ctx = options.ctx ?? null;
    this.loadAsset = options.loadAsset ?? (async (assetPath) => ({ src: assetPath }));
  }

  async load(manifest: LayeredSpriteRigManifest): Promise<void> {
    this.manifest = manifest;
    const needed = new Set<string>(manifest.layers.map((l) => l.asset));
    for (const v of Object.values(manifest.visemeAssets)) if (v) needed.add(v);
    if (manifest.blinkEyeAsset) needed.add(manifest.blinkEyeAsset);
    for (const m of Object.values(manifest.moodOverlays)) if (m) needed.add(m);

    await Promise.all(
      [...needed].map(async (assetPath) => {
        if (!this.assetCache.has(assetPath)) {
          this.assetCache.set(assetPath, await this.loadAsset(assetPath));
        }
      }),
    );
  }

  renderFrame(state: Avatar2DDriveState): void {
    if (!this.manifest) return;
    const layers = evaluateLayeredSpritePose(this.manifest, state);
    this.lastLayers = layers;
    if (!this.ctx) return;

    const w = this.manifest.width;
    const h = this.manifest.height;
    this.ctx.clearRect(0, 0, w, h);

    for (const layer of layers) {
      const spec = this.manifest.layers.find((l) => l.id === layer.id);
      const ax = (spec?.anchorX ?? 0.5) * w;
      const ay = (spec?.anchorY ?? 0.5) * h;
      const img = this.assetCache.get(layer.asset);
      this.ctx.save();
      this.ctx.globalAlpha = layer.opacity;
      this.ctx.translate(ax + layer.translateX, ay + layer.translateY);
      this.ctx.rotate((layer.rotateDeg * Math.PI) / 180);
      this.ctx.scale(layer.scale, layer.scale);
      if (img) {
        this.ctx.drawImage(img, -ax, -ay, w, h);
      }
      this.ctx.restore();
    }
  }

  lastEvaluatedLayers(): readonly EvaluatedSpriteLayer[] {
    return this.lastLayers;
  }

  async dispose(): Promise<void> {
    this.assetCache.clear();
    this.manifest = null;
    this.lastLayers = [];
  }
}
