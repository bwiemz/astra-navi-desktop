import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 as win32Path } from "node:path";
import { z } from "zod";
import { MOODS } from "../shared/ipc.ts";
import { isPrivateIpv4, type PolicyContext, type Verdict } from "./permissions.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Native Model Context Protocol (MCP) Client & Permission Bridge.
 *
 * Speaks JSON-RPC 2.0 (`2025-03-26` / `2024-11-05`) over both local stdio
 * subprocesses and Streamable HTTP / SSE servers, wrapping every tool call
 * inside `core/permissions.ts` approval gates, strict name/schema validation,
 * buffer bounds, redirect blocking, and outside-text tagging.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MAX_MCP_SERVERS = 16;
/** Matches web-page truncation (`~6K`) so chatty MCP servers cannot crowd out a 16K context. */
export const MAX_MCP_OUTPUT_CHARS = 6_000;
const MAX_OUTPUT_CHARS = MAX_MCP_OUTPUT_CHARS;
const MAX_STDIO_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOOL_DESCRIPTION_CHARS = 200;
const MAX_INPUT_SCHEMA_BYTES = 16_384;
const MAX_INPUT_SCHEMA_DEPTH = 8;
const MAX_CALL_CONTENT_ITEMS = 64;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_STABLE_CONNECTION_MS = 30_000;

const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "100.100.100.200",
  "0.0.0.0",
  "::",
  "::ffff:0.0.0.0",
]);

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "VOLTA_HOME",
  "NVM_SYMLINK",
] as const;

const FORBIDDEN_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "BASH_ENV",
  "ENV",
]);

const SAFE_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const MOOD_TAG_RE = new RegExp(`\\[\\[\\s*(${MOODS.join("|")})\\s*\\]\\]`, "gi");

/**
 * The ONLY three Unicode RGI Emoji Subdivision Flag tag sequences (UTS #51):
 * England (`gbeng`), Scotland (`gbsct`), and Wales (`gbwls`).
 * Restricting Unicode tag characters (`U+E0000–U+E007F`) exclusively to these three exact
 * sequences after `🏴` (`U+1F3F4`) preserves legitimate regional flag emoji while completely
 * blocking invisible-text tag smuggling (both uppercase `"IGNORE_ALL"` and lowercase payloads).
 */
const ALLOWED_FLAG_TAG_SEQUENCES = new Set(["gbeng", "gbsct", "gbwls"]);

/**
 * Strips non-whitespace control chars, invisible Unicode tag chars (`U+E0000–U+E007F`) except
 * the three RGI regional subdivision flag sequences (`🏴󠁧󠁢󠁥󠁮󠁧󠁿`, `🏴󠁧󠁢󠁳󠁣󠁴󠁿`, `🏴󠁧󠁢󠁷󠁬󠁳󠁿`), BiDi overrides
 * (`U+202A–U+202E`, `U+061C`), unbalanced BiDi isolates, and companion mood tags (`[[happy]]`,
 * `[[ happy ]]`, etc.) from MCP tool *outputs* and *resources* while preserving legitimate TOML
 * tables (`[[servers]]`), nested arrays (`[[1, 2]]`), LRM/RLM (`U+200E`/`U+200F`), ZWJ/ZWNJ
 * (`U+200D`/`U+200C`), and properly balanced BiDi isolate pairs (`U+2066–U+2068`..`U+2069`).
 */
export function sanitizeUntrustedOutput(raw: string): string {
  const chars = [...raw];
  const kept: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    const cp = ch.codePointAt(0) ?? 0;

    if (cp === 0x1f3f4) {
      kept.push(ch);
      // Only allow exact RGI subdivision flag sequences: 5 lowercase ASCII tag chars (`gbeng`, `gbsct`, `gbwls`) + U+E007F.
      let j = i + 1;
      let asciiTag = "";
      while (j < chars.length && asciiTag.length < 6) {
        const nextCp = chars[j]?.codePointAt(0) ?? 0;
        if (
          (nextCp >= 0xe0061 && nextCp <= 0xe007a) ||
          (nextCp >= 0xe0030 && nextCp <= 0xe0039)
        ) {
          asciiTag += String.fromCodePoint(nextCp - 0xe0000);
          j += 1;
        } else {
          break;
        }
      }
      if (
        ALLOWED_FLAG_TAG_SEQUENCES.has(asciiTag) &&
        (chars[j]?.codePointAt(0) ?? 0) === 0xe007f
      ) {
        kept.push(...chars.slice(i + 1, j + 1));
        i = j;
      }
      continue;
    }

    if (
      (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      cp === 0x7f ||
      cp === 0x061c ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0xe0000 && cp <= 0xe007f)
    ) {
      continue;
    }
    kept.push(ch);
  }

  // Second pass: drop any unmatched BiDi isolate openers (U+2066..U+2068) or closers (U+2069),
  // preserving only properly balanced isolate pairs.
  const openStack: number[] = [];
  const dropIndices = new Set<number>();
  for (let i = 0; i < kept.length; i += 1) {
    const cp = kept[i]?.codePointAt(0) ?? 0;
    if (cp >= 0x2066 && cp <= 0x2068) {
      openStack.push(i);
    } else if (cp === 0x2069) {
      if (openStack.length > 0) {
        openStack.pop();
      } else {
        dropIndices.add(i);
      }
    }
  }
  for (const unmatched of openStack) dropIndices.add(unmatched);

  const balanced =
    dropIndices.size === 0 ? kept.join("") : kept.filter((_, idx) => !dropIndices.has(idx)).join("");
  return balanced.replace(MOOD_TAG_RE, "[$1]");
}

/** Strips control, zero-width, Unicode tag, BiDi override characters, and `[[...]]` mood markers for schema metadata. */
function sanitizeUntrustedText(raw: string, collapseWhitespace: boolean): string {
  const parts: string[] = [];
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      cp === 0x7f ||
      cp === 0x00ad ||
      cp === 0x034f ||
      cp === 0x061c ||
      cp === 0x180e ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x206f) ||
      cp === 0xfeff ||
      (cp >= 0xe0000 && cp <= 0xe007f)
    ) {
      continue;
    }
    if (collapseWhitespace && (cp === 0x09 || cp === 0x0a || cp === 0x0d)) {
      parts.push(" ");
    } else {
      parts.push(ch);
    }
  }
  const withoutMood = parts.join("").replaceAll("[[", "[").replaceAll("]]", "]");
  return collapseWhitespace ? withoutMood.replace(/\s+/g, " ").trim() : withoutMood;
}

