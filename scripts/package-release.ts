#!/usr/bin/env node
/**
 * Release packager for Astra Navi Desktop (`community` open-core vs `supporter` edition).
 *
 *   npm run package:dry
 *   node scripts/package-release.ts --edition supporter --platform win --dry-run
 *   node scripts/package-release.ts --edition community --platform linux --checksums
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
const generateChecksums = process.argv.includes("--checksums");
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
const winIcon = join(ROOT, "assets", "icon.ico");
const extChromiumZip = join(ROOT, "dist", "astra-navi-browser-bridge-chromium-0.1.0.zip");
const extFirefoxZip = join(ROOT, "dist", "astra-navi-browser-bridge-firefox-0.1.0.zip");

const plan = {
  edition,
  features,
  platform,
  dryRun,
  checksums: generateChecksums,
  builderConfig: join(ROOT, "electron-builder.yml"),
  outputs: [
    ...(platform === "linux" || platform === "all"
      ? ["dist/Astra Navi Desktop-0.1.0.AppImage", "dist/astra-navi-desktop_0.1.0_amd64.deb"]
      : []),
    ...(platform === "win" || platform === "all"
      ? ["dist/Astra Navi Desktop Setup 0.1.0.exe", "dist/Astra Navi Desktop 0.1.0.exe"]
      : []),
  ],
  bundledAssets: {
    nativeWinHandsPresent: existsSync(nativeExe),
    windowsIconPresent: existsSync(winIcon),
    androidApkPresent: existsSync(apk),
  },
};

if (dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

await execFileAsync("npm", ["run", "build"], { cwd: ROOT });
await execFileAsync(process.execPath, [join(ROOT, "scripts", "package-extension.ts")], {
  cwd: ROOT,
});

const distDir = join(ROOT, "dist");
await mkdir(distDir, { recursive: true });
await writeFile(
  join(distDir, "edition-manifest.json"),
  `${JSON.stringify({ edition, features, builtAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);

const builderArgs = ["--config", "electron-builder.yml", "--publish", "never"];
if (platform === "linux") builderArgs.push("--linux", "AppImage", "deb");
else if (platform === "win") builderArgs.push("--win", "nsis", "portable");
else builderArgs.push("--linux", "AppImage", "deb", "--win", "nsis", "portable");

await execFileAsync("npx", ["--yes", "electron-builder", ...builderArgs], {
  cwd: ROOT,
  env: { ...process.env, ASTRA_NAVI_EDITION: edition },
});

const extrasDir = join(distDir, "extras");
await mkdir(extrasDir, { recursive: true });
if (existsSync(apk)) {
  await copyFile(apk, join(extrasDir, "astra-navi.apk"));
}
for (const zipPath of [extChromiumZip, extFirefoxZip]) {
  if (existsSync(zipPath)) {
    const base = zipPath.split(/[/\\]/).pop();
    if (base) await copyFile(zipPath, join(extrasDir, base));
  }
}

if (generateChecksums) {
  const entries = (await readdir(distDir)).sort();
  const lines: string[] = [];
  for (const name of entries) {
    if (name === "SHA256SUMS.txt") continue;
    const full = join(distDir, name);
    const info = await stat(full);
    if (!info.isFile()) continue;
    const bytes = await readFile(full);
    const digest = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(join(distDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
}
