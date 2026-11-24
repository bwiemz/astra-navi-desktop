import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  recommendHardwareTier,
  type HardwareProfile,
  type TierRecommendation,
} from "./hardwareTuner.ts";
import { readVrmSummary } from "../shared/vrm.ts";
import {
  MOE_WORKSTATION_MODELS,
  resolveBrain,
  verifyModelSha256,
  type BrainChoice,
  type BrainModel,
  type ResolvedModel,
} from "./models.ts";

/**
 * The character model is never read by the app in its raw form (.pmx and textures).
 * Importing a model packs every file into one encrypted bundle. At runtime a file is
 * decrypted only when the window asks for it, in memory, and handed over a private
 * in-app protocol. Nothing in the app's folders is a loose, copyable model file.
 *
 * What protects the bundle:
 * - The key is not in the app. It is derived from secret material the caller supplies
 *   (see `modelKey.ts`: a random per-install secret plus this computer's and this
 *   user's identity), so a bundle copied to another computer or another account cannot
 *   be opened there.
 * - Every file has its own key and nonce, and the list of files is encrypted too, so
 *   the bundle reveals neither names nor sizes of what is inside.
 * - Everything is authenticated: a bundle that was altered is rejected, not half-read.
 *
 * It remains a strong deterrent rather than DRM. The app must be able to open the
 * bundle to draw the character, so someone in full control of the computer it runs on
 * can, with enough effort, do what the app does.
 */

const MAGIC = Buffer.from("AICHAN02", "ascii");
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
/** Deliberately slow, so guessing the key material is expensive. Costs about a fifth of a second. */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

const MODEL_EXTENSIONS = new Set([".pmx", ".pmd", ".vrm"]);
const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tga",
  ".dds",
  ".gif",
  ".spa",
  ".sph",
  ".vmd",
  ".vpd",
]);
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_BUNDLE_FILES = 3000;
const MAX_WALKED_FILES = 20_000;
const TOO_BIG =
  "That folder holds far more than one model. Put the model and its textures in a folder of their own and pick it there.";
const CANNOT_OPEN =
  "The packed model cannot be opened. It was made on a different computer or account, or the file is damaged. Import the model again.";

/** The name and the author's notes (credits, terms of use) stored inside the model file itself. */
export interface ModelInfo {
  name: string;
  comment: string;
}

interface FileEntry {
  offset: number;
  length: number;
  iv: string;
  tag: string;
}

interface BundleIndex {
  entry: string;
  files: Record<string, FileEntry>;
  info?: ModelInfo;
}

export interface ModelBundle {
  /** Short SHA-256 content identifier of the entry model file for per-model UI persistence. */
  hash?: string;
  info: ModelInfo | null;
  /** Path of the model file inside the bundle, with forward slashes. */
  entry: string;
  /** Decrypts one file. Looks it up the way a Windows-authored model expects: any slash, any letter case. */
  get(path: string): Buffer | undefined;
  fileCount: number;
}

function masterKey(keyMaterial: Buffer, salt: Buffer): Buffer {
  if (keyMaterial.length < 32) throw new Error("Model key material is too short.");
  return scryptSync(keyMaterial, salt, 32, SCRYPT);
}

function subKey(master: Buffer, salt: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, salt, purpose, 32));
}

function seal(
  key: Buffer,
  plain: Buffer,
  context: string,
): { iv: Buffer; tag: Buffer; data: Buffer } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(context, "utf8")]));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function unseal(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer, context: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.concat([MAGIC, Buffer.from(context, "utf8")]));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/")
    .normalize("NFC")
    .toLowerCase();
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
      if (found.length > MAX_WALKED_FILES) throw new Error(TOO_BIG);
    }
  };
  await walk(root);
  return found;
}

