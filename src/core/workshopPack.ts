import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

/**
 * Data-Only Community / Steam Workshop Pack Validator.
 *
 * Launching community packs strictly data-only (avatars, voices, personas, emote packs)
 * with zero executable code prevents supply-chain malware re-uploads seen in desktop-pet
 * Workshop ecosystems. Every file in a pack directory must be a non-symlink regular file
 * matching an explicit safe asset allowlist and staying outside executable extensions.
 */

export const WORKSHOP_PACK_KINDS = ["avatar", "voice", "persona", "emote-pack"] as const;
export type WorkshopPackKind = (typeof WORKSHOP_PACK_KINDS)[number];

export const MAX_WORKSHOP_PACK_FILES = 256;
export const MAX_WORKSHOP_SINGLE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSHOP_TOTAL_BYTES = 128 * 1024 * 1024;

export const ALLOWED_DATA_ONLY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json",
  ".vrm",
  ".glb",
  ".pmx",
  ".pmd",
  ".vrma",
  ".vmd",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tga",
  ".dds",
  ".wav",
  ".ogg",
  ".flac",
  ".mp3",
  ".txt",
  ".md",
]);

export const FORBIDDEN_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".py",
  ".pyc",
  ".pyw",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".node",
  ".vbs",
  ".vbe",
  ".hta",
  ".jar",
  ".class",
  ".apk",
  ".msi",
  ".scr",
  ".com",
  ".reg",
  ".lnk",
  ".html",
  ".htm",
  ".svg",
]);

export const WorkshopPackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(1).max(64),
  kind: z.enum(WORKSHOP_PACK_KINDS),
  version: z.string().min(1).max(32),
  author: z.string().min(1).max(64),
  license: z.string().min(1).max(64),
  dataOnly: z.literal(true),
  description: z.string().max(400).default(""),
  entryFile: z
    .string()
    .min(1)
    .max(160)
    .refine((p) => !p.includes("..") && !p.startsWith("/") && !p.startsWith("\\"), {
      message: "entryFile must be a safe relative path inside the pack.",
    }),
});
export type WorkshopPackManifest = z.infer<typeof WorkshopPackManifestSchema>;

export interface WorkshopPackAuditResult {
  ok: boolean;
  manifest: WorkshopPackManifest | null;
  fileCount: number;
  totalBytes: number;
  violations: string[];
}

/** Checks whether a relative filename is permitted in a data-only Workshop pack. */
export function isSafeDataOnlyFilename(relPath: string): { ok: true } | { ok: false; reason: string } {
  const normalized = relPath.split(sep).join("/");
  if (normalized.includes("..") || normalized.startsWith("/")) {
    return { ok: false, reason: `Unsafe relative path "${normalized}".` };
  }
  const ext = extname(normalized).toLowerCase();
  if (!ext) {
    return { ok: false, reason: `Extensionless file "${normalized}" is not allowed in data-only packs.` };
  }
  if (FORBIDDEN_CODE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: `Executable or script file "${normalized}" (${ext}) is blocked by data-only Workshop policy.`,
    };
  }
  if (!ALLOWED_DATA_ONLY_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: `File "${normalized}" (${ext}) is outside the data-only asset allowlist.`,
    };
  }
  return { ok: true };
}

/**
 * Audits an unpacked community/Workshop pack directory to enforce strict data-only rules:
 * valid `manifest.json` (`dataOnly: true`), zero symlinks, zero executable/script files,
 * bounded file count and total size, and an existing safe `entryFile`.
 */
export async function auditWorkshopPackDirectory(packDir: string): Promise<WorkshopPackAuditResult> {
  const root = resolve(packDir);
  const violations: string[] = [];
  const seenFiles = new Set<string>();
  let totalBytes = 0;

  const walk = async (currentDir: string): Promise<void> => {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const rel = relative(root, fullPath).split(sep).join("/");
      const st = await lstat(fullPath);

      if (st.isSymbolicLink()) {
        violations.push(`Symlink "${rel}" is forbidden in community packs.`);
        continue;
      }
      if (st.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!st.isFile()) {
        violations.push(`Special filesystem entry "${rel}" is not allowed.`);
        continue;
      }

      seenFiles.add(rel);
      if (seenFiles.size > MAX_WORKSHOP_PACK_FILES) {
        violations.push(`Pack exceeds maximum file count (${MAX_WORKSHOP_PACK_FILES}).`);
        return;
      }

      const extCheck = isSafeDataOnlyFilename(rel);
      if (!extCheck.ok) violations.push(extCheck.reason);

      if (st.size > MAX_WORKSHOP_SINGLE_FILE_BYTES) {
        violations.push(`File "${rel}" exceeds 64 MB single-file limit.`);
      }
      totalBytes += st.size;
      if (totalBytes > MAX_WORKSHOP_TOTAL_BYTES) {
        violations.push(`Pack exceeds 128 MB total size budget.`);
      }
    }
  };

  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return {
        ok: false,
        manifest: null,
        fileCount: 0,
        totalBytes: 0,
        violations: ["Pack path must be a real directory (not a symlink)."],
      };
    }
    await walk(root);
  } catch (error) {
    return {
      ok: false,
      manifest: null,
      fileCount: seenFiles.size,
      totalBytes,
      violations: [error instanceof Error ? error.message : String(error)],
    };
  }

  let manifest: WorkshopPackManifest | null = null;
  if (!seenFiles.has("manifest.json")) {
    violations.push("Pack is missing required manifest.json.");
  } else {
    try {
      const rawJson = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as unknown;
      const parsed = WorkshopPackManifestSchema.safeParse(rawJson);
      if (!parsed.success) {
        violations.push(`Invalid manifest.json: ${parsed.error.message}`);
      } else {
        manifest = parsed.data;
        if (!seenFiles.has(manifest.entryFile.split("\\").join("/"))) {
          violations.push(`Declared entryFile "${manifest.entryFile}" was not found in the pack.`);
        }
      }
    } catch {
      violations.push("manifest.json is not valid JSON.");
    }
  }

  return {
    ok: violations.length === 0 && manifest !== null,
    manifest,
    fileCount: seenFiles.size,
    totalBytes,
    violations,
  };
}
