import { createHash, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { inspectCharacterBundle, openSignedCharacterBundle } from "./characterBundle.ts";
import { isPrivateIpv4 } from "./permissions.ts";
import {
  canonicalJsonBytes,
  PluginManifestSchema,
  verifyPluginBundle,
} from "./pluginSdk.ts";
import { isInside } from "./riskRules.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Steam Workshop & Signed Creator Pack Distribution.
 *
 * - Scans local Steam Workshop subscriptions (`libraryfolders.vdf` +
 *   `steamapps/workshop/content/<appId>/<itemId>/`) across Linux, Windows, and macOS
 *   with symlink/realpath escape protection and strict size limits.
 * - Imports signed HTTPS Creator Catalogs for GitHub Releases / itch.io / direct
 *   downloads using Ed25519 signature verification, redirect validation, streaming
 *   byte caps, and per-pack SHA-256 checks.
 * - Plugin packs always require explicit user approval (`approvedByUser: false` on install).
 */

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGIN_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_CREATOR_PACK_BYTES = 512 * 1024 * 1024;
const MAX_HTTPS_REDIRECTS = 3;

const BLOCKED_CREATOR_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "::",
  "::ffff:0.0.0.0",
  "169.254.169.254",
  "metadata.google.internal",
  "100.100.100.200",
]);

export const CREATOR_PACK_KINDS = [
  "character",
  "plugin",
  "outfit",
  "animation",
  "voice",
] as const;
export type CreatorPackKind = (typeof CREATOR_PACK_KINDS)[number];

function normalizeMappedIpv4(host: string): string {
  if (!host.startsWith("::ffff:")) return host;
  const rest = host.slice("::ffff:".length);
  const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hexPair) return rest;
  const hi = Number.parseInt(hexPair[1] ?? "0", 16);
  const lo = Number.parseInt(hexPair[2] ?? "0", 16);
  return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
}

export function validatePublicHttpsPackUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid creator pack URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `Creator pack URL must use https:// (got "${parsed.protocol}").` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Creator pack URLs must not embed credentials." };
  }
  const rawHost = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const host = (rawHost.split("%")[0] ?? rawHost).replace(/\.+$/, "");
  const mappedV4 = normalizeMappedIpv4(host);
  if (
    !host ||
    BLOCKED_CREATOR_HOSTS.has(host) ||
    BLOCKED_CREATOR_HOSTS.has(mappedV4) ||
    mappedV4.startsWith("169.254.") ||
    mappedV4.startsWith("0.") ||
    host.startsWith("fe80:") ||
    isPrivateLanHost(mappedV4) ||
    isPrivateIpv4(mappedV4)
  ) {
    return { ok: false, reason: `Blocked private, loopback, link-local, or metadata host "${host}".` };
  }
  return { ok: true, url: parsed };
}

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
    .refine((u) => validatePublicHttpsPackUrl(u).ok, "Creator pack URLs must use public https://."),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  sizeBytes: z.number().int().min(1).max(MAX_CREATOR_PACK_BYTES),
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

function isSafeRelativePath(p: string): boolean {
  if (!p || p.includes("\0") || p.includes("..") || p.includes("\\") || p.includes(":")) return false;
  if (p.startsWith("/") || p.endsWith("/")) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

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
    .refine(isSafeRelativePath, "Asset entry must remain inside its pack directory."),
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

export const WorkshopSubscriptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  kind: z.enum(CREATOR_PACK_KINDS),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32),
  author: z.string().min(1).max(80),
  source: z.enum(["steam-workshop", "signed-catalog"]),
  installDir: z.string().min(1).max(512),
  workshopId: z.string().max(64).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  subscribedAt: z.string().min(1).max(64),
  verifiedSignature: z.boolean(),
  approvedByUser: z.boolean().optional(),
});
export type WorkshopSubscription = z.infer<typeof WorkshopSubscriptionSchema>;

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

