import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  boxesToText,
  ctcGreedyDecode,
  extractDetBoxes,
  FastOcr,
  findPhraseInBoxes,
  isShortUiLabel,
  mergeMenuBarBoxes,
  parseTsvBoxes,
  type OcrBox,
} from "../src/core/ocr.ts";

describe("isShortUiLabel", () => {
  it("accepts real short UI buttons and menu labels while rejecting random noise", () => {
    for (const label of ["OK", "No", "Go", "On", "Up", "F5", "F12", "7", "×", "✓", "File"]) {
      expect(isShortUiLabel(label)).toBe(true);
    }
    for (const noise of ["", "  ", "|", ".", ",", "a", "xy", "!!"]) {
      expect(isShortUiLabel(noise)).toBe(false);
    }
  });
});

describe("parseTsvBoxes & mergeMenuBarBoxes", () => {
  it("parses word rows, preserves short UI labels, and merges missed top-bar items", () => {
    const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    const tsv = [
      header,
      "5\t1\t1\t1\t1\t1\t20\t120\t40\t18\t95\tSave",
      "5\t1\t1\t1\t1\t2\t68\t120\t70\t18\t92\tchanges",
      "5\t1\t2\t1\t1\t1\t200\t120\t28\t18\t88\tOK",
      "5\t1\t3\t1\t1\t1\t10\t10\t2\t2\t20\t.",
    ].join("\n");

    const mainBoxes = parseTsvBoxes(tsv, { width: 800, height: 600 });
    expect(mainBoxes.map((b) => b.text)).toEqual(["Save", "changes", "OK"]);
    expect(mainBoxes[0]?.line).toBe("Save changes");

    const stripBoxes: OcrBox[] = [
      { text: "File", line: "File", near: "File Edit", left: 10, top: 6, right: 34, bottom: 20, confidence: 0.9 },
      { text: "Edit", line: "Edit", near: "File Edit", left: 42, top: 6, right: 68, bottom: 20, confidence: 0.9 },
      { text: "OK", line: "OK", near: "OK", left: 202, top: 121, right: 226, bottom: 136, confidence: 0.9 },
    ];
    const merged = mergeMenuBarBoxes(mainBoxes, stripBoxes);
    expect(merged.map((b) => b.text)).toEqual(["Save", "changes", "OK", "File", "Edit"]);
  });
});

describe("extractDetBoxes & ctcGreedyDecode", () => {
  it("extracts scaled connected components from DBNet probability maps", () => {
    const mapW = 20;
    const mapH = 10;
    const prob = new Float32Array(mapW * mapH);
    for (let y = 2; y <= 3; y += 1) {
      for (let x = 4; x <= 7; x += 1) {
        prob[y * mapW + x] = 0.85;
      }
    }
    const boxes = extractDetBoxes(prob, mapW, mapH, 200, 100, 0.3);
    expect(boxes).toHaveLength(1);
    const first = boxes[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.left).toBeLessThanOrEqual(40);
      expect(first.right).toBeGreaterThanOrEqual(80);
      expect(first.top).toBeLessThanOrEqual(20);
      expect(first.bottom).toBeGreaterThanOrEqual(40);
      expect(first.score).toBeCloseTo(0.85, 2);
    }
  });

  it("decodes CTC timesteps with blank collapsing and duplicate merging", () => {
    // dict[0]="P", dict[1]="l", dict[2]="a", dict[3]="y"; class 0 = blank
    const dict = ["P", "l", "a", "y"];
    const classes = 5;
    // Sequence: [P, P, 0, l, a, 0, y] -> "Play"
    const seq = [1, 1, 0, 2, 3, 0, 4];
    const logits = new Float32Array(seq.length * classes);
    seq.forEach((cls, t) => {
      for (let c = 0; c < classes; c += 1) {
        logits[t * classes + c] = c === cls ? 0.92 : 0.02;
      }
    });
    const decoded = ctcGreedyDecode(logits, seq.length, classes, dict);
    expect(decoded.text).toBe("Play");
    expect(decoded.confidence).toBeGreaterThan(0.9);
  });
});

describe("boxesToText & findPhraseInBoxes", () => {
  it("orders multi-line boxes cleanly and finds exact phrase centers", () => {
    const boxes: OcrBox[] = [
      { text: "View", line: "File Edit View", near: "File Edit View", left: 90, top: 8, right: 120, bottom: 22, confidence: 0.9 },
      { text: "File", line: "File Edit View", near: "File Edit View", left: 10, top: 8, right: 36, bottom: 22, confidence: 0.9 },
      { text: "Edit", line: "File Edit View", near: "File Edit View", left: 46, top: 8, right: 76, bottom: 22, confidence: 0.9 },
      { text: "Launch", line: "Launch Game", near: "Launch Game", left: 100, top: 200, right: 160, bottom: 230, confidence: 0.95 },
      { text: "Game", line: "Launch Game", near: "Launch Game", left: 168, top: 200, right: 220, bottom: 230, confidence: 0.95 },
    ];
    expect(boxesToText(boxes)).toBe("File Edit View\nLaunch Game");

    const spots = findPhraseInBoxes(boxes, "Launch Game", { width: 400, height: 300 });
    expect(spots).toHaveLength(1);
    expect(spots[0]?.x).toBeCloseTo(160 / 400, 3);
    expect(spots[0]?.y).toBeCloseTo(215 / 300, 3);
  });
});

describe("FastOcr fallback", () => {
  it("falls back cleanly when ONNX models are absent and handles small synthetic PNGs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aichan-ocr-test-"));
    try {
      const png = await sharp({
        create: { width: 240, height: 140, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer();
      const ocr = new FastOcr({ cacheDir: dir, gpuBusy: () => true });
      const res = await ocr.recognize(png, { cropTopStrip: false });
      expect(res.engine).toBe("tesseract");
      expect(Array.isArray(res.boxes)).toBe(true);
      await ocr.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