/** Reads the name and comment from a PMX or VRM (.glb/.vrm) file header. Returns null otherwise. */
export function readModelInfo(data: Buffer): ModelInfo | null {
  if (data.toString("latin1", 0, 4) === "glTF") {
    const vrm = readVrmSummary(data);
    if (vrm) {
      return {
        name: vrm.name,
        comment: vrm.comment,
      };
    }
    return null;
  }
  try {
    if (data.toString("latin1", 0, 4) !== "PMX ") return null;
    let offset = 8; // magic + version
    const globalCount = data.readUInt8(offset);
    const encoding = data.readUInt8(offset + 1) === 0 ? "utf16le" : "utf8";
    offset += 1 + globalCount;
    const text = (): string => {
      const length = data.readInt32LE(offset);
      offset += 4;
      if (length < 0 || offset + length > data.length) throw new RangeError("bad text length");
      const value = data.toString(encoding, offset, offset + length);
      offset += length;
      return value;
    };
    const localName = text();
    const universalName = text();
    const localComment = text();
    const universalComment = text();
    return {
      name: (localName || universalName).trim(),
      comment: (localComment || universalComment).replaceAll("\r\n", "\n").trim(),
    };
  } catch {
    return null; // a header this reader does not understand is not a reason to refuse the model
  }
}

export function isModelFile(path: string): boolean {
  return MODEL_EXTENSIONS.has(extname(path).toLowerCase());
}

/*
 * Bundle layout:
 *   MAGIC (8) | salt (32) | index iv (12) | index tag (16) | index length (4, LE) |
 *   encrypted index | encrypted files, back to back
 * The index (JSON) maps each normalised path to where its encrypted bytes sit and the
 * nonce and tag needed to open them.
 */
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 4;

async function collectModelAssets(
  modelPath: string,
): Promise<{ root: string; resolvedModel: string; wanted: string[]; total: number }> {
  const resolvedModel = resolve(modelPath);
  const root = dirname(resolvedModel);
  // Single-file `.vrm` avatars embed meshes and textures inside their GLB container, so do not walk sibling files.
  if (extname(resolvedModel).toLowerCase() === ".vrm") {
    const total = (await stat(resolvedModel)).size;
    if (total > MAX_BUNDLE_BYTES) throw new Error(TOO_BIG);
    return { root, resolvedModel, wanted: [resolvedModel], total };
  }
  // Only the chosen model plus the assets it can reference; other models in the folder stay out.
  const wanted = (await listFiles(root)).filter(
    (file) => file === resolvedModel || ASSET_EXTENSIONS.has(extname(file).toLowerCase()),
  );
  // Measure before reading anything, so a model picked from a huge folder fails fast.
  if (wanted.length > MAX_BUNDLE_FILES) throw new Error(TOO_BIG);
  let total = 0;
  for (const file of wanted) {
    total += (await stat(file)).size;
    if (total > MAX_BUNDLE_BYTES) throw new Error(TOO_BIG);
  }
  return { root, resolvedModel, wanted, total };
}

/**
 * Packs a model file and everything beside it (textures, motions) into an encrypted bundle.
 * @param modelPath Path to the .pmx / .pmd / .vrm file. Its folder is packed cleanly.
 * @param keyMaterial Secret bytes the key is derived from. The same bytes are needed to open it.
 */
export async function packModel(
  modelPath: string,
  bundlePath: string,
  keyMaterial: Buffer,
): Promise<{ files: number; bytes: number }> {
  if (!isModelFile(modelPath)) {
    throw new Error(`"${modelPath}" is not a .pmx, .pmd, or .vrm model file.`);
  }
  const resolvedModel = resolve(modelPath);
  const info = await stat(resolvedModel);
  if (!info.isFile()) throw new Error(`"${modelPath}" is not a file.`);

  const { root, wanted, total } = await collectModelAssets(resolvedModel);

  const salt = randomBytes(SALT_LENGTH);
  const master = masterKey(keyMaterial, salt);
  const index: BundleIndex = { entry: relative(root, resolvedModel).split(sep).join("/"), files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const file of wanted) {
    const plain = await readFile(file);
    if (file === resolvedModel) {
      const modelInfo = readModelInfo(plain);
      if (modelInfo) index.info = modelInfo;
    }
    const name = normalizePath(relative(root, file));
    const sealed = seal(subKey(master, salt, `file:${name}`), plain, name);
    index.files[name] = {
      offset,
      length: sealed.data.length,
      iv: sealed.iv.toString("base64"),
      tag: sealed.tag.toString("base64"),
    };
    chunks.push(sealed.data);
    offset += sealed.data.length;
  }

  const sealedIndex = seal(
    subKey(master, salt, "index"),
    Buffer.from(JSON.stringify(index), "utf8"),
    "index",
  );
  const indexLength = Buffer.alloc(4);
  indexLength.writeUInt32LE(sealedIndex.data.length);

  await mkdir(dirname(bundlePath), { recursive: true });
  const tmp = `${bundlePath}.tmp`;
  await writeFile(
    tmp,
    Buffer.concat([
      MAGIC,
      salt,
      sealedIndex.iv,
      sealedIndex.tag,
      indexLength,
      sealedIndex.data,
      ...chunks,
    ]),
    { mode: 0o600 },
  );
  await rename(tmp, bundlePath);
  return { files: chunks.length, bytes: total };
}

