import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertSupportBundleSafe,
  buildRedactedSupportBundle,
  collectMcpEnvSecrets,
  collectMcpRedactionLists,
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

  it("runs structural scrubbers before literals (no /home/alice or email leaks), redacts MCP HOST/HOSTNAME & IPv6, and skips benign config patterns & dictionary words", () => {
    const sample =
      "Path /home/alice/.config and /home/will/.bashrc; email Kenji@Example.com and will@example.com; " +
      "I will check at home around 10:30:00 (debug=true on localhost:11434 and ::1); " +
      "IPv6 2001:db8:85a3::8a2e:370:7334 and fe80::1ff:fe23:4567:890a%eth0; " +
      "More information available at gymnasium for administrator; " +
      "connect to nas.tail1234.ts.net, NAS, pve.home.arpa, PVE, homeassistant.tail9f3k.ts.net, kenjis-nas, " +
      "user admin, user kenji, pin 84726193, mcp pin 4829, and token ha-secret-token-7788.";

    const mcpLists = collectMcpRedactionLists([
      {
        headers: { Authorization: "ha-secret-token-7788" },
        env: {
          HOST: "homeassistant.tail9f3k.ts.net",
          HOSTNAME: "kenjis-nas",
          HTTP_PORT: "11434",
          REQUEST_TIMEOUT: "30",
          TIMEOUT_MS: "5000",
          MAX_CONNECTIONS: "10",
          RATE_LIMIT: "30",
          LOG_LEVEL: "info",
          DEBUG: "true",
          PIN: "4829",
        },
      },
    ]);
    expect(mcpLists.identifiers).toContain("homeassistant.tail9f3k.ts.net");
    expect(mcpLists.identifiers).toContain("kenjis-nas");
    expect(mcpLists.credentials).toContain("4829");
    expect(mcpLists.credentials).toContain("ha-secret-token-7788");
    expect([...mcpLists.credentials, ...mcpLists.identifiers]).not.toContain("30");
    expect([...mcpLists.credentials, ...mcpLists.identifiers]).not.toContain("10");
    expect([...mcpLists.credentials, ...mcpLists.identifiers]).not.toContain("11434");
    expect(collectMcpEnvSecrets([{ env: { HOST: "my.box.ts.net", MAX_RETRIES: "30" } }])).toEqual([
      "my.box.ts.net",
    ]);

    // Deliberately pass machine "Home", user "Will", and short "nas"/"pve" BEFORE longer hostnames!
    const scrubbed = redactSupportText(
      sample,
      [
        "Home",
        "Will",
        "nas",
        "nas.tail1234.ts.net",
        "pve",
        "pve.home.arpa",
        "admin",
        "kenji",
        "84726193",
        ...mcpLists.identifiers,
      ],
      ["info", "true", "debug", "localhost", ...mcpLists.credentials],
    );
    // Structural scrubbers ran FIRST: zero username/email leaks!
    expect(scrubbed.text).toContain("/home/[user]/.config");
    expect(scrubbed.text).toContain("/home/[user]/.bashrc");
    expect(scrubbed.text).not.toContain("alice");
    expect(scrubbed.text).not.toContain("Example.com");
    expect(scrubbed.text).not.toContain("example.com");
    expect(scrubbed.text).toContain("[redacted-email]");
    // IPv6 scrubbed while loopback ::1 and timestamps 10:30:00 stay intact!
    expect(scrubbed.text).not.toContain("2001:db8");
    expect(scrubbed.text).not.toContain("fe80::1ff");
    expect(scrubbed.text).toContain("::1");
    expect(scrubbed.text).toContain("10:30:00");
    // Dictionary words ("will", "home") and normal prose untouched!
    expect(scrubbed.text).toContain("I will check at home");
    expect(scrubbed.text).toContain("More information available");
    expect(scrubbed.text).toContain("debug=true");
    expect(scrubbed.text).toContain("localhost:11434");
    expect(scrubbed.text).toContain("gymnasium");
    expect(scrubbed.text).toContain("administrator");
    // All real secrets, hostnames, and MCP HOST/HOSTNAME values completely scrubbed!
    expect(scrubbed.text).not.toContain("tail1234.ts.net");
    expect(scrubbed.text).not.toContain("tail9f3k.ts.net");
    expect(scrubbed.text).not.toContain("kenjis-nas");
    expect(scrubbed.text).not.toContain("home.arpa");
    expect(scrubbed.text).not.toMatch(/\bnas\b/i);
    expect(scrubbed.text).not.toMatch(/\bpve\b/i);
    expect(scrubbed.text).not.toMatch(/\badmin\b/i);
    expect(scrubbed.text).not.toContain("kenji");
    expect(scrubbed.text).not.toContain("84726193");
    expect(scrubbed.text).not.toContain("4829");
    expect(scrubbed.text).not.toContain("ha-secret-token-7788");
  });

  it("passes the full Round 7 redaction behaviour table (dictionary contexts, net.isIPv6 crash safety, unlisted env keys)", () => {
    const mcpLists = collectMcpRedactionLists([
      {
        env: {
          REGION: "us",
          CUSTOM_SHORT: "us",
          HOST: "home",
          API_PIN: "4829",
        },
      },
    ]);
    expect(mcpLists.credentials).toEqual(["4829"]);
    expect(mcpLists.identifiers).toEqual(["home"]);

    const ids = ["home", "Mark", "Will", "nas", "nas.tail1234.ts.net", "admin", "kenji"];
    const creds = [...mcpLists.credentials];

    // Behaviour table: every must-redact and must-preserve case checked in full.
    const table: {
      name: string;
      input: string;
      mustContain?: readonly string[];
      mustNotContain?: readonly string[];
      exact?: string;
    }[] = [
      {
        name: "dictionary-word identifier in host/machine context",
        input: "connect to host home port 22 refused; machine Mark offline",
        exact: "connect to host [redacted] port 22 refused; machine [redacted] offline",
      },
      {
        name: "dictionary-word identifier in ssh/port/url/@/hostname contexts",
        input: "ssh home; home:22; http://home/api; will@box; home.lan",
        exact: "ssh [redacted]; [redacted]:22; http://[redacted]/api; [redacted]@box; [redacted].lan",
      },
      {
        name: "dictionary-word prose stays untouched",
        input: "I will check at home and mark it done",
        exact: "I will check at home and mark it done",
      },
      {
        name: "unlisted/REGION=us env value never redacts Contact us",
        input: "Contact us for support",
        exact: "Contact us for support",
      },
      {
        name: "C++/Vulkan/Node double-colon crash symbols stay untouched (net.isIPv6)",
        input: "Fatal: std::bad_alloc in vk::Device::Create via node::Start",
        exact: "Fatal: std::bad_alloc in vk::Device::Create via node::Start",
      },
      {
        name: "real IPv6 addresses (including IPv4-mapped & zoned) are scrubbed",
        input: "peers 2001:db8::1, fe80::1a2b:3c4d%eth0, ::ffff:192.168.1.5",
        exact: "peers [redacted-ip], [redacted-ip], [redacted-ip]",
      },
      {
        name: "loopback ::1, timestamps, and MAC addresses stay untouched",
        input: "loopback ::1 at 10:30:00 mac AA:BB:CC:DD:EE:FF",
        exact: "loopback ::1 at 10:30:00 mac AA:BB:CC:DD:EE:FF",
      },
      {
        name: "POSIX path and email scrubbed before literal identifiers",
        input: "/home/alice/.config and Kenji@Example.com",
        exact: "/home/[user]/.config and [redacted-email]",
      },
      {
        name: "longest-first FQDN + case-insensitive short hostname + PIN",
        input: "nas.tail1234.ts.net and NAS with pin 4829",
        exact: "[redacted] and [redacted] with pin [redacted]",
      },
    ];

    for (const row of table) {
      const actual = redactSupportText(row.input, ids, creds).text;
      if (row.exact !== undefined) {
        expect(actual, row.name).toBe(row.exact);
      }
      for (const s of row.mustContain ?? []) expect(actual, row.name).toContain(s);
      for (const s of row.mustNotContain ?? []) expect(actual, row.name).not.toContain(s);
    }
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