/**
 * Aggressively sanitizes server-supplied MCP tool & parameter descriptions before they
 * enter the model prompt/tool schema: bounds input BEFORE regex stripping (preventing
 * quadratic regex backtracking on huge descriptions), strips control/zero-width/Unicode-tag/
 * BiDi chars, ChatML delimiters, XML tool/system/memory tags (iterated to true fixed point),
 * and mood markers.
 */
export function sanitizeMcpMetadataText(raw: string, maxChars = MAX_TOOL_DESCRIPTION_CHARS): string {
  const safeMax = Math.max(16, maxChars);
  // Pre-slice before running regexes so adversarial 200K+ descriptions stay O(safeMax).
  const preLimit = Math.max(1024, safeMax * 4);
  const clipped = raw.length > preLimit ? raw.slice(0, preLimit) : raw;
  let cleaned = sanitizeUntrustedText(clipped, true);
  // Loop until true fixed point: every non-noop pass strictly shrinks the bounded string.
  for (;;) {
    const next = cleaned
      .replaceAll("<|im_start|>", "")
      .replaceAll("<|im_end|>", "")
      .replace(/<\/?(?:tool_call|tool_response|system|memories|assistant|user)[^>]{0,256}>/gi, "")
      .replace(/<function=[^>]{0,256}>/gi, "")
      .replaceAll("[[", "[")
      .replaceAll("]]", "]")
      .replace(/\s+/g, " ")
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned.length > safeMax ? `${cleaned.slice(0, safeMax).trim()}…` : cleaned;
}

/**
 * Resolves a stdio MCP command safely while keeping `shell: false` (never spawning `cmd.exe`).
 * On Windows, Node 20+ rejects `.cmd`/`.bat` shims like `npx` with `EINVAL` under `shell: false`;
 * this resolves `npx`/`npm` directly to `node.exe` + `npx-cli.js`/`npm-cli.js` when present
 * (marking `useElectronAsNode: true` if falling back to Electron's `process.execPath`).
 */
export function resolveStdioCommand(
  command: string,
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    envPath?: string;
    env?: Record<string, string | undefined>;
    nodeExecPath?: string;
    fileExists?: (path: string) => boolean;
  } = {},
): { command: string; args: string[]; useElectronAsNode?: boolean; prependPathDir?: string } {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args] };
  }
  const pathLib = win32Path;
  const exists = options.fileExists ?? existsSync;
  const envSource = options.env ?? process.env;
  const envPath = options.envPath ?? envSource["PATH"] ?? "";
  const nodeExec = options.nodeExecPath ?? process.execPath;
  const trimmed = command.trim();
  const baseLower = pathLib.basename(trimmed).toLowerCase();
  const extLower = pathLib.extname(trimmed).toLowerCase();
  const pathDirs = envPath.split(";").map((d) => d.trim()).filter(Boolean);
  const standardWinDirs = [
    envSource["ProgramFiles"] ? pathLib.join(envSource["ProgramFiles"], "nodejs") : "",
    envSource["NVM_SYMLINK"] ?? "",
    envSource["VOLTA_HOME"] ? pathLib.join(envSource["VOLTA_HOME"], "bin") : "",
    envSource["LOCALAPPDATA"] ? pathLib.join(envSource["LOCALAPPDATA"], "Volta", "bin") : "",
    envSource["USERPROFILE"] ? pathLib.join(envSource["USERPROFILE"], "scoop", "apps", "nodejs", "current") : "",
    envSource["USERPROFILE"] ? pathLib.join(envSource["USERPROFILE"], "scoop", "shims") : "",
  ].filter(Boolean);
  const searchDirs = [...new Set([...pathDirs, ...standardWinDirs])];
  const nodeDirs = [pathLib.dirname(nodeExec), ...searchDirs];

  const findNativeExe = (exeName: string): string | null => {
    for (const dir of searchDirs) {
      const cand = pathLib.join(dir, exeName);
      if (exists(cand)) return cand;
    }
    return null;
  };

  const findNodeCliScript = (scriptName: "npx-cli.js" | "npm-cli.js"): string | null => {
    const candidates: string[] = [];
    if (trimmed.includes("\\") || trimmed.includes("/")) {
      const cmdDir = pathLib.dirname(trimmed);
      candidates.push(pathLib.join(cmdDir, "node_modules", "npm", "bin", scriptName));
    }
    for (const dir of nodeDirs) {
      candidates.push(pathLib.join(dir, "node_modules", "npm", "bin", scriptName));
    }
    for (const cand of candidates) {
      if (exists(cand)) return cand;
    }
    return null;
  };

  const findNodeExe = (
    cliPath?: string,
  ): { command: string; useElectronAsNode: boolean; prependPathDir?: string } => {
    if (cliPath) {
      // Prefer a real `node.exe` colocated with the discovered `npx-cli.js` / `npm-cli.js` install root.
      const installRoot = pathLib.resolve(pathLib.dirname(cliPath), "..", "..", "..");
      const siblingNode = pathLib.join(installRoot, "node.exe");
      if (exists(siblingNode)) {
        return { command: siblingNode, useElectronAsNode: false, prependPathDir: installRoot };
      }
    }
    if (pathLib.basename(nodeExec).toLowerCase() === "node.exe" && exists(nodeExec)) {
      return { command: nodeExec, useElectronAsNode: false, prependPathDir: pathLib.dirname(nodeExec) };
    }
    for (const dir of searchDirs) {
      const cand = pathLib.join(dir, "node.exe");
      if (exists(cand)) {
        return { command: cand, useElectronAsNode: false, prependPathDir: dir };
      }
    }
    // Electron fallback (`ELECTRON_RUN_AS_NODE=1`): still prepend the npm root dir so bin shims resolve.
    const fallbackDir = cliPath ? pathLib.resolve(pathLib.dirname(cliPath), "..", "..", "..") : undefined;
    return {
      command: nodeExec,
      useElectronAsNode: pathLib.basename(nodeExec).toLowerCase() !== "node.exe",
      ...(fallbackDir ? { prependPathDir: fallbackDir } : {}),
    };
  };

  if (baseLower === "npx" || baseLower === "npx.cmd") {
    const cli = findNodeCliScript("npx-cli.js");
    if (cli) {
      const node = findNodeExe(cli);
      return {
        command: node.command,
        args: [cli, ...args],
        ...(node.useElectronAsNode ? { useElectronAsNode: true } : {}),
        ...(node.prependPathDir ? { prependPathDir: node.prependPathDir } : {}),
      };
    }
    // Volta and similar Node managers ship a native `npx.exe` shim directly on PATH (no npx-cli.js).
    const nativeNpx = findNativeExe("npx.exe");
    if (nativeNpx) {
      return {
        command: nativeNpx,
        args: [...args],
        prependPathDir: pathLib.dirname(nativeNpx),
      };
    }
    throw new Error(
      `Windows cannot run "${trimmed}" directly without a shell and neither npx-cli.js nor npx.exe was found on PATH. Install Node.js (with npm) or Volta, or configure "node" with the server script path, or use "uvx".`,
    );
  }
  if (baseLower === "npm" || baseLower === "npm.cmd") {
    const cli = findNodeCliScript("npm-cli.js");
    if (cli) {
      const node = findNodeExe(cli);
      return {
        command: node.command,
        args: [cli, ...args],
        ...(node.useElectronAsNode ? { useElectronAsNode: true } : {}),
        ...(node.prependPathDir ? { prependPathDir: node.prependPathDir } : {}),
      };
    }
    const nativeNpm = findNativeExe("npm.exe");
    if (nativeNpm) {
      return {
        command: nativeNpm,
        args: [...args],
        prependPathDir: pathLib.dirname(nativeNpm),
      };
    }
    throw new Error(
      `Windows cannot run "${trimmed}" directly without a shell and neither npm-cli.js nor npm.exe was found on PATH.`,
    );
  }
  if (extLower === ".cmd" || extLower === ".bat") {
    throw new Error(
      `Windows batch/shim script "${trimmed}" cannot be executed safely with shell: false. Point the MCP server command at a native .exe (such as "node", "python", or "uvx") instead.`,
    );
  }
  // For bare executable names without extension (e.g. "uvx", "python"), prefer a concrete `.exe` on PATH.
  if (!extLower && !trimmed.includes("\\") && !trimmed.includes("/")) {
    for (const dir of pathDirs) {
      const exeCandidate = pathLib.join(dir, `${trimmed}.exe`);
      if (exists(exeCandidate)) {
        return { command: exeCandidate, args: [...args] };
      }
    }
  }
  return { command: trimmed, args: [...args] };
}

