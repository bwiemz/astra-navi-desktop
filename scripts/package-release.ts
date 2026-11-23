#!/usr/bin/env node
/**
 * Release packager for Astra Navi Desktop (`community` open-core vs `supporter` edition).
 *
 *   npm run package:dry
 *   node scripts/package-release.ts --edition supporter --platform win --dry-run
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { editionFeatures, resolveEdition, type Edition } from "../src/shared/edition.ts";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

function parseFlag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? (process.argv[idx + 1] ?? null) : null;
}

const dryRun = process.argv.includes("--dry-run");
const rawEdition = parseFlag("--edition");
const edition: Edition =
  rawEdition === "supporter" || rawEdition === "community"
    ? rawEdition
    : resolveEdition();
const platform = (parseFlag("--platform") ?? (process.platform === "win32" ? "win" : "linux")) as
  | "linux"
  | "win"
  | "all";

const features = editionFeatures(edition);
const nativeExe = join(ROOT, "hands", "win-hands-native", "bin", "Release", "net9.0", "win-x64", "publish", "win-hands.exe");
const apk = join(ROOT, "phone-app", "build", "astra-navi.apk");

const plan = {
  edition,
  features,
  platform,
  dryRun,
  builderConfig: join(ROOT, "electron-builder.yml"),
  outputs: [
    ...(platform === "linux" || platform === "all"
      ? ["dist/Astra Navi Desktop-0.1.0.AppImage", "dist/astra-navi-desktop_0.1.0_amd64.deb"]
      : []),
    ...(platform === "win" || platform === "all"
      ? ["dist/Astra Navi Desktop Setup 0.1.0.exe"]
      : []),
  ],
  bundledAssets: {
    nativeWinHandsPresent: existsSync(nativeExe),
    androidApkPresent: existsSync(apk),
  },
};

if (dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

await execFileAsync("npm", ["run", "build"], { cwd: ROOT });
await mkdir(join(ROOT, "dist"), { recursive: true });
await writeFile(
  join(ROOT, "dist", "edition-manifest.json"),
  `${JSON.stringify({ edition, features, builtAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);

const builderArgs = ["--config", "electron-builder.yml"];
if (platform === "linux") builderArgs.push("--linux", "AppImage", "deb");
else if (platform === "win") builderArgs.push("--win", "nsis");
else builderArgs.push("--linux", "--win");

await execFileAsync("npx", ["electron-builder", ...builderArgs], {
  cwd: ROOT,
  env: { ...process.env, ASTRA_NAVI_EDITION: edition },
});
