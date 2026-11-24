import { existsSync } from "node:fs";

/**
 * Opt-In Local ONNX Webcam Presence & Gaze Tracker.
 *
 * Strict privacy guarantees:
 * - Opt-in (`enabled` defaults to `false`).
 * - Strictly in-RAM tensor processing: zero disk writes (never imports write APIs).
 * - Explicitly zeroes reusable RGB/NCHW frame buffers on `stop()` and `dispose()`.
 * - Runs `onnxruntime-node` UltraFace/SCRFD-style `[1, 3, 240, 320]` detector when a
 *   model path is configured, falling back to an in-RAM skin-chroma/luma centroid pass.
 */

export const ONNX_FACE_INPUT_WIDTH = 320;
export const ONNX_FACE_INPUT_HEIGHT = 240;

export interface FaceDetectionBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

export interface OnnxWebcamSampleResult {
  enabled: boolean;
  present: boolean;
  confidence: number;
  gazeTarget: { x: number; y: number } | null;
  backend: "disabled" | "onnx" | "luma-fallback";
}

interface OrtSessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>;
  release?: () => Promise<void>;
}

/** Resamples packed RGB24 `[width, height]` into NCHW `[1, 3, 240, 320]` normalized in `[-1, 1]`. */
export function preprocessRgbToNchw320x240(
  rgb: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  target?: Float32Array,
): Float32Array {
  const planeSize = ONNX_FACE_INPUT_WIDTH * ONNX_FACE_INPUT_HEIGHT;
  const out =
    target && target.length === 3 * planeSize ? target : new Float32Array(3 * planeSize);
  if (srcWidth <= 0 || srcHeight <= 0 || rgb.length < srcWidth * srcHeight * 3) {
    out.fill(0);
    return out;
  }

  for (let dy = 0; dy < ONNX_FACE_INPUT_HEIGHT; dy += 1) {
    const sy = Math.min(srcHeight - 1, Math.floor((dy * srcHeight) / ONNX_FACE_INPUT_HEIGHT));
    for (let dx = 0; dx < ONNX_FACE_INPUT_WIDTH; dx += 1) {
      const sx = Math.min(srcWidth - 1, Math.floor((dx * srcWidth) / ONNX_FACE_INPUT_WIDTH));
      const srcOffset = (sy * srcWidth + sx) * 3;
      const dstIdx = dy * ONNX_FACE_INPUT_WIDTH + dx;
      out[dstIdx] = ((rgb[srcOffset] ?? 0) - 127) / 128;
      out[planeSize + dstIdx] = ((rgb[srcOffset + 1] ?? 0) - 127) / 128;
      out[planeSize * 2 + dstIdx] = ((rgb[srcOffset + 2] ?? 0) - 127) / 128;
    }
  }
  return out;
}

function boxIou(a: FaceDetectionBox, b: FaceDetectionBox): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const denom = areaA + areaB - inter;
  return denom > 1e-6 ? inter / denom : 0;
}

/** Decodes normalized `[x1, y1, x2, y2]` face boxes + 2-class/1-class scores with IoU NMS. */
export function decodeFaceDetections(
  boxes: ArrayLike<number>,
  scores: ArrayLike<number>,
  options: { scoreThreshold?: number; iouThreshold?: number } = {},
): FaceDetectionBox[] {
  const scoreThresh = options.scoreThreshold ?? 0.6;
  const iouThresh = options.iouThreshold ?? 0.35;
  const boxCount = Math.floor(boxes.length / 4);
  const twoClassScores = scores.length >= boxCount * 2;
  const candidates: FaceDetectionBox[] = [];

  for (let i = 0; i < boxCount; i += 1) {
    const score = Number(twoClassScores ? scores[i * 2 + 1] : scores[i]) || 0;
    if (!Number.isFinite(score) || score < scoreThresh) continue;
    const x1 = Math.max(0, Math.min(1, Number(boxes[i * 4]) || 0));
    const y1 = Math.max(0, Math.min(1, Number(boxes[i * 4 + 1]) || 0));
    const x2 = Math.max(0, Math.min(1, Number(boxes[i * 4 + 2]) || 0));
    const y2 = Math.max(0, Math.min(1, Number(boxes[i * 4 + 3]) || 0));
    if (x2 <= x1 || y2 <= y1) continue;
    candidates.push({ x1, y1, x2, y2, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const kept: FaceDetectionBox[] = [];
  for (const cand of candidates) {
    if (kept.every((k) => boxIou(k, cand) <= iouThresh)) {
      kept.push(cand);
    }
  }
  return kept;
}

function analyzeSkinLumaCentroid(
  rgb: Uint8Array,
  width: number,
  height: number,
): { present: boolean; confidence: number; gazeTarget: { x: number; y: number } | null } {
  if (width <= 0 || height <= 0 || rgb.length < width * height * 3) {
    return { present: false, confidence: 0, gazeTarget: null };
  }
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;
  let brightCount = 0;
  const totalPixels = width * height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      const r = rgb[idx] ?? 0;
      const g = rgb[idx + 1] ?? 0;
      const b = rgb[idx + 2] ?? 0;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < 32) continue;
      brightCount += 1;
      const isSkinTone = r > 80 && g > 40 && b > 20 && r > g && r - Math.min(g, b) > 15;
      const w = isSkinTone ? 1.0 : 0.15;
      weightedX += (x / Math.max(1, width - 1)) * 2 * w - w;
      weightedY += w - (y / Math.max(1, height - 1)) * 2 * w;
      totalWeight += w;
    }
  }

  const coverage = brightCount / totalPixels;
  if (coverage < 0.08 || totalWeight <= 1e-3) {
    return { present: false, confidence: 0, gazeTarget: null };
  }
  const conf = Math.min(1, coverage * 1.4);
  return {
    present: true,
    confidence: Number(conf.toFixed(3)),
    gazeTarget: {
      x: Number(Math.max(-1, Math.min(1, weightedX / totalWeight)).toFixed(3)),
      y: Number(Math.max(-1, Math.min(1, weightedY / totalWeight)).toFixed(3)),
    },
  };
}

