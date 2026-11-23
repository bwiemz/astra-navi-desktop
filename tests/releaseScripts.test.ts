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
  });
});
