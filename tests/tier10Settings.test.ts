import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import { SettingsPatchSchema } from "../src/main/settingsSchema.ts";
import { TIER10_KEYS } from "../src/shared/settings.ts";

const ROOT = join(import.meta.dirname, "..");

describe("Tier 10 Settings Schema, Config Synchronization & UI Integration", () => {
  it("keeps all 21 Tier 10 switches default-off and synchronized across config, schema, and shared settings", async () => {
    const cfg = new ConfigStore(join(tmpdir(), "ai-chan-nonexistent-t10-settings.json")).value;
    expect(cfg.characterBundle).toBeNull();

    const configKeys = Object.keys(cfg.tier10).sort();
    const sharedKeys = [...TIER10_KEYS].sort();
    expect(configKeys).toEqual(sharedKeys);
    expect(TIER10_KEYS).toHaveLength(21);

    for (const key of TIER10_KEYS) {
      expect(cfg.tier10[key]).toBe(false);
    }

    const okPatch = SettingsPatchSchema.safeParse({
      tier10: { selfDistillation: true, stationFederation: true },
    });
    expect(okPatch.success).toBe(true);

    const unknownTier10Key = SettingsPatchSchema.safeParse({
      tier10: { imaginarySwitch: true },
    });
    expect(unknownTier10Key.success).toBe(false);

    const [html, uiScript, ipcScript] = await Promise.all([
      readFile(join(ROOT, "src/renderer/settings.html"), "utf8"),
      readFile(join(ROOT, "src/renderer/src/settings.ts"), "utf8"),
      readFile(join(ROOT, "src/main/settingsIpc.ts"), "utf8"),
    ]);
    expect(html).toContain('id="tier10-toggles"');
    expect(uiScript).toContain("TIER10_KEYS");
    expect(uiScript).not.toContain("innerHTML");
    expect(ipcScript).toContain("tier10: { ...config.value.tier10 }");
  });
});