/** Opens a bundle. Returns null when no model has been imported yet. */
export async function openModelBundle(
  bundlePath: string,
  keyMaterial: Buffer,
): Promise<ModelBundle | null> {
  let raw: Buffer;
  try {
    raw = await readFile(bundlePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (raw.length < HEADER_LENGTH || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(
      "The packed model is from an older version of the app or is not a model bundle. Import the model again.",
    );
  }
  let cursor = MAGIC.length;
  const salt = raw.subarray(cursor, (cursor += SALT_LENGTH));
  const indexIv = raw.subarray(cursor, (cursor += IV_LENGTH));
  const indexTag = raw.subarray(cursor, (cursor += TAG_LENGTH));
  const indexLength = raw.readUInt32LE(cursor);
  cursor += 4;
  if (cursor + indexLength > raw.length) throw new Error(CANNOT_OPEN);

  const master = masterKey(keyMaterial, salt);
  let index: BundleIndex;
  try {
    const plain = unseal(
      subKey(master, salt, "index"),
      indexIv,
      indexTag,
      raw.subarray(cursor, cursor + indexLength),
      "index",
    );
    index = JSON.parse(plain.toString("utf8")) as BundleIndex;
  } catch {
    throw new Error(CANNOT_OPEN);
  }
  const body = raw.subarray(cursor + indexLength);

  const entryKey = normalizePath(index.entry);
  const entryMeta = index.files[entryKey];
  let hash = createHash("sha256").update(index.entry).digest("hex").slice(0, 16);
  if (entryMeta) {
    try {
      const entryPlain = unseal(
        subKey(master, salt, `file:${entryKey}`),
        Buffer.from(entryMeta.iv, "base64"),
        Buffer.from(entryMeta.tag, "base64"),
        body.subarray(entryMeta.offset, entryMeta.offset + entryMeta.length),
        entryKey,
      );
      hash = createHash("sha256").update(entryPlain).digest("hex").slice(0, 16);
    } catch {
      // Fallback hash above keeps bundle loading intact if get() handles error reporting.
    }
  }

  return {
    hash,
    info: index.info ?? null,
    entry: index.entry,
    fileCount: Object.keys(index.files).length,
    get(path: string): Buffer | undefined {
      const name = normalizePath(path);
      const entry = index.files[name];
      if (!entry) return undefined;
      try {
        return unseal(
          subKey(master, salt, `file:${name}`),
          Buffer.from(entry.iv, "base64"),
          Buffer.from(entry.tag, "base64"),
          body.subarray(entry.offset, entry.offset + entry.length),
          name,
        );
      } catch {
        console.error(`[model] "${name}" failed its integrity check and was not served.`);
        return undefined;
      }
    },
  };
}

/**
 * Opens an unencrypted distributable character model folder (e.g. a bundled custom asset)
 * as a `ModelBundle` compatible with `serveModelFile`. Returns null if missing or invalid.
 */
export async function openLooseModelFolder(modelPath: string): Promise<ModelBundle | null> {
  if (!isModelFile(modelPath)) return null;
  const resolvedModel = resolve(modelPath);
  let stats;
  try {
    stats = await stat(resolvedModel);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile()) return null;

  const { root, wanted } = await collectModelAssets(resolvedModel);
  const files = new Map<string, Buffer>();
  let info: ModelInfo | null = null;

  let hash = createHash("sha256").update(resolvedModel).digest("hex").slice(0, 16);
  for (const file of wanted) {
    const plain = await readFile(file);
    if (file === resolvedModel) {
      info = readModelInfo(plain);
      hash = createHash("sha256").update(plain).digest("hex").slice(0, 16);
    }
    files.set(normalizePath(relative(root, file)), plain);
  }

  return {
    hash,
    info,
    entry: relative(root, resolvedModel).split(sep).join("/"),
    fileCount: files.size,
    get(path: string): Buffer | undefined {
      return files.get(normalizePath(path));
    },
  };
}

/**
 * Combines hardware profiling with GGUF model resolution so first-launch setup and runtime
 * step-downs share a single KV-cache, quantization, and dense-vs-MoE selection path.
 */
export function selectModelForHardware(
  profile: HardwareProfile,
  preferred: BrainChoice,
  modelsDir: string,
): { model: ResolvedModel; recommendation: TierRecommendation } {
  const tierPref: "auto" | BrainModel["id"] =
    preferred === "auto" ||
    preferred === "small" ||
    preferred === "standard" ||
    preferred === "large" ||
    preferred === "xl"
      ? preferred
      : "auto";
  const recommendation = recommendHardwareTier(profile, tierPref);

  if (preferred !== "auto" && !(preferred in { small: 1, standard: 1, large: 1, xl: 1 })) {
    return {
      model: resolveBrain(preferred, modelsDir, profile.totalVramBytes),
      recommendation,
    };
  }

  if (recommendation.tier === "xl" && recommendation.architecture === "moe") {
    const moe = MOE_WORKSTATION_MODELS.xlMoe;
    return {
      model: {
        label: moe.label,
        path: join(modelsDir, moe.fileName),
        download: moe,
      },
      recommendation,
    };
  }

  return {
    model: resolveBrain(recommendation.tier, modelsDir, profile.totalVramBytes),
    recommendation,
  };
}

export interface ResumableDownloadOptions {
  url: string;
  destPath: string;
  expectedSizeBytes?: number;
  expectedSha256?: string;
  signal?: AbortSignal;
  /** Whether aborting deletes `.part` (default: false so intermittent dropouts can resume). */
  cleanupPartialOnAbort?: boolean;
  skipDiskCheck?: boolean;
  headroomRatio?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: { received: number; total: number }) => void;
}

/** Computes percentage, MB/s throughput, and remaining ETA seconds for a model download. */
export function computeDownloadStats(input: {
  received: number;
  total: number;
  bytesPerSec: number;
}): { percent: number; mbPerSec: number; etaSeconds: number | null } {
  const received = Math.max(0, Number.isFinite(input.received) ? input.received : 0);
  const total = Math.max(0, Number.isFinite(input.total) ? input.total : 0);
  const bytesPerSec = Math.max(0, Number.isFinite(input.bytesPerSec) ? input.bytesPerSec : 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, (received / total) * 100)) : 0;
  const mbPerSec = bytesPerSec / 1e6;
  const remaining = Math.max(0, total - received);
  const etaSeconds =
    total > 0 && remaining === 0
      ? 0
      : bytesPerSec >= 1024 && remaining > 0
        ? Math.ceil(remaining / bytesPerSec)
        : null;
  return { percent, mbPerSec, etaSeconds };
}

