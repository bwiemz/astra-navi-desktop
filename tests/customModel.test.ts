import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PmxReader } from "babylon-mmd/esm/Loader/Parser/pmxReader.js";
import { describe, expect, it } from "vitest";
import { inspectCharacterBundle } from "../src/core/characterBundle.ts";
import { openLooseModelFolder, readModelInfo } from "../src/core/modelBundle.ts";

const MODEL_DIR = join(process.cwd(), "assets", "models", "ai-navigator");
const PMX_PATH = join(MODEL_DIR, "ai-navigator.pmx");

const REQUIRED_BONES = [
  "上半身",
  "首",
  "頭",
  "両目",
  "左目",
  "右目",
  "左腕",
  "右腕",
  "左腕捩",
  "右腕捩",
  "左ひじ",
  "右ひじ",
  "左手捩",
  "右手捩",
  "左親指０",
  "左人指１",
  "左中指１",
  "左薬指１",
  "左小指３",
  "右親指０",
  "右人指１",
  "右中指１",
  "右薬指１",
  "右小指３",
  "左足先EX",
  "右足先EX",
  "左足ＩＫ",
  "右足ＩＫ",
  "左つま先ＩＫ",
  "右つま先ＩＫ",
  "左髪1",
  "左髪2",
  "左髪3",
  "左髪4",
  "右髪1",
  "右髪2",
  "右髪3",
  "右髪4",
  "スカート前",
  "スカート前左",
  "スカート左",
  "スカート後左",
  "スカート後",
  "スカート後右",
  "スカート右",
  "スカート前右",
  "リボン左1",
  "リボン左2",
  "リボン右1",
  "リボン右2",
];

const REQUIRED_MORPHS = [
  "まばたき",
  "ウィンク",
  "ウィンク右",
  "笑い",
  "にこり",
  "なごみ",
  "びっくり",
  "じと目",
  "上",
  "下",
  "真面目",
  "困る",
  "あ",
  "い",
  "う",
  "え",
  "お",
  "ん",
  "ワ",
  "口角上げ",
  "口角下げ",
  "にやり",
  "∧",
  "にっこり",
  "照れ",
];

const IK_BONES = ["左足ＩＫ", "右足ＩＫ", "左つま先ＩＫ", "右つま先ＩＫ"];

describe("custom distributable chibi AI navigator model", () => {
  it("parses cleanly with babylon-mmd PmxReader and exposes all stage.ts bones & morphs", async () => {
    const buf = await readFile(PMX_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const pmx = await PmxReader.ParseAsync(ab);

    expect(pmx.vertices.length).toBeGreaterThan(3000);
    expect(pmx.indices.length).toBeGreaterThan(0);
    expect(pmx.indices.length % 3).toBe(0);
    for (let i = 0; i < pmx.indices.length; i += 1) {
      const vertIdx = pmx.indices[i];
      expect(vertIdx).toBeGreaterThanOrEqual(0);
      expect(vertIdx).toBeLessThan(pmx.vertices.length);
    }

    expect(pmx.textures.length).toBe(7);
    expect(pmx.textures.map((t) => t.replaceAll("\\", "/"))).toContain("textures/toon_skin.png");
    for (const texRel of pmx.textures) {
      const normalized = texRel.replaceAll("\\", "/");
      const info = await stat(join(MODEL_DIR, normalized));
      expect(info.isFile()).toBe(true);
    }

    const modelInfo = readModelInfo(buf);
    expect(modelInfo).not.toBeNull();
    expect(modelInfo?.name).toBe("Astra Navi");
    expect(modelInfo?.comment).toMatch(/CC-BY-4\.0|MIT/);

    expect(pmx.bones.length).toBeGreaterThanOrEqual(90);
    const boneByName = new Map(pmx.bones.map((b) => [b.name, b]));
    for (const requiredBone of REQUIRED_BONES) {
      expect(boneByName.has(requiredBone)).toBe(true);
    }
    for (const ikBoneName of IK_BONES) {
      const ikBone = boneByName.get(ikBoneName);
      expect(ikBone?.ik).toBeDefined();
      expect(ikBone?.ik?.links.length).toBeGreaterThan(0);
    }

    expect(pmx.rigidBodies.length).toBeGreaterThanOrEqual(30);
    expect(pmx.joints.length).toBeGreaterThanOrEqual(18);

    const morphByName = new Map(pmx.morphs.map((m) => [m.name, m]));
    for (const requiredMorph of REQUIRED_MORPHS) {
      const morph = morphByName.get(requiredMorph);
      expect(morph).toBeDefined();
      expect(morph?.type).toBe(1);
      if (morph && morph.type === 1) {
        expect(morph.indices.length).toBeGreaterThan(0);
        expect(morph.positions.length).toBe(morph.indices.length * 3);
      }
    }
  });

  it("passes character bundle inspection and openLooseModelFolder resolution", async () => {
    const inspection = await inspectCharacterBundle(MODEL_DIR);
    expect(inspection.ok).toBe(true);
    expect(inspection.manifest?.id).toBe("astra-navi-chibi");
    expect(inspection.manifest?.version).toBe("2.0.0");
    expect(inspection.manifest?.license).toBe("All-Rights-Reserved (Bundled-App Asset License; see LICENSE.txt)");
    expect(inspection.modelInfo?.name).toBe("Astra Navi");

    const bundle = await openLooseModelFolder(PMX_PATH);
    expect(bundle).not.toBeNull();
    expect(bundle?.entry).toBe("ai-navigator.pmx");
    expect(bundle?.info?.name).toBe("Astra Navi");
    expect(bundle?.fileCount).toBeGreaterThanOrEqual(7);

    expect(bundle?.get("ai-navigator.pmx")?.length).toBeGreaterThan(10000);
    expect(bundle?.get("textures\\tex_face.png")?.length).toBeGreaterThan(1000);
    expect(bundle?.get("TEXTURES/TEX_EYES.PNG")?.length).toBeGreaterThan(1000);

    const missing = await openLooseModelFolder(join(MODEL_DIR, "does-not-exist.pmx"));
    expect(missing).toBeNull();
  });
});
