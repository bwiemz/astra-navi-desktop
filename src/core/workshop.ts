import { createHash, sign, timingSafeEqual, verify } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { inspectCharacterBundle, openSignedCharacterBundle } from "./characterBundle.ts";
import { canonicalJsonBytes, PluginManifestSchema, verifyPluginBundle } from "./pluginSdk.ts";
import { isInside } from "./riskRules.ts";

/**
 * Steam Workshop & Signed Creator Pack Distribution.
 *
 * - Scans local Steam Workshop subscriptions (`libraryfolders.vdf` +
 *   `steamapps/workshop/content/<appId>/<itemId>/`) across Linux, Windows, and macOS.
 * - Imports signed HTTPS Creator Catalogs for GitHub Releases / itch.io / direct
 *   downloads using Ed25519 signature verification and per-pack SHA-256 checks.
 * - Supports characters (`.pmx`, `.pmd`, `.vrm`, `.bundle`), outfits, animations,
 *   voice profiles, and verified plugin packs with zero path-traversal exposure.
 */

export const CREATOR_PACK_KINDS = [
  "character",
  "plugin",
  "outfit",
  "animation",
  "voice",
] as const;
export type CreatorPackKind = (typeof CREATOR_PACK_KINDS)[number];

export const CreatorPackEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  kind: z.enum(CREATOR_PACK_KINDS),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32),
  author: z.string().min(1).max(80),
  license: z.string().min(1).max(120),
  url: z
    .string()
    .url()
    .max(512)
    .refine((u) => u.startsWith("https://"), "Creator pack URLs must use https://."),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  sizeBytes: z.number().int().min(1).max(512 * 1024 * 1024),
  description: z.string().max(400).optional(),
  tags: z.array(z.string().max(32)).max(12).optional(),
});
export type CreatorPackEntry = z.infer<typeof CreatorPackEntrySchema>;

export const CreatorCatalogSchema = z.object({
  catalogVersion: z.literal(1),
  publisher: z.string().min(1).max(80),
  issuedAt: z.string().min(1).max(64),
  packs: z.array(CreatorPackEntrySchema).max(200),
  signature: z.string().max(512).optional(),
});
export type CreatorCatalog = z.infer<typeof CreatorCatalogSchema>;

export const AssetPackManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  kind: z.enum(["outfit", "animation", "voice"]),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32),
  author: z.string().min(1).max(80),
  license: z.string().min(1).max(120),
  entry: z
    .string()
    .min(1)
    .max(160)
    .refine((p) => !p.includes("..") && !p.startsWith("/") && !p.includes("\\")),
});
export type AssetPackManifest = z.infer<typeof AssetPackManifestSchema>;

export interface WorkshopDiscoveredItem {
  workshopId: string;
  itemDir: string;
  kind: "character" | "plugin" | "asset_pack";
  id: string;
  name: string;
  version: string;
  verifiedSignature: boolean;
}

export interface WorkshopSubscription {
  id: string;
  kind: CreatorPackKind;
  name: string;
  version: string;
  author: string;
  source: "steam-workshop" | "signed-catalog";
  installDir: string;
  workshopId?: string;
  sha256?: string;
  subscribedAt: string;
  verifiedSignature: boolean;
}

/** Parses Steam's `libraryfolders.vdf` to extract configured Steam library directories. */
export function parseValveKeyValuesLibraries(vdfText: string): string[] {
  const libs = new Set<string>();
  const pattern = /"path"\s+"([^"]+)"/gi;
  let match: RegExpExecArray | null = pattern.exec(vdfText);
  while (match) {
    const raw = match[1]?.replaceAll("\\\\", "\\").trim();
    if (raw) libs.add(raw);
    match = pattern.exec(vdfText);
  }
  return [...libs];
}

