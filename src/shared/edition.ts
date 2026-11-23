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
  // Storefront distribution conveniences & optional supporter perks:
  // `preTunedLoraPack` only ships when a LoRA checkpoint clears `npm run eval -- --compare`;
  // v1.0.0 distributes verified baseline GGUF weights without a tuned adapter.
  preTunedLoraPack: boolean;
  supporterAvatarPacks: boolean;
  storeAutoUpdate: boolean;
  signedInstallers: boolean;
  prebuiltAndroidApk: boolean;
  packagedBrowserBridge: boolean;
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
    signedInstallers: isSupporter,
    prebuiltAndroidApk: isSupporter,
    packagedBrowserBridge: isSupporter,
  };
}
