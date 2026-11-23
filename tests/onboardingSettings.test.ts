import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import { SettingsPatchSchema } from "../src/main/settingsSchema.ts";

const ROOT = join(import.meta.dirname, "..");

describe("Onboarding Wizard & Simple/Advanced Settings", () => {
  it("defaults onboardingComplete and advancedSettings to false and accepts patches", async () => {
    const cfg = new ConfigStore(join(tmpdir(), "astranavi-nonexistent-onboarding.json")).value;
    expect(cfg.onboardingComplete).toBe(false);
    expect(cfg.advancedSettings).toBe(false);

    expect(
      SettingsPatchSchema.safeParse({ onboardingComplete: true, advancedSettings: true }).success,
    ).toBe(true);
    expect(
      SettingsPatchSchema.safeParse({ onboardingComplete: "yes" }).success,
    ).toBe(false);

    const [html, css, uiScript, ipcScript, preloadScript] = await Promise.all([
      readFile(join(ROOT, "src/renderer/settings.html"), "utf8"),
      readFile(join(ROOT, "src/renderer/src/settings.css"), "utf8"),
      readFile(join(ROOT, "src/renderer/src/settings.ts"), "utf8"),
      readFile(join(ROOT, "src/main/settingsIpc.ts"), "utf8"),
      readFile(join(ROOT, "src/preload/settings.ts"), "utf8"),
    ]);
    expect(html).toContain('id="onboarding-wizard"');
    expect(html).toContain('id="advancedSettings"');
    expect(html).toContain("advanced-only");
    expect(css).toContain('body[data-advanced="false"] .advanced-only');
    expect(uiScript).not.toContain("innerHTML");
    expect(ipcScript).toContain("settings:hardware-profile");
    expect(ipcScript).toContain("settings:preview-voice");
    expect(ipcScript).toContain("settings:run-bootstrap");
    expect(ipcScript).toContain("settings:run-policy-audit");
    expect(preloadScript).toContain("previewVoice");
  });
});
