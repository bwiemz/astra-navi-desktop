import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectBundledPacks, editionFeatures, resolveEdition } from "../src/shared/edition.ts";

const ROOT = resolve(import.meta.dirname, "..");

describe("Open-Core vs Supporter Edition Split", () => {
  it("defaults to community edition and never gates security, evals, training, or BYO-MMD", () => {
    expect(resolveEdition({})).toBe("community");
    expect(resolveEdition({ ASTRA_NAVI_EDITION: "COMMUNITY" })).toBe("community");
    expect(resolveEdition({ ASTRA_NAVI_EDITION: "supporter" })).toBe("supporter");

    const community = editionFeatures("community");
    expect(community.coreRuntime).toBe(true);
    expect(community.securityGating).toBe(true);
    expect(community.defaultAstraAvatar).toBe(true);
    expect(community.byoMmdImport).toBe(true);
    expect(community.offlineEvalSuite).toBe(true);
    expect(community.localLoraTrainer).toBe(true);
    expect(community.mobileStation).toBe(true);
    expect(community.preTunedLoraPack).toBe(false);
    expect(community.supporterAvatarPacks).toBe(false);
    expect(community.storeAutoUpdate).toBe(false);
    expect(community.signedInstallers).toBe(false);
    expect(community.prebuiltAndroidApk).toBe(false);
    expect(community.packagedBrowserBridge).toBe(false);

    const supporter = editionFeatures("supporter");
    expect(supporter.coreRuntime).toBe(true);
    expect(supporter.securityGating).toBe(true);
    expect(supporter.preTunedLoraPack).toBe(true);
    expect(supporter.supporterAvatarPacks).toBe(true);
    expect(supporter.storeAutoUpdate).toBe(true);
    expect(supporter.signedInstallers).toBe(true);
    expect(supporter.prebuiltAndroidApk).toBe(true);
    expect(supporter.packagedBrowserBridge).toBe(true);
  });

  it("detects overlaid packs in the public community tree vs a simulated Supporter overlay", () => {
    const publicPacks = detectBundledPacks({
      bundledRoot: ROOT,
      exists: existsSync,
      readDir: (dir) => readdirSync(dir),
    });
    expect(publicPacks.variantIds).toEqual([]);
    expect(publicPacks.voicePresets).toEqual(["aria", "bright", "perky"]);
    expect(publicPacks.tunedLoraFiles).toEqual([]);
    expect(publicPacks.hasSupporterOverlay).toBe(false);

    const publicFeatures = editionFeatures("community", publicPacks);
    expect(publicFeatures.supporterAvatarPacks).toBe(false);
    expect(publicFeatures.preTunedLoraPack).toBe(false);

    const supporterOverlay = detectBundledPacks({
      bundledRoot: "/opt/supporter-app",
      exists: (path) =>
        path.endsWith("/astral-midnight/manifest.json") ||
        path.endsWith("/sakura-nebula/manifest.json") ||
        path.endsWith("/solar-dawn/manifest.json"),
      readDir: (dir) => {
        if (dir.endsWith("/assets/models/variants")) {
          return ["astral-midnight", "sakura-nebula", "solar-dawn", ".gitkeep"];
        }
        if (dir.endsWith("/assets/voice")) {
          return [
            "aria.wav",
            "bright.wav",
            "lively.wav",
            "lumi.wav",
            "melody.wav",
            "nova.wav",
            "perky.wav",
            "stella.wav",
            "sweet.wav",
            "vega.wav",
          ];
        }
        if (dir.endsWith("/assets/lora")) {
          return ["router-v1.safetensors", ".gitkeep"];
        }
        return [];
      },
    });
    expect(supporterOverlay.variantIds).toEqual([
      "astral-midnight",
      "sakura-nebula",
      "solar-dawn",
    ]);
    expect(supporterOverlay.voicePresets).toHaveLength(10);
    expect(supporterOverlay.tunedLoraFiles).toEqual(["router-v1.safetensors"]);
    expect(supporterOverlay.hasSupporterOverlay).toBe(true);

    const supporterFeatures = editionFeatures("supporter", supporterOverlay);
    expect(supporterFeatures.supporterAvatarPacks).toBe(true);
    expect(supporterFeatures.preTunedLoraPack).toBe(true);
  });
});