/** Returns platform-appropriate default Steam root directories for discovering Workshop content. */
export function defaultSteamRoots(
  platform: NodeJS.Platform = process.platform,
  home = process.env["HOME"] ?? "",
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === "win32") {
    const progX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localApp = env["LOCALAPPDATA"] ?? "";
    return [join(progX86, "Steam"), ...(localApp ? [join(localApp, "Steam")] : [])];
  }
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "Steam")];
  }
  return [
    join(home, ".local", "share", "Steam"),
    join(home, ".steam", "steam"),
    join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
  ];
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Scans Steam Workshop downloads (`<library>/steamapps/workshop/content/<appId>/<itemId>`)
 * for validated character rigs, signed creator plugin packs, and animation/voice/outfit add-ons.
 */
export async function scanSteamWorkshopItems(options: {
  appId: string;
  steamRoots?: readonly string[];
  trustedPublicKeysPem?: readonly string[];
}): Promise<WorkshopDiscoveredItem[]> {
  if (!/^\d+$/.test(options.appId)) {
    throw new Error(`Invalid Steam App ID "${options.appId}".`);
  }
  const roots = [...(options.steamRoots ?? defaultSteamRoots())];
  const libraryDirs = new Set<string>();

  for (const root of roots) {
    libraryDirs.add(resolve(root));
    const vdfPath = join(root, "steamapps", "libraryfolders.vdf");
    try {
      const vdf = await readFile(vdfPath, "utf8");
      for (const lib of parseValveKeyValuesLibraries(vdf)) {
        libraryDirs.add(resolve(lib));
      }
    } catch {
      // Root does not contain libraryfolders.vdf; continue scanning remaining roots.
    }
  }

  const trustedKeys = options.trustedPublicKeysPem ?? [];
  const discovered: WorkshopDiscoveredItem[] = [];
  const seenDirs = new Set<string>();

  for (const lib of libraryDirs) {
    const contentDir = join(lib, "steamapps", "workshop", "content", options.appId);
    let entries;
    try {
      entries = await readdir(contentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d+$/.test(entry.name)) continue;
      const itemDir = resolve(contentDir, entry.name);
      if (seenDirs.has(itemDir) || !isInside(itemDir, contentDir)) continue;
      seenDirs.add(itemDir);

      const manifestFile = join(itemDir, "manifest.json");
      if (await isSymlink(manifestFile)) continue;

      let rawJson: unknown;
      try {
        rawJson = JSON.parse(await readFile(manifestFile, "utf8")) as unknown;
      } catch {
        continue;
      }

      // 1. Character bundle (.pmx/.pmd/.vrm + shader/animations/voice overrides)
      if (typeof rawJson === "object" && rawJson !== null && "modelEntry" in rawJson) {
        const inspected = await inspectCharacterBundle(itemDir, {
          trustedPublicKeysPem: trustedKeys,
        });
        if (inspected.ok && inspected.manifest) {
          discovered.push({
            workshopId: entry.name,
            itemDir,
            kind: "character",
            id: inspected.manifest.id,
            name: inspected.manifest.name,
            version: inspected.manifest.version,
            verifiedSignature: inspected.verifiedSignature,
          });
        }
        continue;
      }

      // 2. Plugin SDK pack (requires valid manifest + entry digest + optional signature)
      if (typeof rawJson === "object" && rawJson !== null && "permissions" in rawJson) {
        const parsed = PluginManifestSchema.safeParse(rawJson);
        if (!parsed.success) continue;
        const entryPath = resolve(itemDir, parsed.data.entry);
        if (!isInside(entryPath, itemDir) || (await isSymlink(entryPath))) continue;
        try {
          const entryBytes = await readFile(entryPath);
          let sig = "";
          try {
            sig = (await readFile(join(itemDir, "manifest.sig"), "utf8")).trim();
          } catch {
            // Signature optional when scanning unverified local Workshop folders.
          }
          let verifiedSignature = false;
          if (sig && trustedKeys.length > 0) {
            const check = await verifyPluginBundle({
              manifest: parsed.data,
              signature: sig,
              entryBytes,
              trustedPublicKeysPem: trustedKeys,
            });
            if (!check.ok) continue;
            verifiedSignature = true;
          } else {
            const actual = createHash("sha256").update(entryBytes).digest();
            const expected = Buffer.from(parsed.data.sha256, "hex");
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) continue;
          }
          discovered.push({
            workshopId: entry.name,
            itemDir,
            kind: "plugin",
            id: parsed.data.id,
            name: parsed.data.name,
            version: parsed.data.version,
            verifiedSignature,
          });
        } catch {
          // Skip invalid item cleanly.
        }
        continue;
      }

      // 3. Asset add-on pack (outfit, animation, voice profile)
      const assetParsed = AssetPackManifestSchema.safeParse(rawJson);
      if (assetParsed.success) {
        const entryPath = resolve(itemDir, assetParsed.data.entry);
        if (isInside(entryPath, itemDir) && !(await isSymlink(entryPath))) {
          discovered.push({
            workshopId: entry.name,
            itemDir,
            kind: "asset_pack",
            id: assetParsed.data.id,
            name: assetParsed.data.name,
            version: assetParsed.data.version,
            verifiedSignature: false,
          });
        }
      }
    }
  }

  return discovered.sort((a, b) => a.id.localeCompare(b.id));
}

