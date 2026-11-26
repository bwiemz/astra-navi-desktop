import { replaceInternalCaptain } from "./characterLayer.ts";
import type { WindowDetail } from "./desktop.ts";
import { matchWindows } from "./desktop.ts";
import { parseKeys } from "./hands.ts";
import type { PolicyContext, Verdict } from "./permissions.ts";
import type { SomMark } from "./som.ts";
import { isPrivate } from "./watch.ts";

/**
 * The rules for working inside other programs: which she may touch at all, and which
 * steps the user sees one by one.
 *
 * Pressing a button in someone else's program is the most open-ended thing she can do:
 * what it means depends entirely on the program. So the rules are built in three rings.
 * Some programs she never touches (where passwords live, where the system asks for
 * authority, a terminal's keyboard, her own windows). Some steps are always shown one
 * at a time (anything that reads like deleting, sending or paying, anything in a
 * program that speaks to the outside, anything typed once she has read outside text).
 * Everything else is asked once per program, for the rest of the conversation.
 */

export const OPERATE_ACTIONS = [
  "controls",
  "press",
  "fill",
  "click",
  "type",
  "key",
  "scroll",
] as const;
export type OperateAction = (typeof OPERATE_ACTIONS)[number];

export interface OperateInput {
  action: OperateAction;
  /** Words from the window's title or its program. Left out: the window in front. */
  window?: string;
  /** The control's name, or the words to click on. */
  name?: string;
  /** Its number in the last list. */
  which?: number;
  text?: string;
  /** For key: "ctrl+s". */
  keys?: string;
  /** For key: how many times. For scroll: how far, positive is down. */
  amount?: number;
  /** For click: "double" or "right". */
  how?: string;
}

/** The most text she may type into another program once she has read outside text. */
export const MAX_TYPED_CHARS = 600;

/** A terminal's keyboard runs commands. She has run_command for that, which the user can read first. */
const TERMINALS =
  /terminal|termite|sakura|konsole|yakuake|terminator|terminology|term($|[.\-_])|(^|[\\/._-])(kitty|alacritty|foot|footclient|urxvt|rxvt|st|ghostty|ptyxis|kgx|console|tilix|contour|rio|blackbox|warp|tabby|hyper|guake|tilda|cool-retro-term|wt|windowsterminal|openconsole|cmd|powershell|pwsh|conhost|mintty)(\.exe|-gui)?($|[.\-_])/i;

/** Where passwords and keys are kept. Not read, not touched. */
const SECRET_KEEPERS =
  /(keepass|bitwarden|1password|enpass|kwallet|seahorse|keyring|lastpass|dashlane|nordpass|proton-?pass|authenticator|pinentry|ksshaskpass|gcr-prompter|secrets)/i;

/** Windows through which the system itself asks the user for authority or consent. */
const AUTHORITY =
  /(polkit|kdesu|kscreenlocker|screenlock|xdg-desktop-portal|plasma-login|sddm|lightdm|gdm|ksecretd|kded|ukui-polkit|lxqt-policykit|drkonqi-polkit)/i;

/**
 * Programs whose buttons reach outside this computer or change the system: every step
 * in them is shown. A browser's page is also entirely someone else's text.
 */
const OUTWARD =
  /(firefox|librewolf|zen|chrom|brave|vivaldi|opera|edge|falkon|epiphany|konqueror|tor-?browser|thunderbird|betterbird|kmail|kontact|korganizer|kaddressbook|akregator|evolution|geary|mailspring|discord|vesktop|element|signal|telegram|slack|whatsapp|teams|zoom|skype|neochat|konversation|hexchat|steam|lutris|heroic|systemsettings|kcm|discover|pamac|octopi|gnome-software|bauh|software|partition|gparted|kde-?connect|bank|wallet|ledger|electrum)/i;

/**
 * Programs with a terminal or a command line built in: an editor's terminal panel, a file
 * manager's, a launcher. What she types there could be run, so it is always shown first.
 */
const RUNS_WHAT_IS_TYPED =
  /(code|codium|vscode|cursor|windsurf|zed|jetbrains|idea|pycharm|clion|rider|webstorm|goland|rustrover|android-?studio|kate|kdevelop|dolphin|krusader|emacs|g?vim|neovide|sublime|atom|theia|rstudio|spyder|jupyter|krunner|rofi|wofi|fuzzel|ulauncher|albert|unreal|godot|blender)/i;

