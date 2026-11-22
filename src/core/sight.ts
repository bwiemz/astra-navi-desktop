import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AutoProcessor,
  AutoTokenizer,
  env,
  Florence2ForConditionalGeneration,
  RawImage,
} from "@huggingface/transformers";
import sharp from "sharp";
import type { Control } from "./hands.ts";
import {
  FastOcr,
  findPhraseInBoxes,
  type OcrEngine,
  type TextSpot,
} from "./ocr.ts";
import {
  VideoBufferWatch,
  type VideoFrameInput,
  type VideoPushResult,
} from "./multimodal.ts";
import type { PlatformAdapter } from "./platform/adapter.ts";
import { buildSomMarks, renderSomOverlay, type SomMark } from "./som.ts";

/**
 * Her eyes. A picture (usually the screen) is turned into words in two ways and both are
 * handed to her: a description of the scene from a small vision model (Florence-2, about
 * 350 MB, runs on the processor in a few seconds), and the text on it from Tesseract,
 * which reads interface text far better than the vision model does. The picture itself
 * never leaves the computer and is deleted as soon as it has been read.
 */

const MODEL = "onnx-community/Florence-2-base-ft";
const DESCRIBE = "<MORE_DETAILED_CAPTION>";
/** Kept in memory this long after last use, then let go. */
const REST_AFTER_MS = 5 * 60_000;
const MAX_TEXT_CHARS = 5000;

interface Vision {
  model: {
    generate(inputs: Record<string, unknown>): Promise<unknown>;
    dispose(): Promise<unknown>;
  };
  processor: {
    (image: RawImage): Promise<Record<string, unknown>>;
    construct_prompts(task: string): string[];
    post_process_generation(
      text: string,
      task: string,
      size: [number, number],
    ): Record<string, unknown>;
  };
  tokenizer: {
    (prompts: string[]): Record<string, unknown>;
    batch_decode(ids: unknown, options: { skip_special_tokens: boolean }): string[];
  };
}

export interface Seen {
  /** What the picture shows, in a sentence or two. Empty when the vision model could not be used. */
  description: string;
  /** The text visible in it. */
  text: string;
}

export interface SomSeen extends Seen {
  marks: SomMark[];
  ocrMs: number;
  engine: OcrEngine;
}

export type { TextSpot };

