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
  /** Strict credentials (API keys, tokens, passwords, PINs): redacted at any length (>= 2), never exempted by dictionary words. */
  credentialLiterals?: readonly string[];
  /** Identifiers (hostnames, usernames, machine names, MCP HOST*): whole-token case-insensitive, skipping common dictionary words left to structural scrubbers. */
  extraSecretLiterals?: readonly string[];
  /** Legacy MCP env/header values (treated as credentials excluding obvious boolean/log-level values). */
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

/**
 * Common English dictionary words that may appear as machine nicknames or first names
 * ("Home", "Will", "May", "Work", "Main") — left to the structural path/email/IP/URL
 * pass in Pass 1 so prose ("I will check", "at home") and paths aren't mangled.
 * Never includes short host/user identifiers like `admin`, `nas`, `pve`, or `kenji`.
 */
const COMMON_IDENTIFIER_DICTIONARY_WORDS = new Set([
  ...COMMON_NON_SECRET_LITERALS,
  "home",
  "will",
  "may",
  "mark",
  "grace",
  "hope",
  "bill",
  "grant",
  "chase",
  "work",
  "office",
  "desk",
  "main",
  "play",
  "game",
  "media",
  "host",
  "user",
  "test",
  "dev",
  "prod",
]);

/** Non-secret MCP config env key patterns (ports, timeouts, limits, retries, locale/logging) — NEVER skips HOST/HOSTNAME! */
const NON_SECRET_MCP_ENV_KEY_RE =
  /^(?:PORT|.*_PORT|.*TIMEOUT.*|.*_MS|.*_SEC|.*_SECONDS|MAX_.*|MIN_.*|.*_LIMIT|.*LIMIT|RETRIES|.*_RETRIES|WORKERS|.*_WORKERS|CONCURRENCY|TZ|LANG|LC_ALL|NODE_ENV|LOG_LEVEL|DEBUG|VERBOSE|COLOR|NO_COLOR|TERM|CI)$/i;

/** MCP env keys that hold host/user/endpoint identifiers (including HOST and HOSTNAME). */
const IDENTIFIER_MCP_ENV_KEY_RE =
  /(?:^|_)(?:HOST|HOSTNAME|SERVER|DOMAIN|USER|USERNAME|EMAIL|URL|URI|ENDPOINT)$/i;

/**
 * Separates MCP server headers and environment variables into `credentials` (headers, tokens,
 * passwords, PINs) and `identifiers` (HOST, HOSTNAME, *_HOST, *_USER, *_URL), while skipping
 * benign numeric/config env keys by key pattern (`*_PORT`, `*TIMEOUT*`, `*_MS`, `MAX_*`, `*LIMIT*`).
 */
export function collectMcpRedactionLists(
  servers: readonly { headers?: Record<string, string>; env?: Record<string, string> }[],
): { credentials: string[]; identifiers: string[] } {
  const credentials: string[] = [];
  const identifiers: string[] = [];
  for (const server of servers) {
    for (const val of Object.values(server.headers ?? {})) {
      if (typeof val === "string" && val.trim().length > 0) credentials.push(val);
    }
    for (const [rawKey, val] of Object.entries(server.env ?? {})) {
      if (typeof val !== "string" || val.trim().length === 0) continue;
      const key = rawKey.trim();
      if (NON_SECRET_MCP_ENV_KEY_RE.test(key)) continue;
      if (IDENTIFIER_MCP_ENV_KEY_RE.test(key)) {
        identifiers.push(val);
      } else {
        credentials.push(val);
      }
    }
  }
  return { credentials, identifiers };
}

/** Backwards-compatible wrapper returning all MCP secrets (credentials + host/user identifiers) except non-secret config keys. */
export function collectMcpEnvSecrets(
  servers: readonly { headers?: Record<string, string>; env?: Record<string, string> }[],
): string[] {
  const { credentials, identifiers } = collectMcpRedactionLists(servers);
  return [...credentials, ...identifiers];
}

function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldRedactCredentialLiteral(secret: string): boolean {
  if (secret.length < 2) return false;
  if (COMMON_NON_SECRET_LITERALS.has(secret.toLowerCase())) return false;
  return true;
}

function shouldRedactIdentifierLiteral(secret: string): boolean {
  if (secret.length < 2) return false;
  if (COMMON_IDENTIFIER_DICTIONARY_WORDS.has(secret.toLowerCase())) return false;
  return true;
}

