import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertSupportBundleSafe,
  buildRedactedSupportBundle,
  collectMcpEnvSecrets,
  formatSupportBundleJson,
  redactSupportText,
} from "../src/core/supportBundle.ts";

describe("redacted support bundle", () => {
  it("scrubs tokens, private keys, SSH hosts, emails, query params, and user paths", () => {
    const sample = [
      `Error opening ${homedir()}/.local/share/astra-navi/config.json`,
      "C:\\Users\\Alice\\AppData\\Local\\Temp\\crash.log",
      "Authorization: Bearer super_secret_token_value_123456",
      "braveApiKey=sk-1234567890abcdef1234567890abcdef",
      "GitHub token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 failed",
      "SSH connect admin@192.168.10.42 SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 failed",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyMaterialHereForTest user@example.com",
      "https://search.local/query?api_key=xyz&q=private_query",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nMOCKSECRETKEYDATA\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const { text, count } = redactSupportText(sample, ["nas-box.local", "secret-user"]);
    expect(count).toBeGreaterThan(0);
    expect(text).not.toContain("super_secret_token_value_123456");
    expect(text).not.toContain("sk-1234567890abcdef1234567890abcdef");
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(text).not.toContain("192.168.10.42");
    expect(text).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(text).not.toContain("AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyMaterialHereForTest");
    expect(text).not.toContain("user@example.com");
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("MOCKSECRETKEYDATA");
    expect(text).not.toContain("private_query");
    expect(text).toContain("?[redacted-query]");
    expect(text).toContain("[redacted-private-key]");
  });

  it("drops storage file paths, redacts error buffers, and validates safe JSON output", () => {
    const bundle = buildRedactedSupportBundle({
      appVersion: "0.1.0",
      edition: "community",
      platform: "linux",
      arch: "x64",
      nodeVersion: "24.0.0",
      desktopSessionNotice: "Non-KDE Wayland session detected (GNOME)",
      selfCheck: {
        lines: [
          { system: "Local brain", ok: true, detail: "Qwen 9B at /home/alice/.local/share/model.gguf" },
        ],
        storage: [{ label: "Her records database", path: "/home/alice/.local/share/her.db", bytes: 4096 }],
        freeBytes: 100_000_000,
      },
      recentErrors: [
        "Failed connecting to nas.internal (10.0.0.44) as deploy: Bearer top_secret_bearer_token_999",
      ],
      settingsSummary: {
        brain: "auto",
        language: "en",
        voiceEngine: "light",
        speak: "when-spoken-to",
        handsOff: false,
        lookWithoutAsking: false,
        yieldToGames: true,
        quietInGames: true,
        fittingTools: true,
        keepTraces: false,
        advancedSettings: false,
        stationOpen: false,
        enabledTier10Flags: [],
      },
      extraSecretLiterals: ["nas.internal", "deploy"],
    });

    const json = formatSupportBundleJson(bundle);
    expect(json).not.toContain("alice");
    expect(json).not.toContain("nas.internal");
    expect(json).not.toContain("10.0.0.44");
    expect(json).not.toContain("top_secret_bearer_token_999");
    expect(json).not.toContain("/home/alice/.local/share/her.db");
    expect(bundle.redactionsApplied).toBeGreaterThanOrEqual(4);
    expect(bundle.selfCheck?.storage[0]).toEqual({ label: "Her records database", bytes: 4096 });
  });

  it("sorts secrets longest-first, matches case-insensitively, scrubs short/numeric secrets & 4-digit MCP PINs, and skips non-secret MCP env keys", () => {
    const sample =
      "More information available (debug=true on localhost:11434) at gymnasium for administrator; " +
      "connect to nas.tail1234.ts.net, NAS, pve.home.arpa, PVE, user admin, user kenji, " +
      "pin 84726193, mcp pin 4829, and token ha-secret-token-7788.";
    // Deliberately pass short secrets BEFORE longer hostnames to verify longest-first sorting!
    const mcpEnv = collectMcpEnvSecrets([
      {
        headers: { Authorization: "ha-secret-token-7788" },
        env: { PORT: "11434", LOG_LEVEL: "info", DEBUG: "true", PIN: "4829" },
      },
    ]);
    expect(mcpEnv).not.toContain("11434");
    expect(mcpEnv).toContain("4829");
    expect(mcpEnv).toContain("ha-secret-token-7788");

    const scrubbed = redactSupportText(
      sample,
      ["nas", "nas.tail1234.ts.net", "pve", "pve.home.arpa", "admin", "kenji", "84726193"],
      ["info", "true", "debug", "localhost", ...mcpEnv],
    );
    expect(scrubbed.text).toContain("More information available");
    expect(scrubbed.text).toContain("debug=true");
    expect(scrubbed.text).toContain("localhost:11434");
    expect(scrubbed.text).toContain("gymnasium");
    expect(scrubbed.text).toContain("administrator");
    expect(scrubbed.text).not.toContain("tail1234.ts.net");
    expect(scrubbed.text).not.toContain("home.arpa");
    expect(scrubbed.text).not.toMatch(/\bnas\b/i);
    expect(scrubbed.text).not.toMatch(/\bpve\b/i);
    expect(scrubbed.text).not.toMatch(/\badmin\b/i);
    expect(scrubbed.text).not.toContain("kenji");
    expect(scrubbed.text).not.toContain("84726193");
    expect(scrubbed.text).not.toContain("4829");
    expect(scrubbed.text).not.toContain("ha-secret-token-7788");
  });

  it("rejects forbidden private fields or unredacted keys if ever injected", () => {
    expect(() =>
      assertSupportBundleSafe(JSON.stringify({ conversations: ["secret user chat"] })),
    ).toThrow(/forbidden field "conversations"/);
    expect(() =>
      assertSupportBundleSafe(JSON.stringify({ err: "ghp_123456789012345678901234" })),
    ).toThrow(/unredacted API token/);
  });
});
