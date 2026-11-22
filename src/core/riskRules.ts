import { realpath } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { PolicyContext } from "./permissions.ts";

/**
 * What makes a thing she might touch risky: a path where passwords, keys or sign-in
 * data are kept, a shell command that reaches such a place or cannot be read, a web
 * address that points back at this computer or network. `permissions.ts` turns these
 * into allow or ask; nothing here decides.
 */

/** Places that hold passwords, keys, tokens, messages or browser sessions. Touching them always asks. */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.(aws|azure|kube)(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)\.config\/(anthropic|gh|gcloud|rclone|fish|discord|Signal|Element|Slack|telegram-desktop|1Password|Bitwarden|keepassxc)(\/|$)/i,
  /(^|\/)\.password-store(\/|$)/,
  /(^|\/)\.config\/(git\/credentials|sops|kwalletrc)(\/|$)/,
  /(^|\/)\.local\/share\/(keyrings|kwalletd|fish|TelegramDesktop)(\/|$)/,
  /(^|\/)\.(mozilla|librewolf|thunderbird|zen)(\/|$)/,
  /(^|\/)\.var\/app(\/|$)/,
  /(^|\/)\.config\/(google-chrome|chromium|BraveSoftware|vivaldi|microsoft-edge|opera)[^/]*(\/|$)/i,
  /(^|\/)\.(netrc|git-credentials|pgpass|npmrc|pypirc)$/,
  /(^|\/)\.(bash|zsh|python|node_repl|psql|mysql|sqlite)_history$/,
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx|kdbx)$/i,
  /^\/etc\/(shadow|gshadow|sudoers)(\b|\.d\/)/,
  // Nearly everything under /proc describes running programs, their environment included.
  /^\/proc\/(?!(?:cpuinfo|meminfo|version|uptime|loadavg|stat|mounts|partitions|swaps)$)/,
  // Shell and login files often hold `export TOKEN=...` lines.
  /(^|\/)\.(bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|xprofile|pam_environment)$/,
  /(^|\/)\.gitconfig$/,
  /(^|\/)\.config\/(git\/config|environment\.d)(\/|$)/,
  /^\/run\/user\/\d+(\/|$)/,
  /(credentials|secrets?)\.(json|ya?ml|toml|ini)$/i,
  // Her own settings, memory and records. If she could rewrite these unasked she could
  // give herself permissions, and the settings can hold a search key.
  /(^|\/)\.local\/share\/ai-chan(\/|$)/,
  // Anything placed here runs by itself at login or when a menu entry is clicked.
  /(^|\/)\.config\/(autostart|systemd)(\/|$)/,
  /(^|\/)\.local\/share\/applications(\/|$)/,
];

export const SENSITIVE_REASON =
  "This touches a place where passwords, keys or sign-in data are kept.";
export const BROAD_REASON =
  "This reaches across folders where passwords, keys or sign-in data are kept.";

export function isSensitivePath(path: string): boolean {
  const normalized = path.split(sep).join("/");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** As `isSensitivePath`, and also true inside her own data folders, wherever those are. */
export function isPrivatePath(path: string, context: PolicyContext): boolean {
  if (isSensitivePath(path)) return true;
  const normalized = path.split(sep).join("/").replace(/\/+$/, "");
  return (context.privateDirs ?? []).some((dir) => {
    const folder = dir.split(sep).join("/").replace(/\/+$/, "");
    return folder.length > 1 && (normalized === folder || normalized.startsWith(`${folder}/`));
  });
}

/**
 * True for a folder so high up that searching it sweeps through private places too:
 * the home folder and everything above it, and the folders where apps keep their data.
 */
export function isBroadPath(path: string, home: string): boolean {
  const normalized = path.split(sep).join("/").replace(/\/+$/, "") || "/";
  const homeDir = home.split(sep).join("/").replace(/\/+$/, "");
  if (normalized === "/" || normalized === homeDir || homeDir.startsWith(`${normalized}/`))
    return true;
  return [
    `${homeDir}/.config`,
    `${homeDir}/.local`,
    `${homeDir}/.local/share`,
    `${homeDir}/.var`,
    "/etc",
    "/proc",
    "/root",
    "/var",
    "/run",
    "/run/user",
  ].includes(normalized);
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Resolves symlinks in the deepest part of the path that exists, so a link cannot dodge the rules. */
export async function canonical(path: string): Promise<string> {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export async function resolvePath(raw: string, context: PolicyContext): Promise<string> {
  const home = context.home ?? homedir();
  const expanded = expandHome(raw, home);
  return canonical(isAbsolute(expanded) ? expanded : resolve(context.workspace, expanded));
}

export function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

// ---------- shell commands ----------

/**
 * True when the shell would build file names or commands at run time: wildcards,
 * variables, command substitution. Quoting is honoured the way the shell honours it,
 * so `find . -name "*.mp4"` (the pattern goes to `find` untouched) is not expansion.
 */
export function hasShellExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      i += 1; // the next character is taken literally
      continue;
    }
    if (char === "$" || char === "`") return true; // these expand even inside double quotes
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if ("*?[]{}".includes(char)) return true;
  }
  return false;
}

