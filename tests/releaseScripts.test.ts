import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPublishPlan,
  discoverSteamCmd,
  renderSteamVdfs,
  resolveSteamConfig,
  validateSteamReady,
} from "../scripts/publish-store.ts";

const ROOT = resolve(import.meta.dirname, "..");

describe("publish-store SteamCMD & storefront helpers", () => {
  it("discovers steamcmd in priority order: STEAMCMD_BIN > STEAMWORKS_SDK_DIR > Downloads/steamworks_sdk_165 > PATH fallback", () => {
    const explicit = discoverSteamCmd({
      env: { STEAMCMD_BIN: "/opt/steamcmd/steamcmd.sh", STEAMWORKS_SDK_DIR: "/ignored" },
      platform: "linux",
      home: "/home/tester",
      exists: (p) => p === "/opt/steamcmd/steamcmd.sh",
    });
    expect(explicit).toEqual({
      bin: "/opt/steamcmd/steamcmd.sh",
      source: "env:STEAMCMD_BIN",
      found: true,
    });

    const fromSdkEnv = discoverSteamCmd({
      env: { STEAMWORKS_SDK_DIR: "/opt/swsdk" },
      platform: "win32",
      home: "C:\\Users\\tester",
      exists: (p) => p === join("/opt/swsdk", "tools", "ContentBuilder", "builder", "steamcmd.exe"),
    });
    expect(fromSdkEnv.source).toBe("env:STEAMWORKS_SDK_DIR");
    expect(fromSdkEnv.found).toBe(true);
    expect(fromSdkEnv.bin).toContain("steamcmd.exe");

    const fromDownloadsLinux = discoverSteamCmd({
      env: {},
      platform: "linux",
      home: "/home/tester",
      exists: (p) =>
        p ===
        join(
          "/home/tester",
          "Downloads",
          "steamworks_sdk_165",
          "sdk",
          "tools",
          "ContentBuilder",
          "builder_linux",
          "steamcmd.sh",
        ),
    });
    expect(fromDownloadsLinux.source).toBe("downloads:steamworks_sdk_165");
    expect(fromDownloadsLinux.found).toBe(true);

    const fromDownloadsWin = discoverSteamCmd({
      env: {},
      platform: "win32",
      home: "C:\\Users\\tester",
      exists: (p) =>
        p ===
        join(
          "C:\\Users\\tester",
          "Downloads",
          "steamworks_sdk_165",
          "sdk",
          "tools",
          "ContentBuilder",
          "builder",
          "steamcmd.exe",
        ),
    });
    expect(fromDownloadsWin.source).toBe("downloads:steamworks_sdk_165");
    expect(fromDownloadsWin.found).toBe(true);

    const fallback = discoverSteamCmd({
      env: {},
      platform: "linux",
      home: "/home/tester",
      exists: () => false,
    });
    expect(fallback).toEqual({ bin: "steamcmd", source: "path-fallback", found: false });
  });

  it("resolves Steam config and refuses AppID 0 or missing credentials outside dry-run", () => {
    const defaults = resolveSteamConfig({});
    expect(defaults.appId).toBe("0");
    expect(defaults.depotWin64Id).toBe("1001");
    expect(defaults.depotLinux64Id).toBe("1002");

    expect(() =>
      validateSteamReady(defaults, { bin: "steamcmd", source: "downloads:steamworks_sdk_165", found: true }),
    ).toThrow(/placeholder STEAM_APP_ID="0"/);

    const withApp = resolveSteamConfig({ STEAM_APP_ID: "480000" });
    expect(() =>
      validateSteamReady(withApp, { bin: "steamcmd", source: "downloads:steamworks_sdk_165", found: true }),
    ).toThrow(/STEAM_USER/);

    const readyCfg = resolveSteamConfig({ STEAM_APP_ID: "480000", STEAM_USER: "builder_acct" });
    expect(() =>
      validateSteamReady(readyCfg, { bin: "steamcmd", source: "path-fallback", found: false }),
    ).toThrow(/Could not locate steamcmd/);

    expect(() =>
      validateSteamReady(readyCfg, {
        bin: "/tmp/steamcmd.sh",
        source: "downloads:steamworks_sdk_165",
        found: true,
      }),
    ).not.toThrow();
  });

  it("renders resolved SteamPipe VDF files into a clean temp output directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "astra-steam-vdf-"));
    try {
      const cfg = resolveSteamConfig({
        STEAM_APP_ID: "123456",
        STEAM_DEPOT_WIN64_ID: "2001",
        STEAM_DEPOT_LINUX64_ID: "2002",
        STEAM_BRANCH: "beta",
        STEAM_DESC: "Supporter Beta",
      });
      const outDir = join(tmp, "vdf");
      const files = renderSteamVdfs(tmp, cfg, outDir);
      const appVdf = readFileSync(files.appBuildPath, "utf8");
      const winVdf = readFileSync(files.depotWin64Path, "utf8");
      const linuxVdf = readFileSync(files.depotLinux64Path, "utf8");

      expect(appVdf).toContain('"AppID" "123456"');
      expect(appVdf).toContain('"SetLive" "beta"');
      expect(appVdf).toContain('"2001"');
      expect(appVdf).toContain('"2002"');
      expect(winVdf).toContain('"DepotID" "2001"');
      expect(winVdf).toContain("win-unpacked");
      expect(linuxVdf).toContain('"DepotID" "2002"');
      expect(linuxVdf).toContain("linux-unpacked");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("builds structured publish plans across steam, itch, and github", () => {
    const steamPlan = buildPublishPlan({
      target: "steam",
      tag: "v0.1.0",
      dryRun: true,
      rootDir: ROOT,
      env: {},
      exists: () => false,
    });
    expect(steamPlan.target).toBe("steam");
    expect(steamPlan.args).toContain("+run_app_build");

    const itchPlan = buildPublishPlan({
      target: "itch",
      tag: "v0.1.0",
      channel: "win64",
      dryRun: true,
      rootDir: ROOT,
      env: {},
    });
    expect(itchPlan.bin).toBe("butler");
    expect(itchPlan.channel).toBe("win64");
    expect(itchPlan.args).toContain("bwiemz/astra-navi-desktop:win64");

    const ghPlan = buildPublishPlan({ target: "github", tag: "v0.1.0", dryRun: true, rootDir: ROOT });
    expect(ghPlan.bin).toBe("gh");
    expect(ghPlan.args).toContain("--draft");

    expect(() => buildPublishPlan({ target: "invalid" })).toThrow(/Unknown publish target/);
  });
});

describe("release asset, legal, community & launch kit completeness", () => {
  it("contains non-empty Windows ICO, extension PNGs, workflows, issue templates, legal docs & launch kit", () => {
    const requiredFiles = [
      "assets/icon.ico",
      "browser-bridge/icons/icon-16.png",
      "browser-bridge/icons/icon-32.png",
      "browser-bridge/icons/icon-48.png",
      "browser-bridge/icons/icon-128.png",
      "browser-bridge/STORE_LISTING.md",
      ".github/workflows/release.yml",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      "PRIVACY.md",
      "CHANGELOG.md",
      "NOTICE.md",
      "store/STEAM_AI_DISCLOSURE.md",
      "store/STORE_COPY.md",
      "store/TRAILER_SCRIPT.md",
      "store/LAUNCH_CHECKLIST.md",
      "scripts/verify-clean-windows.ps1",
    ];
    for (const rel of requiredFiles) {
      const full = join(ROOT, rel);
      expect(existsSync(full), `Missing release file: ${rel}`).toBe(true);
      expect(statSync(full).size, `Empty release file: ${rel}`).toBeGreaterThan(0);
    }

    const notice = readFileSync(join(ROOT, "NOTICE.md"), "utf8");
    expect(notice).not.toContain("voice actresses");
    expect(notice).toContain("OFL-1.1");
    expect(notice).toContain("Apache-2.0");
    expect(notice).toContain("BSD-3-Clause");
    expect(notice).toContain("Qwen3.5 4B / 9B / 72B");

    const privacy = readFileSync(join(ROOT, "PRIVACY.md"), "utf8");
    expect(privacy).toContain("Export Support Bundle (Redacted)");
    expect(privacy).toContain("app.astranavi.dom_bridge");
  });
});
