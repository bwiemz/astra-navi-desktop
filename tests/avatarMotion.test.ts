import { describe, expect, it } from "vitest";
import { ProceduralAvatarController } from "../src/renderer/src/avatarAnimator.ts";
import { VrmaStageBridge } from "../src/renderer/src/vrmaStageBridge.ts";
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
import type { QuatTuple, VrmaClip } from "../src/shared/vrma.ts";

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

  it("ends non-looping VRMA clips cleanly after durationSec and restores legs, hands, fingers, and expressions to rest pose", () => {
    const poseQuat: QuatTuple = [0, Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)];
    const clip: VrmaClip = {
      name: "wave-and-step",
      specVersion: "1.0",
      durationSec: 0.4,
      humanoidRotations: {
        leftUpperLeg: {
          times: new Float32Array([0, 0.4]),
          values: new Float32Array([...poseQuat, ...poseQuat]),
        },
        rightHand: {
          times: new Float32Array([0, 0.4]),
          values: new Float32Array([...poseQuat, ...poseQuat]),
        },
        leftIndexProximal: {
          times: new Float32Array([0, 0.4]),
          values: new Float32Array([...poseQuat, ...poseQuat]),
        },
      },
      hipsTranslation: null,
      expressions: {
        happy: {
          times: new Float32Array([0, 0.4]),
          values: new Float32Array([0.9, 0.9]),
        },
      },
      lookAt: null,
    };

    const controller = new ProceduralAvatarController();
    const bridge = new VrmaStageBridge(controller);
    const appliedBones = new Map<string, QuatTuple>();
    const appliedExpressions = new Map<string, number>();
    const sink = {
      setBoneRotation: (bone: string, q: QuatTuple) => {
        appliedBones.set(bone, q);
      },
      setHipsTranslation: () => undefined,
      setExpressionWeight: (name: string, w: number) => {
        appliedExpressions.set(name, w);
      },
      setEyeGaze: () => undefined,
    };

    controller.playClip(clip, { loop: false, fadeSec: 0.05 });

    // Mid-clip (0.2s): clip is active and poses legs, hands, fingers, and expression.
    const midPose = bridge.step(0.2, sink);
    expect(midPose.clipActive).toBe(true);
    expect(midPose.clipBlendWeight).toBeGreaterThan(0.9);
    expect(appliedBones.get("leftUpperLeg")?.[1]).toBeCloseTo(poseQuat[1], 3);
    expect(appliedBones.get("rightHand")?.[1]).toBeCloseTo(poseQuat[1], 3);
    expect(appliedBones.get("leftIndexProximal")?.[1]).toBeCloseTo(poseQuat[1], 3);
    expect(appliedExpressions.get("happy")).toBeCloseTo(0.9, 2);

    // Past end of non-looping clip (0.25s more -> 0.45s >= 0.4s): auto-stops and starts fade-out.
    const triggerFade = bridge.step(0.25, sink);
    expect(triggerFade.clipActive).toBe(false);

    // Advance past 0.25s fade-out window: blend weight reaches 0 and all non-idle bones reset to identity!
    let finalPose = triggerFade;
    for (let i = 0; i < 6; i += 1) {
      finalPose = bridge.step(0.05, sink);
    }
    expect(finalPose.clipActive).toBe(false);
    expect(finalPose.clipBlendWeight).toBe(0);
    expect(appliedBones.get("leftUpperLeg")).toEqual([0, 0, 0, 1]);
    expect(appliedBones.get("rightHand")).toEqual([0, 0, 0, 1]);
    expect(appliedBones.get("leftIndexProximal")).toEqual([0, 0, 0, 1]);
    expect(appliedExpressions.get("happy")).toBe(0);
  });

  it("restores legs, hands, and finger bones to identity when stopping a looping VRMA clip manually", () => {
    const bentQuat: QuatTuple = [Math.sin(Math.PI / 5), 0, 0, Math.cos(Math.PI / 5)];
    const clip: VrmaClip = {
      name: "loop-dance",
      specVersion: "1.0",
      durationSec: 1.0,
      humanoidRotations: {
        rightLowerLeg: {
          times: new Float32Array([0, 1.0]),
          values: new Float32Array([...bentQuat, ...bentQuat]),
        },
        leftHand: {
          times: new Float32Array([0, 1.0]),
          values: new Float32Array([...bentQuat, ...bentQuat]),
        },
        rightThumbProximal: {
          times: new Float32Array([0, 1.0]),
          values: new Float32Array([...bentQuat, ...bentQuat]),
        },
      },
      hipsTranslation: null,
      expressions: {},
      lookAt: null,
    };

    const controller = new ProceduralAvatarController();
    controller.playClip(clip, { loop: true, fadeSec: 0 });
    const playing = controller.step(0.1);
    expect(playing.clipActive).toBe(true);
    expect(playing.boneRotations["rightLowerLeg"]?.[0]).toBeCloseTo(bentQuat[0], 3);

    controller.stopClip(0.15);
    const fading = controller.step(0.05);
    expect(fading.clipActive).toBe(false);
    expect(fading.clipBlendWeight).toBeGreaterThan(0);

    const settled = controller.step(0.15);
    expect(settled.clipActive).toBe(false);
    expect(settled.clipBlendWeight).toBe(0);
    expect(settled.boneRotations["rightLowerLeg"]).toEqual([0, 0, 0, 1]);
    expect(settled.boneRotations["leftHand"]).toEqual([0, 0, 0, 1]);
    expect(settled.boneRotations["rightThumbProximal"]).toEqual([0, 0, 0, 1]);
  });
});
