import { existsSync } from "node:fs";
import {
  detectDistributionChannel,
  shouldCheckGithubUpdates,
  type UpdateCheckResult,
} from "../shared/edition.ts";

export type { UpdateCheckResult };

const GITHUB_RELEASES_API =
  "https://api.github.com/repos/bwiemz/astra-navi-desktop/releases/latest";
const PINNED_API_PREFIX = "https://api.github.com/repos/bwiemz/astra-navi-desktop/";
export const PINNED_RELEASES_BASE =
  "https://github.com/bwiemz/astra-navi-desktop/releases";
const MAX_RELEASE_RESPONSE_BYTES = 256 * 1024;

export function sanitizePinnedReleaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return PINNED_RELEASES_BASE;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return PINNED_RELEASES_BASE;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname.includes("..")
  ) {
    return PINNED_RELEASES_BASE;
  }
  if (
    parsed.pathname !== "/bwiemz/astra-navi-desktop/releases" &&
    !parsed.pathname.startsWith("/bwiemz/astra-navi-desktop/releases/")
  ) {
    return PINNED_RELEASES_BASE;
  }
  return parsed.toString();
}

export function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Returns >0 if `a > b`, <0 if `a < b`, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const lenHeader = response.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub Releases response exceeded ${maxBytes} byte limit.`);
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
        if (next.value) {
          total += next.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`GitHub Releases response exceeded ${maxBytes} byte limit.`);
          }
          chunks.push(decoder.decode(next.value, { stream: true }));
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
    throw new Error(`GitHub Releases response exceeded ${maxBytes} byte limit.`);
  }
  return text;
}

/**
 * Queries the pinned official GitHub Releases metadata API over HTTPS with redirects blocked.
 * Never downloads, unpacks, or executes remote release binaries.
 */
export async function checkGithubReleaseUpdate(options: {
  currentVersion: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<UpdateCheckResult> {
  const checkExists = options.exists ?? existsSync;
  const channel = detectDistributionChannel(options.env, checkExists);

  if (!shouldCheckGithubUpdates(options.env, checkExists)) {
    return {
      status: "disabled",
      channel,
      currentVersion: options.currentVersion,
      reason: `Updates are managed by ${channel === "standalone" ? "your storefront" : channel}; standalone GitHub update checks are disabled.`,
    };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchFn(GITHUB_RELEASES_API, {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `AstraNaviDesktop/${options.currentVersion}`,
      },
      signal: controller.signal,
    });
    if (response.url && !response.url.startsWith(PINNED_API_PREFIX)) {
      return {
        status: "error",
        channel,
        currentVersion: options.currentVersion,
        reason: `Refused unexpected update response origin (${response.url}).`,
      };
    }
    if (!response.ok) {
      return {
        status: "error",
        channel,
        currentVersion: options.currentVersion,
        reason: `GitHub Releases returned HTTP ${response.status}.`,
      };
    }
    const rawBody = await readBoundedText(response, MAX_RELEASE_RESPONSE_BYTES);
    const data = JSON.parse(rawBody) as {
      tag_name?: unknown;
      html_url?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    };
    if (data.draft === true || data.prerelease === true) {
      return {
        status: "up-to-date",
        channel,
        currentVersion: options.currentVersion,
        latestVersion: options.currentVersion,
        releaseUrl: PINNED_RELEASES_BASE,
        reason: "Ignored draft or pre-release tag from GitHub Releases feed.",
      };
    }
    const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
    const latestVersion = tag.replace(/^v/i, "");
    const releaseUrl = sanitizePinnedReleaseUrl(data.html_url);
    if (!parseSemver(latestVersion)) {
      return {
        status: "error",
        channel,
        currentVersion: options.currentVersion,
        reason: "Could not parse latest release version from GitHub response.",
      };
    }
    if (compareSemver(latestVersion, options.currentVersion) > 0) {
      return {
        status: "update-available",
        channel,
        currentVersion: options.currentVersion,
        latestVersion,
        releaseUrl,
        reason: `Astra Navi Desktop v${latestVersion} is available.`,
      };
    }
    return {
      status: "up-to-date",
      channel,
      currentVersion: options.currentVersion,
      latestVersion,
      releaseUrl,
      reason: `You are running the latest release (v${options.currentVersion}).`,
    };
  } catch (error) {
    return {
      status: "error",
      channel,
      currentVersion: options.currentVersion,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