async function resolveInsideRealDir(targetPath: string, realRootDir: string): Promise<string | null> {
  if (await isSymlink(targetPath)) return null;
  try {
    const realTarget = await realpath(targetPath);
    if (!isInside(realTarget, realRootDir)) return null;
    return realTarget;
  } catch {
    return null;
  }
}

async function readFileBounded(path: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) {
    throw new Error(`Refused file exceeding ${maxBytes} bytes: ${basename(path)}`);
  }
  return readFile(path);
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
      const vdf = (await readFileBounded(vdfPath, MAX_MANIFEST_BYTES)).toString("utf8");
      for (const lib of parseValveKeyValuesLibraries(vdf)) {
        libraryDirs.add(resolve(lib));
      }
    } catch {
      // Root does not contain readable libraryfolders.vdf; continue scanning remaining roots.
    }
  }

  const trustedKeys = options.trustedPublicKeysPem ?? [];
  const discovered: WorkshopDiscoveredItem[] = [];
  const seenDirs = new Set<string>();

  for (const lib of libraryDirs) {
    const contentDir = join(lib, "steamapps", "workshop", "content", options.appId);
    if (await isSymlink(contentDir)) continue;
    let realContentDir: string;
    try {
      realContentDir = await realpath(contentDir);
    } catch {
      continue;
    }
    let entries;
    try {
      entries = await readdir(realContentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d+$/.test(entry.name)) continue;
      const candidateDir = resolve(realContentDir, entry.name);
      const realItemDir = await resolveInsideRealDir(candidateDir, realContentDir);
      if (!realItemDir || seenDirs.has(realItemDir)) continue;
      seenDirs.add(realItemDir);

      const realManifestFile = await resolveInsideRealDir(join(realItemDir, "manifest.json"), realItemDir);
      if (!realManifestFile) continue;

      let rawJson: unknown;
      try {
        const manifestBytes = await readFileBounded(realManifestFile, MAX_MANIFEST_BYTES);
        rawJson = JSON.parse(manifestBytes.toString("utf8")) as unknown;
      } catch {
        continue;
      }

      // 1. Character bundle (.pmx/.pmd/.vrm + shader/animations/voice overrides)
      if (typeof rawJson === "object" && rawJson !== null && "modelEntry" in rawJson) {
        const inspected = await inspectCharacterBundle(realItemDir, {
          trustedPublicKeysPem: trustedKeys,
        });
        if (inspected.ok && inspected.manifest) {
          discovered.push({
            workshopId: entry.name,
            itemDir: realItemDir,
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
        const entryCandidate = resolve(realItemDir, parsed.data.entry);
        const realEntryPath = await resolveInsideRealDir(entryCandidate, realItemDir);
        if (!realEntryPath) continue;
        try {
          const entryBytes = await readFileBounded(realEntryPath, MAX_PLUGIN_ENTRY_BYTES);
          let sig = "";
          const sigPath = await resolveInsideRealDir(join(realItemDir, "manifest.sig"), realItemDir);
          if (sigPath) {
            try {
              sig = (await readFileBounded(sigPath, MAX_MANIFEST_BYTES)).toString("utf8").trim();
            } catch {
              sig = "";
            }
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
            itemDir: realItemDir,
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
        const entryCandidate = resolve(realItemDir, assetParsed.data.entry);
        const realEntryPath = await resolveInsideRealDir(entryCandidate, realItemDir);
        if (realEntryPath) {
          discovered.push({
            workshopId: entry.name,
            itemDir: realItemDir,
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
  fetchImpl?: typeof fetch;
  trustedBundleKeysPem?: readonly string[];
  requireSignedBundle?: boolean;
}

async function writeAtomicExclusive(targetPath: string, bytes: Buffer): Promise<void> {
  const tmpPath = `${targetPath}.${randomBytes(8).toString("hex")}.tmp`;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags =
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow;
  const handle = await open(tmpPath, flags, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  if (await isSymlink(targetPath)) {
    throw new Error(`Refused overwriting symlink destination "${basename(targetPath)}".`);
  }
  await rename(tmpPath, targetPath);
}

async function fetchBoundedCreatorPackBytes(
  startUrl: string,
  maxBytes: number,
  fetchFn: typeof fetch,
): Promise<Buffer> {
  let currentUrl = startUrl;
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_HTTPS_REDIRECTS; hop += 1) {
    const check = validatePublicHttpsPackUrl(currentUrl);
    if (!check.ok) throw new Error(check.reason);
    const attempt = await fetchFn(check.url.toString(), { redirect: "manual" });
    if (attempt.status >= 300 && attempt.status < 400) {
      const location = attempt.headers.get("location");
      await attempt.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new Error(`Redirect response (${attempt.status}) missing Location header.`);
      }
      if (hop === MAX_HTTPS_REDIRECTS) {
        throw new Error(`Too many HTTPS redirects (>${MAX_HTTPS_REDIRECTS}) downloading creator pack.`);
      }
      currentUrl = new URL(location, check.url).toString();
      continue;
    }
    res = attempt;
    break;
  }

  if (!res) throw new Error("Failed to resolve creator pack response.");
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status} downloading creator pack.`);
  }
  const declaredLen = res.headers.get("content-length");
  if (declaredLen) {
    const n = Number(declaredLen);
    if (Number.isFinite(n) && n > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Creator pack Content-Length (${n} bytes) exceeds declared size limit (${maxBytes} bytes).`);
    }
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Creator pack payload (${buf.byteLength} bytes) exceeds declared size limit (${maxBytes} bytes).`);
    }
    return buf;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`Creator pack stream exceeded declared size limit (${maxBytes} bytes).`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  return Buffer.concat(chunks, total);
}

/**
 * Downloads (HTTPS public hosts only, redirect-validated, streaming byte-capped),
 * SHA-256 verifies with `timingSafeEqual`, validates plugin/bundle schemas, and installs
 * cleanly inside `installRoot/<id>` without allowing symlink or path traversal escapes.
 */
export async function installCreatorPack(
  options: InstallCreatorPackOptions,
): Promise<WorkshopSubscription> {
  const entry = CreatorPackEntrySchema.parse(options.entry);
  const maxBytes = Math.min(entry.sizeBytes, MAX_CREATOR_PACK_BYTES);
  const fetcher =
    options.fetchBytes ??
    ((url: string) => fetchBoundedCreatorPackBytes(url, maxBytes, options.fetchImpl ?? fetch));

  const payload = await fetcher(entry.url);
  if (payload.byteLength === 0 || payload.byteLength > maxBytes) {
    throw new Error(
      `Creator pack size mismatch for "${entry.id}" (${payload.byteLength} bytes, expected <= ${maxBytes}).`,
    );
  }

  const actualHash = createHash("sha256").update(payload).digest();
  const expectedHash = Buffer.from(entry.sha256, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw new Error(`Creator pack "${entry.id}" failed SHA-256 integrity verification.`);
  }

  const rootResolved = resolve(options.installRoot);
  await mkdir(rootResolved, { recursive: true, mode: 0o700 });
  if (await isSymlink(rootResolved)) {
    throw new Error("Refused installing creator pack into a symlinked installRoot.");
  }
  const realRoot = await realpath(rootResolved);
  const packDir = resolve(realRoot, basename(entry.id));
  if (!isInside(packDir, realRoot) || (await isSymlink(packDir))) {
    throw new Error(`Refused path traversal or symlink in pack id "${entry.id}".`);
  }
  await mkdir(packDir, { recursive: true, mode: 0o700 });
  const realPackDir = await realpath(packDir);
  if (!isInside(realPackDir, realRoot)) {
    throw new Error(`Pack install directory escaped installRoot: "${entry.id}".`);
  }

  let verifiedSignature = false;
  if (entry.kind === "plugin") {
    let rawPluginObj: unknown;
    try {
      rawPluginObj = JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      throw new Error(`Plugin creator pack "${entry.id}" is not valid JSON.`);
    }
    const objRec =
      typeof rawPluginObj === "object" && rawPluginObj !== null && !Array.isArray(rawPluginObj)
        ? (rawPluginObj as Record<string, unknown>)
        : null;
    if (!objRec) {
      throw new Error(`Plugin creator pack "${entry.id}" must be a manifest or bundle object.`);
    }
    if ("manifest" in objRec) {
      const parsedManifest = PluginManifestSchema.parse(objRec["manifest"]);
      const sig = typeof objRec["signature"] === "string" ? objRec["signature"] : "";
      const entryB64 = typeof objRec["entryBase64"] === "string" ? objRec["entryBase64"] : "";
      const entryBytes = Buffer.from(entryB64, "base64");
      if (options.requireSignedBundle && (!sig || !(options.trustedBundleKeysPem?.length))) {
        throw new Error(`Plugin "${entry.id}" requires a valid Ed25519 signature.`);
      }
      if (sig && options.trustedBundleKeysPem?.length) {
        const check = await verifyPluginBundle({
          manifest: parsedManifest,
          signature: sig,
          entryBytes,
          trustedPublicKeysPem: options.trustedBundleKeysPem,
        });
        if (!check.ok) throw new Error(check.reason);
        verifiedSignature = true;
      } else {
        const digest = createHash("sha256").update(entryBytes).digest();
        const expected = Buffer.from(parsedManifest.sha256, "hex");
        if (digest.length !== expected.length || !timingSafeEqual(digest, expected)) {
          throw new Error(`Plugin "${entry.id}" entry SHA-256 mismatch.`);
        }
      }
    } else {
      PluginManifestSchema.parse(objRec);
      if (options.requireSignedBundle) {
        throw new Error(`Plugin "${entry.id}" requires a signed bundle envelope.`);
      }
    }
    await writeAtomicExclusive(join(realPackDir, "pack.json"), payload);
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      version: entry.version,
      author: entry.author,
      source: "signed-catalog",
      installDir: realPackDir,
      sha256: entry.sha256,
      subscribedAt: new Date().toISOString(),
      verifiedSignature,
      approvedByUser: false,
    };
  }

  if (entry.kind === "character" && payload.subarray(0, 8).toString("ascii") === "AICHANB1") {
    const bundleOut = join(realPackDir, `${entry.id}.bundle`);
    await writeAtomicExclusive(bundleOut, payload);
    const opened = await openSignedCharacterBundle(bundleOut, {
      ...(options.trustedBundleKeysPem ? { trustedPublicKeysPem: options.trustedBundleKeysPem } : {}),
      ...(options.requireSignedBundle !== undefined
        ? { requireSignature: options.requireSignedBundle }
        : {}),
    });
    verifiedSignature = opened.verifiedSignature;
  } else {
    const targetFile = join(realPackDir, `${entry.id}.pack.bin`);
    await writeAtomicExclusive(targetFile, payload);
  }

  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    version: entry.version,
    author: entry.author,
    source: "signed-catalog",
    installDir: realPackDir,
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
          const valid = WorkshopSubscriptionSchema.safeParse(item);
          if (valid.success) {
            this.items.set(valid.data.id, valid.data);
          }
        }
      }
    } catch {
      // Corrupt store starts fresh rather than crashing startup.
    }
  }

  async save(): Promise<void> {
    await mkdir(resolve(this.filePath, ".."), { recursive: true, mode: 0o700 });
    await writeAtomicExclusive(this.filePath, Buffer.from(JSON.stringify(this.list(), null, 2), "utf8"));
  }

  list(): WorkshopSubscription[] {
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async subscribe(sub: WorkshopSubscription): Promise<void> {
    const validated = WorkshopSubscriptionSchema.parse(sub);
    this.items.set(validated.id, validated);
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
      const prev = this.items.get(item.id);
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
        ...(mappedKind === "plugin" ? { approvedByUser: prev?.approvedByUser === true } : {}),
      });
    }
    await this.save();
    return discovered;
  }
}
