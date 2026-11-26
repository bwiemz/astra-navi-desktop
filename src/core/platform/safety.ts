import { replaceInternalCaptain } from "../characterLayer.ts";
import type { Control } from "../hands.ts";
import { forbidden, type OperateAction } from "../operateRules.ts";

const LINUX_AND_CROSS_PLATFORM_TERMINALS =
  /terminal|termite|sakura|konsole|yakuake|terminator|terminology|term($|[.\-_])|(^|[.\-_])(kitty|alacritty|wezterm|foot|footclient|urxvt|rxvt|st|ghostty|ptyxis|kgx|console|tilix|contour|rio|blackbox|warp|tabby|hyper|guake|tilda|cool-retro-term)(-gui)?($|[.\-_])/i;

const WINDOWS_TERMINALS =
  /(?:^|[\\/._-])(wt|windowsterminal|openconsole|cmd|powershell|pwsh|conhost|mintty|alacritty|wezterm|hyper|tabby)(?:\.exe)?$/i;

const TERMINAL_TITLES =
  /^(?:administrator:\s*)?(?:windows powershell|command prompt|developer command prompt|developer powershell)(?:$|\s|-)/i;

/**
 * Shared Linux + Windows check for terminal emulators and command shells.
 * AI-chan must run commands via `run_command` (where the user approves them) rather than
 * blindly typing/sending keystrokes into an interactive terminal window.
 */
export function isTerminalApp(app: string, title = ""): boolean {
  const cleanApp = app.trim();
  const cleanTitle = title.trim();
  return (
    LINUX_AND_CROSS_PLATFORM_TERMINALS.test(cleanApp) ||
    WINDOWS_TERMINALS.test(cleanApp) ||
    (cleanTitle.length > 0 && TERMINAL_TITLES.test(cleanTitle))
  );
}

export type ControlMatchResult =
  | { kind: "match"; control: Control }
  | { kind: "none" }
  | { kind: "ambiguous"; exact: boolean; choices: Control[] };

/**
 * Cross-platform exact full-name / index matching for accessible controls.
 * Never auto-selects a partial/fuzzy substring match; refuses ambiguous matches cleanly.
 */
export function matchControlExact(
  controls: readonly Control[],
  query: { name?: string; which?: number },
): ControlMatchResult {
  if (query.which !== undefined && query.name === undefined) {
    const byIndex = controls.find((control) => control.n === query.which);
    return byIndex ? { kind: "match", control: byIndex } : { kind: "none" };
  }

  const wanted = (query.name ?? "").trim();
  if (!wanted) {
    if (query.which !== undefined) {
      const byIndex = controls.find((control) => control.n === query.which);
      return byIndex ? { kind: "match", control: byIndex } : { kind: "none" };
    }
    return { kind: "none" };
  }

  const lower = wanted.toLowerCase();
  const exactMatches = controls.filter((control) => control.name.trim().toLowerCase() === lower);
  if (exactMatches.length === 1 && exactMatches[0]) {
    return { kind: "match", control: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    if (query.which !== undefined) {
      const disambiguated = exactMatches.find((control) => control.n === query.which);
      if (disambiguated) return { kind: "match", control: disambiguated };
    }
    return { kind: "ambiguous", exact: true, choices: exactMatches };
  }

  const partialMatches = controls.filter((control) =>
    control.name.trim().toLowerCase().includes(lower),
  );
  if (partialMatches.length > 0) {
    return { kind: "ambiguous", exact: false, choices: partialMatches };
  }
  return { kind: "none" };
}

export interface SafeDispatchRequest {
  handsOff: boolean;
  action: OperateAction;
  targetWindow: { id: string; app: string; title: string };
  actualForeground: { id: string; app: string; title: string } | null;
  ownApps?: readonly string[];
  userAddress?: string;
}

export interface SafeDispatchDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Shared cross-platform pre-dispatch safety gate executed identically on Linux and Windows:
 * 1. Master hands-off switch check.
 * 2. Forbidden / password-manager / system-auth / own-window isolation.
 * 3. Terminal typing / key injection block (both Linux + Windows terminals).
 * 4. Immediate foreground-window re-verification before clicking or sending keys.
 */
export function assertSafeDesktopDispatch(req: SafeDispatchRequest): SafeDispatchDecision {
  if (req.handsOff) {
    return {
      allowed: false,
      reason: "Hands-off mode is enabled; desktop input is blocked.",
    };
  }

  const ownApps = req.ownApps ?? [];
  const targetRefusal = forbidden(req.targetWindow, req.action, ownApps, req.userAddress);
  if (targetRefusal) {
    return { allowed: false, reason: targetRefusal };
  }

  if (
    (req.action === "type" || req.action === "key" || req.action === "fill") &&
    isTerminalApp(req.targetWindow.app, req.targetWindow.title)
  ) {
    return {
      allowed: false,
      reason: replaceInternalCaptain(
        "That is a terminal. You do not type into terminals; run the command with run_command instead, where Captain can read it first.",
        req.userAddress,
      ),
    };
  }

  if (!req.actualForeground || req.actualForeground.id !== req.targetWindow.id) {
    return {
      allowed: false,
      reason: "Foreground window changed before dispatch; action cancelled.",
    };
  }

  const foregroundRefusal = forbidden(req.actualForeground, req.action, ownApps, req.userAddress);
  if (foregroundRefusal) {
    return { allowed: false, reason: foregroundRefusal };
  }

  return { allowed: true };
}
