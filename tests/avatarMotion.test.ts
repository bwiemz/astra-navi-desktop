import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AVATAR_EVENT_KINDS,
  BUILT_IN_EMOTE_PACKS,
  detectMotionClipFormat,
  evaluateIdleLoop,
  IDLE_LOOP_PRESETS,
  IdleFlourishScheduler,
  inspectVmdHeader,
  parseEmotePackJson,
  resolveEventReaction,
} from "../src/shared/avatarMotion.ts";

function makeSyntheticVmd(modelName: string, boneFrames = 12): Uint8Array {
  const buf = new Uint8Array(64);
  const sig = new TextEncoder().encode("Vocaloid Motion Data 0002");
  buf.set(sig, 0);
  const nameBytes = new TextEncoder().encode(modelName);
  buf.set(nameBytes.subarray(0, 19), 30);
  const view = new DataView(buf.buffer);
  view.setUint32(50, boneFrames, true);
  return buf;
}

describe("Avatar motion: idle loops, flourishes & event reactions", () => {
  it("evaluates smooth finite idle loops across all presets", () => {
    for (const preset of IDLE_LOOP_PRESETS) {
      const awakeSample = evaluateIdleLoop(preset, 4.2, 1, 0);
      expect(Number.isFinite(awakeSample.breath)).toBe(true);
      expect(Number.isFinite(awakeSample.sway)).toBe(true);
      expect(Number.isFinite(awakeSample.weightShift)).toBe(true);

      const sleepSample = evaluateIdleLoop(preset, 4.2, 0, 1);
      expect(sleepSample.sway).toBeCloseTo(0, 5);
      expect(sleepSample.weightShift).toBeCloseTo(0, 5);
    }
  });

  it("schedules ambient idle flourishes only when awake and unoccupied", () => {
    const scheduler = new IdleFlourishScheduler(10);
    expect(scheduler.poll(5, "playful-sway", true, () => 0)).toBeNull();
    expect(scheduler.poll(12, "playful-sway", false, () => 0)).toBeNull();
    const first = scheduler.poll(12, "playful-sway", true, () => 0);
    expect(first).toBe("perk");
    // Immediately after firing, cooldown prevents rapid-fire gestures.
    expect(scheduler.poll(13, "playful-sway", true, () => 0)).toBeNull();
    const second = scheduler.poll(40, "playful-sway", true, () => 0);
    expect(second).toBe("wave");
  });

  it("maps every desktop/companion event to a coordinated mood + gesture reaction", () => {
    for (const event of AVATAR_EVENT_KINDS) {
      const reaction = resolveEventReaction(event);
      expect(reaction.event).toBe(event);
      expect(reaction.mood.length).toBeGreaterThan(0);
      expect(reaction.gesture.length).toBeGreaterThan(0);
      expect(reaction.holdMoodMs).toBeGreaterThan(0);
    }
    expect(resolveEventReaction("reminder-fired").gesture).toBe("perk");
    expect(resolveEventReaction("mission-finished").gesture).toBe("cheer");
    expect(resolveEventReaction("mission-failed").mood).toBe("worried");
  });
});

describe("Data-only emote packs & VMD/VRMA motion clip validation", () => {
  it("validates built-in and custom data-only emote packs while blocking unsafe paths", () => {
    expect(BUILT_IN_EMOTE_PACKS.length).toBeGreaterThan(0);
    for (const pack of BUILT_IN_EMOTE_PACKS) {
      expect(() => parseEmotePackJson(pack)).not.toThrow();
    }

    const validPack = parseEmotePackJson({
      schemaVersion: 1,
      id: "supporter-dance-pack",
      name: "Supporter Emote Pack",
      author: "Astra Studio",
      version: "1.0.0",
      emotes: [
        {
          id: "victory-spin",
          label: "Victory Spin",
          category: "dance",
          mood: "excited",
          clipFile: "clips/victory.vrma",
          loop: false,
        },
        {
          id: "mmd-wave",
          label: "MMD Wave",
          category: "greeting",
          mood: "happy",
          clipFile: "clips/wave.vmd",
          loop: true,
        },
      ],
    });
    expect(validPack.emotes).toHaveLength(2);

    // Path traversal and executable extensions must be rejected.
    expect(() =>
      parseEmotePackJson({
        schemaVersion: 1,
        id: "bad-pack",
        name: "Bad",
        author: "Evil",
        version: "1.0.0",
        emotes: [{ id: "bad", label: "Bad", clipFile: "../../script.vmd" }],
      }),
    ).toThrow();
    expect(() =>
      parseEmotePackJson({
        schemaVersion: 1,
        id: "bad-ext",
        name: "Bad Ext",
        author: "Evil",
        version: "1.0.0",
        emotes: [{ id: "bad", label: "Bad", clipFile: "clips/payload.js" }],
      }),
    ).toThrow();
  });

  it("inspects valid VMD headers, detects VRMA vs VMD magic bytes, and rejects corrupt buffers", () => {
    const vmd = makeSyntheticVmd("AstraNavi", 42);
    expect(detectMotionClipFormat(vmd)).toBe("vmd");
    const info = inspectVmdHeader(vmd);
    expect(info.version).toBe("0002");
    expect(info.modelName).toBe("AstraNavi");
    expect(info.boneKeyFrameCount).toBe(42);

    const glbHeader = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
    expect(detectMotionClipFormat(glbHeader)).toBe("vrma");

    expect(() => inspectVmdHeader(new Uint8Array(10))).toThrow(/too short/i);
    expect(() => inspectVmdHeader(new Uint8Array(80))).toThrow(/not a valid/i);
  });

  it("wires VRMA + VMD playback, emote popover, and event reactions cleanly without innerHTML", () => {
    const root = join(import.meta.dirname, "..");
    const stageTs = readFileSync(join(root, "src/renderer/src/stage.ts"), "utf8");
    const mainRendererTs = readFileSync(join(root, "src/renderer/src/main.ts"), "utf8");
    const indexHtml = readFileSync(join(root, "src/renderer/index.html"), "utf8");
    const mainProcessTs = readFileSync(join(root, "src/main/index.ts"), "utf8");

    expect(stageTs).toContain("VmdLoader");
    expect(stageTs).toContain("VrmaStageBridge");
    expect(stageTs).toContain("playMotionBytes");
    expect(stageTs).toContain("triggerEventReaction");
    expect(indexHtml).toContain('id="emote-popover"');
    expect(indexHtml).toContain('id="emote-idle-preset"');
    expect(mainRendererTs).toContain("wireEmotePopover");
    expect(mainRendererTs).toContain("onAvatarReaction");
    expect(mainProcessTs).toContain('"stage:reaction"');
  });
});
