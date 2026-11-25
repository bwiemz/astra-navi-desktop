import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

/**
 * Fast local OCR for desktop windows and menus.
 *
 * Uses PP-OCRv4 ONNX models (det + rec) with CUDA when available and not yielding to a
 * fullscreen game (falling back to multi-core ONNX CPU when needed), and falls back to
 * cropped-window Tesseract TSV plus a 2× upscaled menu-bar strip when ONNX models have not
 * been installed yet.
 */

export interface OcrBox {
  text: string;
  line: string;
  near: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  confidence: number;
}

export type OcrEngine = "onnx-cuda" | "onnx-cpu" | "tesseract";

export interface OcrResult {
  boxes: OcrBox[];
  text: string;
  engine: OcrEngine;
  ms: number;
}

export interface TextSpot {
  line: string;
  near: string;
  x: number;
  y: number;
}

const MAX_TEXT_CHARS = 5000;
const REST_AFTER_MS = 5 * 60_000;
const DET_MAX_SIDE = 960;
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 640;

const SHORT_UI_WORDS = new Set([
  "ok",
  "no",
  "go",
  "on",
  "up",
  "in",
  "to",
  "by",
  "at",
  "or",
  "id",
  "ui",
  "os",
  "3d",
  "2d",
]);

const SHORT_UI_SYMBOLS = new Set(["+", "-", "×", "÷", "=", "✓", "✔", "✕", "✖", "?"]);

/** True when a short token is a real UI label rather than 1-2 character speck noise. */
export function isShortUiLabel(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (SHORT_UI_SYMBOLS.has(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (SHORT_UI_WORDS.has(lower)) return true;
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) return true;
  if (/^\d{1,2}$/.test(trimmed)) return true;
  return (trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3;
}

function isReadableLine(lineText: string, words: readonly { text: string; confidence: number }[]): boolean {
  const alnum = (lineText.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alnum >= 3) return true;
  return words.some((word) => isShortUiLabel(word.text) && word.confidence >= 0.45);
}

interface RawTsvWord {
  lineKey: string;
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  confidence: number;
}

/** Parses Tesseract `--psm ... tsv` output into normalized `OcrBox` entries. */
export function parseTsvBoxes(
  tsv: string,
  imageSize: { width: number; height: number },
): OcrBox[] {
  if (imageSize.width <= 0 || imageSize.height <= 0) return [];
  const grouped = new Map<string, RawTsvWord[]>();
  for (const row of tsv.split("\n")) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const [leftRaw, topRaw, widthRaw, heightRaw, confRaw] = cells.slice(6, 11).map(Number);
    const text = cells.slice(11).join("\t").trim();
    if (!text) continue;
    if (
      leftRaw === undefined ||
      topRaw === undefined ||
      widthRaw === undefined ||
      heightRaw === undefined ||
      !Number.isFinite(leftRaw) ||
      !Number.isFinite(topRaw) ||
      !Number.isFinite(widthRaw) ||
      !Number.isFinite(heightRaw)
    ) {
      continue;
    }
    if (widthRaw <= 0 || heightRaw <= 0) continue;
    const left = Math.max(0, Math.min(imageSize.width - 1, leftRaw));
    const top = Math.max(0, Math.min(imageSize.height - 1, topRaw));
    const right = Math.max(left + 1, Math.min(imageSize.width, leftRaw + widthRaw));
    const bottom = Math.max(top + 1, Math.min(imageSize.height, topRaw + heightRaw));
    const confidence =
      typeof confRaw === "number" && Number.isFinite(confRaw) && confRaw >= 0
        ? Math.min(1, confRaw / 100)
        : 0.5;
    const lineKey = cells.slice(1, 5).join(".");
    const bucket = grouped.get(lineKey) ?? [];
    bucket.push({ lineKey, text, left, top, right, bottom, confidence });
    grouped.set(lineKey, bucket);
  }

  const out: OcrBox[] = [];
  for (const words of grouped.values()) {
    words.sort((a, b) => a.left - b.left);
    const lineText = words.map((word) => word.text).join(" ");
    if (!isReadableLine(lineText, words)) continue;
    const clippedLine = lineText.slice(0, 120);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (!word) continue;
      const near = words
        .slice(Math.max(0, index - 2), index + 3)
        .map((entry) => entry.text)
        .join(" ")
        .slice(0, 120);
      out.push({
        text: word.text,
        line: clippedLine,
        near,
        left: word.left,
        top: word.top,
        right: word.right,
        bottom: word.bottom,
        confidence: word.confidence,
      });
    }
  }
  return out;
}