/**
 * Redacts text in three strictly separated passes by type:
 * 1. **Structural scrubbers FIRST:** API token shapes, private/SSH keys, OS user paths
 *    (`/home/<user>`, `/Users/<user>`, `C:\Users\<user>`), emails, URLs with credentials/queries,
 *    IPv4, and IPv6 addresses — so literal names like `"Home"` or `"kenji"` can NEVER break path
 *    or email scrubbers.
 * 2. **Credentials ALWAYS (any length >= 2, longest-first, case-insensitive):** API keys, tokens,
 *    passwords, PINs (including 4-digit MCP PINs).
 * 3. **Identifiers (longest-first, case-insensitive, whole-token for `< 16`-char alphanumerics):**
 *    hostnames (`nas.tail1234.ts.net`, `homeassistant.tail9f3k.ts.net`, `pve.home.arpa`),
 *    usernames (`admin`, `kenji`), machine names (`nas`, `pve`, `kenjis-nas`), skipping common
 *    English dictionary words (`home`, `will`, `may`) that are already covered structurally.
 */
export function redactSupportText(
  text: string,
  identifierSecrets: readonly string[] = [],
  credentialSecrets: readonly string[] = [],
): { text: string; count: number } {
  let out = withoutSecrets(text);
  let count = out === text ? 0 : 1;

  const replaceCount = (pattern: RegExp, replacement: string | ((m: string, ...args: string[]) => string)): void => {
    const next =
      typeof replacement === "string"
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
    if (next !== out) {
      count += 1;
      out = next;
    }
  };

  // --- Pass 1: Structural scrubbers FIRST (paths, keys, emails, URLs, IPv4, IPv6) ---
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

  // Windows and POSIX user profile paths (MUST run before literal pass so machine "Home" never breaks `/home/alice`)
  replaceCount(/[A-Za-z]:\\Users\\[^\\\s"':]+/gi, "C:\\Users\\[user]");
  replaceCount(/[A-Za-z]:\/Users\/[^/\s"':]+/gi, "C:/Users/[user]");
  replaceCount(/\/home\/[^/\s"':]+/g, "/home/[user]");
  replaceCount(/\/Users\/[^/\s"':]+/g, "/Users/[user]");

  // user@host / emails (MUST run before literal pass so "kenji" never leaves `[redacted]@Example.com`)
  replaceCount(/\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, "[redacted-email]");
  replaceCount(
    /\b[A-Za-z0-9._-]+@(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    "[redacted-ssh-target]",
  );

  // Embedded credentials and query parameters on HTTP(S) URLs
  replaceCount(/(https?:\/\/)[^/\s@"'#?]+@/gi, "$1[redacted]@");
  replaceCount(/(https?:\/\/[^\s"'?#]+)\?[^\s"'#]+/gi, "$1?[redacted-query]");

  // IPv4 addresses (avoid matching leading-v version strings like v1.2.3.4)
  replaceCount(
    /(?<![vV.\d])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![.\d])/g,
    "[redacted-ip]",
  );

  // IPv6 addresses (full 8-group or `::`-compressed, preserving bare `::` and loopback `::1`, never matching `10:30:00`)
  replaceCount(
    /(?<![0-9a-fA-F:])(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?|:(?::[0-9a-fA-F]{1,4}){1,7}|::ffff:(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))(?:%[A-Za-z0-9_.-]+)?(?![0-9a-fA-F:])/g,
    (match) => {
      const lower = match.toLowerCase();
      if (lower === "::" || lower === "::1") return match;
      return "[redacted-ip]";
    },
  );

  // --- Helper for longest-first case-insensitive literal redaction ---
  const scrubLiteralList = (rawList: readonly string[], predicate: (s: string) => boolean): void => {
    const seenLower = new Set<string>();
    const ordered: string[] = [];
    for (const raw of rawList) {
      const secret = raw.trim();
      if (!predicate(secret)) continue;
      const lower = secret.toLowerCase();
      if (seenLower.has(lower)) continue;
      seenLower.add(lower);
      ordered.push(secret);
    }
    ordered.sort((a, b) => b.length - a.length);

    for (const secret of ordered) {
      if (secret.length < 16 && /^[A-Za-z0-9_]+$/.test(secret)) {
        replaceCount(
          new RegExp(`(?<![A-Za-z0-9_])${escapeRegexLiteral(secret)}(?![A-Za-z0-9_])`, "gi"),
          "[redacted]",
        );
      } else {
        replaceCount(new RegExp(escapeRegexLiteral(secret), "gi"), "[redacted]");
      }
    }
  };

  // --- Pass 2: Credentials ALWAYS (longest-first, case-insensitive) ---
  scrubLiteralList(credentialSecrets, shouldRedactCredentialLiteral);

  // --- Pass 3: Identifiers (longest-first, case-insensitive, skipping dictionary words) ---
  scrubLiteralList(identifierSecrets, shouldRedactIdentifierLiteral);

  return { text: out, count };
}

export function buildRedactedSupportBundle(input: SupportBundleInput): RedactedSupportBundle {
  let redactionsApplied = 0;
  const credentials = [
    ...(input.credentialLiterals ?? []),
    ...(input.mcpEnvLiterals ?? []),
  ];
  const identifiers = input.extraSecretLiterals ?? [];
  const scrub = (value: string): string => {
    const res = redactSupportText(value, identifiers, credentials);
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