function assertSafeEnvOverrides(env: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (typeof val === "string") base[key] = val;
  }
  if (!env) return base;
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (FORBIDDEN_ENV_KEYS.has(upper) || k.includes("\0") || v.includes("\0")) {
      throw new Error(`Refused unsafe MCP environment override "${k}".`);
    }
    base[k] = v;
  }
  return base;
}

function hasUnsafeCommandChars(cmd: string): boolean {
  for (let i = 0; i < cmd.length; i += 1) {
    const code = cmd.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return /[;&|`$<>]/.test(cmd);
}

function jsonDepthWithinLimit(value: unknown, maxDepth: number, depth = 0): boolean {
  if (depth > maxDepth) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!jsonDepthWithinLimit(item, maxDepth, depth + 1)) return false;
    }
    return true;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (!jsonDepthWithinLimit(v, maxDepth, depth + 1)) return false;
  }
  return true;
}

function sanitizeInputSchema(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (!jsonDepthWithinLimit(raw, MAX_INPUT_SCHEMA_DEPTH)) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return undefined;
  }
  if (!serialized || serialized.length > MAX_INPUT_SCHEMA_BYTES) return undefined;
  return raw as Record<string, unknown>;
}

export const McpServerConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    name: z.string().min(1).max(80).optional(),
    transport: z.enum(["stdio", "http"]),
    /** When false, the server stays saved in config without connecting or exposing tools. */
    enabled: z.boolean().default(true),
    command: z.string().min(1).max(260).optional(),
    args: z.array(z.string().max(512)).max(64).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().max(400).optional(),
    url: z.string().url().max(512).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Only when explicitly true may `readOnlyHint: true` tools auto-run before reading outside text. */
    readOnlyAutoAllow: z.boolean().default(false),
    /** Opt-in: always include this server's tools in every turn without naming the server (e.g. filesystem/database). */
    alwaysOffer: z.boolean().optional(),
    timeoutMs: z.number().int().min(500).max(120_000).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "stdio") {
      if (!cfg.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Stdio MCP server requires a `command` executable.",
        });
      } else if (hasUnsafeCommandChars(cfg.command)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Stdio MCP `command` contains forbidden control or shell characters.",
        });
      }
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          if (FORBIDDEN_ENV_KEYS.has(k.toUpperCase()) || k.includes("\0") || v.includes("\0")) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `MCP stdio env override "${k}" is blocked for security.`,
            });
          }
        }
      }
    }
    if (cfg.transport === "http") {
      if (!cfg.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "HTTP MCP server requires a valid `url`.",
        });
      } else {
        const check = validateMcpHttpUrl(cfg.url);
        if (!check.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: check.reason,
          });
        }
      }
    }
  });

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerConfigInput = z.input<typeof McpServerConfigSchema>;

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpCallResult {
  content: { type: string; text?: string; [key: string]: unknown }[];
  textSummary: string;
  isError: boolean;
  /** Always true: remote/external MCP outputs are untrusted text per security policy. */
  outsideText: true;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

export interface McpTransport {
  connect(): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  /** Optional live-liveness check (e.g. active child process for stdio). */
  isConnected?(): boolean;
  /** Optional callback fired when an active transport drops unexpectedly (e.g. crashed process). */
  onDisconnect?(listener: (reason: string) => void): void;
}

function normalizeMappedIpv4(host: string): string {
  if (!host.startsWith("::ffff:")) return host;
  const rest = host.slice("::ffff:".length);
  const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hexPair) return rest;
  const hi = Number.parseInt(hexPair[1] ?? "0", 16);
  const lo = Number.parseInt(hexPair[2] ?? "0", 16);
  return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
}

/** Validates HTTP/SSE MCP endpoint URLs against SSRF / metadata / unencrypted non-LAN targets. */
export function validateMcpHttpUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid MCP endpoint URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported MCP URL scheme "${parsed.protocol}"; use http or https.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "MCP URLs must not embed credentials." };
  }
  const rawHost = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const host = (rawHost.split("%")[0] ?? rawHost).replace(/\.+$/, "");
  const mappedV4 = normalizeMappedIpv4(host);
  if (
    !host ||
    BLOCKED_METADATA_HOSTS.has(host) ||
    BLOCKED_METADATA_HOSTS.has(mappedV4) ||
    mappedV4.startsWith("169.254.") ||
    mappedV4.startsWith("0.") ||
    host.startsWith("fe80:")
  ) {
    return { ok: false, reason: `Blocked cloud metadata, unspecified, or link-local MCP host "${host}".` };
  }
  const isLoopback =
    mappedV4 === "localhost" || mappedV4 === "127.0.0.1" || host === "::1";
  const isLan = isLoopback || isPrivateLanHost(mappedV4) || isPrivateIpv4(mappedV4);
  if (parsed.protocol === "http:" && !isLan) {
    return {
      ok: false,
      reason: `Plaintext http:// MCP endpoints are restricted to localhost/private LAN (got "${host}").`,
    };
  }
  return { ok: true, url: parsed };
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Newline-delimited JSON-RPC 2.0 MCP transport over child process stdio. */
export class StdioMcpTransport implements McpTransport {
  private readonly cfg: McpServerConfig;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private stdoutBuf = "";
  private readonly pending = new Map<number, PendingRpc>();
  private closedByCaller = false;
  private disconnectListener: ((reason: string) => void) | null = null;

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
  }

  isConnected(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  onDisconnect(listener: (reason: string) => void): void {
    this.disconnectListener = listener;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const rawCommand = this.cfg.command ?? "";
    if (!rawCommand || hasUnsafeCommandChars(rawCommand)) {
      throw new Error(`Unsafe or missing MCP stdio command "${rawCommand}".`);
    }
    const resolved = resolveStdioCommand(rawCommand, this.cfg.args ?? []);
    const cleanEnv = assertSafeEnvOverrides(this.cfg.env);
    const spawnEnv: Record<string, string> = {
      ...cleanEnv,
      ...(resolved.useElectronAsNode
        ? { ELECTRON_RUN_AS_NODE: "1", npm_node_execpath: resolved.command }
        : {}),
    };
    if (resolved.prependPathDir) {
      const existingPath = spawnEnv["PATH"] ?? "";
      spawnEnv["PATH"] = existingPath
        ? `${resolved.prependPathDir};${existingPath}`
        : resolved.prependPathDir;
    }
    this.closedByCaller = false;
    this.stdoutBuf = "";
    let stderrTail = "";
    const child = spawn(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}),
      env: spawnEnv,
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.handleChunk(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });
    child.on("error", (err) => {
      const reason = `MCP stdio error: ${err.message}`;
      const wasActive = this.child === child;
      if (wasActive) {
        this.child = null;
        this.rejectAll(new Error(reason));
        if (!this.closedByCaller) {
          this.disconnectListener?.(reason);
        }
      }
    });
    child.on("exit", (code, signal) => {
      const reason = `MCP stdio process exited (${code ?? signal ?? "unknown"})${stderrTail ? `: ${stderrTail.trim()}` : ""}`;
      const wasActive = this.child === child;
      if (wasActive) {
        this.child = null;
        this.rejectAll(new Error(reason));
        if (!this.closedByCaller) {
          this.disconnectListener?.(reason);
        }
      }
    });
  }

  private rejectAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  private killChildQuietly(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // Ignore broken pipe during teardown.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }, 1500);
    forceTimer.unref?.();
  }

  private handleChunk(chunk: string): void {
    if (Buffer.byteLength(this.stdoutBuf, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_STDIO_BUFFER_BYTES) {
      const reason = "MCP stdio stdout buffer exceeded 2 MiB limit.";
      this.stdoutBuf = "";
      this.rejectAll(new Error(reason));
      this.killChildQuietly();
      if (!this.closedByCaller) {
        this.disconnectListener?.(reason);
      }
      return;
    }
    this.stdoutBuf += chunk;
    let nl = this.stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.dispatchLine(line);
      nl = this.stdoutBuf.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (msg["error"] && typeof msg["error"] === "object") {
      const errObj = msg["error"] as Record<string, unknown>;
      entry.reject(new Error(String(errObj["message"] ?? "MCP JSON-RPC error")));
    } else {
      entry.resolve(msg["result"]);
    }
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.child?.stdin) {
      return Promise.reject(new Error("MCP stdio transport is not connected."));
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });
      try {
        this.child?.stdin?.write(`${payload}\n`, "utf8", (writeErr) => {
          if (!writeErr) return;
          const pendingEntry = this.pending.get(id);
          if (!pendingEntry) return;
          this.pending.delete(id);
          clearTimeout(pendingEntry.timer);
          pendingEntry.reject(writeErr);
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.child?.stdin) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.child.stdin.write(`${payload}\n`);
  }

  async close(): Promise<void> {
    this.closedByCaller = true;
    this.rejectAll(new Error("MCP stdio transport closed."));
    this.killChildQuietly();
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const lenHeader = response.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`MCP HTTP response declared ${declared} bytes (exceeds ${maxBytes} byte limit).`);
    }
  }
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder("utf-8");
    const chunks: string[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const val = next.value;
        if (val) {
          total += val.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`MCP HTTP response exceeded ${maxBytes} byte limit.`);
          }
          chunks.push(decoder.decode(val, { stream: true }));
        }
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`MCP HTTP response exceeded ${maxBytes} byte limit.`);
  }
  return text;
}

