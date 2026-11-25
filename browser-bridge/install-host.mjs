#!/usr/bin/env node
/**
 * Cross-platform Native Messaging Host installer for Astra Navi Desktop.
 * Registers `app.astranavi.dom_bridge` for Chromium/Chrome/Brave/Edge and Firefox on
 * Linux, macOS, and Windows. Supports `--dry-run` and `--uninstall`.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const NATIVE_HOST_ID = "app.astranavi.dom_bridge";

export function buildHostManifests(options) {
  const executablePath = options.executablePath;
  const extensionOrigin =
    options.extensionOrigin || "chrome-extension://astranavidombridgeplaceholderid/";
  const geckoExtensionId = options.geckoExtensionId || "dom-bridge@astranavi.app";

  const chromium = {
    name: NATIVE_HOST_ID,
    description: "Astra Navi Desktop local semantic DOM native messaging host",
    path: executablePath,
    type: "stdio",
    allowed_origins: [extensionOrigin],
  };

  const firefox = {
    name: NATIVE_HOST_ID,
    description: "Astra Navi Desktop local semantic DOM native messaging host",
    path: executablePath,
    type: "stdio",
    allowed_extensions: [geckoExtensionId],
  };

  return { chromium, firefox };
}

export function nativeHostTargets(options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const dataRoot = options.dataRoot ?? join(home, ".local", "share", "astra-navi", "browser-bridge");

  if (platform === "win32") {
    const manifestDir = join(options.localAppData ?? join(home, "AppData", "Local"), "AstraNavi", "BrowserBridge");
    return {
      launcherPath: join(manifestDir, "astra-navi-dom-bridge.cmd"),
      manifests: [
        { kind: "chromium", file: join(manifestDir, `${NATIVE_HOST_ID}.chrome.json`) },
        { kind: "firefox", file: join(manifestDir, `${NATIVE_HOST_ID}.firefox.json`) },
      ],
      registryKeys: [
        { kind: "chromium", key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_ID}` },
        { kind: "chromium", key: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_ID}` },
        { kind: "chromium", key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_ID}` },
        { kind: "chromium", key: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_ID}` },
        { kind: "firefox", key: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_ID}` },
      ],
    };
  }

  if (platform === "darwin") {
    const lib = join(home, "Library", "Application Support");
    return {
      launcherPath: join(dataRoot, "astra-navi-dom-bridge"),
      manifests: [
        { kind: "chromium", file: join(lib, "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
        { kind: "chromium", file: join(lib, "Chromium", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
        { kind: "chromium", file: join(lib, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
        { kind: "chromium", file: join(lib, "Microsoft Edge", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
        { kind: "firefox", file: join(lib, "Mozilla", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
      ],
      registryKeys: [],
    };
  }

  const configHome = options.configHome ?? join(home, ".config");
  return {
    launcherPath: join(dataRoot, "astra-navi-dom-bridge"),
    manifests: [
      { kind: "chromium", file: join(configHome, "google-chrome", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
      { kind: "chromium", file: join(configHome, "chromium", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
      { kind: "chromium", file: join(configHome, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
      { kind: "chromium", file: join(configHome, "microsoft-edge", "NativeMessagingHosts", `${NATIVE_HOST_ID}.json`) },
      { kind: "firefox", file: join(home, ".mozilla", "native-messaging-hosts", `${NATIVE_HOST_ID}.json`) },
    ],
    registryKeys: [],
  };
}

export async function installNativeHost(options = {}) {
  const platform = options.platform ?? process.platform;
  const dryRun = options.dryRun === true;
  const uninstall = options.uninstall === true;
  const hostScript = resolve(
    options.hostScript ?? join(import.meta.dirname, "native-host.mjs"),
  );
  const nodePath = options.nodePath ?? process.execPath;
  const electronRunAsNode = options.electronRunAsNode ?? Boolean(process.versions?.electron);
  const targets = nativeHostTargets(options);
  const payloads = buildHostManifests({
    executablePath: targets.launcherPath,
    extensionOrigin: options.extensionOrigin,
    geckoExtensionId: options.geckoExtensionId,
  });

  if (uninstall) {
    if (!dryRun) {
      rmSync(targets.launcherPath, { force: true });
      for (const m of targets.manifests) rmSync(m.file, { force: true });
      if (platform === "win32") {
        for (const reg of targets.registryKeys) {
          await execFileAsync("reg.exe", ["delete", reg.key, "/f"], { windowsHide: true }).catch(
            () => undefined,
          );
        }
      }
    }
    return {
      action: "uninstall",
      dryRun,
      launcherPath: targets.launcherPath,
      files: targets.manifests.map((m) => m.file),
      registryKeys: targets.registryKeys.map((r) => r.key),
    };
  }

  const launcherBody =
    platform === "win32"
      ? electronRunAsNode
        ? `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${nodePath}" "${hostScript}" %*\r\n`
        : `@echo off\r\n"${nodePath}" "${hostScript}" %*\r\n`
      : electronRunAsNode
        ? `#!/usr/bin/env sh\nELECTRON_RUN_AS_NODE=1 exec "${nodePath}" "${hostScript}" "$@"\n`
        : `#!/usr/bin/env sh\nexec "${nodePath}" "${hostScript}" "$@"\n`;

  if (!dryRun) {
    mkdirSync(dirname(targets.launcherPath), { recursive: true, mode: 0o700 });
    writeFileSync(targets.launcherPath, launcherBody, "utf8");
    if (platform !== "win32") chmodSync(targets.launcherPath, 0o755);

    for (const target of targets.manifests) {
      mkdirSync(dirname(target.file), { recursive: true });
      const manifest = target.kind === "firefox" ? payloads.firefox : payloads.chromium;
      writeFileSync(target.file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }

    if (platform === "win32") {
      for (const reg of targets.registryKeys) {
        const manifestFile =
          targets.manifests.find((m) => m.kind === reg.kind)?.file ?? targets.manifests[0].file;
        await execFileAsync(
          "reg.exe",
          ["add", reg.key, "/ve", "/t", "REG_SZ", "/d", manifestFile, "/f"],
          { windowsHide: true },
        );
      }
    }
  }

  return {
    action: "install",
    dryRun,
    launcherPath: targets.launcherPath,
    files: targets.manifests.map((m) => m.file),
    registryKeys: targets.registryKeys.map((r) => r.key),
    manifests: payloads,
  };
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const uninstall = process.argv.includes("--uninstall");
  const result = await installNativeHost({ dryRun, uninstall });
  console.log(JSON.stringify(result, null, 2));
}
