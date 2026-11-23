import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openModelBundle, packModel, readModelInfo } from "../src/core/modelBundle.ts";
import { evaluateGestureMotion, GESTURES } from "../src/shared/gestures.ts";
import {
  extractImageBytes,
  parseVrmGlb,
  readAccessorFloat32,
  readAccessorIndices,
  readVrmSummary,
  VerletSpringSolver,
} from "../src/shared/vrm.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "astranavi-vrm-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function buildGlbBuffer(jsonObj: Record<string, unknown>, binData: Uint8Array): Buffer {
  const jsonText = JSON.stringify(jsonObj);
  const jsonBytes = Buffer.from(jsonText, "utf8");
  const jsonPaddedLen = Math.ceil(jsonBytes.length / 4) * 4;
  const jsonChunk = Buffer.alloc(jsonPaddedLen, 0x20); // space-padded per glTF 2.0 spec
  jsonBytes.copy(jsonChunk);

  const binPaddedLen = Math.ceil(binData.byteLength / 4) * 4;
  const binChunk = Buffer.alloc(binPaddedLen, 0x00);
  Buffer.from(binData).copy(binChunk);

  const totalLength = 12 + 8 + jsonChunk.length + (binPaddedLen > 0 ? 8 + binChunk.length : 0);
  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(0x46546c67, 0); // "glTF"
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);

  let offset = 12;
  out.writeUInt32LE(jsonChunk.length, offset);
  out.writeUInt32LE(0x4e4f534a, offset + 4); // "JSON"
  jsonChunk.copy(out, offset + 8);
  offset += 8 + jsonChunk.length;

  if (binPaddedLen > 0) {
    out.writeUInt32LE(binChunk.length, offset);
    out.writeUInt32LE(0x004e4942, offset + 4); // "BIN\0"
    binChunk.copy(out, offset + 8);
  }
  return out;
}

function buildSyntheticVrm1(): Buffer {
  // Vertex positions (3 vertices), morph delta (3 vertices), indices (3 ushort), tiny PNG header bytes
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const deltaAa = new Float32Array([0, -0.05, 0, 0, -0.05, 0, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const bin = Buffer.concat([
    Buffer.from(positions.buffer),
    Buffer.from(deltaAa.buffer),
    Buffer.from(indices.buffer),
    Buffer.from([0, 0]), // 4-byte align
    fakePng,
  ]);

  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "hips", translation: [0, 1, 0], children: [1, 2] },
      { name: "head", translation: [0, 0.6, 0], mesh: 0, children: [3] },
      { name: "hairRoot", translation: [0, 0.7, -0.1], children: [4] },
      { name: "hairCol", translation: [0, 0.55, 0] },
      { name: "hairTip", translation: [0, 0.4, -0.1] },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 },
      { buffer: 0, byteOffset: 80, byteLength: 8 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    images: [{ mimeType: "image/png", bufferView: 3 }],
    textures: [{ source: 0 }],
    materials: [{ name: "MToonFace", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [
      {
        name: "HeadMesh",
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 2,
            material: 0,
            targets: [{ POSITION: 1 }],
          },
        ],
      },
    ],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: {
          name: "VRoid Navi",
          version: "1.2.0",
          authors: ["Studio Chibi"],
          licenseUrl: "https://vrm.dev/licenses/1.0/",
          commercialUsage: "personalNonProfit",
        },
        humanoid: {
          humanBones: {
            hips: { node: 0 },
            head: { node: 1 },
          },
        },
        expressions: {
          preset: {
            aa: { isBinary: false, morphTargetBinds: [{ node: 1, index: 0, weight: 1 }] },
            blink: { isBinary: false, morphTargetBinds: [{ node: 1, index: 0, weight: 0.8 }] },
            happy: { isBinary: true, morphTargetBinds: [{ node: 1, index: 0, weight: 1 }] },
          },
        },
      },
      VRMC_springBone: {
        specVersion: "1.0",
        colliders: [{ node: 1, shape: { sphere: { offset: [0, 0, 0], radius: 0.14 } } }],
        colliderGroups: [{ colliders: [0] }],
        springs: [
          {
            name: "TwinTail",
            colliderGroups: [0],
            joints: [
              { node: 2, hitRadius: 0.03, stiffness: 1.5, gravityPower: 1.2, gravityDir: [0, -1, 0], dragForce: 0.3 },
              { node: 4, hitRadius: 0.03, stiffness: 1.0, gravityPower: 1.2, gravityDir: [0, -1, 0], dragForce: 0.3 },
            ],
          },
        ],
      },
    },
  };

  return buildGlbBuffer(json, bin);
}

