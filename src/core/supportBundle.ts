import { homedir } from "node:os";
import type { BootstrapStatusView, HardwareRecommendationView } from "../shared/settings.ts";
import type { SelfCheckResult } from "./selfCheck.ts";
import { withoutSecrets } from "./secrets.ts";

export interface SupportBundleInput {
  appVersion: string;
  edition: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion?: string;
  desktopSessionNotice?: string | null;
  selfCheck?: SelfCheckResult | null;
  hardware?: HardwareRecommendationView | null;
  bootstrapStatus?: BootstrapStatusView | null;
  recentErrors?: readonly string[];
  settingsSummary?: {
    brain: string;
    language: string;
    voiceEngine: string;
    speak: string;
    handsOff: boolean;
    lookWithoutAsking: boolean;
    yieldToGames: boolean;
    quietInGames: boolean;
    fittingTools: boolean;
    keepTraces: boolean;
    advancedSettings: boolean;
    stationOpen: boolean;
    enabledTier10Flags: readonly string[];
  };
  /** Strict secrets (API keys, hostnames, usernames, machine names): redacted whole-token even if short or numeric. */
  extraSecretLiterals?: readonly string[];
  /** MCP server env/header values: skips benign config literals (`true`, `info`, `debug`, etc.) while still redacting secrets. */
  mcpEnvLiterals?: readonly string[];
}

export interface RedactedSupportBundle {
  schemaVersion: 1;
  generatedAt: string;
  privacyNotice: string;
  app: {
    version: string;
    edition: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    electronVersion: string | null;
  };
  desktopSession: {
    notice: string | null;
  };
  hardware: HardwareRecommendationView | null;
  bootstrapStatus: BootstrapStatusView | null;
  selfCheck: {
    lines: { system: string; ok: boolean; detail: string }[];
    storage: { label: string; bytes: number; inUse?: boolean; spare?: boolean }[];
    freeBytes: number | null;
  } | null;
  settingsSummary: SupportBundleInput["settingsSummary"] | null;
  recentErrors: string[];
  redactionsApplied: number;
}

const FORBIDDEN_BUNDLE_FIELDS = [
  "conversations",
  "conversationHistory",
  "pastExchanges",
  "memory",
  "journal",
  "transcripts",
  "braveApiKey",
  "searxngUrl",
  "sshHost",
  "privateKey",
  "stationAccount",
  "password",
] as const;

const COMMON_NON_SECRET_LITERALS = new Set([
  "true",
  "false",
  "null",
  "none",
  "info",
  "debug",
  "warn",
  "warning",
  "error",
  "trace",
  "fatal",
  "verbose",
  "silent",
  "localhost",
  "default",
  "development",
  "production",
  "staging",
  "testing",
  "local",
  "public",
  "private",
  "enabled",
  "disabled",
  "utf8",
  "utf-8",
  "ascii",
  "json",
  "text",
  "plain",
  "http",
  "https",
  "stdio",
  "status",
  "server",
  "client",
  "system",
]);

const NON_SECRET_MCP_ENV_KEYS = new Set([
  "PORT",
  "HOST",
  "HOSTNAME",
  "TZ",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "LOG_LEVEL",
  "DEBUG",
  "VERBOSE",
  "TIMEOUT",
  "RETRIES",
  "MAX_RETRIES",
  "WORKERS",
]);

/** Collects MCP server header and env values worth redacting, skipping benign non-secret env keys like `PORT` or `LOG_LEVEL`. */
export function collectMcpEnvSecrets(
  servers: readonly { headers?: Record<string, string>; env?: Record<string, string> }[],
): string[] {
  const out: string[] = [];
  for (const server of servers) {
    for (const val of Object.values(server.headers ?? {})) {
      if (typeof val === "string" && val.trim().length > 0) out.push(val);
    }
    for (const [key, val] of Object.entries(server.env ?? {})) {
      if (NON_SECRET_MCP_ENV_KEYS.has(key.trim().toUpperCase())) continue;
      if (typeof val === "string" && val.trim().length > 0) out.push(val);
    }
  }
  return out;
}

