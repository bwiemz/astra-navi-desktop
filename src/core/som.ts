import sharp from "sharp";
import type { Control } from "./hands.ts";
import type { OcrBox } from "./ocr.ts";

/**
 * Set-of-Mark (SoM) visual grounding: merges visible AT-SPI controls and cropped-window
 * OCR boxes into numbered visual marks drawn onto the window capture before Florence-2
 * sees it, letting the brain click ambiguous or bare UI elements by reliable number.
 */

export interface SomBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SomMark {
  /** 1-based mark number rendered on the image and selectable via `operate({ which })`. */
  id: number;
  source: "control" | "ocr";
  kind: string;
  label: string;
  near: string;
  /** Window-relative pixel rectangle. */
  box: SomBox;
  /** Whole-desktop normalized click center (`0..1`). */
  center: { x: number; y: number };
  controlNumber?: number;
  greyed?: boolean;
}

export interface BuildSomOptions {
  window: { x: number; y: number; width: number; height: number };
  desktop: { width: number; height: number };
  controls: readonly Control[];
  ocrBoxes: readonly OcrBox[];
  maxMarks?: number;
}

interface CandidateMark {
  source: "control" | "ocr";
  kind: string;
  label: string;
  near: string;
  box: SomBox;
  controlNumber?: number;
  greyed?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rectIou(a: SomBox, b: SomBox): number {
  const ax1 = a.x + a.width;
  const ay1 = a.y + a.height;
  const bx1 = b.x + b.width;
  const by1 = b.y + b.height;
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const areaA = Math.max(1, a.width * a.height);
  const areaB = Math.max(1, b.width * b.height);
  return inter / (areaA + areaB - inter);
}

function pointInside(px: number, py: number, box: SomBox): boolean {
  return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
}

/** Merges AT-SPI controls and window-relative OCR boxes into numbered Set-of-Mark targets. */
export function buildSomMarks(options: BuildSomOptions): SomMark[] {
  const { window: win, desktop, controls, ocrBoxes } = options;
  const maxMarks = Math.max(1, options.maxMarks ?? 60);
  if (win.width <= 0 || win.height <= 0 || desktop.width <= 0 || desktop.height <= 0) return [];

  const candidates: CandidateMark[] = [];
  const controlBoxes: SomBox[] = [];

  for (const control of controls) {
    if (control.hidden || !control.rect) continue;
    const label = control.name.trim();
    if (!label && !control.kind.includes("field")) continue;
    const relLeft = clamp(control.rect.x - win.x, 0, win.width);
    const relTop = clamp(control.rect.y - win.y, 0, win.height);
    const relRight = clamp(control.rect.x + control.rect.width - win.x, 0, win.width);
    const relBottom = clamp(control.rect.y + control.rect.height - win.y, 0, win.height);
    const w = Math.round(relRight - relLeft);
    const h = Math.round(relBottom - relTop);
    if (w < 4 || h < 4) continue;
    const box: SomBox = { x: Math.round(relLeft), y: Math.round(relTop), width: w, height: h };
    controlBoxes.push(box);
    candidates.push({
      source: "control",
      kind: control.kind,
      label: label || control.kind,
      near: label || control.kind,
      box,
      controlNumber: control.n,
      ...(control.greyed ? { greyed: true } : {}),
    });
  }

  for (const ocr of ocrBoxes) {
    const label = ocr.text.trim();
    if (!label) continue;
    const relLeft = clamp(ocr.left, 0, win.width);
    const relTop = clamp(ocr.top, 0, win.height);
    const relRight = clamp(ocr.right, 0, win.width);
    const relBottom = clamp(ocr.bottom, 0, win.height);
    const w = Math.round(relRight - relLeft);
    const h = Math.round(relBottom - relTop);
    if (w < 4 || h < 4) continue;
    const box: SomBox = { x: Math.round(relLeft), y: Math.round(relTop), width: w, height: h };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const coveredByControl = controlBoxes.some(
      (ctrl) => rectIou(ctrl, box) >= 0.45 || pointInside(cx, cy, ctrl),
    );
    if (coveredByControl) continue;
    candidates.push({
      source: "ocr",
      kind: "text",
      label,
      near: ocr.near.trim() || label,
      box,
    });
  }

  candidates.sort((a, b) => {
    const rowDiff = Math.floor(a.box.y / 16) - Math.floor(b.box.y / 16);
    if (rowDiff !== 0) return rowDiff;
    return a.box.x - b.box.x;
  });

  return candidates.slice(0, maxMarks).map((item, index) => ({
    id: index + 1,
    source: item.source,
    kind: item.kind,
    label: item.label.slice(0, 100),
    near: item.near.slice(0, 120),
    box: item.box,
    center: {
      x: clamp((win.x + item.box.x + item.box.width / 2) / desktop.width, 0, 1),
      y: clamp((win.y + item.box.y + item.box.height / 2) / desktop.height, 0, 1),
    },
    ...(item.controlNumber !== undefined ? { controlNumber: item.controlNumber } : {}),
    ...(item.greyed ? { greyed: true } : {}),
  }));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Builds a transparent SVG overlay drawing numbered bounding boxes for each mark. */
export function buildSomOverlaySvg(
  marks: readonly SomMark[],
  width: number,
  height: number,
): string {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));
  const shapes: string[] = [];