function unsignedCatalogBytes(catalog: CreatorCatalog): Buffer {
  const rest = Object.fromEntries(
    Object.entries(catalog).filter(([k]) => k !== "signature"),
  );
  return canonicalJsonBytes(rest);
}

/** Signs a Creator Catalog JSON payload with an Ed25519 private key PEM. */
export function signCreatorCatalog(
  catalog: Omit<CreatorCatalog, "signature">,
  privateKeyPem: string,
): string {
  const parsed = CreatorCatalogSchema.parse(catalog);
  return sign(null, unsignedCatalogBytes(parsed), privateKeyPem).toString("base64");
}

/** Verifies an Ed25519-signed Creator Catalog for GitHub Releases / itch.io distribution. */
export function verifyCreatorCatalog(
  rawCatalog: unknown,
  trustedPublicKeysPem: readonly string[],
): { ok: true; catalog: CreatorCatalog } | { ok: false; reason: string } {
  const parsed = CreatorCatalogSchema.safeParse(rawCatalog);
  if (!parsed.success) {
    return { ok: false, reason: `Invalid creator catalog schema: ${parsed.error.message}` };
  }
  if (!parsed.data.signature || trustedPublicKeysPem.length === 0) {
    return { ok: false, reason: "Creator catalog signature or trusted public keys missing." };
  }
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(parsed.data.signature, "base64");
  } catch {
    return { ok: false, reason: "Malformed base64 catalog signature." };
  }
  const payload = unsignedCatalogBytes(parsed.data);
  for (const key of trustedPublicKeysPem) {
    try {
      if (verify(null, payload, key, sigBytes)) {
        return { ok: true, catalog: parsed.data };
      }
    } catch {
      // Try next trusted publisher key.
    }
  }
  return { ok: false, reason: "Creator catalog Ed25519 signature did not verify." };
}

export interface InstallCreatorPackOptions {
  entry: CreatorPackEntry;
  installRoot: string;
  fetchBytes?(url: string): Promise<Buffer>;
  trustedBundleKeysPem?: readonly string[];
  requireSignedBundle?: boolean;
}

/**
 * Downloads (HTTPS only), SHA-256 verifies with `timingSafeEqual`, and installs a Creator Pack
 * cleanly inside `installRoot/<id>` without allowing path traversal or tampered archives.
 */
