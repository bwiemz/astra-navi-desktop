import { createHash, sign, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { readModelInfo, type ModelBundle, type ModelInfo } from "./modelBundle.ts";
import { canonicalJsonBytes } from "./pluginSdk.ts";
import { canonical, isInside } from "./riskRules.ts";

/**
 * Character `.bundle` Packs (ai_chan_plan.pdf p. 15).
 *
 * One-click portable character directory OR single-file signed `.bundle` (`AICHANB1`
 * container) packaging `.pmx`/`.pmd`/`.vrm` 3D mesh, custom `mmdStandard`/`mmdOutline`
 * shader presets, idle/breathing animations, `persona.ts` overrides, and local TTS
 * voice checkpoint settings with strict path containment and Ed25519 verification.
 */

const BUNDLE_FILE_MAGIC = Buffer.from("AICHANB1", "ascii");
const MAX_SINGLE_BUNDLE_BYTES = 192 * 1024 * 1024;
const ALLOWED_EXTS = new Set([
  ".pmx",
  ".pmd",
  ".vrm",
  ".glb",
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tga",
  ".dds",
  ".spa",
  ".sph",
  ".vmd",
  ".pt",
  ".safetensors",
  ".onnx",
  ".wav",
  ".txt",
]);

export const CharacterBundleManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32),
  author: z.string().min(1).max(80),
  license: z.string().min(1).max(120),
  modelEntry: z.string().min(1).max(200),
  modelFormat: z.enum(["pmx", "pmd", "vrm"]),
  persona: z
    .object({
      displayName: z.string().min(1).max(40),
      greetingStyle: z.string().max(120).optional(),
      traits: z.array(z.string().max(120)).max(6).optional(),
      speakInThirdPerson: z.boolean().optional(),
    })
    .optional(),
  voice: z
    .object({
      engine: z.enum(["full", "light"]),
      design: z.string().max(60),
      speed: z.number().min(0.5).max(2).optional(),
      checkpointEntry: z.string().max(200).optional(),
      speakerRefEntry: z.string().max(200).optional(),
    })
    .optional(),
  shader: z
    .object({
      outlineWidth: z.number().min(0).max(0.5).optional(),
      outlineColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      toonTint: z.string().max(24).optional(),
      specularScale: z.number().min(0).max(2).optional(),
    })
    .optional(),
  animations: z
    .object({
      idleMotion: z.enum(["standard", "gentle", "energetic"]).optional(),
      breathingAmplitude: z.number().min(0.2).max(2).optional(),
      talkGestureScale: z.number().min(0.2).max(2).optional(),
    })
    .optional(),
  signature: z.string().max(512).optional(),
});
export type CharacterBundleManifest = z.infer<typeof CharacterBundleManifestSchema>;

export interface CharacterBundleInspection {
  ok: boolean;
  bundleDir: string;
  manifest?: CharacterBundleManifest;
  modelPath?: string;
  modelInfo?: ModelInfo | null;
  verifiedSignature: boolean;
  reason?: string;
}

function normalizeBundlePath(relPath: string): string {
  return relPath.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

function unsignedBundlePayload(manifest: CharacterBundleManifest): Buffer {
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "signature"),
  );
  return canonicalJsonBytes(unsigned);
}

/** Signs a character bundle manifest using an Ed25519 private key PEM. */
export function signCharacterBundleManifest(
  manifest: Omit<CharacterBundleManifest, "signature">,
  privateKeyPem: string,
): string {
  const parsed = CharacterBundleManifestSchema.parse(manifest);
  return sign(null, unsignedBundlePayload(parsed), privateKeyPem).toString("base64");
}

function verifyBundleSignature(
  manifest: CharacterBundleManifest,
  trustedKeys: readonly string[],
): boolean {
  if (!manifest.signature || trustedKeys.length === 0) return false;
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(manifest.signature, "base64");
  } catch {
    return false;
  }
  const payload = unsignedBundlePayload(manifest);
  for (const key of trustedKeys) {
    try {
      if (verify(null, payload, key, sigBytes)) return true;
    } catch {
      // Try next trusted public key.
    }
  }
  return false;
}

