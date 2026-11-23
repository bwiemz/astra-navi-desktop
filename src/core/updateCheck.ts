import { existsSync } from "node:fs";
import {
  detectDistributionChannel,
  shouldCheckGithubUpdates,
  type UpdateCheckResult,
} from "../shared/edition.ts";

export type { UpdateCheckResult };

const GITHUB_RELEASES_API =
  "https://api.github.com/repos/bwiemz/astra-navi-desktop/releases/latest";

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
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `AstraNaviDesktop/${options.currentVersion}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "error",
        channel,
        currentVersion: options.currentVersion,
        reason: `GitHub Releases returned HTTP ${response.status}.`,
      };
    }
    const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
    const latestVersion = tag.replace(/^v/i, "");
    const releaseUrl =
      typeof data.html_url === "string"
        ? data.html_url
        : "https://github.com/bwiemz/astra-navi-desktop/releases";
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
