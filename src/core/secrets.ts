/**
 * Blanks out things that look like credentials before anything is kept: a command line
 * can carry a token, and a note is replayed into future conversations and sits in a file.
 */
export function withoutSecrets(text: string): string {
  return (
    text
      .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [hidden]")
      .replace(
        /\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
        "$1[hidden]",
      )
      // As written in a tool call's arguments: {"password":"…"}, {"api_key": "…"}.
      .replace(
        /("(?:[\w-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth)[\w-]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
        '$1"[hidden]"',
      )
      .replace(/(--?(?:password|passwd|token|secret|api-key|key)[= ])(\S+)/gi, "$1[hidden]")
      .replace(/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1[hidden]@")
      .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[abp]|hf)[-_][A-Za-z0-9_-]{16,}\b/g, "[hidden]")
      .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[hidden]")
  );
}

export interface LocalSecretBackendProbe {
  platform: NodeJS.Platform;
  safeStorageAvailable: boolean;
  hasSecretService?: boolean;
}

export interface LocalSecretBackendResolution {
  backend: "os-keyring" | "owner-file-0600";
  degraded: boolean;
  notice: string | null;
}

/**
 * Resolves the local secret storage strategy without crashing on minimal Linux desktops
 * (Sway/Hyprland/headless X11) that do not run gnome-keyring or KWallet Secret Service.
 */
export function resolveLocalSecretBackend(
  probe: LocalSecretBackendProbe,
): LocalSecretBackendResolution {
  if (probe.platform !== "linux") {
    return probe.safeStorageAvailable
      ? { backend: "os-keyring", degraded: false, notice: null }
      : {
          backend: "owner-file-0600",
          degraded: true,
          notice: "OS credential store unavailable; storing local key material in 0600 owner-only file.",
        };
  }

  const secretServiceReady = probe.safeStorageAvailable && probe.hasSecretService !== false;
  if (secretServiceReady) {
    return { backend: "os-keyring", degraded: false, notice: null };
  }

  return {
    backend: "owner-file-0600",
    degraded: true,
    notice:
      "No Linux Secret Service daemon (gnome-keyring / KWallet) detected; cleanly using 0600 owner-only key file.",
  };
}