const GLOB_CHARACTERS = /[*?[\]{}$`]/;
/** Commands that print the environment, which can hold access tokens. */
const ENVIRONMENT_DUMP =
  /(^|[\s;&|(])(printenv|env|set|export\s+-p|declare\s+-[a-zA-Z]*[px])\s*($|[;&|)>])/;
/** Commands that read or copy file contents, possibly a whole tree of them. */
const READS_WIDELY =
  /(^|[\s;&|(])(grep|egrep|fgrep|rg|ag|ack|tar|zip|7z|cp|rsync|scp|cat|head|tail|strings|xxd|base64)(\s|$)/;

export type CommandRisk = "sensitive" | "broad" | "opaque" | "plain";

/**
 * Sorts a shell command by what can be told from its text alone.
 *
 * - "sensitive": names a private place, or prints the environment.
 * - "broad": reads across the home folder or a system folder.
 * - "opaque": builds names at run time (wildcards, variables, substitution), so the
 *   text does not say what it will touch.
 * - "plain": every path in it is spelled out and none is private.
 */
export async function classifyCommand(
  command: string,
  context: PolicyContext,
): Promise<CommandRisk> {
  const home = context.home ?? homedir();
  // Quotes and backslashes can split a name in the text (`.s""sh`) that the shell joins back up.
  const unquoted = command.replace(/["'\\]/g, "");
  if (ENVIRONMENT_DUMP.test(unquoted)) return "sensitive";

  /**
   * Where a word points if it is a file name. Commands run inside the assistant's own
   * folder, so a relative word is resolved from there; `../../..` and links are followed.
   */
  const target = async (word: string): Promise<string | null> => {
    if (word.startsWith("-") || GLOB_CHARACTERS.test(word)) return null;
    const expanded = expandHome(word, home);
    return canonical(isAbsolute(expanded) ? expanded : resolve(context.workspace, expanded));
  };

  let otherAccount = false;
  let deviceFile = false;
  for (const word of unquoted.split(/[\s;|&<>()=,]+/).filter(Boolean)) {
    if (isPrivatePath(expandHome(word, home), context)) return "sensitive";
    const path = await target(word);
    if (path !== null && isPrivatePath(path, context)) return "sensitive";
    // "~name" is another account's home folder; the shell works out where that is.
    if (/^~[^/]/.test(word)) otherAccount = true;
  }
  const workspace = await canonical(context.workspace);
  for (const segment of unquoted.split(/\|\||&&|[|;\n]/)) {
    const words = segment.split(/[\s<>()=,]+/).filter(Boolean);
    const name = words[0] ?? "";
    // A search through a whole folder reads files nobody named: `.env`, keys, anything in
    // there. Outside her own folder that is the user's call.
    const recursive =
      /^(?:rg|ag|ack)$/.test(name) ||
      (/^(?:e|f)?grep$/.test(name) &&
        words.some(
          (word) => /^-[a-zA-Z]*[rR]/.test(word) || /^--(?:dereference-)?recursive$/.test(word),
        ));
    for (const word of words.slice(1)) {
      const path = await target(word);
      if (path === null) continue;
      // A search pattern resolves to a name inside her folder and so passes; only a real
      // path leading somewhere else trips this.
      if (recursive && !isInside(path, workspace)) return "broad";
      // Device files never end (`/dev/zero`) or are not text; reading one is not a look-only act.
      if (path.startsWith("/dev/") && path !== "/dev/null") deviceFile = true;
    }
  }
  // Judged one command at a time, so `df -h / | tail -1` is not mistaken for reading all of `/`.
  for (const segment of unquoted.split(/\|\||&&|[|;\n]/)) {
    if (!READS_WIDELY.test(segment)) continue;
    const words = segment.split(/[\s<>()=,]+/).filter(Boolean);
    for (const word of words.slice(1)) {
      const path = await target(word);
      if (path !== null && isBroadPath(path, home)) return "broad";
    }
  }
  return otherAccount || deviceFile || hasShellExpansion(command) ? "opaque" : "plain";
}

// ---------- web addresses ----------

/**
 * True for an ordinary public web address. Addresses on this computer or the local
 * network, and addresses long enough to be carrying data out, are not "plain".
 */
export function isPlainWebAddress(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  // A trailing dot is still the same host; without removing it "localhost." slips through.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa") ||
    !host.includes(".") ||
    host.includes(":") || // IPv6 literal
    isPrivateIpv4(host);
  if (local) return false;
  return target.length <= 300 && url.search.length <= 120;
}

/** True for IPv4 addresses that are not on the public internet. */
export function isPrivateIpv4(address: string): boolean {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!parts) return false;
  const [a, b] = [Number(parts[1]), Number(parts[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, also used by VPN meshes
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
/** Ranges inside the global block that are tunnels or reserved, and can lead back to a private IPv4 address. */
const NOT_REALLY_GLOBAL = new BlockList();
NOT_REALLY_GLOBAL.addSubnet("2002::", 16, "ipv6"); // 6to4
NOT_REALLY_GLOBAL.addSubnet("2001::", 32, "ipv6"); // Teredo
NOT_REALLY_GLOBAL.addSubnet("2001:db8::", 32, "ipv6"); // documentation

/**
 * True only for an address on the public internet. Everything else is refused: this
 * computer, the local network, and every IPv6 form that wraps an IPv4 address (mapped,
 * compatible, NAT64), since those can be made to point anywhere.
 */
export function isPublicIp(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !isPrivateIpv4(address);
  if (kind !== 6) return false;
  return GLOBAL_IPV6.check(address, "ipv6") && !NOT_REALLY_GLOBAL.check(address, "ipv6");
}

export const WEB_REASON =
  "This address points at this computer or network, or is long enough to be carrying information out.";
