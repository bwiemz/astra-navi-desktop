import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { ProfileBackupSummary, ProfileRestoreResult } from "../shared/settings.ts";

export type { ProfileBackupSummary, ProfileRestoreResult };

export const PROFILE_BACKUP_MAGIC = "ASTRANAVI_PROFILE_V1";
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
  bytes: z.number().int().min(0),
  dataBase64: z.string(),
});

const ProfileBackupSchema = z.object({
  magic: z.literal(PROFILE_BACKUP_MAGIC),
  version: z.literal(1),
  exportedAt: z.string().min(1),
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

/**
 * Bundles user companion state (config, memory, standing orders, agenda, reminders,
 * missions, routines, play log, and SQLite DB) into one gzipped, SHA-256 verified archive.
 */
export async function exportProfileBackup(
  sourceDataDir: string,
  archivePath: string,
): Promise<ProfileBackupSummary> {
  const packed: z.infer<typeof BackupFileSchema>[] = [];
  let totalBytes = 0;

  for (const name of PROFILE_STATE_FILES) {
    const full = join(sourceDataDir, name);
    let raw: Buffer;
    try {
      raw = await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    totalBytes += raw.length;
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
  const tmp = `${archivePath}.tmp`;
  await writeFile(tmp, compressed, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, archivePath);

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
  let plain: Buffer;
  try {
    plain = gunzipSync(rawGzip);
  } catch (error) {
    throw new Error(
      `Invalid profile archive: could not decompress (${error instanceof Error ? error.message : String(error)}).`,
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
  let totalBytes = 0;

  for (const entry of parsed.data.files) {
    if (
      basename(entry.name) !== entry.name ||
      entry.name.includes("..") ||
      !ALLOWED_FILENAMES.has(entry.name)
    ) {
      throw new Error(`Unsafe or unsupported profile entry: "${entry.name}".`);
    }
    const bytes = Buffer.from(entry.dataBase64, "base64");
    if (bytes.length !== entry.bytes || !digestMatches(entry.sha256, bytes)) {
      throw new Error(`Integrity check failed for "${entry.name}" in profile archive.`);
    }
    totalBytes += bytes.length;
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
  const rawGzip = await readFile(archivePath);
  return parseAndVerifyArchive(rawGzip).summary;
}

/**
 * Validates archive magic, schema, filenames, and per-file SHA-256 BEFORE modifying any state,
 * snapshots existing files into `pre-restore-backups/<timestamp>`, and atomically restores.
 */
export async function importProfileBackup(
  archivePath: string,
  targetDataDir: string,
): Promise<ProfileRestoreResult> {
  const rawGzip = await readFile(archivePath);
  const { summary, decodedFiles } = parseAndVerifyArchive(rawGzip);

  await mkdir(targetDataDir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = join(targetDataDir, "pre-restore-backups", stamp);
  let snapshotCreated = false;

  for (const name of PROFILE_STATE_FILES) {
    const existing = join(targetDataDir, name);
    try {
      await readFile(existing, { flag: "r" });
      if (!snapshotCreated) {
        await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
        snapshotCreated = true;
      }
      const dest = join(snapshotDir, name);
      await copyFile(existing, dest);
      await chmod(dest, 0o600).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const restoredFiles: string[] = [];
  for (const file of decodedFiles) {
    const dest = join(targetDataDir, file.name);
    const tmp = `${dest}.restore.tmp`;
    await writeFile(tmp, file.bytes, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, dest);
    restoredFiles.push(file.name);
  }

  return {
    restoredFiles,
    backupSnapshotDir: snapshotCreated ? snapshotDir : null,
    exportedAt: summary.exportedAt,
  };
}