/** Streamable HTTP + SSE MCP transport (`application/json` and `text/event-stream`). */
export class HttpMcpTransport implements McpTransport {
  private readonly cfg: McpServerConfig;
  private readonly endpointUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(cfg: McpServerConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    const validated = validateMcpHttpUrl(cfg.url ?? "");
    if (!validated.ok) throw new Error(validated.reason);
    this.endpointUrl = validated.url;
    this.fetchImpl = fetchImpl;
  }

  async connect(): Promise<void> {
    // Streamable HTTP is stateless until `initialize` negotiates an optional `Mcp-Session-Id`.
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private parseSseOrJson(contentType: string, bodyText: string, expectedId?: number): unknown {
    if (contentType.includes("text/event-stream")) {
      const events = bodyText.split(/\r?\n\r?\n/);
      let lastResult: unknown = undefined;
      for (const block of events) {
        const dataLines = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .filter(Boolean);
        if (dataLines.length === 0) continue;
        const raw = dataLines.join("\n");
        let parsed: Record<string, unknown>;
        try {
          const obj = JSON.parse(raw) as unknown;
          if (typeof obj !== "object" || obj === null || Array.isArray(obj)) continue;
          parsed = obj as Record<string, unknown>;
        } catch {
          continue;
        }
        if (expectedId !== undefined && parsed["id"] !== expectedId) continue;
        if (parsed["error"] && typeof parsed["error"] === "object") {
          throw new Error(String((parsed["error"] as Record<string, unknown>)["message"] ?? "MCP SSE error"));
        }
        lastResult = parsed["result"];
        if (expectedId !== undefined) return lastResult;
      }
      if (lastResult !== undefined) return lastResult;
      throw new Error("MCP SSE stream ended without a matching JSON-RPC result.");
    }

    const rawParsed = JSON.parse(bodyText) as unknown;
    if (typeof rawParsed !== "object" || rawParsed === null || Array.isArray(rawParsed)) {
      throw new Error("MCP HTTP payload must be a JSON object.");
    }
    const parsed = rawParsed as Record<string, unknown>;
    if (expectedId !== undefined && parsed["id"] !== expectedId) {
      throw new Error(`MCP JSON-RPC id mismatch: expected ${expectedId}, got ${String(parsed["id"])}.`);
    }
    if (parsed["error"] && typeof parsed["error"] === "object") {
      throw new Error(String((parsed["error"] as Record<string, unknown>)["message"] ?? "MCP HTTP error"));
    }
    return parsed["result"];
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpointUrl.toString(), {
        method: "POST",
        redirect: "error",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        }),
        signal: controller.signal,
      });
      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!response.ok) {
        throw new Error(`MCP HTTP ${response.status} from ${this.endpointUrl.origin}`);
      }
      const ctype = (response.headers.get("content-type") ?? "application/json").toLowerCase();
      const text = await readBoundedResponseText(response, MAX_HTTP_RESPONSE_BYTES);
      return this.parseSseOrJson(ctype, text, id) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      await this.fetchImpl(this.endpointUrl.toString(), {
        method: "POST",
        redirect: "error",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params !== undefined ? { params } : {}),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }
}

