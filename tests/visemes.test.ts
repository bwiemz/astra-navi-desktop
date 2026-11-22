import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import {
  estimateSpokenOffset,
  sampleVisemeWeights,
  textToVisemes,
  VISEME_MORPH_CANDIDATES,
} from "../src/core/voice/visemes.ts";

describe("Phoneme-Driven Visemes & Tier 10 Pillar IV/V Config Defaults", () => {
  it("keeps Tier 10 Pillar IV and V flags strictly default-off", () => {
    const cfg = new ConfigStore(join(tmpdir(), "ai-chan-nonexistent-p45.json")).value;
    expect(cfg.tier10.episodicCalibration).toBe(false);
    expect(cfg.tier10.attentionArbiter).toBe(false);
    expect(cfg.tier10.nightlyHygiene).toBe(false);
    expect(cfg.tier10.fullDuplexVoice).toBe(false);
    expect(cfg.tier10.phonemeVisemes).toBe(false);
  });

  it("maps English and Japanese text into duration-normalized viseme tracks", () => {
    const en = textToVisemes("Hello Captain, open audio!", 1200, "en");
    expect(en.length).toBeGreaterThan(8);
    const totalEnDur = en.reduce((sum, f) => sum + f.durationMs, 0);
    expect(totalEnDur).toBeCloseTo(1200, 3);
    expect(en.some((f) => f.viseme === "O")).toBe(true);
    expect(en.some((f) => f.viseme === "A")).toBe(true);
    expect(en.some((f) => f.viseme === "closed")).toBe(true);

    const ja = textToVisemes("あいうえおん", 600, "ja");
    expect(ja.map((f) => f.viseme)).toEqual(["A", "I", "U", "E", "O", "closed"]);
    expect(VISEME_MORPH_CANDIDATES.A[0]).toBe("あ");
    expect(VISEME_MORPH_CANDIDATES.O[0]).toBe("お");
  });

  it("evaluates bounded smooth co-articulation weights and accurate interruption word offsets", () => {
    const frames = textToVisemes("あい", 400, "ja");
    const early = sampleVisemeWeights(frames, 100);
    expect(early.A).toBeGreaterThan(0.5);
    expect(early.A).toBeLessThanOrEqual(1);

    const boundary = sampleVisemeWeights(frames, 200);
    // Both overlapping co-articulation vowels active in smooth blend
    expect(boundary.A).toBeGreaterThan(0.1);
    expect(boundary.I).toBeGreaterThan(0.1);

    const afterEnd = sampleVisemeWeights(frames, 500);
    expect(afterEnd).toEqual({ A: 0, I: 0, U: 0, E: 0, O: 0 });

    const half = estimateSpokenOffset("One two three four five six", 500, 1000);
    expect(half.spokenWordOffset).toBe(3);
    expect(half.heardText).toBe("One two three");

    const jaOffset = estimateSpokenOffset("おはよう艦長", 500, 1000);
    expect(jaOffset.spokenWordOffset).toBe(3);
    expect(jaOffset.heardText).toBe("おはよ");
  });
});