function boxIou(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): number {
  const ix0 = Math.max(a.left, b.left);
  const iy0 = Math.max(a.top, b.top);
  const ix1 = Math.min(a.right, b.right);
  const iy1 = Math.min(a.bottom, b.bottom);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const areaA = Math.max(1, (a.right - a.left) * (a.bottom - a.top));
  const areaB = Math.max(1, (b.right - b.left) * (b.bottom - b.top));
  return inter / (areaA + areaB - inter);
}

/** Merges menu-bar strip OCR detections not already covered in `mainBoxes`. */
export function mergeMenuBarBoxes(
  mainBoxes: readonly OcrBox[],
  stripBoxes: readonly OcrBox[],
  iouThreshold = 0.35,
): OcrBox[] {
  const merged = [...mainBoxes];
  for (const candidate of stripBoxes) {
    const cx = (candidate.left + candidate.right) / 2;
    const cy = (candidate.top + candidate.bottom) / 2;
    const covered = mainBoxes.some((existing) => {
      if (boxIou(existing, candidate) >= iouThreshold) return true;
      return (
        cx >= existing.left &&
        cx <= existing.right &&
        cy >= existing.top &&
        cy <= existing.bottom
      );
    });
    if (!covered) merged.push(candidate);
  }
  return merged;
}

/**
 * Extracts merged word/line detection boxes from a PP-OCRv4 DBNet probability map
 * using 4-connected component analysis, scaled back to `(origW, origH)`.
 */
export function extractDetBoxes(
  probMap: Float32Array,
  mapW: number,
  mapH: number,
  origW: number,
  origH: number,
  threshold = 0.3,
): { left: number; top: number; right: number; bottom: number; score: number }[] {
  if (mapW <= 0 || mapH <= 0 || origW <= 0 || origH <= 0) return [];
  const total = mapW * mapH;
  if (probMap.length < total) return [];
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const scaleX = origW / mapW;
  const scaleY = origH / mapH;
  const boxes: { left: number; top: number; right: number; bottom: number; score: number }[] = [];

  for (let startIdx = 0; startIdx < total; startIdx += 1) {
    if (visited[startIdx] || (probMap[startIdx] ?? 0) < threshold) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = startIdx;
    visited[startIdx] = 1;

    let minX = mapW;
    let maxX = 0;
    let minY = mapH;
    let maxY = 0;
    let scoreSum = 0;
    let area = 0;

    while (head < tail) {
      const idx = queue[head++] ?? 0;
      const x = idx % mapW;
      const y = (idx - x) / mapW;
      const prob = probMap[idx] ?? 0;
      scoreSum += prob;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x + 1 < mapW ? idx + 1 : -1,
        y > 0 ? idx - mapW : -1,
        y + 1 < mapH ? idx + mapW : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && !visited[n] && (probMap[n] ?? 0) >= threshold) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
    }

    if (area < 2) continue;
    const rawH = (maxY - minY + 1) * scaleY;
    const padX = Math.min(8, Math.max(0, Math.round(rawH * 0.12)));
    const padY = Math.min(6, Math.max(0, Math.round(rawH * 0.12)));
    const left = Math.max(0, Math.floor(minX * scaleX) - padX);
    const top = Math.max(0, Math.floor(minY * scaleY) - padY);
    const right = Math.min(origW, Math.ceil((maxX + 1) * scaleX) + padX);
    const bottom = Math.min(origH, Math.ceil((maxY + 1) * scaleY) + padY);
    if (right - left < 2 || bottom - top < 2) continue;
    boxes.push({
      left,
      top,
      right,
      bottom,
      score: scoreSum / area,
    });
  }

  return boxes.sort((a, b) => Math.floor(a.top / 16) - Math.floor(b.top / 16) || a.left - b.left);
}

