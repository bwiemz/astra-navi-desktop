import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

describe("release asset, legal, community & workflow completeness", () => {
  it("contains non-empty Windows ICO, extension PNGs, workflows, issue templates, legal docs & asset license", () => {
    const requiredFiles = [
      "assets/icon.ico",
      "assets/models/ai-navigator/LICENSE.txt",
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

    const releaseYml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(releaseYml).toContain("bwiemz/astra-navi-supporter");
    expect(releaseYml).toContain("SUPPORTER_OVERLAY_TOKEN");
    expect(releaseYml).toContain("id-token: write");
    expect(releaseYml).toContain("signing_mode");
    expect(releaseYml).toContain("--stage unpacked");
    expect(releaseYml).toContain("--stage installers");
    expect(releaseYml).toContain("-VerifyOnly");

    const androidManifest = readFileSync(join(ROOT, "phone-app", "AndroidManifest.xml"), "utf8");
    expect(androidManifest).toContain("android.permission.ACCESS_NETWORK_STATE");

    const extManifest = JSON.parse(readFileSync(join(ROOT, "browser-bridge", "manifest.json"), "utf8")) as {
      browser_specific_settings?: {
        gecko?: { data_collection_permissions?: { required?: string[] } };
      };
    };
    expect(extManifest.browser_specific_settings?.gecko?.data_collection_permissions?.required).toContain("none");

    const signPs1 = readFileSync(join(ROOT, "scripts", "sign-windows.ps1"), "utf8");
    expect(signPs1).toContain("Get-AuthenticodeSignature");
    expect(signPs1).toContain("TimeStamperCertificate");
    expect(signPs1).toContain("AZURE_CODE_SIGNING_CERT_PROFILE_PRIVATE");
    expect(signPs1).toContain("AssertNoThirdPartyResignDir");
    expect(signPs1).toContain("RequireAllTargets");

    const builderYml = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
    expect(builderYml).not.toContain("!win-hands-native/bin/**/!(win-hands.exe)");

    expect(releaseYml).toContain("-RequireAllTargets");
    expect(releaseYml).toContain("isTrustedReleaseRef");
    expect(releaseYml).toContain("refs/heads/main");
    expect(releaseYml).toContain("refs/tags/v*");
    expect(releaseYml).toContain(
      "dist\\win-unpacked\\resources\\hands\\win-hands-native\\bin\\Release\\net9.0\\win-x64\\publish\\win-hands.exe",
    );

    const extBackground = readFileSync(join(ROOT, "browser-bridge", "background.js"), "utf8");
    expect(extBackground).toContain("tab.incognito");

    const pkgExtScript = readFileSync(join(ROOT, "scripts", "package-extension.ts"), "utf8");
    expect(pkgExtScript).toContain('delete chromiumManifest["browser_specific_settings"]');
    expect(pkgExtScript).toContain('background: { service_worker: "background.js" }');
    expect(pkgExtScript).toContain('background: { scripts: ["background.js"] }');
  });
});