/**
 * Checks free disk space in `dir` without throwing so onboarding UI can display
 * available vs required space side-by-side.
 */
export async function probeDiskSpace(
  dir: string,
  requiredBytes: number,
  headroomRatio = 1.1,
): Promise<{ availableBytes: number; requiredBytes: number; enough: boolean }> {
  const neededBytes = Math.max(0, Math.ceil(requiredBytes * headroomRatio));
  let probeDir = resolve(dir);
  while (true) {
    try {
      const info = await statfs(probeDir);
      const availableBytes = Number(info.bavail) * Number(info.bsize);
      return {
        availableBytes,
        requiredBytes: neededBytes,
        enough: neededBytes === 0 || availableBytes >= neededBytes,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(probeDir);
        if (parent === probeDir) break;
        probeDir = parent;
        continue;
      }
      return { availableBytes: 0, requiredBytes: neededBytes, enough: neededBytes === 0 };
    }
  }
  return { availableBytes: 0, requiredBytes: neededBytes, enough: neededBytes === 0 };
}

/**
 * Verifies free disk space in `dir` (or its nearest existing ancestor) before starting a
 * multi-gigabyte model download. Throws with a clear GB shortfall when insufficient.
 */
export async function checkFreeDiskSpace(
  dir: string,
  requiredBytes: number,
  headroomRatio = 1.1,
): Promise<{ availableBytes: number; requiredBytes: number }> {
  const neededBytes = Math.max(0, Math.ceil(requiredBytes * headroomRatio));
  let probeDir = resolve(dir);
  while (true) {
    try {
      const info = await statfs(probeDir);
      const availableBytes = Number(info.bavail) * Number(info.bsize);
      if (neededBytes > 0 && availableBytes < neededBytes) {
        const gib = 1024 ** 3;
        throw new Error(
          `Insufficient disk space in ${probeDir}: ${(availableBytes / gib).toFixed(2)} GB free, need ${(neededBytes / gib).toFixed(2)} GB (including headroom).`,
        );
      }
      return { availableBytes, requiredBytes: neededBytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(probeDir);
        if (parent === probeDir) break;
        probeDir = parent;
        continue;
      }
      throw error;
    }
  }
  return { availableBytes: 0, requiredBytes: neededBytes };
}