/** True for a program in which typed text could be run as a command. */
export function runsWhatIsTyped(window: Pick<WindowDetail, "app">): boolean {
  return RUNS_WHAT_IS_TYPED.test(window.app);
}

/** Names that read like something hard to take back, in the three languages she speaks. */
const RISKY_NAME =
  /\b(delete|remove|erase|wipe|format|discard|overwrite|replace|trash|bin|empty|merge|save|commit|push|rename|cut|transfer|withdraw|subscribe|download|enable|uninstall|install|send|submit|post|publish|share|upload|pay|buy|purchase|order|checkout|confirm|sign|log ?out|sign ?out|log ?in|sign ?in|shut ?down|restart|reboot|suspend|allow|grant|authori[sz]e|accept|agree|yes|ok|okay|apply|reset|clear|don[’']?t save|do not save|quit|exit|close|revert|force|kill|terminate|unlock|disable|trust|run|execute|open with)\b|削除|消去|ゴミ箱|保存|送信|投稿|購入|支払|注文|確認|同意|許可|はい|適用|終了|インストール|初期化|上書|删除|清除|回收站|保存|发送|發送|发布|購買|购买|支付|付款|确认|確認|同意|允许|允許|是|应用|退出|安装|重置|覆盖/i;

/** Keys that only move about. Anything else is shown before it is pressed. */
const CALM_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "tab",
  "shift+tab",
  "pageup",
  "pagedown",
  "home",
  "end",
  "escape",
  "esc",
  "ctrl+f",
  "ctrl+home",
  "ctrl+end",
  "ctrl+tab",
  "ctrl+shift+tab",
  "f6",
]);

export function isRiskyName(name: string): boolean {
  // Toolkits mark a button's shortcut letter with "_" or "&" ("_Delete", "&Send").
  return RISKY_NAME.test(name.replace(/[_&]/g, ""));
}

export function isCalmKey(keys: string): boolean {
  // Read exactly as it will be pressed, so "h o m e" (four letters) is not taken for Home.
  return CALM_KEYS.has(parseKeys(keys).join("+"));
}

/** Why she may not work in this window, or null when she may. */
export function forbidden(
  window: Pick<WindowDetail, "app" | "title">,
  action: OperateAction,
  ownApps: readonly string[],
  userAddress?: string,
): string | null {
  const app = window.app.toLowerCase();
  if (ownApps.some((own) => own.toLowerCase() === app)) {
    return replaceInternalCaptain(
      "That is your own window. You do not work your own controls; answer Captain in words.",
      userAddress,
    );
  }
  if (SECRET_KEEPERS.test(app)) {
    return replaceInternalCaptain(
      "That program keeps passwords and keys. You do not read or touch it; Captain does.",
      userAddress,
    );
  }
  if (AUTHORITY.test(app)) {
    return replaceInternalCaptain(
      "That window is the system asking Captain for a password or for permission. Only Captain answers it.",
      userAddress,
    );
  }
  // The same windows her watch never reads: private browsing, sign-in pages, anything
  // whose title speaks of passwords. Their controls hold what is typed into them.
  if (isPrivate(window, [])) {
    return replaceInternalCaptain(
      "That window is private (a sign-in, private browsing, or something to do with passwords). You do not read or touch it; Captain does.",
      userAddress,
    );
  }
  if (TERMINALS.test(app) && (action === "type" || action === "key" || action === "fill")) {
    return replaceInternalCaptain(
      "That is a terminal. You do not type into terminals; run the command with run_command instead, where Captain can read it first.",
      userAddress,
    );
  }
  return null;
}

/** True for a program in which every step is shown to the user. */
export function isOutward(window: Pick<WindowDetail, "app">): boolean {
  return OUTWARD.test(window.app);
}

/**
 * The window meant: by her words, or the one in front. Her own window is usually the
 * one being typed into when she is asked, so "in front" means the topmost one that is
 * not hers. Throws, in words for her, when it cannot be told which is meant.
 */
