import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { ProfileBackupSummary, ProfileRestoreResult } from "../shared/settings.ts";
import { isInside } from "./riskRules.ts";

export type { ProfileBackupSummary, ProfileRestoreResult };

export const PROFILE_BACKUP_MAGIC = "ASTRANAVI_PROFILE_V1";
export const MAX_ARCHIVE_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
export const MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BASE64_LEN = Math.ceil((MAX_SINGLE_FILE_BYTES * 4) / 3) + 8;

export const PROFILE_STATE_FILES = [
  "config.json",
  "memory.json",
  "standing-orders.json",
  "agenda.json",
  "reminders.json",
  "missions.json",
  "routines.json",
  "play-log.json",
  "her.db",
] as const;

const ALLOWED_FILENAMES = new Set<string>(PROFILE_STATE_FILES);

const BackupFileSchema = z.object({
  name: z.string().min(1).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  bytes: z.number().int().min(0).max(MAX_SINGLE_FILE_BYTES),
  dataBase64: z.string().max(MAX_BASE64_LEN),
});

const ProfileBackupSchema = z.object({
  magic: z.literal(PROFILE_BACKUP_MAGIC),
  version: z.literal(1),
  exportedAt: z.string().min(1).max(64),
  files: z.array(BackupFileSchema).max(32),
});

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function digestMatches(expectedHex: string, actualBytes: Buffer): boolean {
  const clean = expectedHex.trim().toLowerCase();
  const actualHex = sha256Hex(actualBytes);
  const a = Buffer.from(clean, "hex");
  const b = Buffer.from(actualHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function assertNotSymlinkIfExists(path: string, label: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      throw new Error(`Refused symlink ${label}: "${basename(path)}".`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function readArchiveBounded(archivePath: string): Promise<Buffer> {
  await assertNotSymlinkIfExists(archivePath, "profile archive");
  const st = await stat(archivePath);
  if (!st.isFile()) {
    throw new Error("Profile archive path is not a regular file.");
  }
  if (st.size > MAX_ARCHIVE_COMPRESSED_BYTES) {
    throw new Error(
      `Profile archive (${st.size} bytes) exceeds ${MAX_ARCHIVE_COMPRESSED_BYTES} byte compressed limit.`,
    );
  }
  return readFile(archivePath);
}

async function writeAtomicPrivate(targetPath: string, bytes: Buffer): Promise<void> {
  await assertNotSymlinkIfExists(targetPath, "restore target");
  const tmpPath = `${targetPath}.${randomBytes(8).toString("hex")}.tmp`;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(
    tmpPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(tmpPath, 0o600).catch(() => undefined);
  await rename(tmpPath, targetPath);
}

/**
 * Bundles user companion state (config, memory, standing orders, agenda, reminders,
 * missions, routines, play log, and SQLite DB) into one gzipped, SHA-256 verified archive.
 */
export async function exportProfileBackup(
  sourceDataDir: string,
  archivePath: string,
): Promise<ProfileBackupSummary> {
  await assertNotSymlinkIfExists(sourceDataDir, "source data directory");
  const packed: z.infer<typeof BackupFileSchema>[] = [];
  let totalBytes = 0;

  for (const name of PROFILE_STATE_FILES) {
    const full = join(sourceDataDir, name);
    await assertNotSymlinkIfExists(full, "state file");
    let raw: Buffer;
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.size > MAX_SINGLE_FILE_BYTES) {
        throw new Error(`State file "${name}" exceeds safe export limits.`);
      }
      raw = await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    totalBytes += raw.length;
    if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error("Total exported profile size exceeds safe archive limit.");
    }
    packed.push({
      name,
      sha256: sha256Hex(raw),
      bytes: raw.length,
      dataBase64: raw.toString("base64"),
    });
  }

  const exportedAt = new Date().toISOString();
  const payload = {
    magic: PROFILE_BACKUP_MAGIC,
    version: 1 as const,
    exportedAt,
    files: packed,
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 6 });

  await mkdir(join(archivePath, ".."), { recursive: true, mode: 0o700 });
  await writeAtomicPrivate(archivePath, compressed);

  return {
    version: 1,
    exportedAt,
    files: packed.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    totalBytes,
  };
}

function parseAndVerifyArchive(rawGzip: Buffer): {
  summary: ProfileBackupSummary;
  decodedFiles: { name: string; bytes: Buffer }[];
} {
  if (rawGzip.byteLength > MAX_ARCHIVE_COMPRESSED_BYTES) {
    throw new Error(
      `Invalid profile archive: compressed size exceeds ${MAX_ARCHIVE_COMPRESSED_BYTES} bytes.`,
    );
  }
  let plain: Buffer;
  try {
    plain = gunzipSync(rawGzip, { maxOutputLength: MAX_ARCHIVE_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw new Error(
      `Invalid profile archive: could not decompress cleanly (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("Invalid profile archive: corrupted JSON manifest.");
  }

  const parsed = ProfileBackupSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(`Invalid profile archive schema: ${parsed.error.message}`);
  }

  const decodedFiles: { name: string; bytes: Buffer }[] = [];
  const summaryFiles: ProfileBackupSummary["files"] = [];
  const seenNames = new Set<string>();
  let totalBytes = 0;

  for (const entry of parsed.data.files) {
    if (
      basename(entry.name) !== entry.name ||
      entry.name.includes("..") ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      entry.name.includes(":") ||
      entry.name.includes("\0") ||
      !ALLOWED_FILENAMES.has(entry.name)
    ) {
      throw new Error(`Unsafe or unsupported profile entry: "${entry.name}".`);
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`Duplicate entry "${entry.name}" in profile archive.`);
    }
    seenNames.add(entry.name);

    const bytes = Buffer.from(entry.dataBase64, "base64");
    if (
      bytes.length > MAX_SINGLE_FILE_BYTES ||
      bytes.length !== entry.bytes ||
      !digestMatches(entry.sha256, bytes)
    ) {
      throw new Error(`Integrity check failed for "${entry.name}" in profile archive.`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Profile archive unpacked size exceeds ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} byte safety cap.`,
      );
    }
    decodedFiles.push({ name: entry.name, bytes });
    summaryFiles.push({ name: entry.name, bytes: bytes.length, sha256: entry.sha256 });
  }

  return {
    summary: {
      version: 1,
      exportedAt: parsed.data.exportedAt,
      files: summaryFiles,
      totalBytes,
    },
    decodedFiles,
  };
}

export async function inspectProfileBackup(archivePath: string): Promise<ProfileBackupSummary> {
  const rawGzip = await readArchiveBounded(archivePath);
  return parseAndVerifyArchive(rawGzip).summary;
}

/**
 * Validates archive magic, bounded gzip output, schema, filenames, duplicates, and per-file
 * SHA-256 BEFORE modifying any state, guards against symlinks/traversal, snapshots existing
 * files into `pre-restore-backups/<timestamp>`, and atomically restores.
 */
export async function importProfileBackup(
  archivePath: string,
  targetDataDir: string,
): Promise<ProfileRestoreResult> {
  const rawGzip = await readArchiveBounded(archivePath);
  const { summary, decodedFiles } = parseAndVerifyArchive(rawGzip);

  await assertNotSymlinkIfExists(targetDataDir, "target data directory");
  await mkdir(targetDataDir, { recursive: true, mode: 0o700 });
  const realTargetDir = await realpath(targetDataDir);

  const backupsRoot = join(realTargetDir, "pre-restore-backups");
  await assertNotSymlinkIfExists(backupsRoot, "pre-restore-backups directory");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = join(backupsRoot, stamp);
  let snapshotCreated = false;

  for (const name of PROFILE_STATE_FILES) {
    const existing = resolve(realTargetDir, name);
    if (!isInside(existing, realTargetDir)) {
      throw new Error(`Unsafe restore path "${name}".`);
    }
    await assertNotSymlinkIfExists(existing, "existing state file");
    try {
      const st = await lstat(existing);
      if (!st.isFile()) continue;
      if (!snapshotCreated) {
        await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
        snapshotCreated = true;
      }
      const dest = join(snapshotDir, name);
      await assertNotSymlinkIfExists(dest, "snapshot destination");
      await copyFile(existing, dest);
      await chmod(dest, 0o600).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const restoredFiles: string[] = [];
  for (const file of decodedFiles) {
    const dest = resolve(realTargetDir, file.name);
    if (!isInside(dest, realTargetDir)) {
      throw new Error(`Refused Zip-Slip restore outside target dir: "${file.name}".`);
    }
    await assertNotSymlinkIfExists(dest, "restore destination");
    await writeAtomicPrivate(dest, file.bytes);
    restoredFiles.push(file.name);
  }

  return {
    restoredFiles,
    backupSnapshotDir: snapshotCreated ? snapshotDir : null,
    exportedAt: summary.exportedAt,
  };
}