/** PP-OCRv4 CTC greedy decode (class 0 = blank, classes `1..dict.length` -> `dict[idx - 1]`). */
export function ctcGreedyDecode(
  logits: Float32Array,
  timesteps: number,
  numClasses: number,
  dict: readonly string[],
): { text: string; confidence: number } {
  if (timesteps <= 0 || numClasses <= 1 || logits.length < timesteps * numClasses) {
    return { text: "", confidence: 0 };
  }
  const chars: string[] = [];
  let prevIdx = 0;
  let confSum = 0;
  let confCount = 0;

  for (let t = 0; t < timesteps; t += 1) {
    const offset = t * numClasses;
    let bestIdx = 0;
    let bestVal = -Infinity;
    let sumRaw = 0;
    let looksProb = true;
    for (let c = 0; c < numClasses; c += 1) {
      const val = logits[offset + c] ?? 0;
      if (val < -0.001 || val > 1.001) looksProb = false;
      sumRaw += val;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = c;
      }
    }
    if (bestIdx !== 0 && bestIdx !== prevIdx) {
      const token = dict[bestIdx - 1];
      if (token !== undefined) {
        chars.push(token);
        let prob = bestVal;
        if (!looksProb || Math.abs(sumRaw - 1) > 0.05) {
          let denom = 0;
          for (let c = 0; c < numClasses; c += 1) {
            denom += Math.exp((logits[offset + c] ?? 0) - bestVal);
          }
          prob = denom > 0 ? 1 / denom : 0;
        }
        confSum += Math.max(0, Math.min(1, prob));
        confCount += 1;
      }
    }
    prevIdx = bestIdx;
  }

  return {
    text: chars.join("").trim(),
    confidence: confCount > 0 ? confSum / confCount : 0,
  };
}

function groupBoxesIntoLines(boxes: readonly OcrBox[]): OcrBox[][] {
  if (boxes.length === 0) return [];
  const sorted = [...boxes].sort(
    (a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2 || a.left - b.left,
  );
  const rows: { midY: number; height: number; boxes: OcrBox[] }[] = [];
  for (const box of sorted) {
    const midY = (box.top + box.bottom) / 2;
    const h = Math.max(8, box.bottom - box.top);
    const target = rows.find((row) => Math.abs(midY - row.midY) <= Math.max(8, row.height * 0.55));
    if (target) {
      target.boxes.push(box);
      const count = target.boxes.length;
      target.midY = (target.midY * (count - 1) + midY) / count;
      target.height = (target.height * (count - 1) + h) / count;
    } else {
      rows.push({ midY, height: h, boxes: [box] });
    }
  }
  return rows.map((row) => row.boxes.sort((a, b) => a.left - b.left));
}

/** Converts ordered OCR boxes into clean multi-line readable text. */
export function boxesToText(boxes: readonly OcrBox[], maxChars = MAX_TEXT_CHARS): string {
  const rows = groupBoxesIntoLines(boxes);
  const lines: string[] = [];
  for (const row of rows) {
    const joined = row
      .map((box) => box.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!joined) continue;
    if (isReadableLine(joined, row)) lines.push(joined);
  }
  const combined = lines.join("\n");
  return combined.length > maxChars
    ? `${combined.slice(0, maxChars)}\n… (more text on screen)`
    : combined;
}

function plain(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Finds all occurrences of `phrase` across structured `OcrBox` lines with normalized `[0..1]` centers. */
export function findPhraseInBoxes(
  boxes: readonly OcrBox[],
  phrase: string,
  size: { width: number; height: number },
): TextSpot[] {
  const wanted = phrase.split(/\s+/).map(plain).filter(Boolean);
  if (wanted.length === 0 || size.width <= 0 || size.height <= 0) return [];
  const target = wanted.join("");
  const found: (TextSpot & { extra: number })[] = [];

  for (const words of groupBoxesIntoLines(boxes)) {
    const read = words.map((word) => plain(word.text));
    const fullLine = words.map((word) => word.text).join(" ").slice(0, 120);
    for (let start = 0; start < words.length; start += 1) {
      let end = start;
      let joined = "";
      while (end < words.length && joined.length < target.length) {
        joined += read[end] ?? "";
        end += 1;
      }
      if (joined !== target) continue;
      const run = words.slice(start, end);
      const left = Math.min(...run.map((word) => word.left));
      const right = Math.max(...run.map((word) => word.right));
      const top = Math.min(...run.map((word) => word.top));
      const bottom = Math.max(...run.map((word) => word.bottom));
      found.push({
        line: fullLine,
        near: words
          .slice(Math.max(0, start - 2), end + 2)
          .map((word) => word.text)
          .join(" ")
          .slice(0, 120),
        x: (left + right) / 2 / size.width,
        y: (top + bottom) / 2 / size.height,
        extra: words.length - run.length,
      });
    }
  }
  return found
    .sort((a, b) => a.extra - b.extra || a.y - b.y || a.x - b.x)
    .map(({ line, near, x, y }) => ({ line, near, x, y }));
}

function runCommand(
  program: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  extraEnv?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        signal,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new Error(
            missing
              ? `This needs "${program}", which is not installed.`
              : (error.message.split("\n")[0] ?? "failed"),
          ),
        );
      },
    );
  });
}