function parseContentRangeTotal(header: string | null): number {
  if (!header) return 0;
  const slash = header.lastIndexOf("/");
  if (slash === -1) return 0;
  const parsed = Number(header.slice(slash + 1));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Downloads large GGUF model files into `<destPath>.part` with HTTP `Range` resume,
 * free-space pre-checks, `AbortSignal` support, SHA-256 verification, and corrupt-file cleanup.
 */
export async function downloadModelResumable(
  options: ResumableDownloadOptions,
): Promise<{ path: string; bytes: number; resumed: boolean }> {
  const destDir = dirname(options.destPath);
  await mkdir(destDir, { recursive: true });
  const partPath = `${options.destPath}.part`;
  const fetchFn = options.fetchImpl ?? fetch;

  let existingBytes = 0;
  try {
    const info = await stat(partPath);
    if (info.isFile()) existingBytes = info.size;
  } catch {
    existingBytes = 0;
  }

  if (!options.skipDiskCheck && options.expectedSizeBytes && options.expectedSizeBytes > existingBytes) {
    await checkFreeDiskSpace(
      destDir,
      options.expectedSizeBytes - existingBytes,
      options.headroomRatio ?? 1.1,
    );
  }

  const issueRequest = (offset: number): Promise<Response> =>
    fetchFn(options.url, {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
      signal: options.signal,
    });

  let response = await issueRequest(existingBytes);
  if (response.status === 416 && existingBytes > 0) {
    if (options.expectedSizeBytes && existingBytes >= options.expectedSizeBytes * 0.98) {
      if (options.expectedSha256) {
        const check = await verifyModelSha256(partPath, options.expectedSha256);
        if (check.ok) {
          await rename(partPath, options.destPath);
          return { path: options.destPath, bytes: existingBytes, resumed: true };
        }
      } else {
        await rename(partPath, options.destPath);
        return { path: options.destPath, bytes: existingBytes, resumed: true };
      }
    }
    await rm(partPath, { force: true });
    existingBytes = 0;
    response = await issueRequest(0);
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      await rm(partPath, { force: true });
    }
    throw new Error(`Model download failed with HTTP ${response.status} (${options.url}).`);
  }

  const append = existingBytes > 0 && response.status === 206;
  if (!append) existingBytes = 0;

  const contentLength = Number(response.headers.get("content-length") ?? "0") || 0;
  const totalBytes =
    parseContentRangeTotal(response.headers.get("content-range")) ||
    (contentLength > 0 ? existingBytes + contentLength : options.expectedSizeBytes ?? 0);

  let received = existingBytes;
  options.onProgress?.({ received, total: totalBytes });

  const handle = await open(partPath, append ? "a" : "w", 0o600);
  try {
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await handle.write(value);
          received += value.byteLength;
          options.onProgress?.({ received, total: totalBytes });
        }
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > 0) {
        await handle.write(buf);
        received += buf.byteLength;
        options.onProgress?.({ received, total: totalBytes });
      }
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    const shouldClean = !options.signal?.aborted || options.cleanupPartialOnAbort === true;
    if (shouldClean) {
      await rm(partPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  await handle.close();

  if (options.expectedSizeBytes && received < options.expectedSizeBytes * 0.98) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(
      `Downloaded model file appears incomplete (${received} bytes < expected ${options.expectedSizeBytes} bytes); partial file removed.`,
    );
  }

  if (options.expectedSha256) {
    const check = await verifyModelSha256(partPath, options.expectedSha256);
    if (!check.ok) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Model SHA-256 verification failed (expected ${options.expectedSha256}, got ${check.actual}); partial file removed.`,
      );
    }
  }

  await rename(partPath, options.destPath);
  return { path: options.destPath, bytes: received, resumed: append };
}