export function pickTarget(
  input: Pick<OperateInput, "window">,
  windows: readonly WindowDetail[],
  ownApps: readonly string[],
): WindowDetail {
  const own = (window: WindowDetail): boolean =>
    ownApps.some((name) => name.toLowerCase() === window.app.toLowerCase());
  const words = (input.window ?? "").trim();
  if (words) {
    const matches = matchWindows(
      windows.filter((window) => !own(window)),
      words,
    ) as WindowDetail[];
    const programs = new Set(matches.map((window) => window.app));
    if (matches.length === 0) {
      const open = [...new Set(windows.filter((w) => !own(w)).map((w) => w.app))].join(", ");
      throw new Error(`No open window matches "${words}". Open programs: ${open || "none"}.`);
    }
    if (programs.size > 1) {
      throw new Error(
        `No open window matches "${words}" alone: ${matches.length} do. Say which: ${matches
          .map((window) => `"${window.title}" (${window.app})`)
          .join("; ")}.`,
      );
    }
    // Several windows of one program: the one in use, then a dialog (it is what needs answering).
    return (
      matches.find((window) => window.active) ??
      matches.find((window) => window.dialog && !window.minimized) ??
      matches.find((window) => !window.minimized) ??
      (matches[0] as WindowDetail)
    );
  }
  const candidates = windows.filter((window) => !own(window) && !window.minimized);
  const front =
    candidates.find((window) => window.active) ??
    [...candidates].sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0];
  if (!front) throw new Error("No open window matches: nothing is open besides you.");
  return front;
}

/** The names behind the numbers she was last shown, per window, so a number can be put into words. */
const listedNames = new Map<string, Map<number, { kind: string; name: string }>>();

/** Records the numbered list she was just given for a window. */
export function rememberListed(
  windowId: string,
  controls: readonly { n: number; kind: string; name: string }[],
): void {
  listedNames.set(windowId, new Map(controls.map((c) => [c.n, { kind: c.kind, name: c.name }])));
  if (listedNames.size > 20) listedNames.delete(listedNames.keys().next().value ?? "");
}

/** What a number in the last list for this window stands for, if anything. */
export function listedControl(
  windowId: string,
  which: number,
): { kind: string; name: string } | undefined {
  return listedNames.get(windowId)?.get(which);
}

const SOM_TTL_MS = 90_000;
const somMarksByWindow = new Map<string, { at: number; marks: readonly SomMark[] }>();

/** Records numbered Set-of-Mark targets seen in a window so `operate({ which })` can click them. */
export function rememberSomMarks(
  windowId: string,
  marks: readonly SomMark[],
  nowMs = Date.now(),
): void {
  somMarksByWindow.set(windowId, { at: nowMs, marks: [...marks] });
  if (somMarksByWindow.size > 20) somMarksByWindow.delete(somMarksByWindow.keys().next().value ?? "");
}

/** Returns a still-fresh Set-of-Mark target by 1-based mark number, or undefined if expired/absent. */
export function somMark(
  windowId: string,
  which: number,
  nowMs = Date.now(),
): SomMark | undefined {
  const entry = somMarksByWindow.get(windowId);
  if (!entry) return undefined;
  if (nowMs - entry.at > SOM_TTL_MS) {
    somMarksByWindow.delete(windowId);
    return undefined;
  }
  return entry.marks.find((mark) => mark.id === which);
}

/** The window a call was approved for, kept so the step lands in that window and no other. */
const approvedTargets = new WeakMap<object, WindowDetail>();

export function targetFor(input: object): WindowDetail | undefined {
  return approvedTargets.get(input);
}

function nameOf(window: Pick<WindowDetail, "app" | "title">): string {
  return `${window.app} ("${window.title}")`;
}

/** One step, in words the user can check at a glance. */
export function describeStep(input: OperateInput, where: string, listed?: string): string {
  const what = input.name
    ? `"${input.name}"`
    : input.which
      ? `number ${input.which}${listed ? ` (the ${listed})` : " (she did not say which control that is)"}`
      : "";
  switch (input.action) {
    case "controls":
      return `Read the controls of ${where}`;
    case "press":
      return `Press ${what || "a control"} in ${where}`;
    case "click":
      return `${input.how === "double" ? "Double-click" : input.how === "right" ? "Right-click" : "Click"} on ${what || "a spot"} in ${where}`;
    case "fill":
      return `Fill in ${what || "the field"} in ${where} with:\n${input.text ?? ""}`;
    case "type":
      return `Type into ${where}:\n${input.text ?? ""}`;
    case "key":
      return `Press the key${(input.amount ?? 1) > 1 ? ` ${input.amount} times` : ""} ${input.keys ?? ""} in ${where}`;
    case "scroll":
      return `Scroll ${(input.amount ?? 3) < 0 ? "up" : "down"} in ${where}`;
  }
}

function isAction(value: unknown): value is OperateAction {
  return OPERATE_ACTIONS.includes(value as OperateAction);
}