function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldRedactMcpEnvLiteral(secret: string): boolean {
  if (secret.length < 2) return false;
  if (COMMON_NON_SECRET_LITERALS.has(secret.toLowerCase())) return false;
  return true;
}

/**
 * Scrubs API keys, tokens, URLs with embedded credentials/queries, private keys,
 * SSH public/host fingerprints, email addresses, IP addresses, OS user paths,
 * strict secrets (hostnames, usernames, machine names — even short or numeric),
 * and MCP env/header values (excluding common benign config words like `true`/`info`).
 *
 * All candidate literals are sorted longest-first and matched case-insensitively so
 * short names (`nas`, `pve`) NEVER partially rewrite longer hostnames (`nas.tail1234.ts.net`,
 * `pve.home.arpa`) and uppercase variants (`NAS`) cannot leak through.
 */
export function redactSupportText(
  text: string,
  extraSecrets: readonly string[] = [],
  mcpEnvSecrets: readonly string[] = [],
): { text: string; count: number } {
  let out = withoutSecrets(text);
  let count = out === text ? 0 : 1;

  const replaceCount = (pattern: RegExp, replacement: string): void => {
    const next = out.replace(pattern, replacement);
    if (next !== out) {
      count += 1;
      out = next;
    }
  };

  // Deduplicate case-insensitively and sort LONGEST FIRST so `nas.tail1234.ts.net` is always
  // scrubbed before `nas`, preventing `[redacted].tail1234.ts.net` leaks.
  const seenLower = new Set<string>();
  const orderedLiterals: string[] = [];
  for (const rawSecret of extraSecrets) {
    const secret = rawSecret.trim();
    if (secret.length < 2) continue;
    const lower = secret.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    orderedLiterals.push(secret);
  }
  for (const rawEnv of mcpEnvSecrets) {
    const secret = rawEnv.trim();
    if (!shouldRedactMcpEnvLiteral(secret)) continue;
    const lower = secret.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    orderedLiterals.push(secret);
  }
  orderedLiterals.sort((a, b) => b.length - a.length);

  for (const secret of orderedLiterals) {
    // Alphanumeric tokens < 16 chars use whole-token boundaries so short hostnames/usernames
    // ("pve", "nas", "admin", "kenji", "84726193") are ALWAYS scrubbed case-insensitively
    // without mangling unrelated English words ("gymnasium", "administrator", "information").
    if (secret.length < 16 && /^[A-Za-z0-9_]+$/.test(secret)) {
      replaceCount(
        new RegExp(`(?<![A-Za-z0-9_])${escapeRegexLiteral(secret)}(?![A-Za-z0-9_])`, "gi"),
        "[redacted]",
      );
    } else {
      replaceCount(new RegExp(escapeRegexLiteral(secret), "gi"), "[redacted]");
    }
  }

  const currentHome = homedir();
  if (currentHome && currentHome.length > 1 && out.includes(currentHome)) {
    out = out.split(currentHome).join("~");
    count += 1;
  }

  // PEM private key blocks and OpenSSH public keys / host fingerprints
  replaceCount(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[redacted-private-key]",
  );
  replaceCount(/ssh-(?:ed25519|rsa|ecdsa)\s+[A-Za-z0-9+/=]{16,}(?:\s+\S+)?/g, "[redacted-ssh-key]");
  replaceCount(/SHA256:[A-Za-z0-9+/=]{16,}/g, "SHA256:[redacted]");

  // Windows and POSIX user profile paths
  replaceCount(/[A-Za-z]:\\Users\\[^\\\s"':]+/gi, "C:\\Users\\[user]");
  replaceCount(/[A-Za-z]:\/Users\/[^/\s"':]+/gi, "C:/Users/[user]");
  replaceCount(/\/home\/[^/\s"':]+/g, "/home/[user]");
  replaceCount(/\/Users\/[^/\s"':]+/g, "/Users/[user]");

  // user@host / emails
  replaceCount(/\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, "[redacted-email]");
  replaceCount(
    /\b[A-Za-z0-9._-]+@(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    "[redacted-ssh-target]",
  );

  // Query parameters on HTTP(S) URLs
  replaceCount(/(https?:\/\/[^\s"'?#]+)\?[^\s"'#]+/gi, "$1?[redacted-query]");

  // IPv4 addresses (avoid matching leading-v version strings like v1.2.3.4)
  replaceCount(
    /(?<![vV.\d])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![.\d])/g,
    "[redacted-ip]",
  );

  return { text: out, count };
}

export function buildRedactedSupportBundle(input: SupportBundleInput): RedactedSupportBundle {
  let redactionsApplied = 0;
  const scrub = (value: string): string => {
    const res = redactSupportText(value, input.extraSecretLiterals, input.mcpEnvLiterals);
    redactionsApplied += res.count;
    return res.text;
  };

  const scrubBootstrap = (
    status: BootstrapStatusView | null | undefined,
  ): BootstrapStatusView | null => {
    if (!status) return null;
    return {
      voice: { ready: status.voice.ready, detail: scrub(status.voice.detail) },
      ocr: { ready: status.ocr.ready, detail: scrub(status.ocr.detail) },
      launcher: { ready: status.launcher.ready, detail: scrub(status.launcher.detail) },
      browserBridge: {
        ready: status.browserBridge.ready,
        detail: scrub(status.browserBridge.detail),
      },
    };
  };

  const hardware = input.hardware
    ? {
        ...input.hardware,
        gpuName: input.hardware.gpuName ? scrub(input.hardware.gpuName) : null,
        reason: scrub(input.hardware.reason),
      }
    : null;

  const selfCheck = input.selfCheck
    ? {
        lines: input.selfCheck.lines.map((line) => ({
          system: scrub(line.system),
          ok: line.ok,
          detail: scrub(line.detail),
        })),
        // Intentionally drop absolute `path` strings from storage items to avoid leaking host paths.
        storage: input.selfCheck.storage.map((item) => ({
          label: scrub(item.label),
          bytes: item.bytes,
          ...(item.inUse !== undefined ? { inUse: item.inUse } : {}),
          ...(item.spare !== undefined ? { spare: item.spare } : {}),
        })),
        freeBytes: input.selfCheck.freeBytes,
      }
    : null;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    privacyNotice:
      "Redacted local diagnostics bundle. Excludes conversation history, long-term memory, SSH hostnames/IPs, API keys, and user home directories.",
    app: {
      version: input.appVersion,
      edition: input.edition,
      platform: input.platform,
      arch: input.arch,
      nodeVersion: input.nodeVersion,
      electronVersion: input.electronVersion ?? null,
    },
    desktopSession: {
      notice: input.desktopSessionNotice ? scrub(input.desktopSessionNotice) : null,
    },
    hardware,
    bootstrapStatus: scrubBootstrap(input.bootstrapStatus),
    selfCheck,
    settingsSummary: input.settingsSummary
      ? {
          ...input.settingsSummary,
          brain: scrub(
            /^[A-Za-z]:[\\/]|^\/|^\\\\|\\|\.gguf$/i.test(input.settingsSummary.brain)
              ? (input.settingsSummary.brain.split(/[\\/]+/).filter(Boolean).pop() ?? "custom.gguf")
              : input.settingsSummary.brain,
          ),
        }
      : null,
    recentErrors: (input.recentErrors ?? []).slice(-30).map((err) => scrub(err)),
    redactionsApplied,
  };
}

/** Verifies serialized bundle JSON contains no forbidden private fields or raw secret patterns. */
export function assertSupportBundleSafe(jsonText: string): void {
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_BUNDLE_FIELDS) {
    if (forbidden in parsed) {
      throw new Error(`Unsafe support bundle: forbidden field "${forbidden}" present.`);
    }
  }
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(jsonText)) {
    throw new Error("Unsafe support bundle: private key material detected.");
  }
  if (/\b(?:sk|pk|ghp|gho|github_pat|xox[abp]|hf)[-_][A-Za-z0-9_-]{16,}\b/.test(jsonText)) {
    throw new Error("Unsafe support bundle: unredacted API token detected.");
  }
}

export function formatSupportBundleJson(bundle: RedactedSupportBundle): string {
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  assertSupportBundleSafe(json);
  return json;
}
