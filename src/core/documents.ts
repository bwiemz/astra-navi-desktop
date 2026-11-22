import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { isSensitivePath } from "./permissions.ts";

/**
 * Reading what is inside documents that are not plain text (PDFs, office files, text in
 * pictures) and finding files by name or by what they say. Each uses a program that
 * is already on most Linux desktops, started directly with fixed arguments: no shell
 * is involved, so a file's name can never be read as a command.
 */

const TIMEOUT_MS = 60_000;
/** How many matches are looked at before the newest are picked. */
const CONSIDERED = 3000;
const MAX_OUTPUT = 4 * 1024 * 1024;

const OFFICE = new Set([".docx", ".doc", ".odt", ".rtf", ".epub"]);
const SLIDES = new Set([".pptx", ".ppt", ".odp"]);
const SHEETS = new Set([".xlsx", ".xls", ".ods"]);
const PICTURES = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"]);

function run(
  program: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, signal, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new Error(
              missing
                ? `The program "${program}" is not installed.`
                : `${program} failed: ${error.message.split("\n")[0]}`,
            ),
          );
        } else resolve(stdout);
      },
    );
  });
}

let canIsolate: Promise<boolean> | null = null;

/**
 * A document can ask the program that opens it to fetch pictures or data from an
 * address of its choosing, this computer's own network included. So LibreOffice is run
 * with no network at all, when the system has the means (bubblewrap) to do that.
 */
async function offline(program: string, args: string[]): Promise<[string, string[]]> {
  canIsolate ??= run(
    "bwrap",
    ["--unshare-net", "--dev-bind", "/", "/", "--", "true"],
    undefined,
    5000,
  ).then(
    () => true,
    () => false,
  );
  return (await canIsolate)
    ? ["bwrap", ["--unshare-net", "--dev-bind", "/", "/", "--", program, ...args]]
    : [program, args];
}

/** True for a file type `readDocument` knows how to get text out of. */
export function isDocument(path: string): boolean {
  const kind = extname(path).toLowerCase();
  return (
    kind === ".pdf" ||
    OFFICE.has(kind) ||
    SLIDES.has(kind) ||
    SHEETS.has(kind) ||
    PICTURES.has(kind)
  );
}

/**
 * The text of a PDF, an office document, a spreadsheet, or the words visible in a picture.
 * @returns The text and a word about how it was read.
 */
