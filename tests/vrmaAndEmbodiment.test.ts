import { describe, expect, it } from "vitest";
import { ProceduralAvatarController } from "../src/renderer/src/avatarAnimator.ts";
import {
  evaluateLayeredSpritePose,
  LayeredSpriteRigManifestSchema,
} from "../src/shared/avatar2d.ts";
import { PresenceNotificationGate } from "../src/shared/spatialStage.ts";
import { parseVrmaBinary, sampleVrmaClip } from "../src/shared/vrma.ts";

function buildMinimalVrmaBinary(): Uint8Array {
  const times = new Float32Array([0, 1]);
  // Hips rotation: 0 deg -> 90 deg around Y axis
  const halfAngle = Math.PI / 4;
  const quats = new Float32Array([
    0, 0, 0, 1,
    0, Math.sin(halfAngle), 0, Math.cos(halfAngle),
  ]);
  // Hips translation: [0, 1, 0] -> [0, 1.2, 0]
  const pos = new Float32Array([0, 1, 0, 0, 1.2, 0]);
  // Happy expression X channel: 0 -> 1
  const exprPos = new Float32Array([0, 0, 0, 1, 0, 0]);

  const binRaw = new Uint8Array(
    times.byteLength + quats.byteLength + pos.byteLength + exprPos.byteLength,
  );
  let off = 0;
  binRaw.set(new Uint8Array(times.buffer), off);
  const timesOff = off;
  off += times.byteLength;

  binRaw.set(new Uint8Array(quats.buffer), off);
  const quatsOff = off;
  off += quats.byteLength;

  binRaw.set(new Uint8Array(pos.buffer), off);
  const posOff = off;
  off += pos.byteLength;

  binRaw.set(new Uint8Array(exprPos.buffer), off);
  const exprOff = off;

  const gltf = {
    asset: { version: "2.0" },
    extensionsUsed: ["VRMC_vrm_animation"],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: "1.0",
        humanoid: { humanBones: { hips: { node: 0 } } },
        expressions: { preset: { happy: { node: 1 } } },
      },
    },
    nodes: [{ name: "hips" }, { name: "happyExpr" }],
    bufferViews: [
      { buffer: 0, byteOffset: timesOff, byteLength: times.byteLength },
      { buffer: 0, byteOffset: quatsOff, byteLength: quats.byteLength },
      { buffer: 0, byteOffset: posOff, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: exprOff, byteLength: exprPos.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: "SCALAR" },
      { bufferView: 1, componentType: 5126, count: 2, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
      { bufferView: 3, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [
      {
        name: "idle_sway",
        samplers: [
          { input: 0, output: 1, interpolation: "LINEAR" },
          { input: 0, output: 2, interpolation: "LINEAR" },
          { input: 0, output: 3, interpolation: "LINEAR" },
        ],
        channels: [
          { sampler: 0, target: { node: 0, path: "rotation" } },
          { sampler: 1, target: { node: 0, path: "translation" } },
          { sampler: 2, target: { node: 1, path: "translation" } },
        ],
      },
    ],
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = new TextEncoder().encode(jsonStr);
  const jsonPad = (4 - (jsonBuf.byteLength % 4)) % 4;
  const binPad = (4 - (binRaw.byteLength % 4)) % 4;
  const totalLen = 12 + 8 + jsonBuf.byteLength + jsonPad + 8 + binRaw.byteLength + binPad;

  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);

  let p = 12;
  dv.setUint32(p, jsonBuf.byteLength + jsonPad, true);
  dv.setUint32(p + 4, 0x4e4f534a, true);
  out.set(jsonBuf, p + 8);
  for (let i = 0; i < jsonPad; i += 1) out[p + 8 + jsonBuf.byteLength + i] = 0x20;
  p += 8 + jsonBuf.byteLength + jsonPad;

  dv.setUint32(p, binRaw.byteLength + binPad, true);
  dv.setUint32(p + 4, 0x004e4942, true);
  out.set(binRaw, p + 8);
  return out;
}

describe("VRMA Parser & Procedural Avatar Controller", () => {
  it("parses valid .vrma GLB, SLERPs rotations cleanly, and rejects malformed buffers", () => {
    const valid = buildMinimalVrmaBinary();
    const clip = parseVrmaBinary(valid);
    expect(clip.name).toBe("idle_sway");
    expect(clip.durationSec).toBe(1);

    const mid = sampleVrmaClip(clip, 0.5, false);
    // Halfway between 0 and 90 deg Y rotation -> sin(22.5 deg) ~ 0.3827
    expect(mid.humanoidRotations["hips"]?.[1]).toBeCloseTo(Math.sin(Math.PI / 8), 3);
    expect(mid.hipsTranslation?.[1]).toBeCloseTo(1.1, 3);
    expect(mid.expressions["happy"]).toBeCloseTo(0.5, 3);

    // Truncated / bad magic / corrupted length must fail cleanly
    expect(() => parseVrmaBinary(valid.subarray(0, 16))).toThrow();
    const badMagic = new Uint8Array(valid);
    badMagic[0] = 0;
    expect(() => parseVrmaBinary(badMagic)).toThrow();
  });

  it("crossfades clips, clamps damped spring look-at IK, and blends expressive cues", () => {
    const clip = parseVrmaBinary(buildMinimalVrmaBinary());
    const ctrl = new ProceduralAvatarController();
    ctrl.playClip(clip, { fadeSec: 0.2, loop: true });
    ctrl.setLookTarget(120, -90); // Extreme target must be anatomically clamped
    ctrl.setExpressiveCue({
      emphasis: 0.8,
      pause: false,
      laugh: 0,
      eyebrowRaise: 0.65,
      headTiltDeg: 6,
      nodDrive: 0.5,
      postureEnergy: 1.15,
    });

    let pose = ctrl.step(0.05);
    for (let i = 0; i < 30; i += 1) pose = ctrl.step(0.05);
    expect(pose.clipActive).toBe(true);
    expect(pose.headYawDeg).toBeLessThanOrEqual(ctrl.maxHeadYawDeg);
    expect(Math.abs(pose.headPitchDeg)).toBeLessThanOrEqual(ctrl.maxHeadPitchDeg);
    expect(pose.eyebrowRaise).toBeCloseTo(0.65, 2);
    expect(pose.headTiltDeg).toBe(6);

    ctrl.stopClip(0.1);
    const faded = ctrl.step(0.15);
    expect(faded.clipActive).toBe(false);
  });
});

describe("Presence Notification Gate", () => {
  it("holds non-urgent notices while away, bypasses urgent ones, and flushes on sit-down", () => {
    const gate = new PresenceNotificationGate({ initialPresent: false });
    const normal = gate.enqueue({ id: "1", text: "Backup finished", urgent: false, atMs: 100 });
    expect(normal.held).toBe(true);
    expect(normal.deliverNow).toBe(false);

    const urgent = gate.enqueue({ id: "2", text: "Disk critical!", urgent: true, atMs: 120 });
    expect(urgent.deliverNow).toBe(true);
    expect(gate.pendingCount).toBe(1);

    const wake = gate.updatePresence(true);
    expect(wake.wokeUp).toBe(true);
    expect(wake.flushed).toHaveLength(1);
    expect(wake.flushed[0]?.id).toBe("1");
    expect(gate.pendingCount).toBe(0);
  });
});

describe("Open 2D Layered-Sprite Rig & Live2D Licensing Audit", () => {
  it("validates relative layer assets, blocks traversal/URLs, and evaluates viseme & blink swaps", () => {
    const manifest = LayeredSpriteRigManifestSchema.parse({
      version: 1,
      name: "Astra Mini 2D",
      width: 512,
      height: 512,
      layers: [
        { id: "base", asset: "layers/base.png", zIndex: 0, role: "base" },
        { id: "eyes", asset: "layers/eyes_open.png", zIndex: 10, role: "eyes" },
        { id: "mouth", asset: "layers/mouth_closed.png", zIndex: 11, role: "mouth" },
        { id: "brows", asset: "layers/brows.png", zIndex: 12, role: "brows" },
      ],
      visemeAssets: { A: "layers/mouth_a.png", closed: "layers/mouth_closed.png" },
      blinkEyeAsset: "layers/eyes_blink.png",
    });

    const evaluated = evaluateLayeredSpritePose(manifest, {
      mood: "happy",
      visemes: { A: 0.85, I: 0, U: 0, E: 0, O: 0 },
      blink: 0.9,
      gazeX: 0.5,
      gazeY: -0.25,
      cue: {
        eyebrowRaise: 0.6,
        headTiltDeg: 5,
        nodDrive: 0.4,
        emphasis: 0.5,
        postureEnergy: 1.1,
      },
    });
    expect(evaluated.find((l) => l.id === "eyes")?.asset).toBe("layers/eyes_blink.png");
    expect(evaluated.find((l) => l.id === "mouth")?.asset).toBe("layers/mouth_a.png");

    expect(() =>
      LayeredSpriteRigManifestSchema.parse({
        version: 1,
        name: "Evil",
        width: 256,
        height: 256,
        layers: [{ id: "bad", asset: "../../etc/passwd.png", zIndex: 0 }],
      }),
    ).toThrow();
    expect(() =>
      LayeredSpriteRigManifestSchema.parse({
        version: 1,
        name: "Remote",
        width: 256,
        height: 256,
        layers: [{ id: "bad", asset: "https://evil.test/sprite.png", zIndex: 0 }],
      }),
    ).toThrow();
  });
});