async function listBundleFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listBundleFiles(full)));
    } else if (entry.isFile() && ALLOWED_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

const SingleBundleArchiveSchema = z.object({
  version: z.literal(1),
  manifest: CharacterBundleManifestSchema,
  files: z.array(
    z.object({
      path: z.string().min(1).max(200),
      sha256: z.string().regex(/^[0-9a-f]{64}$/i),
      dataBase64: z.string(),
    }),
  ),
});

/**
 * Packs a validated character directory (`manifest.json`, `.pmx`/`.vrm`, textures, voice
 * checkpoints, shader presets) into a single portable signed `.bundle` archive.
 */
export async function packSignedCharacterBundle(
  sourceDir: string,
  outBundleFile: string,
  options: { privateKeyPem?: string } = {},
): Promise<{ files: number; bytes: number }> {
  const inspected = await inspectCharacterBundle(sourceDir);
  if (!inspected.ok || !inspected.manifest) {
    throw new Error(inspected.reason ?? "Cannot pack invalid character bundle directory.");
  }

  let manifest = inspected.manifest;
  if (options.privateKeyPem) {
    const unsigned = Object.fromEntries(
      Object.entries(manifest).filter(([k]) => k !== "signature"),
    ) as Omit<CharacterBundleManifest, "signature">;
    const signature = signCharacterBundleManifest(unsigned, options.privateKeyPem);
    manifest = { ...unsigned, signature };
  }

  const root = await canonical(resolve(sourceDir));
  const diskFiles = await listBundleFiles(root);
  const packedFiles: { path: string; sha256: string; dataBase64: string }[] = [];
  let totalBytes = 0;

  for (const absPath of diskFiles) {
    const raw = await readFile(absPath);
    totalBytes += raw.length;
    if (totalBytes > MAX_SINGLE_BUNDLE_BYTES) {
      throw new Error("Character bundle exceeds maximum size budget.");
    }
    const rel = relative(root, absPath).split(sep).join("/");
    packedFiles.push({
      path: rel,
      sha256: createHash("sha256").update(raw).digest("hex"),
      dataBase64: raw.toString("base64"),
    });
  }

  const archiveJson = JSON.stringify({ version: 1, manifest, files: packedFiles });
  const compressed = gzipSync(Buffer.from(archiveJson, "utf8"));
  await mkdir(resolve(outBundleFile, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${outBundleFile}.tmp`;
  await writeFile(tmp, Buffer.concat([BUNDLE_FILE_MAGIC, compressed]), { mode: 0o600 });
  await rename(tmp, outBundleFile);
  return { files: packedFiles.length, bytes: compressed.length + BUNDLE_FILE_MAGIC.length };
}

/**
 * Opens and verifies a portable `.bundle` archive in memory, checking magic header,
 * Ed25519 signature (when required), path safety, and per-file SHA-256 digests.
 */
export async function openSignedCharacterBundle(
  bundleFile: string,
  options: { trustedPublicKeysPem?: readonly string[]; requireSignature?: boolean } = {},
): Promise<{
  bundle: ModelBundle;
  manifest: CharacterBundleManifest;
  verifiedSignature: boolean;
}> {
  const raw = await readFile(bundleFile);
  if (
    raw.length <= BUNDLE_FILE_MAGIC.length ||
    !raw.subarray(0, BUNDLE_FILE_MAGIC.length).equals(BUNDLE_FILE_MAGIC)
  ) {
    throw new Error("Not a valid AI-chan .bundle archive.");
  }
  const jsonText = gunzipSync(raw.subarray(BUNDLE_FILE_MAGIC.length)).toString("utf8");
  const parsed = SingleBundleArchiveSchema.parse(JSON.parse(jsonText) as unknown);
  const verifiedSignature = verifyBundleSignature(
    parsed.manifest,
    options.trustedPublicKeysPem ?? [],
  );
  if (options.requireSignature && !verifiedSignature) {
    throw new Error("Character .bundle signature missing or untrusted.");
  }

  const fileMap = new Map<string, Buffer>();
  for (const entry of parsed.files) {
    if (entry.path.includes("..") || entry.path.startsWith("/")) {
      throw new Error(`Unsafe archive file path "${entry.path}".`);
    }
    const bytes = Buffer.from(entry.dataBase64, "base64");
    const actual = createHash("sha256").update(bytes).digest();
    const expected = Buffer.from(entry.sha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error(`File "${entry.path}" failed SHA-256 verification inside .bundle.`);
    }
    fileMap.set(normalizeBundlePath(entry.path), bytes);
  }

  const entryBytes = fileMap.get(normalizeBundlePath(parsed.manifest.modelEntry));
  const modelInfo =
    parsed.manifest.modelFormat === "pmx" && entryBytes ? readModelInfo(entryBytes) : null;
  const hash = createHash("sha256")
    .update(entryBytes ?? parsed.manifest.id)
    .digest("hex")
    .slice(0, 16);

  return {
    manifest: parsed.manifest,
    verifiedSignature,
    bundle: {
      hash,
      info: modelInfo,
      entry: parsed.manifest.modelEntry.replaceAll("\\", "/"),
      fileCount: fileMap.size,
      get(path: string): Buffer | undefined {
        return fileMap.get(normalizeBundlePath(path));
      },
    },
  };
}

/**
 * Loads, path-checks, and validates a character `.bundle` directory on disk.
 * Rejects path traversal out of the bundle folder and verifies model header magic.
 */
export async function inspectCharacterBundle(
  bundleDir: string,
  options: { trustedPublicKeysPem?: readonly string[]; requireSignature?: boolean } = {},
): Promise<CharacterBundleInspection> {
  const bundleRoot = await canonical(resolve(bundleDir));
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(await readFile(join(bundleRoot, "manifest.json"), "utf8")) as unknown;
  } catch (error) {
    return {
      ok: false,
      bundleDir: bundleRoot,
      verifiedSignature: false,
      reason: `Could not read manifest.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = CharacterBundleManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      ok: false,
      bundleDir: bundleRoot,
      verifiedSignature: false,
      reason: `Invalid character bundle manifest: ${parsed.error.message}`,
    };
  }
  const manifest = parsed.data;
  const modelPath = await canonical(resolve(bundleRoot, manifest.modelEntry));
  if (!isInside(modelPath, bundleRoot)) {
    return {
      ok: false,
      bundleDir: bundleRoot,
      manifest,
      verifiedSignature: false,
      reason: `Refused modelEntry path escaping bundle root: "${manifest.modelEntry}".`,
    };
  }

  const verifiedSignature = verifyBundleSignature(manifest, options.trustedPublicKeysPem ?? []);
  if (options.requireSignature && !verifiedSignature) {
    return {
      ok: false,
      bundleDir: bundleRoot,
      manifest,
      verifiedSignature: false,
      reason: "Character bundle signature missing or untrusted.",
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(modelPath);
  } catch (error) {
    return {
      ok: false,
      bundleDir: bundleRoot,
      manifest,
      verifiedSignature,
      reason: `Could not read model file "${manifest.modelEntry}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let modelInfo: ModelInfo | null = null;
  if (manifest.modelFormat === "pmx") {
    modelInfo = readModelInfo(bytes);
    if (!modelInfo) {
      return {
        ok: false,
        bundleDir: bundleRoot,
        manifest,
        verifiedSignature,
        reason: `Model "${manifest.modelEntry}" is not a valid PMX 2.0 file.`,
      };
    }
  } else if (manifest.modelFormat === "pmd") {
    if (bytes.subarray(0, 3).toString("ascii") !== "Pmd") {
      return {
        ok: false,
        bundleDir: bundleRoot,
        manifest,
        verifiedSignature,
        reason: `Model "${manifest.modelEntry}" is not a valid PMD file.`,
      };
    }
  } else if (bytes.subarray(0, 4).toString("ascii") !== "glTF") {
    return {
      ok: false,
      bundleDir: bundleRoot,
      manifest,
      verifiedSignature,
      reason: `Model "${manifest.modelEntry}" is not a valid VRM/GLB file.`,
    };
  }

  return {
    ok: true,
    bundleDir: bundleRoot,
    manifest,
    modelPath,
    modelInfo,
    verifiedSignature,
  };
}

/** Discovers valid character bundles inside `rootDir`. */
export async function discoverCharacterBundles(
  rootDir: string,
  options: { trustedPublicKeysPem?: readonly string[]; requireSignature?: boolean } = {},
): Promise<CharacterBundleInspection[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const results: CharacterBundleInspection[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const inspected = await inspectCharacterBundle(join(rootDir, entry.name), options);
    if (inspected.ok) results.push(inspected);
  }
  return results.sort((a, b) =>
    (a.manifest?.name ?? "").localeCompare(b.manifest?.name ?? ""),
  );
}
