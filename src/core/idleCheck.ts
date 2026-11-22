import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Checks whether someone is actively at the desktop before starting an unattended background
 * eval chunk. Falls back cleanly to null on headless machines so automated timers still run.
 */

const run = promisify(execFile);

/** Parses `gdbus call ... GetSessionIdleTime` output like `(uint32 125000,)`. */
export function parseGdbusIdleMs(stdout: string): number | null {
  const match = /\(\s*(?:uint32|uint64|int32|int64)?\s*(\d+)\s*,?\s*\)/.exec(stdout);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parses plain integer millisecond output from `xprintidle` or `qdbus6`. */
export function parseIdleNumber(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Best-effort desktop idle time in milliseconds, or null when unsupported/headless. */
export async function sessionIdleMs(): Promise<number | null> {
  try {
    const { stdout } = await run(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.ScreenSaver",
        "--object-path",
        "/org/freedesktop/ScreenSaver",
        "--method",
        "org.freedesktop.ScreenSaver.GetSessionIdleTime",
      ],
      { timeout: 3000 },
    );
    const parsed = parseGdbusIdleMs(stdout);
    if (parsed !== null) return parsed;
  } catch {
    // try other helpers below
  }
  try {
    const { stdout } = await run("xprintidle", [], { timeout: 3000 });
    const parsed = parseIdleNumber(stdout);
    if (parsed !== null) return parsed;
  } catch {
    // not installed or no X display
  }
  return null;
}

/** Reason not to start an unattended chunk right now, or null when idle long enough. */
export function unattendedReason(idleMs: number | null, minIdleMinutes: number): string | null {
  if (minIdleMinutes <= 0 || idleMs === null) return null;
  const neededMs = minIdleMinutes * 60_000;
  if (idleMs >= neededMs) return null;
  const idleMinutes = Math.floor(idleMs / 60_000);
  return `someone was active ${
    idleMinutes === 0 ? "just now" : `${idleMinutes} minute${idleMinutes === 1 ? "" : "s"} ago`
  } (waiting for ${minIdleMinutes} idle minutes)`;
}
