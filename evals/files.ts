import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Report } from "./types.ts";

/**
 * Putting reports on disk without ever losing one. A run takes half an hour of the
 * graphics card; neither it nor the report it would replace is thrown away unasked.
 */

/**
 * Writes a finished report under its label. Unless `overwrite` was asked for, a report
 * already there under that name is left as it is, however it came to be there since the
 * run began, and this one is written beside it with the time in its name. Returns the
 * report as written (its label may have changed) and where it went.
 */
export async function writeReport(
  folder: string,
  report: Report,
  options: { overwrite: boolean; stamp: string },
): Promise<{ file: string; report: Report }> {
  await mkdir(folder, { recursive: true });
  const text = (written: Report): string => `${JSON.stringify(written, null, 2)}\n`;
  const first = join(folder, `${report.label}.json`);
  if (options.overwrite) {
    await writeFile(first, text(report), "utf8");
    return { file: first, report };
  }
  let named = report;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const file = join(folder, `${named.label}.json`);
    try {
      // "wx": fails if the file exists, so the check and the write are one step.
      await writeFile(file, text(named), { encoding: "utf8", flag: "wx" });
      return { file, report: named };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const suffix = attempt === 0 ? options.stamp : `${options.stamp}-${attempt + 1}`;
      named = { ...report, label: `${report.label}-${suffix}` };
    }
  }
  throw new Error(`Could not find a free name for the report ${report.label} in ${folder}.`);
}

/**
 * Keeps a copy of a report as it was before it is marked again for the first time,
 * beside it as "<name>.before-rescore.json". A later marking leaves that first copy
 * alone: it is the report as the run wrote it. Returns where the copy is, or null when
 * one was already there.
 */
export async function keepBeforeRescore(file: string): Promise<string | null> {
  const copy = join(
    dirname(file),
    `${file.slice(dirname(file).length + 1).replace(/\.json$/, "")}.before-rescore.json`,
  );
  try {
    // COPYFILE_EXCL: fails if the copy exists, so an earlier one is never replaced.
    await copyFile(file, copy, 1);
    return copy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

/** Where the reports are kept. */
export const RESULTS_DIR = join(import.meta.dirname, "results");

/** The file for a report given by its label, or by a path of its own. */
export function reportFile(name: string): string {
  return existsSync(name)
    ? name
    : join(RESULTS_DIR, name.endsWith(".json") ? name : `${name}.json`);
}

/** Reads a report by label or path. Throws, naming the file, when there is none. */
export async function loadReport(name: string): Promise<Report> {
  const file = reportFile(name);
  try {
    return JSON.parse(await readFile(file, "utf8")) as Report;
  } catch {
    throw new Error(`There is no report at ${file}.`);
  }
}
