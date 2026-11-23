export type Edition = "community" | "supporter";

export interface BundledPackInventory {
  variantIds: string[];
  voicePresets: string[];
  tunedLoraFiles: string[];
  hasSupporterOverlay: boolean;
}

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
  // Build/distribution flags: govern storefront packaging behavior (disabling GitHub update nags
  // on Steam/itch.io) and auto-detect overlaid packs rather than enforcing client-side DRM booleans.
  preTunedLoraPack: boolean;
  supporterAvatarPacks: boolean;
  storeAutoUpdate: boolean;
  signedInstallers: boolean;
  prebuiltAndroidApk: boolean;
  packagedBrowserBridge: boolean;
}

function joinSubpath(root: string, ...parts: string[]): string {
  const cleanRoot = root.replace(/[\\/]+$/, "");
  const suffix = parts.map((p) => p.replace(/^[\\/]+|[\\/]+$/g, "")).filter(Boolean).join("/");
  return cleanRoot ? `${cleanRoot}/${suffix}` : suffix;
}

/**
 * Pure filesystem-callback helper that detects optional overlaid asset packs
 * (`variants/`, extra voice presets beyond the 3 core public voices, and optional `assets/lora/`).
 */
export function detectBundledPacks(options: {
  bundledRoot: string;
  exists?: (path: string) => boolean;
  readDir?: (path: string) => string[];
}): BundledPackInventory {
  const readDirSafe = (dir: string): string[] => {
    try {
      return options.readDir ? [...options.readDir(dir)] : [];
    } catch {
      return [];
    }
  };
  const existsSafe = (path: string): boolean => {
    try {
      return options.exists ? options.exists(path) : false;
    } catch {
      return false;
    }
  };

  const variantsDir = joinSubpath(options.bundledRoot, "assets", "models", "variants");
  const variantIds = readDirSafe(variantsDir)
    .filter((entry) => !entry.startsWith("."))
    .filter((entry) => {
      const manifestPath = joinSubpath(variantsDir, entry, "manifest.json");
      return options.exists ? existsSafe(manifestPath) : true;
    })
    .sort();

  const voiceDir = joinSubpath(options.bundledRoot, "assets", "voice");
  const voicePresets = readDirSafe(voiceDir)
    .filter((name) => name.endsWith(".wav"))
    .map((name) => name.slice(0, -".wav".length))
    .sort();

  const loraDir = joinSubpath(options.bundledRoot, "assets", "lora");
  const tunedLoraFiles = readDirSafe(loraDir)
    .filter((name) => /\.(gguf|safetensors|bin)$/i.test(name) && !name.startsWith("."))
    .sort();

  const hasSupporterOverlay =
    variantIds.length > 0 || tunedLoraFiles.length > 0 || voicePresets.length > 3;

  return {
    variantIds,
    voicePresets,
    tunedLoraFiles,
    hasSupporterOverlay,
  };
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

export function editionFeatures(
  edition: Edition,
  bundledPacks?: BundledPackInventory,
): EditionFeatures {
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
    preTunedLoraPack: bundledPacks ? bundledPacks.tunedLoraFiles.length > 0 : isSupporter,
    supporterAvatarPacks: bundledPacks ? bundledPacks.variantIds.length > 0 : isSupporter,
    storeAutoUpdate: isSupporter,
    signedInstallers: isSupporter,
    prebuiltAndroidApk: isSupporter,
    packagedBrowserBridge: isSupporter,
  };
}