describe("Pillar 1 & 4a: VRM 1.0 support, spring physics, and expanded gestures", () => {
  it("parses VRM 1.0 GLB metadata, accessors, textures, visemes, and spring bones", () => {
    const glb = buildSyntheticVrm1();
    const doc = parseVrmGlb(glb);

    expect(doc.meta.specVersion).toBe("1.0");
    expect(doc.meta.name).toBe("VRoid Navi");
    expect(doc.meta.authors).toEqual(["Studio Chibi"]);
    expect(doc.humanoidBones["hips"]).toBe(0);
    expect(doc.humanoidBones["head"]).toBe(1);
    expect(doc.expressions["aa"]?.binds[0]?.index).toBe(0);
    expect(doc.expressions["happy"]?.isBinary).toBe(true);
    expect(doc.springs).toHaveLength(1);
    expect(doc.springs[0]?.colliders[0]?.radius).toBeCloseTo(0.14, 5);

    const pos = readAccessorFloat32(doc, 0);
    expect(pos).toHaveLength(9);
    const idx = readAccessorIndices(doc, 2);
    expect(Array.from(idx)).toEqual([0, 1, 2]);
    const img = extractImageBytes(doc, 0);
    expect(img?.mimeType).toBe("image/png");
    expect(Array.from(img?.bytes.subarray(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const summary = readVrmSummary(glb);
    expect(summary?.name).toBe("VRoid Navi");
  });

  it("supports VRM 0.x blendShapeGroups normalization and Verlet spring-bone solver collision projection", () => {
    const glb0 = buildGlbBuffer(
      {
        asset: { version: "2.0" },
        nodes: [
          { name: "hips" },
          { name: "hairRoot", translation: [0, 1, 0], children: [2] },
          { name: "hairTip", translation: [0, 0.7, 0] },
        ],
        meshes: [{ name: "Face", primitives: [] }],
        extensions: {
          VRM: {
            meta: { title: "Classic VRM0", author: "ArtistA", version: "0.9" },
            humanoid: { humanBones: [{ bone: "hips", node: 0 }] },
            blendShapeMaster: {
              blendShapeGroups: [
                { presetName: "joy", isBinary: false, binds: [] },
                { presetName: "a", isBinary: false, binds: [] },
              ],
            },
            secondaryAnimation: {
              colliderGroups: [{ node: 0, colliders: [{ offset: { x: 0, y: 0.75, z: 0 }, radius: 0.25 }] }],
              boneGroups: [{ comment: "Hair", bones: [1], colliderGroups: [0], gravityPower: 1.5 }],
            },
          },
        },
      },
      new Uint8Array(0),
    );

    const doc0 = parseVrmGlb(glb0);
    expect(doc0.meta.specVersion).toBe("0.x");
    expect(doc0.expressions["happy"]).toBeDefined();
    expect(doc0.expressions["aa"]).toBeDefined();
    expect(doc0.springs).toHaveLength(1);

    const positions = new Map<number, [number, number, number]>([
      [0, [0, 0, 0]],
      [1, [0, 1, 0]],
      [2, [0, 0.7, 0.02]],
    ]);
    const solver = new VerletSpringSolver(doc0.springs, (n) => positions.get(n) ?? [0, 0, 0]);
    for (let i = 0; i < 60; i += 1) {
      solver.step(1 / 60, (n) => positions.get(n) ?? [0, 0, 0]);
    }
    const tail = solver.chains[0]?.joints[0]?.currentTail;
    expect(tail).toBeDefined();
    // Bone length stays constrained at 0.3005m and outside collider radius.
    const distFromRoot = Math.hypot(tail?.[0] ?? 0, (tail?.[1] ?? 0) - 1, tail?.[2] ?? 0);
    expect(distFromRoot).toBeCloseTo(Math.hypot(0, -0.3, 0.02), 2);
  });

  it("packs single-file .vrm into encrypted modelBundle without pulling unrelated sibling files", async () => {
    const dir = await makeTempDir();
    const vrmPath = join(dir, "avatar.vrm");
    const unrelatedTxt = join(dir, "huge-unrelated-file.txt");
    const bundlePath = join(dir, "sealed.bundle");
    const key = Buffer.alloc(32, 0x42);

    const glb = buildSyntheticVrm1();
    await writeFile(vrmPath, glb);
    await writeFile(unrelatedTxt, "should not be swept into vrm bundle");

    expect(readModelInfo(glb)?.name).toBe("VRoid Navi");
    const packed = await packModel(vrmPath, bundlePath, key);
    expect(packed.files).toBe(1);

    const reopened = await openModelBundle(bundlePath, key);
    expect(reopened?.entry).toBe("avatar.vrm");
    expect(reopened?.info?.name).toBe("VRoid Navi");
    expect(reopened?.fileCount).toBe(1);
  });

  it("evaluates all 10 expanded conversation gestures smoothly across [0, 1]", () => {
    const names = Object.keys(GESTURES) as (keyof typeof GESTURES)[];
    expect(names).toEqual(
      expect.arrayContaining([
        "nod",
        "shake",
        "perk",
        "wave",
        "think",
        "point",
        "shrug",
        "salute",
        "cheer",
        "bow",
      ]),
    );

    for (const kind of names) {
      const start = evaluateGestureMotion(kind, 0);
      const mid = evaluateGestureMotion(kind, 0.35);
      const end = evaluateGestureMotion(kind, 1);
      expect(Object.values(start).every((v) => v === 0)).toBe(true);
      expect(Object.values(end).every((v) => v === 0)).toBe(true);
      expect(Object.values(mid).some((v) => Math.abs(v) > 0.05)).toBe(true);
    }
  });
});
