import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalOnnxWebcamPresence } from "../src/core/webcamPresenceOnnx.ts";

describe("Local ONNX Webcam Presence (Wave 3)", () => {
  it("stays disabled by default, detects skin-chroma fallback, writes zero disk files, and zeroes RAM on stop", async () => {
    const src = await readFile(
      join(import.meta.dirname, "../src/core/webcamPresenceOnnx.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\b(?:writeFile|createWriteStream|appendFile|mkdir)\b/);

    const cam = new LocalOnnxWebcamPresence();
    const w = 16;
    const h = 12;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i += 1) {
      rgb[i * 3] = 200;
      rgb[i * 3 + 1] = 140;
      rgb[i * 3 + 2] = 100;
    }

    const off = await cam.processRgbFrame(rgb, w, h);
    expect(off.enabled).toBe(false);
    expect(off.backend).toBe("disabled");

    cam.enabled = true;
    const on = await cam.processRgbFrame(rgb, w, h);
    expect(on.enabled).toBe(true);
    expect(on.present).toBe(true);
    expect(on.backend).toBe("luma-fallback");

    cam.stop();
    expect(cam.areBuffersZeroed()).toBe(true);
    await cam.dispose();
  });
});