  for (const mark of marks) {
    const color = mark.source === "control" ? "#38bdf8" : "#facc15";
    const dash = mark.source === "ocr" ? ' stroke-dasharray="4 2"' : "";
    const tag = escapeXml(`[${mark.id}]`);
    const tagW = Math.max(22, tag.length * 8 + 8);
    const tagH = 16;
    const tagX = clamp(mark.box.x, 0, Math.max(0, safeW - tagW));
    const tagY = mark.box.y >= tagH ? mark.box.y - tagH : clamp(mark.box.y, 0, Math.max(0, safeH - tagH));
    shapes.push(
      `<rect x="${mark.box.x}" y="${mark.box.y}" width="${mark.box.width}" height="${mark.box.height}" fill="none" stroke="${color}" stroke-width="2"${dash}/>` +
        `<rect x="${tagX}" y="${tagY}" width="${tagW}" height="${tagH}" rx="3" fill="#0f172a" stroke="${color}" stroke-width="1"/>` +
        `<text x="${tagX + 4}" y="${tagY + 12}" fill="#ffffff" font-family="sans-serif" font-size="11" font-weight="bold">${tag}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${safeW}" height="${safeH}" viewBox="0 0 ${safeW} ${safeH}">${shapes.join("")}</svg>`;
}

/** Composites the numbered Set-of-Mark SVG overlay onto a PNG/image file or Buffer. */
export async function renderSomOverlay(
  image: string | Buffer,
  marks: readonly SomMark[],
  size: { width: number; height: number },
): Promise<Buffer> {
  if (marks.length === 0) {
    return sharp(image).png().toBuffer();
  }
  const svg = Buffer.from(buildSomOverlaySvg(marks, size.width, size.height), "utf8");
  return sharp(image)
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function spotWords(spot: { x: number; y: number }): string {
  const row = spot.y < 0.34 ? "top" : spot.y > 0.66 ? "bottom" : "middle";
  const col = spot.x < 0.34 ? "left" : spot.x > 0.66 ? "right" : "centre";
  return row === "middle" && col === "centre" ? "centre" : `${row} ${col}`;
}

/** Summarizes numbered Set-of-Mark targets cleanly for the assistant. */
export function describeSomMarks(marks: readonly SomMark[]): string {
  return marks
    .map((mark) => {
      const label = mark.label.replace(/\s+/g, " ").trim();
      const grey = mark.greyed ? " (greyed)" : "";
      return `[${mark.id}] ${mark.kind} "${label}"${grey} (${spotWords(mark.center)})`;
    })
    .join("\n");
}
