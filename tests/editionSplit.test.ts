import { describe, expect, it } from "vitest";
import { editionFeatures, resolveEdition } from "../src/shared/edition.ts";

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
});