function run(
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

/** Tidies recognised text: drops the specks and one-character noise that icons turn into. */
export function tidyRecognisedText(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => (line.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3);
  const text = lines.join("\n");
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (more text on screen)`
    : text;
}

interface ReadWord {
  line: string;
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Letters and digits only, in lower case: how two readings of the same word are compared. */
function plain(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Finds a phrase in what the text reader made of a picture (its table output: one word
 * per row with its box). Returns every place the phrase's words stand side by side on
 * one line, best first: a line that is nothing but the phrase before one that holds it.
 */
export function findPhrase(
  table: string,
  phrase: string,
  size: { width: number; height: number },
): TextSpot[] {
  const wanted = phrase.split(/\s+/).map(plain).filter(Boolean);
  if (wanted.length === 0 || size.width <= 0 || size.height <= 0) return [];
  const lines = new Map<string, ReadWord[]>();
  for (const row of table.split("\n")) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const [left, top, width, height] = cells.slice(6, 10).map(Number);
    const text = cells.slice(11).join("\t").trim();
    if (!text || ![left, top, width, height].every((value) => Number.isFinite(value))) continue;
    const line = cells.slice(1, 5).join(".");
    const words = lines.get(line) ?? [];
    words.push({
      line,
      text,
      left: left ?? 0,
      top: top ?? 0,
      right: (left ?? 0) + (width ?? 0),
      bottom: (top ?? 0) + (height ?? 0),
    });
    lines.set(line, words);
  }
  const found: (TextSpot & { extra: number })[] = [];
  for (const words of lines.values()) {
    // A word the reader split or joined ("Save As" read as "SaveAs") still counts.
    const read = words.map((word) => plain(word.text));
    for (let start = 0; start < words.length; start++) {
      let end = start;
      let joined = "";
      const target = wanted.join("");
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
        line: words
          .map((word) => word.text)
          .join(" ")
          .slice(0, 120),
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

/** A picture narrower than this is doubled before words are looked for in it. */
const LARGE_ENOUGH_WIDTH = 1700;
/** Windows narrower than this are doubled in size before being read. */
const SMALL_PICTURE_WIDTH = 1100;

/**
 * The text reader does badly on small interface lettering. A small window (a dialog, a
 * calculator) is cheap to enlarge first, and reads far better for it.
 */
async function enlargeIfSmall(file: string): Promise<void> {
  try {
    const image = await RawImage.read(file);
    if (image.width >= SMALL_PICTURE_WIDTH || image.width < 8) return;
    const larger = await image.resize(image.width * 2, image.height * 2);
    await larger.save(file);
  } catch (error) {
    console.warn("[sight] a small picture could not be enlarged:", error);
  }
}

export interface SightOptions {
  adapter?: PlatformAdapter;
  gpuBusy?(): boolean;
  videoBufferMaxFrames?: number;
  videoChangeThreshold?: number;
  onVideoChange?: (event: { frame: VideoFrameInput; changeScore: number }) => void;
}

export class Sight {
  private readonly cacheDir: string;
  private readonly workDir: string;
  private readonly adapter?: PlatformAdapter;
  private readonly ocr: FastOcr;
  private readonly videoBuffer: VideoBufferWatch;
  private videoTimer: NodeJS.Timeout | null = null;
  private videoInFlight = false;
  private vision: Promise<Vision> | null = null;
  private restTimer: NodeJS.Timeout | null = null;
  private busy = 0;

  /**
   * @param cacheDir Where the vision and OCR models are kept once downloaded.
   * @param workDir A private folder for the picture while it is being read.
   */
  constructor(cacheDir: string, workDir: string, options?: SightOptions) {
    this.cacheDir = cacheDir;
    this.workDir = workDir;
    this.adapter = options?.adapter;
    this.ocr = new FastOcr({ cacheDir, gpuBusy: options?.gpuBusy });
    this.videoBuffer = new VideoBufferWatch({
      maxFrames: options?.videoBufferMaxFrames,
      changeThreshold: options?.videoChangeThreshold,
      onSignificantChange: options?.onVideoChange,
    });
  }

  /** Pushes a downsampled viewport frame into the non-persistent rolling temporal ring buffer. */
  pushVideoFrame(frame: VideoFrameInput): VideoPushResult {
    return this.videoBuffer.pushFrame(frame);
  }

  /** Returns recent non-private frames kept in the rolling buffer. */
  recentVideoFrames(count?: number): VideoFrameInput[] {
    return this.videoBuffer.recent(count);
  }

  /** Summarizes recent non-private buffered frame transitions as compact context text. */
  recentVideoContext(count = 5): string {
    const frames = this.videoBuffer.recent(count);
    if (frames.length === 0) return "";
    return frames
      .map(
        (frame) =>
          `[${new Date(frame.atMs).toISOString()}] ${frame.app}: "${frame.title}" (${frame.width}x${frame.height})`,
      )
      .join("\n");
  }

  /** Clears buffered rolling video frames immediately. */
  clearVideoBuffer(): void {
    this.videoBuffer.clear();
  }

  /** Starts a non-overlapping, throttled background sampler that never stalls a CPU core. */
  startVideoBufferLoop(options: {
    intervalMs?: number;
    sample: () => Promise<VideoFrameInput | null>;
  }): void {
    this.stopVideoBufferLoop();
    const intervalMs = Math.max(250, options.intervalMs ?? 1500);
    this.videoTimer = setInterval(() => {
      if (this.videoInFlight) return;
      this.videoInFlight = true;
      void options
        .sample()
        .then((frame) => {
          if (frame) this.videoBuffer.pushFrame(frame);
        })
        .catch((error: unknown) => {
          console.warn("[sight] video buffer sample skipped:", error);
        })
        .finally(() => {
          this.videoInFlight = false;
        });
    }, intervalMs);
    this.videoTimer.unref();
  }

  /** Stops the background video sampler without touching disk. */
  stopVideoBufferLoop(): void {
    if (this.videoTimer) clearInterval(this.videoTimer);
    this.videoTimer = null;
    this.videoInFlight = false;
  }

  private async captureWholeScreen(file: string, signal?: AbortSignal): Promise<void> {
    if (this.adapter) {
      await this.adapter.screenCapture.captureScreen(file);
      return;
    }
    await run("spectacle", ["-b", "-n", "-f", "-o", file], 15_000, signal);
  }

  private async captureActiveWindow(file: string, signal?: AbortSignal): Promise<void> {
    if (this.adapter) {
      const layout = await this.adapter.windowManager.layout().catch(() => null);
      const active = layout?.windows.find((win) => win.active && !win.minimized);
      if (active) {
        await this.adapter.screenCapture.captureWindow(active, file);
        return;
      }
      await this.adapter.screenCapture.captureScreen(file);
      return;
    }
    await run("spectacle", ["-b", "-n", "-a", "-o", file], 15_000, signal);
  }

  /** Takes a picture of the whole screen, reads it, and deletes it. */
  async lookAtScreen(signal?: AbortSignal): Promise<Seen> {
    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    const file = join(this.workDir, `screen-${randomBytes(6).toString("hex")}.png`);
    try {
      await this.captureWholeScreen(file, signal);
      return await this.read(file, signal);
    } finally {
      await rm(file, { force: true });
    }
  }

  /**
   * Captures a single window, runs fast local OCR + merges AT-SPI controls into numbered
   * Set-of-Mark boxes, composites the visual marks onto the image, and asks Florence-2
   * to describe the annotated window. Deletes all temporary images before returning.
   */
  async lookAtWindowWithSom(options: {
    window: { x: number; y: number; width: number; height: number };
    desktop: { width: number; height: number };
    controls: readonly Control[];
    signal?: AbortSignal;
  }): Promise<SomSeen> {
    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    const tag = randomBytes(6).toString("hex");
    const screenFile = join(this.workDir, `som-screen-${tag}.png`);
    const annotatedFile = join(this.workDir, `som-ann-${tag}.png`);
    try {
      await this.captureWholeScreen(screenFile, options.signal);
      const meta = await sharp(screenFile).metadata();
      const screenW = meta.width ?? options.desktop.width;
      const screenH = meta.height ?? options.desktop.height;
      if (screenW <= 0 || screenH <= 0) {
        return { description: "", text: "", marks: [], ocrMs: 0, engine: "tesseract" };
      }

      const clamp = (value: number, most: number): number =>
        Math.min(most, Math.max(0, Math.round(value)));
      const left = clamp(options.window.x, screenW - 2);
      const top = clamp(options.window.y, screenH - 2);
      const right = clamp(options.window.x + options.window.width, screenW);
      const bottom = clamp(options.window.y + options.window.height, screenH);
      const cropW = right - left;
      const cropH = bottom - top;
      if (cropW < 8 || cropH < 8) {
        return { description: "", text: "", marks: [], ocrMs: 0, engine: "tesseract" };
      }

      const cropBuf = await sharp(screenFile)
        .extract({ left, top, width: cropW, height: cropH })
        .png()
        .toBuffer();

      this.busy += 1;
      if (this.restTimer) clearTimeout(this.restTimer);
      try {
        const ocr = await this.ocr.recognize(cropBuf, {
          signal: options.signal,
          imageSize: { width: cropW, height: cropH },
        });
        const marks = buildSomMarks({
          window: { x: left, y: top, width: cropW, height: cropH },
          desktop: {
            width: options.desktop.width > 0 ? options.desktop.width : screenW,
            height: options.desktop.height > 0 ? options.desktop.height : screenH,
          },
          controls: options.controls,
          ocrBoxes: ocr.boxes,
        });
        const somBuf = await renderSomOverlay(cropBuf, marks, { width: cropW, height: cropH });
        await writeFile(annotatedFile, somBuf, { mode: 0o600 });
        const description = await this.describe(annotatedFile).catch((error: unknown) => {
          console.warn("[sight] the SoM window could not be described:", error);
          return "";
        });
        return {
          description,
          text: ocr.text,
          marks,
          ocrMs: ocr.ms,
          engine: ocr.engine,
        };
      } finally {
        this.busy -= 1;
        if (this.busy === 0) {
          this.restTimer = setTimeout(() => void this.rest(), REST_AFTER_MS);
          this.restTimer.unref();
        }
      }
    } finally {
      await Promise.allSettled([
        rm(screenFile, { force: true }),
        rm(annotatedFile, { force: true }),
      ]);
    }
  }

  /**
   * Reads only the text of the window in front, without describing the scene. This is
   * the quick look she takes again and again while keeping watch.
   */
  async readFrontWindow(signal?: AbortSignal): Promise<string> {
    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    const file = join(this.workDir, `front-${randomBytes(6).toString("hex")}.png`);
    try {
      await this.captureActiveWindow(file, signal);
      await enlargeIfSmall(file);
      // Lowest priority: this runs unasked, so it must never be what makes the PC feel slow.
      const ocr = await this.ocr.recognize(file, { signal, background: true });
      return tidyRecognisedText(ocr.text);
    } finally {
      await rm(file, { force: true });
    }
  }

  /**
   * Finds where a phrase is written on the screen. Given the part of the screen to look
   * in (as fractions of it: a window's rectangle), only that part is read, enlarged
   * first when it is small: interface lettering is read far more reliably that way than
   * as a corner of a whole-screen picture. The places come back as fractions of the
   * whole screen either way.
   */
  async findOnScreen(
    phrase: string,
    signal?: AbortSignal,
    within?: { left: number; top: number; width: number; height: number },
  ): Promise<TextSpot[]> {
    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    const file = join(this.workDir, `find-${randomBytes(6).toString("hex")}.png`);
    try {
      await this.captureWholeScreen(file, signal);
      const meta = await sharp(file).metadata();
      const screen = { width: meta.width ?? 0, height: meta.height ?? 0 };
      if (screen.width <= 0 || screen.height <= 0) return [];

      let left = 0;
      let top = 0;
      let cropW = screen.width;
      let cropH = screen.height;
      if (within) {
        const clamp = (value: number, most: number): number =>
          Math.min(most, Math.max(0, Math.round(value)));
        left = clamp(within.left * screen.width, screen.width - 2);
        top = clamp(within.top * screen.height, screen.height - 2);
        const right = clamp((within.left + within.width) * screen.width, screen.width);
        const bottom = clamp((within.top + within.height) * screen.height, screen.height);
        cropW = right - left;
        cropH = bottom - top;
        if (cropW < 8 || cropH < 8) return [];
      }

      const enlarged = cropW < LARGE_ENOUGH_WIDTH ? 2 : 1;
      const outW = cropW * enlarged;
      const outH = cropH * enlarged;
      let pipeline = sharp(file);
      if (within) pipeline = pipeline.extract({ left, top, width: cropW, height: cropH });
      if (enlarged > 1) pipeline = pipeline.resize(outW, outH);
      const buf = await pipeline.png().toBuffer();

      const ocr = await this.ocr.recognize(buf, { signal, imageSize: { width: outW, height: outH } });
      return findPhraseInBoxes(ocr.boxes, phrase, { width: outW, height: outH }).map((spot) => ({
        ...spot,
        x: (left + (spot.x * outW) / enlarged) / screen.width,
        y: (top + (spot.y * outH) / enlarged) / screen.height,
      }));
    } finally {
      await rm(file, { force: true });
    }
  }

  /** Describes a picture file and reads the text in it. */
  async read(file: string, signal?: AbortSignal): Promise<Seen> {
    this.busy += 1;
    if (this.restTimer) clearTimeout(this.restTimer);
    try {
      const [description, ocrResult] = await Promise.all([
        this.describe(file).catch((error: unknown) => {
          console.warn("[sight] the picture could not be described:", error);
          return "";
        }),
        this.ocr
          .recognize(file, { signal })
          .catch(() => ({ boxes: [], text: "", engine: "tesseract" as const, ms: 0 })),
      ]);
      return { description, text: tidyRecognisedText(ocrResult.text) };
    } finally {
      this.busy -= 1;
      if (this.busy === 0) {
        this.restTimer = setTimeout(() => void this.rest(), REST_AFTER_MS);
        this.restTimer.unref();
      }
    }
  }

  /** Lets go of the vision and OCR models' memory. They load again when next needed. */
  async rest(): Promise<void> {
    this.stopVideoBufferLoop();
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    if (this.busy > 0) return;
    const loaded = this.vision;
    this.vision = null;
    await Promise.allSettled([
      loaded ? loaded.then((vision) => vision.model.dispose()) : Promise.resolve(),
      this.ocr.rest(),
    ]);
  }

  private async describe(file: string): Promise<string> {
    const vision = await this.load();
    const image = await RawImage.read(file);
    const prompts = vision.processor.construct_prompts(DESCRIBE);
    const ids = await vision.model.generate({
      ...vision.tokenizer(prompts),
      ...(await vision.processor(image)),
      max_new_tokens: 160,
    });
    const written = vision.tokenizer.batch_decode(ids, { skip_special_tokens: false })[0] ?? "";
    const result = vision.processor.post_process_generation(written, DESCRIBE, [
      image.width,
      image.height,
    ]);
    const description = result[DESCRIBE];
    return typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
  }

  private load(): Promise<Vision> {
    if (!this.vision) {
      env.cacheDir = this.cacheDir;
      const loading = (async (): Promise<Vision> => {
        const [model, processor, tokenizer] = await Promise.all([
          Florence2ForConditionalGeneration.from_pretrained(MODEL, {
            dtype: {
              embed_tokens: "fp16",
              vision_encoder: "fp16",
              encoder_model: "q4",
              decoder_model_merged: "q4",
            },
            device: "cpu",
          }),
          AutoProcessor.from_pretrained(MODEL),
          AutoTokenizer.from_pretrained(MODEL),
        ]);
        return { model, processor, tokenizer } as unknown as Vision;
      })();
      this.vision = loading;
      loading.catch(() => {
        if (this.vision === loading) this.vision = null;
      });
    }
    return this.vision;
  }
}