export async function readDocument(
  path: string,
  signal?: AbortSignal,
): Promise<{ text: string; how: string }> {
  const kind = extname(path).toLowerCase();
  if (kind === ".pdf") {
    // The first forty pages are plenty to answer from, and keep a huge manual from stalling her.
    const text = await run("pdftotext", ["-l", "40", "-nopgbrk", "--", path, "-"], signal);
    return { text, how: "text of the PDF (first 40 pages at most)" };
  }
  if (PICTURES.has(kind)) {
    const text = await run("tesseract", [path, "stdout", "--psm", "3"], signal);
    return { text, how: "words read from the picture" };
  }
  if (OFFICE.has(kind) || SHEETS.has(kind) || SLIDES.has(kind)) {
    const work = await mkdtemp(join(tmpdir(), "aichan-doc-"));
    try {
      // Slides have no plain-text export, so they go by way of a PDF.
      const target = SHEETS.has(kind) ? "csv" : SLIDES.has(kind) ? "pdf" : "txt:Text";
      const [program, args] = await offline("soffice", [
        // Its own profile folder, so a LibreOffice the user has open is not disturbed.
        `-env:UserInstallation=file://${join(work, "profile")}`,
        "--headless",
        "--convert-to",
        target,
        "--outdir",
        work,
        path,
      ]);
      await run(program, args, signal);
      const made = (await readdir(work)).find((name) => /\.(?:txt|csv|pdf)$/i.test(name));
      if (!made) throw new Error(`LibreOffice could not read ${basename(path)}.`);
      if (SLIDES.has(kind)) {
        const text = await run(
          "pdftotext",
          ["-l", "60", "-nopgbrk", "--", join(work, made), "-"],
          signal,
        );
        return { text, how: "text of the slides" };
      }
      return {
        text: await readFile(join(work, made), "utf8"),
        how: SHEETS.has(kind) ? "first sheet as comma-separated values" : "text of the document",
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  throw new Error(`${basename(path)} is not a kind of document this can read.`);
}

export interface FoundFile {
  path: string;
  bytes: number;
  modified: Date;
}

export interface FindOptions {
  /** Part of the file's name, or a pattern with * in it. */
  name?: string;
  /** Words that appear inside the file. */
  content?: string;
  /** Where to look. */
  folder: string;
  limit?: number;
  /** Folders whose contents must not be listed (her own settings and records). */
  skipDirs?: readonly string[];
}

/**
 * Finds files by name or by content, newest first. Hidden folders and anything that
 * holds passwords or keys are left out.
 */
export async function findFiles(options: FindOptions, signal?: AbortSignal): Promise<FoundFile[]> {
  const limit = options.limit ?? 20;
  let paths: string[];
  const name = options.name?.trim();
  const content = options.content?.trim();
  if (content) {
    // Files only (-l), text files only (default), not hidden, at most a megabyte each.
    const args = [
      "--files-with-matches",
      "--ignore-case",
      "--fixed-strings",
      "--max-filesize",
      "1M",
    ];
    if (name) args.push("--iglob", name.includes("*") ? name : `*${name}*`);
    args.push("--", content, options.folder);
    paths = await lines("rg", args, signal, 20_000);
  } else if (name) {
    const args = [
      "--type",
      "f",
      "--ignore-case",
      "--absolute-path",
      "--max-results",
      String(CONSIDERED),
    ];
    // Build output and dependencies are not what anyone means by "my files".
    for (const noise of ["node_modules", "target", "__pycache__", ".git"]) {
      args.push("--exclude", noise);
    }
    if (name.includes("*")) args.push("--glob");
    else args.push("--fixed-strings");
    args.push("--", name, options.folder);
    paths = await lines("fd", args, signal, 20_000);
  } else {
    throw new Error("Say part of the file's name, or words that are in it.");
  }

  const found: FoundFile[] = [];
  const skipped = (options.skipDirs ?? []).map((dir) => dir.replace(/\/+$/, ""));
  for (const path of paths.slice(0, CONSIDERED)) {
    if (isSensitivePath(path)) continue;
    if (skipped.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue;
    try {
      const info = await stat(path);
      if (info.isFile()) found.push({ path, bytes: info.size, modified: info.mtime });
    } catch {
      // gone since it was listed
    }
  }
  return found.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, limit);
}

/** Runs a search program and returns its output lines. "Found nothing" is an empty list, not an error. */
async function lines(
  program: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, signal, encoding: "utf8" },
      (error, stdout) => {
        const found = stdout.split("\n").filter((line) => line.length > 0);
        if (!error || found.length > 0) return resolve(found);
        const code: unknown = (error as { code?: unknown }).code;
        if (code === "ENOENT")
          return reject(new Error(`The program "${program}" is not installed.`));
        // Both programs exit with 1 when nothing matched.
        if (code === 1) return resolve([]);
        const tooSlow = (error as { killed?: boolean }).killed === true;
        reject(
          new Error(
            tooSlow
              ? "The search took too long. Look in a smaller folder, or use more exact words."
              : `The search failed: ${error.message.split("\n")[0]}`,
          ),
        );
      },
    );
  });
}

export function describeFound(files: readonly FoundFile[]): string {
  const size = (bytes: number): string =>
    bytes >= 1e9
      ? `${(bytes / 1e9).toFixed(1)} GB`
      : bytes >= 1e6
        ? `${(bytes / 1e6).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
  return files
    .map(
      (file) =>
        `${file.path} (${size(file.bytes)}, changed ${file.modified.toISOString().slice(0, 10)})`,
    )
    .join("\n");
}