export class McpClient {
  readonly config: McpServerConfig;
  private readonly transport: McpTransport;
  private initialized = false;
  private cachedTools: McpToolDescriptor[] = [];
  private disconnectHandler: ((reason: string) => void) | null = null;

  constructor(config: McpServerConfigInput, customTransport?: McpTransport) {
    this.config = McpServerConfigSchema.parse(config);
    this.transport =
      customTransport ??
      (this.config.transport === "stdio"
        ? new StdioMcpTransport(this.config)
        : new HttpMcpTransport(this.config));
    this.transport.onDisconnect?.((reason) => {
      this.initialized = false;
      this.cachedTools = [];
      this.disconnectHandler?.(reason);
    });
  }

  /** Subscribes to unexpected transport disconnects (e.g., crashed stdio child process). */
  setOnDisconnect(handler: ((reason: string) => void) | null): void {
    this.disconnectHandler = handler;
  }

  get isConnected(): boolean {
    return this.initialized && (this.transport.isConnected ? this.transport.isConnected() : true);
  }

  get tools(): readonly McpToolDescriptor[] {
    return this.cachedTools;
  }

  async initialize(): Promise<McpInitializeResult> {
    await this.transport.connect();
    const result = await this.transport.request<McpInitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "astra-navi-desktop", version: "1.0.0" },
    });
    await this.transport.notify("notifications/initialized", {});
    this.initialized = true;
    return result;
  }

  async ping(): Promise<boolean> {
    try {
      await this.transport.request("ping", {});
      return true;
    } catch {
      return false;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const res = await this.transport.request<{ tools?: unknown[] }>("tools/list", {});
    const rawList = Array.isArray(res?.tools) ? res.tools : [];
    const seen = new Set<string>();
    const clean: McpToolDescriptor[] = [];
    for (const item of rawList) {
      if (clean.length >= MAX_TOOLS_PER_SERVER) break;
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const rawName = typeof obj["name"] === "string" ? obj["name"] : "";
      if (!SAFE_TOOL_NAME_RE.test(rawName) || seen.has(rawName)) continue;
      seen.add(rawName);
      const rawDesc = typeof obj["description"] === "string" ? obj["description"] : undefined;
      const description =
        rawDesc !== undefined
          ? sanitizeMcpMetadataText(rawDesc, MAX_TOOL_DESCRIPTION_CHARS)
          : undefined;
      const inputSchema = sanitizeInputSchema(obj["inputSchema"]);
      const rawAnn = obj["annotations"];
      const annotations: McpToolAnnotations | undefined =
        typeof rawAnn === "object" && rawAnn !== null && !Array.isArray(rawAnn)
          ? {
              ...(typeof (rawAnn as Record<string, unknown>)["readOnlyHint"] === "boolean"
                ? { readOnlyHint: (rawAnn as Record<string, unknown>)["readOnlyHint"] as boolean }
                : {}),
              ...(typeof (rawAnn as Record<string, unknown>)["destructiveHint"] === "boolean"
                ? { destructiveHint: (rawAnn as Record<string, unknown>)["destructiveHint"] as boolean }
                : {}),
              ...(typeof (rawAnn as Record<string, unknown>)["idempotentHint"] === "boolean"
                ? { idempotentHint: (rawAnn as Record<string, unknown>)["idempotentHint"] as boolean }
                : {}),
              ...(typeof (rawAnn as Record<string, unknown>)["openWorldHint"] === "boolean"
                ? { openWorldHint: (rawAnn as Record<string, unknown>)["openWorldHint"] as boolean }
                : {}),
            }
          : undefined;
      clean.push({
        name: rawName,
        ...(description !== undefined ? { description } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        ...(annotations !== undefined ? { annotations } : {}),
      });
    }
    this.cachedTools = clean;
    return this.cachedTools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    if (!SAFE_TOOL_NAME_RE.test(name)) {
      throw new Error(`Invalid MCP tool name "${name}".`);
    }
    const raw = await this.transport.request<{
      content?: { type: string; text?: string; [key: string]: unknown }[];
      isError?: boolean;
    }>("tools/call", { name, arguments: args });
    const items = Array.isArray(raw?.content) ? raw.content.slice(0, MAX_CALL_CONTENT_ITEMS) : [];
    const parts: string[] = [];
    let runningLen = 0;
    for (const item of items) {
      let piece: string;
      if (item && typeof item === "object" && typeof item.text === "string") {
        piece = item.text.slice(0, MAX_OUTPUT_CHARS);
      } else {
        try {
          piece = (JSON.stringify(item) ?? "").slice(0, MAX_OUTPUT_CHARS);
        } catch {
          piece = "[unserializable MCP content item]";
        }
      }
      const sanitized = sanitizeUntrustedOutput(piece);
      parts.push(sanitized);
      runningLen += sanitized.length;
      if (runningLen >= MAX_OUTPUT_CHARS) break;
    }
    const joined = parts.join("\n");
    const bounded =
      joined.length > MAX_OUTPUT_CHARS
        ? `${joined.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${joined.length - MAX_OUTPUT_CHARS} chars]`
        : joined;
    return {
      content: items,
      textSummary: bounded,
      isError: raw?.isError === true,
      outsideText: true,
    };
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    const res = await this.transport.request<{ resources?: McpResourceDescriptor[] }>(
      "resources/list",
      {},
    );
    return Array.isArray(res?.resources) ? res.resources : [];
  }

  async readResource(uri: string): Promise<{ text: string; mimeType?: string; outsideText: true }> {
    const res = await this.transport.request<{
      contents?: { uri?: string; text?: string; mimeType?: string }[];
    }>("resources/read", { uri });
    const first = Array.isArray(res?.contents) ? res.contents[0] : undefined;
    const rawText = typeof first?.text === "string" ? first.text : "";
    return {
      text: sanitizeUntrustedOutput(rawText.slice(0, MAX_OUTPUT_CHARS)),
      ...(first?.mimeType ? { mimeType: first.mimeType } : {}),
      outsideText: true,
    };
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.cachedTools = [];
    await this.transport.close();
  }
}

/** Permission verdict for calling a discovered MCP tool through `core/permissions.ts`. */
export function evaluateMcpToolVerdict(
  serverId: string,
  tool: McpToolDescriptor | undefined,
  readOnlyAutoAllow: boolean,
  context: Pick<PolicyContext, "readOutsideText" | "handsOff">,
): Verdict {
  if (context.handsOff) {
    return {
      decision: "ask",
      sensitive: true,
      reason: `Hands-off mode blocks external MCP tool "${serverId}.${tool?.name ?? "unknown"}" without confirmation.`,
    };
  }
  if (!tool) {
    return {
      decision: "ask",
      sensitive: false,
      reason: `MCP tool on "${serverId}" is not in the initialized server manifest.`,
    };
  }
  const safeReadOnly =
    readOnlyAutoAllow &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations?.destructiveHint !== true &&
    tool.annotations?.openWorldHint !== true;
  if (!safeReadOnly) {
    return {
      decision: "ask",
      sensitive: tool.annotations?.destructiveHint === true,
      reason: `MCP tool "${serverId}.${tool.name}" may modify external state or reach open-world endpoints.`,
    };
  }
  if (context.readOutsideText) {
    return {
      decision: "ask",
      sensitive: false,
      reason: `She has read outside text in this conversation, so check before running MCP tool "${serverId}.${tool.name}".`,
    };
  }
  return { decision: "allow" };
}

export interface McpCallGuard {
  policyContext?: PolicyContext;
  onOutsideText?: () => void;
  confirm?: (reason: string, sensitive: boolean) => Promise<boolean>;
}

export interface McpServerRuntimeStatus {
  id: string;
  connected: boolean;
  tools: readonly McpToolDescriptor[];
  error: string | null;
}

export interface McpHubOptions {
  /** Initial delay before auto-reconnecting a crashed MCP server (default 1000ms). */
  reconnectBaseMs?: number;
  /** Cap for exponential backoff between reconnect attempts (default 30000ms). */
  reconnectMaxMs?: number;
  /** Maximum consecutive automatic reconnect attempts after a crash (default 5; 0 disables). */
  maxReconnectAttempts?: number;
  /** How long a server must stay connected before resetting consecutive crash backoff (default 30000ms). */
  stableConnectionMs?: number;
}

/** Multi-server MCP coordinator integrated with `permissions.ts` and `semanticBridge.ts`. */
export class McpHub {
  private readonly clients = new Map<string, McpClient>();
  private readonly configSnapshots = new Map<string, string>();
  private readonly lastErrors = new Map<string, string>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly stableConnectionMs: number;
  private closed = false;

  constructor(options: McpHubOptions = {}) {
    this.reconnectBaseMs = Math.max(10, options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS);
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS);
    this.stableConnectionMs = Math.max(50, options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS);
  }

  private clearReconnectTimer(serverId: string): void {
    const timer = this.reconnectTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(serverId);
    }
  }

  private clearStableTimer(serverId: string): void {
    const timer = this.stableTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      this.stableTimers.delete(serverId);
    }
  }

  private scheduleStabilityReset(serverId: string, client: McpClient): void {
    this.clearStableTimer(serverId);
    if (!this.reconnectAttempts.has(serverId)) return;
    const timer = setTimeout(() => {
      this.stableTimers.delete(serverId);
      if (!this.closed && this.clients.get(serverId) === client && client.isConnected) {
        this.reconnectAttempts.delete(serverId);
      }
    }, this.stableConnectionMs);
    timer.unref?.();
    this.stableTimers.set(serverId, timer);
  }

  private scheduleReconnect(serverId: string): void {
    if (this.closed || this.maxReconnectAttempts <= 0) return;
    const client = this.clients.get(serverId);
    if (!client || client.config.enabled === false) return;
    if (this.reconnectTimers.has(serverId)) return;

    const attempt = (this.reconnectAttempts.get(serverId) ?? 0) + 1;
    if (attempt > this.maxReconnectAttempts) {
      const prev = this.lastErrors.get(serverId) ?? "Server disconnected.";
      if (!prev.includes("auto-reconnect paused")) {
        this.lastErrors.set(
          serverId,
          `${prev} (auto-reconnect paused after ${this.maxReconnectAttempts} consecutive crashes; reconnect manually in Settings)`,
        );
      }
      return;
    }
    this.reconnectAttempts.set(serverId, attempt);

    const delayMs = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(serverId);
      if (this.closed) return;
      const current = this.clients.get(serverId);
      if (!current || current.config.enabled === false || current.isConnected) return;
      void this.connectServer(serverId, { fromAutoReconnect: true }).then((res) => {
        if (!res.ok && !this.closed) this.scheduleReconnect(serverId);
      });
    }, delayMs);
    timer.unref?.();
    this.reconnectTimers.set(serverId, timer);
  }

  registerServer(config: McpServerConfigInput, customTransport?: McpTransport): McpClient {
    const client = new McpClient(config, customTransport);
    const id = client.config.id;
    this.clearReconnectTimer(id);
    this.clearStableTimer(id);
    this.reconnectAttempts.delete(id);
    client.setOnDisconnect((reason) => {
      if (this.closed || this.clients.get(id) !== client) return;
      this.clearStableTimer(id);
      this.lastErrors.set(id, reason);
      this.scheduleReconnect(id);
    });
    if (!this.closed) {
      this.clients.set(id, client);
      this.configSnapshots.set(id, JSON.stringify(client.config));
      this.lastErrors.delete(id);
    }
    return client;
  }

  async unregisterServer(serverId: string): Promise<void> {
    this.clearReconnectTimer(serverId);
    this.clearStableTimer(serverId);
    this.reconnectAttempts.delete(serverId);
    const existing = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.configSnapshots.delete(serverId);
    this.lastErrors.delete(serverId);
    if (existing) {
      existing.setOnDisconnect(null);
      await existing.close().catch(() => undefined);
    }
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId);
  }

  listServers(): readonly McpServerConfig[] {
    return [...this.clients.values()].map((c) => c.config);
  }

  statusFor(serverId: string): McpServerRuntimeStatus {
    const client = this.clients.get(serverId);
    return {
      id: serverId,
      connected: client?.isConnected === true,
      tools: client?.tools ?? [],
      error: this.lastErrors.get(serverId) ?? null,
    };
  }

  statusSnapshot(): McpServerRuntimeStatus[] {
    return [...this.clients.keys()].map((id) => this.statusFor(id));
  }

  private parsePrefixedToolName(
    fullToolName: string,
  ): { serverId: string; toolName: string; client?: McpClient } | null {
    if (!fullToolName.startsWith("mcp:")) return null;
    const rest = fullToolName.slice("mcp:".length);
    // Longest-prefix match over registered IDs (defense in depth alongside dot-free IDs).
    const registeredIds = [...this.clients.keys()].sort((a, b) => b.length - a.length);
    for (const id of registeredIds) {
      const prefix = `${id}.`;
      if (rest.startsWith(prefix)) {
        const toolName = rest.slice(prefix.length);
        if (!SAFE_TOOL_NAME_RE.test(toolName)) return null;
        return { serverId: id, toolName, client: this.clients.get(id) };
      }
    }
    const match = /^([a-z0-9][a-z0-9_-]{0,63})\.([A-Za-z0-9_-]{1,64})$/.exec(rest);
    if (!match) return null;
    const serverId = match[1] ?? "";
    const toolName = match[2] ?? "";
    return { serverId, toolName, client: this.clients.get(serverId) };
  }

  async connectServer(
    serverId: string,
    options: { fromAutoReconnect?: boolean } = {},
  ): Promise<{ ok: boolean; tools: readonly McpToolDescriptor[]; error?: string }> {
    if (this.closed) {
      return { ok: false, tools: [], error: "MCP hub is closed." };
    }
    if (!options.fromAutoReconnect) {
      this.reconnectAttempts.delete(serverId);
    }
    this.clearReconnectTimer(serverId);
    this.clearStableTimer(serverId);
    const client = this.clients.get(serverId);
    if (!client) {
      return { ok: false, tools: [], error: `Unknown MCP server "${serverId}".` };
    }
    if (client.config.enabled === false) {
      await client.close().catch(() => undefined);
      this.lastErrors.delete(serverId);
      return { ok: false, tools: [], error: "Server is disabled." };
    }
    if (client.isConnected) {
      await client.close().catch(() => undefined);
    }
    if (this.closed || this.clients.get(serverId) !== client) {
      await client.close().catch(() => undefined);
      return { ok: false, tools: [], error: "MCP hub is closed." };
    }
    try {
      await client.initialize();
      if (this.closed || this.clients.get(serverId) !== client) {
        await client.close().catch(() => undefined);
        return { ok: false, tools: [], error: "MCP hub closed during connect." };
      }
      await client.listTools();
      if (this.closed || this.clients.get(serverId) !== client) {
        await client.close().catch(() => undefined);
        return { ok: false, tools: [], error: "MCP hub closed during connect." };
      }
      this.lastErrors.delete(serverId);
      // Only reset backoff after the server stays connected for `stableConnectionMs` so rapid crash loops give up.
      this.scheduleStabilityReset(serverId, client);
      return { ok: true, tools: client.tools };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.closed) this.lastErrors.set(serverId, message);
      await client.close().catch(() => undefined);
      return { ok: false, tools: [], error: message };
    }
  }

  async connectAll(): Promise<{ connected: string[]; errors: Record<string, string> }> {
    const connected: string[] = [];
    const errors: Record<string, string> = {};
    if (this.closed) return { connected, errors };
    for (const [id, client] of this.clients) {
      if (this.closed) break;
      if (client.config.enabled === false) continue;
      try {
        await client.initialize();
        if (this.closed) {
          await client.close().catch(() => undefined);
          break;
        }
        await client.listTools();
        if (this.closed) {
          await client.close().catch(() => undefined);
          break;
        }
        this.lastErrors.delete(id);
        connected.push(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.closed) this.lastErrors.set(id, message);
        errors[id] = message;
      }
    }
    return { connected, errors };
  }

  /**
   * Reconciles live MCP connections against the persisted server list: closes removed,
   * disabled, or modified servers while preserving unchanged active connections.
   */
  async syncServers(
    configs: readonly McpServerConfigInput[],
  ): Promise<{ connected: string[]; errors: Record<string, string> }> {
    const connected: string[] = [];
    const errors: Record<string, string> = {};
    if (this.closed) return { connected, errors };
    const desired = new Map<string, McpServerConfig>();
    for (const raw of configs.slice(0, MAX_MCP_SERVERS)) {
      const parsed = McpServerConfigSchema.safeParse(raw);
      if (parsed.success) desired.set(parsed.data.id, parsed.data);
    }

    // Close servers removed from config, disabled, or whose configuration changed.
    for (const [id, client] of [...this.clients.entries()]) {
      if (this.closed) return { connected, errors };
      const next = desired.get(id);
      if (!next || next.enabled === false) {
        await this.unregisterServer(id);
        continue;
      }
      const nextSnap = JSON.stringify(next);
      if (this.configSnapshots.get(id) !== nextSnap) {
        await this.unregisterServer(id);
      } else if (!client.isConnected) {
        this.lastErrors.delete(id);
      }
    }

    for (const [id, cfg] of desired) {
      if (this.closed) break;
      if (cfg.enabled === false) continue;
      const existing = this.clients.get(id);
      if (existing && existing.isConnected) {
        connected.push(id);
        continue;
      }
      if (!existing) {
        this.registerServer(cfg);
      }
      if (this.closed) break;
      const res = await this.connectServer(id);
      if (this.closed) {
        const client = this.clients.get(id);
        if (client) await client.close().catch(() => undefined);
        break;
      }
      if (res.ok) connected.push(id);
      else if (res.error) errors[id] = res.error;
    }
    return { connected, errors };
  }

  /** True only when the discovered MCP tool explicitly declares itself read-only and local/non-destructive. */
  isReadOnlyTool(fullToolName: string): boolean {
    const parsed = this.parsePrefixedToolName(fullToolName);
    if (!parsed?.client) return false;
    const tool = parsed.client.tools.find((t) => t.name === parsed.toolName);
    return (
      tool?.annotations?.readOnlyHint === true &&
      tool.annotations.destructiveHint !== true &&
      tool.annotations.openWorldHint !== true
    );
  }

  listPrefixedTools(): { fullName: string; serverId: string; tool: McpToolDescriptor }[] {
    const out: { fullName: string; serverId: string; tool: McpToolDescriptor }[] = [];
    for (const [serverId, client] of this.clients) {
      if (client.config.enabled === false || !client.isConnected) continue;
      for (const tool of client.tools) {
        out.push({ fullName: `mcp:${serverId}.${tool.name}`, serverId, tool });
      }
    }
    return out;
  }

  /** Evaluates `permissions.ts` policy for any prefixed `mcp:<server>.<tool>` call. */
  verdictForTool(fullToolName: string, context: PolicyContext): Verdict {
    const parsed = this.parsePrefixedToolName(fullToolName);
    if (!parsed) {
      return {
        decision: "ask",
        sensitive: false,
        reason: `Unrecognized MCP tool identifier "${fullToolName}".`,
      };
    }
    const client = parsed.client;
    const tool = client?.tools.find((t) => t.name === parsed.toolName);
    return evaluateMcpToolVerdict(
      parsed.serverId,
      tool,
      client?.config.readOnlyAutoAllow === true,
      context,
    );
  }

  async callPrefixedTool(
    fullToolName: string,
    args: Record<string, unknown> = {},
    guard?: McpCallGuard,
  ): Promise<McpCallResult> {
    if (this.closed) {
      throw new Error(`Cannot call MCP tool "${fullToolName}": MCP hub is closed.`);
    }
    const parsed = this.parsePrefixedToolName(fullToolName);
    if (!parsed) throw new Error(`Invalid MCP tool name "${fullToolName}".`);
    const { serverId, toolName, client } = parsed;
    if (!client) throw new Error(`Unknown MCP server "${serverId}".`);
    if (!client.isConnected) {
      await client.initialize();
      if (this.closed) {
        await client.close().catch(() => undefined);
        throw new Error(`Cannot call MCP tool "${fullToolName}": MCP hub is closed.`);
      }
    }
    if (client.tools.length === 0) {
      await client.listTools();
      if (this.closed) {
        await client.close().catch(() => undefined);
        throw new Error(`Cannot call MCP tool "${fullToolName}": MCP hub is closed.`);
      }
    }
    const registeredTool = client.tools.find((t) => t.name === toolName);
    if (!registeredTool) {
      throw new Error(`Refused unknown or undeclared MCP tool "${fullToolName}".`);
    }
    if (guard?.policyContext || guard?.confirm) {
      const verdict = evaluateMcpToolVerdict(
        serverId,
        registeredTool,
        client.config.readOnlyAutoAllow,
        guard.policyContext ?? {},
      );
      if (verdict.decision === "ask") {
        const ok = guard.confirm ? await guard.confirm(verdict.reason, verdict.sensitive) : false;
        if (!ok) {
          throw new Error(`Permission denied for MCP tool "${fullToolName}": ${verdict.reason}`);
        }
      }
    }
    const result = await client.callTool(toolName, args);
    guard?.onOutsideText?.();
    return result;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const timer of this.stableTimers.values()) clearTimeout(timer);
    this.stableTimers.clear();
    this.reconnectAttempts.clear();
    this.lastErrors.clear();
    for (const client of this.clients.values()) {
      client.setOnDisconnect(null);
      await client.close().catch(() => undefined);
    }
  }
}
