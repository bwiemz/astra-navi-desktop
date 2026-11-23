export type Edition = "community" | "supporter";

export interface EditionFeatures {
  edition: Edition;
  // Core open-source capabilities: always enabled in every edition
  coreRuntime: true;
  securityGating: true;
  defaultAstraAvatar: true;
  byoMmdImport: true;
  offlineEvalSuite: true;
  localLoraTrainer: true;
  mobileStation: true;
  // Optional supporter convenience packs & storefront distribution conveniences
  preTunedLoraPack: boolean;
  supporterAvatarPacks: boolean;
  storeAutoUpdate: boolean;
}

/**
 * Resolves the build/runtime edition (`community` open-core vs `supporter` store distribution).
 * Privacy, security gating, offline evals, local LoRA training, and BYO-MMD never require a paid key.
 */
export function resolveEdition(env?: Record<string, string | undefined>): Edition {
  const source =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  const raw = source["ASTRA_NAVI_EDITION"]?.trim().toLowerCase();
  return raw === "supporter" ? "supporter" : "community";
}

export function editionFeatures(edition: Edition): EditionFeatures {
  const isSupporter = edition === "supporter";
  return {
    edition,
    coreRuntime: true,
    securityGating: true,
    defaultAstraAvatar: true,
    byoMmdImport: true,
    offlineEvalSuite: true,
    localLoraTrainer: true,
    mobileStation: true,
    preTunedLoraPack: isSupporter,
    supporterAvatarPacks: isSupporter,
    storeAutoUpdate: isSupporter,
  };
}
