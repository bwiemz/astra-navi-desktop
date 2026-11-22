import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Control } from "../src/core/hands.ts";
import type { OcrBox } from "../src/core/ocr.ts";
import { buildSomMarks, buildSomOverlaySvg, describeSomMarks, renderSomOverlay } from "../src/core/som.ts";

describe("Set-of-Mark (SoM) visual grounding", () => {
  const windowRect = { x: 100, y: 50, width: 800, height: 600 };
  const desktop = { width: 2560, height: 1440 };

  it("merges AT-SPI controls and OCR boxes, deduplicating overlapping controls", () => {
    const controls: Control[] = [
      {
        n: 1,
        kind: "button",
        name: "Play",
        rect: { x: 140, y: 450, width: 120, height: 40 },
      },
      {
        n: 2,
        kind: "button",
        name: "HiddenBtn",
        hidden: true,
        rect: { x: 300, y: 450, width: 80, height: 40 },
      },
      {
        n: 3,
        kind: "field",
        name: "",
        rect: { x: 140, y: 120, width: 220, height: 32 },
      },
    ];
    const ocrBoxes: OcrBox[] = [
      // Overlaps AT-SPI Play button (window-relative x=40..160, y=400..440) -> suppressed
      { text: "Play", line: "Play", near: "Play", left: 50, top: 408, right: 150, bottom: 432, confidence: 0.96 },
      // Menu item missed by AT-SPI -> kept as OCR mark
      { text: "File", line: "File Edit", near: "File Edit", left: 12, top: 8, right: 42, bottom: 24, confidence: 0.9 },
      // Empty whitespace -> skipped
      { text: "   ", line: "", near: "", left: 10, top: 10, right: 20, bottom: 20, confidence: 0.9 },
    ];

    const marks = buildSomMarks({ window: windowRect, desktop, controls, ocrBoxes });
    expect(marks.map((m) => `${m.id}:${m.source}:${m.label}`)).toEqual([
      "1:ocr:File",
      "2:control:field",
      "3:control:Play",
    ]);
    // Normalized desktop click center for "Play": (100 + 40 + 60) / 2560, (50 + 400 + 20) / 1440
    expect(marks[2]?.center.x).toBeCloseTo(200 / 2560, 4);
    expect(marks[2]?.center.y).toBeCloseTo(470 / 1440, 4);

    const summary = describeSomMarks(marks);
    expect(summary).toContain('[1] text "File"');
    expect(summary).toContain('[3] button "Play"');
  });

  it("renders XML-escaped SVG and composites a valid PNG of matching size", async () => {
    const marks = buildSomMarks({
      window: windowRect,
      desktop,
      controls: [
        {
          n: 1,
          kind: "button",
          name: "Save & <Export>",
          rect: { x: 120, y: 70, width: 100, height: 30 },
        },
      ],
      ocrBoxes: [
        { text: "Help", line: "Help", near: "Help", left: 600, top: 12, right: 640, bottom: 28, confidence: 0.92 },
      ],
    });

    const svg = buildSomOverlaySvg(marks, 800, 600);
    expect(svg).toContain('viewBox="0 0 800 600"');
    expect(svg).toContain("[1]");
    expect(svg).toContain("[2]");

    const baseImg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 24, g: 30, b: 44 } },
    })
      .png()
      .toBuffer();

    const composited = await renderSomOverlay(baseImg, marks, { width: 800, height: 600 });
    const meta = await sharp(composited).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });
});
