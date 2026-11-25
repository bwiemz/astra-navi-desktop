#!/usr/bin/env node
/**
 * Release packager for Astra Navi Desktop (`community` open-core vs `supporter` edition).
 *
 *   npm run package:dry
 *   node scripts/package-release.ts --edition supporter --platform win --dry-run
 *   node scripts/package-release.ts --edition community --platform linux --checksums
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  detectBundledPacks,
  editionFeatures,
  resolveEdition,
  type Edition,
} from "../src/shared/edition.ts";

const ROOT = resolve(import.meta.dirname, "..");

function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const needsCmdShim =
      process.platform === "win32" && !command.includes("/") && !command.includes("\\");
    const child = spawn(command, [...args], {
      cwd: ROOT,
      env,
      stdio: "inherit",
      shell: needsCmdShim,
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(
            `${command} ${args.join(" ")} exited with ${
              code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`
            }`,
          ),
        );
      }
    });
  });
}

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
const rawStage = parseFlag("--stage") ?? "all";
if (rawStage !== "all" && rawStage !== "unpacked" && rawStage !== "installers") {
  throw new Error(`Invalid --stage value "${rawStage}" (expected all, unpacked, or installers).`);
}
const stage = rawStage as "all" | "unpacked" | "installers";
if (stage !== "all" && platform === "all") {
  throw new Error(`--stage ${stage} requires a single --platform (win or linux).`);
}

function readManifestVersion(path: string, fallback = "0.1.0"): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : fallback;
  } catch {
    return fallback;
  }
}

const pkgVersion = readManifestVersion(join(ROOT, "package.json"));
const extVersion = readManifestVersion(join(ROOT, "browser-bridge", "manifest.json"));

const bundledPacks = detectBundledPacks({
  bundledRoot: ROOT,
  exists: existsSync,
  readDir: (dir) => readdirSync(dir),
});
const features = editionFeatures(edition, bundledPacks);
const nativeExe = join(ROOT, "hands", "win-hands-native", "bin", "Release", "net9.0", "win-x64", "publish", "win-hands.exe");
const apk = join(ROOT, "phone-app", "build", "astra-navi.apk");
const winIcon = join(ROOT, "assets", "icon.ico");
const extChromiumZip = join(ROOT, "dist", `astra-navi-browser-bridge-chromium-${extVersion}.zip`);
const extFirefoxZip = join(ROOT, "dist", `astra-navi-browser-bridge-firefox-${extVersion}.zip`);

const plan = {
  edition,
  version: pkgVersion,
  extensionVersion: extVersion,
  features,
  bundledPacks,
  platform,
  stage,
  dryRun,
  checksums: generateChecksums,
  builderConfig: join(ROOT, "electron-builder.yml"),
  outputs: [
    ...(platform === "linux" || platform === "all"
      ? [`dist/Astra Navi Desktop-${pkgVersion}.AppImage`, `dist/astra-navi-desktop_${pkgVersion}_amd64.deb`]
      : []),
    ...(platform === "win" || platform === "all"
      ? [`dist/Astra Navi Desktop Setup ${pkgVersion}.exe`, `dist/Astra Navi Desktop ${pkgVersion}.exe`]
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

if (edition === "supporter" && bundledPacks.variantIds.length === 0) {
  throw new Error(
    "Supporter Edition build requested, but no Supporter overlay variants were found under assets/models/variants/. Apply bwiemz/astra-navi-supporter overlay/ first (or configure SUPPORTER_OVERLAY_TOKEN in CI).",
  );
}

const distDir = join(ROOT, "dist");

if (stage === "all" || stage === "unpacked") {
  await runCommand("npm", ["run", "build"]);
  await runCommand(process.execPath, [join(ROOT, "scripts", "package-extension.ts")]);

  await mkdir(distDir, { recursive: true });
  await writeFile(
    join(distDir, "edition-manifest.json"),
    `${JSON.stringify({ edition, version: pkgVersion, features, bundledPacks, builtAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

const builderArgs = ["--config", "electron-builder.yml", "--publish", "never"];
if (stage === "unpacked") {
  if (platform === "linux") builderArgs.push("--linux", "--dir");
  else builderArgs.push("--win", "--dir");
} else if (stage === "installers") {
  const prepackagedDir = join(distDir, platform === "win" ? "win-unpacked" : "linux-unpacked");
  if (!existsSync(prepackagedDir)) {
    throw new Error(`--stage installers requires prepackaged directory at ${prepackagedDir}. Run --stage unpacked first.`);
  }
  if (platform === "linux") builderArgs.push("--linux", "AppImage", "deb");
  else builderArgs.push("--win", "nsis", "portable");
  builderArgs.push("--prepackaged", prepackagedDir);
} else {
  if (platform === "linux") builderArgs.push("--linux", "AppImage", "deb");
  else if (platform === "win") builderArgs.push("--win", "nsis", "portable");
  else builderArgs.push("--linux", "AppImage", "deb", "--win", "nsis", "portable");
}

await runCommand("npx", ["--yes", "electron-builder", ...builderArgs], {
  ...process.env,
  ASTRA_NAVI_EDITION: edition,
});

if (stage !== "unpacked") {
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
}