export class LocalOnnxWebcamPresence {
  enabled: boolean;
  private readonly modelPath: string | null;
  private readonly scoreThreshold: number;
  private session: OrtSessionLike | null = null;
  private tensorCtor: (new (type: string, data: Float32Array, dims: number[]) => unknown) | null =
    null;
  private nchwBuffer = new Float32Array(3 * ONNX_FACE_INPUT_WIDTH * ONNX_FACE_INPUT_HEIGHT);
  private lastWorkingCopy = new Uint8Array(0);

  constructor(options: { enabled?: boolean; modelPath?: string; scoreThreshold?: number } = {}) {
    this.enabled = options.enabled ?? false;
    this.modelPath = options.modelPath ?? null;
    this.scoreThreshold = options.scoreThreshold ?? 0.6;
  }

  /** Optionally warms up `onnxruntime-node` session if an ONNX face detector model exists. */
  async warm(): Promise<boolean> {
    if (!this.enabled || !this.modelPath || !existsSync(this.modelPath)) {
      return false;
    }
    try {
      const ort = (await import(/* @vite-ignore */ "onnxruntime-node")) as unknown as {
        InferenceSession: { create(path: string, opts?: unknown): Promise<OrtSessionLike> };
        Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
      };
      this.tensorCtor = ort.Tensor;
      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ["cpu"],
      });
      return true;
    } catch {
      this.session = null;
      return false;
    }
  }

  /** Evaluates a single RGB24 frame strictly in-RAM without persisting any pixels to disk. */
  async processRgbFrame(
    rgb: Uint8Array,
    width: number,
    height: number,
  ): Promise<OnnxWebcamSampleResult> {
    if (!this.enabled) {
      return {
        enabled: false,
        present: false,
        confidence: 0,
        gazeTarget: null,
        backend: "disabled",
      };
    }

    if (this.lastWorkingCopy.length !== rgb.length) {
      this.lastWorkingCopy = new Uint8Array(rgb.length);
    }
    this.lastWorkingCopy.set(rgb);

    if (this.session && this.tensorCtor) {
      preprocessRgbToNchw320x240(this.lastWorkingCopy, width, height, this.nchwBuffer);
      const inputName = this.session.inputNames[0] ?? "input";
      const tensor = new this.tensorCtor("float32", this.nchwBuffer, [
        1,
        3,
        ONNX_FACE_INPUT_HEIGHT,
        ONNX_FACE_INPUT_WIDTH,
      ]);
      const outputs = await this.session.run({ [inputName]: tensor });
      const scoresOut = outputs[this.session.outputNames[0] ?? "scores"]?.data;
      const boxesOut = outputs[this.session.outputNames[1] ?? "boxes"]?.data;
      if (scoresOut && boxesOut) {
        const faces = decodeFaceDetections(boxesOut, scoresOut, {
          scoreThreshold: this.scoreThreshold,
        });
        const top = faces[0];
        if (!top) {
          return {
            enabled: true,
            present: false,
            confidence: 0,
            gazeTarget: null,
            backend: "onnx",
          };
        }
        const cx = (top.x1 + top.x2) / 2;
        const cy = (top.y1 + top.y2) / 2;
        return {
          enabled: true,
          present: true,
          confidence: Number(top.score.toFixed(3)),
          gazeTarget: {
            x: Number((cx * 2 - 1).toFixed(3)),
            y: Number((1 - cy * 2).toFixed(3)),
          },
          backend: "onnx",
        };
      }
    }

    const fallback = analyzeSkinLumaCentroid(this.lastWorkingCopy, width, height);
    return {
      enabled: true,
      present: fallback.present,
      confidence: fallback.confidence,
      gazeTarget: fallback.gazeTarget,
      backend: "luma-fallback",
    };
  }

  /** Disables tracking and explicitly wipes all in-memory pixel & tensor buffers. */
  stop(): void {
    this.enabled = false;
    this.nchwBuffer.fill(0);
    this.lastWorkingCopy.fill(0);
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.session?.release?.();
    this.session = null;
  }

  /** Inspection helper proving frame/tensor buffers are zeroed after `stop()`. */
  areBuffersZeroed(): boolean {
    for (let i = 0; i < this.nchwBuffer.length; i += 1) {
      if (this.nchwBuffer[i] !== 0) return false;
    }
    for (let i = 0; i < this.lastWorkingCopy.length; i += 1) {
      if (this.lastWorkingCopy[i] !== 0) return false;
    }
    return true;
  }
}