interface LoadedOnnxOcr {
  det: ort.InferenceSession;
  rec: ort.InferenceSession;
  dict: string[];
  recHeight: number;
  engine: "onnx-cuda" | "onnx-cpu";
}

export interface FastOcrOptions {
  cacheDir: string;
  gpuBusy?(): boolean;
}

export interface RecognizeOptions {
  signal?: AbortSignal;
  background?: boolean;
  imageSize?: { width: number; height: number };
  cropTopStrip?: boolean;
}

export class FastOcr {
  private readonly cacheDir: string;
  private readonly gpuBusy?: () => boolean;
  private loaded: Promise<LoadedOnnxOcr | null> | null = null;
  private loadedEngine: OcrEngine | null = null;
  private restTimer: NodeJS.Timeout | null = null;
  private busy = 0;

  constructor(options: FastOcrOptions) {
    this.cacheDir = options.cacheDir;
    this.gpuBusy = options.gpuBusy;
  }

  /** Resolves `<cacheDir>/ocr` or sibling `<dirname(cacheDir)>/ocr` (e.g. `models/ocr` next to `models/speech`). */
  resolveOcrDir(): string | null {
    const candidates = [join(this.cacheDir, "ocr"), join(dirname(this.cacheDir), "ocr")];
    for (const dir of candidates) {
      if (
        existsSync(join(dir, "det.onnx")) &&
        existsSync(join(dir, "rec.onnx")) &&
        existsSync(join(dir, "dict.txt"))
      ) {
        return dir;
      }
    }
    return null;
  }

