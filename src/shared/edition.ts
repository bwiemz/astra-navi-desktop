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

export type DistributionChannel = "standalone" | "steam" | "itch" | "flatpak";

export interface UpdateCheckResult {
  status: "disabled" | "up-to-date" | "update-available" | "error";
  channel: DistributionChannel;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  reason?: string;
}

/**
 * Detects how this build is distributed so store-managed packages (Steam, itch.io,
 * Flatpak) do not prompt users with standalone GitHub Releases update nags.
 */
export function detectDistributionChannel(
  env?: Record<string, string | undefined>,
  exists?: (path: string) => boolean,
): DistributionChannel {
  const source =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  const explicit = source["ASTRA_NAVI_DISTRIBUTION"]?.trim().toLowerCase();
  if (
    explicit === "steam" ||
    explicit === "itch" ||
    explicit === "flatpak" ||
    explicit === "standalone"
  ) {
    return explicit;
  }
  if (source["FLATPAK_ID"] || exists?.("/.flatpak-info")) {
    return "flatpak";
  }
  if (source["SteamAppId"] || source["STEAM_COMPAT_APP_ID"] || source["SteamGameId"]) {
    return "steam";
  }
  if (source["BUTLER_INSTALL"] || source["ITCHIO_API_KEY"] || source["WHARF_CHANNEL"]) {
    return "itch";
  }
  return "standalone";
}

export function shouldCheckGithubUpdates(
  env?: Record<string, string | undefined>,
  exists?: (path: string) => boolean,
): boolean {
  const edition = resolveEdition(env);
  if (editionFeatures(edition).storeAutoUpdate) return false;
  return detectDistributionChannel(env, exists) === "standalone";
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