export async function installCreatorPack(
  options: InstallCreatorPackOptions,
): Promise<WorkshopSubscription> {
  const entry = CreatorPackEntrySchema.parse(options.entry);
  const fetcher =
    options.fetchBytes ??
    (async (url: string): Promise<Buffer> => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading creator pack.`);
      return Buffer.from(await res.arrayBuffer());
    });

  const payload = await fetcher(entry.url);
  if (payload.byteLength === 0 || payload.byteLength > entry.sizeBytes * 2) {
    throw new Error(`Creator pack size mismatch for "${entry.id}" (${payload.byteLength} bytes).`);
  }

  const actualHash = createHash("sha256").update(payload).digest();
  const expectedHash = Buffer.from(entry.sha256, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw new Error(`Creator pack "${entry.id}" failed SHA-256 integrity verification.`);
  }

  const rootResolved = resolve(options.installRoot);
  const packDir = resolve(rootResolved, basename(entry.id));
  if (!isInside(packDir, rootResolved)) {
    throw new Error(`Refused path traversal in pack id "${entry.id}".`);
  }
  await mkdir(packDir, { recursive: true, mode: 0o700 });

  let verifiedSignature = false;
  if (entry.kind === "character" && payload.subarray(0, 8).toString("ascii") === "AICHANB1") {
    const bundleOut = join(packDir, `${entry.id}.bundle`);
    await writeFile(`${bundleOut}.tmp`, payload, { mode: 0o600 });
    await rename(`${bundleOut}.tmp`, bundleOut);
    const opened = await openSignedCharacterBundle(bundleOut, {
      ...(options.trustedBundleKeysPem ? { trustedPublicKeysPem: options.trustedBundleKeysPem } : {}),
      ...(options.requireSignedBundle !== undefined
        ? { requireSignature: options.requireSignedBundle }
        : {}),
    });
    verifiedSignature = opened.verifiedSignature;
  } else {
    const ext = entry.kind === "plugin" ? "pack.json" : `${entry.id}.pack.bin`;
    const targetFile = join(packDir, ext);
    await writeFile(`${targetFile}.tmp`, payload, { mode: 0o600 });
    await rename(`${targetFile}.tmp`, targetFile);
  }

  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    version: entry.version,
    author: entry.author,
    source: "signed-catalog",
    installDir: packDir,
    sha256: entry.sha256,
    subscribedAt: new Date().toISOString(),
    verifiedSignature,
  };
}

/** Atomic local store tracking active Steam Workshop & Creator Pack subscriptions. */
export class WorkshopSubscriptionStore {
  private readonly filePath: string;
  private items = new Map<string, WorkshopSubscription>();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async load(): Promise<void> {
    this.items.clear();
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
            const sub = item as WorkshopSubscription;
            this.items.set(sub.id, sub);
          }
        }
      }
    } catch {
      // Corrupt store starts fresh rather than crashing startup.
    }
  }

  async save(): Promise<void> {
    await mkdir(resolve(this.filePath, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.list(), null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.filePath);
  }

  list(): WorkshopSubscription[] {
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async subscribe(sub: WorkshopSubscription): Promise<void> {
    this.items.set(sub.id, sub);
    await this.save();
  }

  async unsubscribe(id: string): Promise<boolean> {
    const removed = this.items.delete(id);
    if (removed) await this.save();
    return removed;
  }

  async syncFromSteam(options: {
    appId: string;
    steamRoots?: readonly string[];
    trustedPublicKeysPem?: readonly string[];
  }): Promise<WorkshopDiscoveredItem[]> {
    const discovered = await scanSteamWorkshopItems(options);
    for (const item of discovered) {
      const mappedKind: CreatorPackKind =
        item.kind === "character" ? "character" : item.kind === "plugin" ? "plugin" : "outfit";
      this.items.set(item.id, {
        id: item.id,
        kind: mappedKind,
        name: item.name,
        version: item.version,
        author: "Steam Workshop Creator",
        source: "steam-workshop",
        installDir: item.itemDir,
        workshopId: item.workshopId,
        subscribedAt: new Date().toISOString(),
        verifiedSignature: item.verifiedSignature,
      });
    }
    await this.save();
    return discovered;
  }
}