/** Reads a tool call's input into the shape the rules use. Unknown actions are rejected. */
export function readOperateInput(input: unknown): OperateInput {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (!isAction(raw["action"])) {
    throw new Error(`operate needs an action: ${OPERATE_ACTIONS.join(", ")}.`);
  }
  const text = (key: string): string | undefined =>
    typeof raw[key] === "string" && raw[key].length > 0 ? raw[key] : undefined;
  const number = (key: string): number | undefined =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? Math.trunc(raw[key]) : undefined;
  return {
    action: raw["action"],
    window: text("window"),
    name: text("name"),
    which: number("which"),
    text: text("text"),
    keys: text("keys"),
    amount: number("amount"),
    how: text("how"),
  };
}

/**
 * Decides one `operate` call. Throws (in words for her) when the window may not be
 * touched or cannot be told apart; otherwise says whether the user is asked, and how.
 */
export async function operateVerdict(input: unknown, context: PolicyContext): Promise<Verdict> {
  const step = readOperateInput(input);
  if (!context.windows) throw new Error("Working other programs is not available here.");
  const target = pickTarget(step, await context.windows(), context.ownApps ?? []);
  const refusal = forbidden(target, step.action, context.ownApps ?? [], context.userAddress);
  if (refusal) throw new Error(refusal);
  if (typeof input === "object" && input !== null) approvedTargets.set(input, target);
  const where = nameOf(target);

  if (step.action === "controls") {
    if (context.maySeeScreen && !context.away) return { decision: "allow" };
    return {
      decision: "ask",
      sensitive: false,
      reason:
        "She will read the names of that window's buttons, menus and fields, and what is written in them. Nothing leaves this computer.",
      summary: { title: "Let her read this window's controls?", detail: where, note: null },
      rememberable: true,
    };
  }

  const typed = step.action === "type" || step.action === "fill";
  if (typed && context.readOutsideText && (step.text ?? "").length > MAX_TYPED_CHARS) {
    throw new Error(
      `That is too long to type now (${MAX_TYPED_CHARS} characters at most once you have read outside text). Save it to a file with write_file instead.`,
    );
  }
  // What a bare number stands for, from the list or Set-of-Mark view she was last shown for this window.
  const chosenControl =
    step.which !== undefined && !step.name ? listedControl(target.id, step.which) : undefined;
  const chosenSom =
    step.which !== undefined && !chosenControl ? somMark(target.id, step.which) : undefined;
  const listed = chosenControl
    ? `${chosenControl.kind} "${chosenControl.name}"`
    : chosenSom
      ? `${chosenSom.kind} "${chosenSom.label}"`
      : undefined;
  const named = [
    step.name ?? "",
    chosenControl?.name ?? "",
    chosenSom?.near ?? "",
    chosenSom?.label ?? "",
  ].join(" ");
  let each: string | null = null;
  if (isOutward(target)) {
    each =
      "This program reaches outside this computer or changes the system, so each step is shown to you.";
  } else if (
    (step.action === "press" || step.action === "click") &&
    (isRiskyName(named) || (step.which !== undefined && !step.name))
  ) {
    // A number names nothing: what it points at is only known to her, so it is shown.
    each = isRiskyName(named)
      ? "This could be hard to undo, so it is shown to you on its own."
      : "She chose this one from a list by its number, so check it is the one you mean.";
  } else if (step.action === "key" && !isCalmKey(step.keys ?? "")) {
    each = "A key can confirm, close or delete, depending on the program.";
  } else if (typed && runsWhatIsTyped(target)) {
    each =
      "This program can run what is typed into it (a terminal panel or a command line), so what she types is shown to you.";
  } else if ((typed || step.action === "key") && context.readOutsideText) {
    each =
      "She has read a web page, a file or a program's output in this conversation, so check this is what you want typed.";
  }
  if (each) {
    return {
      decision: "ask",
      sensitive: false,
      reason: each,
      summary: { title: "Let her do this?", detail: describeStep(step, where, listed), note: null },
      rememberable: false,
    };
  }
  return {
    decision: "ask",
    sensitive: false,
    reason:
      'If you choose "for this chat" she will go on working in this program without asking each step. Anything that reads like deleting, sending or confirming is still shown to you first.',
    summary: {
      title: "Let her work in this program?",
      detail: target.app,
      note: `First step: ${describeStep(step, `"${target.title}"`)}`,
    },
    rememberable: true,
  };
}