  private async ensureOnnx(forceCpu = false): Promise<LoadedOnnxOcr | null> {
    const ocrDir = this.resolveOcrDir();
    if (!ocrDir) return null;
    const wantCpuOnly = forceCpu || this.gpuBusy?.() === true;
    if (this.loaded && this.loadedEngine === "onnx-cuda" && wantCpuOnly) {
      await this.rest().catch(() => undefined);
    }
    if (!this.loaded) {
      const loading = (async (): Promise<LoadedOnnxOcr | null> => {
        const backends = ort.listSupportedBackends();
        const cudaBundled = backends.some((b) => b.name === "cuda" && b.bundled);
        const useCuda = cudaBundled && !wantCpuOnly;
        const providers: ort.InferenceSession.SessionOptions["executionProviders"] = useCuda
          ? ["cuda", "cpu"]
          : ["cpu"];
        const threads = Math.min(8, Math.max(1, cpus().length));
        const sessionOptions: ort.InferenceSession.SessionOptions = {
          executionProviders: providers,
          intraOpNumThreads: threads,
          graphOptimizationLevel: "all",
        };
        const [det, rec, dictRaw] = await Promise.all([
          ort.InferenceSession.create(join(ocrDir, "det.onnx"), sessionOptions),
          ort.InferenceSession.create(join(ocrDir, "rec.onnx"), sessionOptions),
          readFile(join(ocrDir, "dict.txt"), "utf8"),
        ]);
        const dict = dictRaw
          .split(/\r?\n/)
          .filter((line) => line.length > 0);
        // Append trailing space token used by PP-OCR dictionaries when absent
        if (dict.at(-1) !== " ") dict.push(" ");
        const engine: "onnx-cuda" | "onnx-cpu" = useCuda ? "onnx-cuda" : "onnx-cpu";
        this.loadedEngine = engine;
        return { det, rec, dict, recHeight: REC_HEIGHT, engine };
      })();
      this.loaded = loading;
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = null;
      });
    }
    return this.loaded;
  }

  /** Recognizes text and bounding boxes in an image file or encoded image buffer. */
  async recognize(input: string | Buffer, options: RecognizeOptions = {}): Promise<OcrResult> {
    const startMs = Date.now();
    this.busy += 1;
    if (this.restTimer) clearTimeout(this.restTimer);
    try {
      const meta = await sharp(input).metadata();
      const origW = options.imageSize?.width ?? meta.width ?? 0;
      const origH = options.imageSize?.height ?? meta.height ?? 0;
      if (origW <= 0 || origH <= 0) {
        return { boxes: [], text: "", engine: "tesseract", ms: Date.now() - startMs };
      }

      if (!options.background || process.platform === "win32") {
        const onnx = await this.ensureOnnx(options.background === true).catch((error: unknown) => {
          console.warn("[ocr] ONNX initialization failed, falling back to Tesseract:", error);
          return null;
        });
        if (onnx) {
          const boxes = await this.runOnnx(onnx, input, origW, origH, options.signal);
          return {
            boxes,
            text: boxesToText(boxes),
            engine: onnx.engine,
            ms: Date.now() - startMs,
          };
        }
      }

      const boxes = await this.runTesseractFallback(input, origW, origH, options);
      return {
        boxes,
        text: boxesToText(boxes),
        engine: "tesseract",
        ms: Date.now() - startMs,
      };
    } finally {
      this.busy -= 1;
      if (this.busy === 0) {
        this.restTimer = setTimeout(() => void this.rest(), REST_AFTER_MS);
        this.restTimer.unref();
      }
    }
  }

  private async runOnnx(
    onnx: LoadedOnnxOcr,
    input: string | Buffer,
    origW: number,
    origH: number,
    signal?: AbortSignal,
  ): Promise<OcrBox[]> {
    const scale = Math.min(1, DET_MAX_SIDE / Math.max(origW, origH));
    const detW = Math.max(32, Math.round((origW * scale) / 32) * 32);
    const detH = Math.max(32, Math.round((origH * scale) / 32) * 32);
    const { data: rgbDet } = await sharp(input)
      .resize(detW, detH, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const mean = [0.485, 0.456, 0.406] as const;
    const std = [0.229, 0.224, 0.225] as const;
    const planeSize = detW * detH;
    const detFloat = new Float32Array(3 * planeSize);
    for (let i = 0; i < planeSize; i += 1) {
      const r = (rgbDet[i * 3] ?? 0) / 255;
      const g = (rgbDet[i * 3 + 1] ?? 0) / 255;
      const b = (rgbDet[i * 3 + 2] ?? 0) / 255;
      detFloat[i] = (r - mean[0]) / std[0];
      detFloat[planeSize + i] = (g - mean[1]) / std[1];
      detFloat[2 * planeSize + i] = (b - mean[2]) / std[2];
    }

    const detInputName = onnx.det.inputNames[0] ?? "x";
    const detOutputName = onnx.det.outputNames[0] ?? "sigmoid_0.tmp_0";
    const detOut = await onnx.det.run({
      [detInputName]: new ort.Tensor("float32", detFloat, [1, 3, detH, detW]),
    });
    const probTensor = detOut[detOutputName];
    if (!probTensor || !(probTensor.data instanceof Float32Array)) return [];
    const detBoxes = extractDetBoxes(probTensor.data, detW, detH, origW, origH, 0.3);
    if (detBoxes.length === 0) return [];

    const sourceBuf =
      typeof input === "string"
        ? await readFile(input)
        : input;
    const recInputName = onnx.rec.inputNames[0] ?? "x";
    const recOutputName = onnx.rec.outputNames[0] ?? "softmax_11.tmp_0";

    const outBoxes: OcrBox[] = [];
    const runRec = async (
      left: number,
      top: number,
      cropW: number,
      cropH: number,
      height: number,
    ) => {
      const recW = Math.min(REC_MAX_WIDTH, Math.max(16, Math.round((cropW / cropH) * height)));
      const { data: rgbCrop } = await sharp(sourceBuf)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(recW, height, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const recPlane = recW * height;
      const recFloat = new Float32Array(3 * recPlane);
      for (let i = 0; i < recPlane; i += 1) {
        recFloat[i] = (rgbCrop[i * 3] ?? 0) / 127.5 - 1;
        recFloat[recPlane + i] = (rgbCrop[i * 3 + 1] ?? 0) / 127.5 - 1;
        recFloat[2 * recPlane + i] = (rgbCrop[i * 3 + 2] ?? 0) / 127.5 - 1;
      }

      return onnx.rec.run({
        [recInputName]: new ort.Tensor("float32", recFloat, [1, 3, height, recW]),
      });
    };

    for (const detBox of detBoxes.slice(0, 120)) {
      if (signal?.aborted) break;
      const cropW = Math.max(2, detBox.right - detBox.left);
      const cropH = Math.max(2, detBox.bottom - detBox.top);
      let recOut: Awaited<ReturnType<typeof onnx.rec.run>>;
      try {
        recOut = await runRec(detBox.left, detBox.top, cropW, cropH, onnx.recHeight);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (onnx.recHeight === 48 && /expected:\s*32\b/i.test(msg)) {
          onnx.recHeight = 32;
          recOut = await runRec(detBox.left, detBox.top, cropW, cropH, 32);
        } else {
          throw error;
        }
      }
      const recTensor = recOut[recOutputName];
      if (!recTensor || !(recTensor.data instanceof Float32Array)) continue;
      const dims = recTensor.dims;
      const timesteps = Number(dims[1] ?? 0);
      const numClasses = Number(dims[2] ?? 0);
      const decoded = ctcGreedyDecode(recTensor.data, timesteps, numClasses, onnx.dict);
      if (!decoded.text || decoded.confidence < 0.35) continue;
      outBoxes.push({
        text: decoded.text,
        line: decoded.text.slice(0, 120),
        near: decoded.text.slice(0, 120),
        left: detBox.left,
        top: detBox.top,
        right: detBox.right,
        bottom: detBox.bottom,
        confidence: decoded.confidence,
      });
    }
    return outBoxes;
  }

  private async runTesseractFallback(
    input: string | Buffer,
    origW: number,
    origH: number,
    options: RecognizeOptions,
  ): Promise<OcrBox[]> {
    const tempFiles: string[] = [];
    const runTsv = async (file: string, psm: string): Promise<string> => {
      if (options.background) {
        return runCommand(
          "nice",
          ["-n", "19", "tesseract", file, "stdout", "--psm", psm, "tsv"],
          45_000,
          options.signal,
          { OMP_THREAD_LIMIT: "1" },
        );
      }
      return runCommand(
        "tesseract",
        [file, "stdout", "--psm", psm, "tsv"],
        30_000,
        options.signal,
        { OMP_THREAD_LIMIT: String(Math.min(4, Math.max(1, cpus().length))) },
      );
    };

    try {
      let mainFile: string;
      if (typeof input === "string") {
        mainFile = input;
      } else {
        mainFile = join(tmpdir(), `aichan-ocr-${randomBytes(6).toString("hex")}.png`);
        tempFiles.push(mainFile);
        await writeFile(mainFile, input, { mode: 0o600 });
      }

      const mainTsv = await runTsv(mainFile, "11").catch(() => "");
      const mainBoxes = parseTsvBoxes(mainTsv, { width: origW, height: origH });

      const wantStrip = options.cropTopStrip !== false && !options.background && origH >= 120 && origW >= 32;
      if (!wantStrip) return mainBoxes;

      const stripHeight = Math.min(72, Math.round(origH * 0.14));
      if (stripHeight < 12) return mainBoxes;

      const stripFile = join(tmpdir(), `aichan-strip-${randomBytes(6).toString("hex")}.png`);
      tempFiles.push(stripFile);
      const stripBuf = await sharp(input)
        .extract({ left: 0, top: 0, width: origW, height: stripHeight })
        .resize(origW * 2, stripHeight * 2)
        .png()
        .toBuffer();
      await writeFile(stripFile, stripBuf, { mode: 0o600 });

      const stripTsv = await runTsv(stripFile, "6").catch(() => "");
      const scaledStrip = parseTsvBoxes(stripTsv, {
        width: origW * 2,
        height: stripHeight * 2,
      }).map((box) => ({
        ...box,
        left: Math.round(box.left / 2),
        top: Math.round(box.top / 2),
        right: Math.round(box.right / 2),
        bottom: Math.round(box.bottom / 2),
      }));

      return mergeMenuBarBoxes(mainBoxes, scaledStrip);
    } finally {
      await Promise.allSettled(tempFiles.map((file) => rm(file, { force: true })));
    }
  }

  /** Releases cached ONNX inference sessions to free memory/VRAM. */
  async rest(): Promise<void> {
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    if (this.busy > 0 || !this.loaded) return;
    const pending = this.loaded;
    this.loaded = null;
    this.loadedEngine = null;
    await pending
      .then(async (onnx) => {
        if (!onnx) return;
        await Promise.allSettled([onnx.det.release(), onnx.rec.release()]);
      })
      .catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.rest();
  }
}

export async function ensureOcrDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
