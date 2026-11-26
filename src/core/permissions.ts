import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { WindowDetail } from "./desktop.ts";
import { operateVerdict } from "./operateRules.ts";
import type { Backup, Machine } from "./fleet.ts";
import { remoteChangesSomething, remoteVerdict, shown } from "./fleetRules.ts";
import { compareText } from "./textDiff.ts";
import {
  describeWake,
  planMission,
  type DurableMission,
  type MissionRequest,
  type MissionWakeTrigger,
} from "./missionPlan.ts";
import {
  BROAD_REASON,
  canonical,
  classifyCommand,
  type CommandRisk,
  hasShellExpansion,
  isInside,
  isPlainWebAddress,
  isPrivatePath,
  resolvePath,
  SENSITIVE_REASON,
  WEB_REASON,
} from "./riskRules.ts";
import { isReadOnlyCommand } from "./shell.ts";
import {
  auditSecurityRules,
  type RuleAuditFinding,
  type RuleAuditInput,
  type RuleAuditReport,
  type RuleAuditSeverity,
} from "./ruleAudit.ts";
import {
  describeCheck,
  describeCondition,
  makeOrder,
  type OrderRequest,
  type StandingOrder,
} from "./standingOrders.ts";

// What is risky about a path, a command or an address, for those who ask it of the rules.
export {
  classifyCommand,
  type CommandRisk,
  hasShellExpansion,
  isBroadPath,
  isPlainWebAddress,
  isPrivateIpv4,
  isPublicIp,
  isSensitivePath,
} from "./riskRules.ts";

/**
 * The rules for what the assistant may do without asking.
 *
 * The assistant reads web pages, and a page can try to talk it into things. These
 * rules are what stands between such a page and the user's files, so they err toward
 * asking: anything they cannot be sure about is shown to the user.
 *
 * - "allow": harmless, goes ahead.
 * - "ask": the user is shown exactly what would happen and decides.
 */
export type Verdict =
  | { decision: "allow" }
  | {
      decision: "ask";
      sensitive: boolean;
      reason: string;
      /** How the question is put, when the rule knows more than the bare request shows. */
      summary?: RequestSummary;
      /** Whether "for this chat" may be offered; left out, the tool's usual answer applies. */
      rememberable?: boolean;
      /** Command classification when originating from run_command / start_mission. */
      commandRisk?: CommandRisk;
    };

export interface PolicyContext {
  /** The assistant's own folder; it may create and edit files here freely. */
  workspace: string;
  home?: string;
  /**
   * True for a web address the user wrote or a search returned. Other addresses could have
   * been made up to carry information out, so opening one asks first. When left out,
   * every ordinary public address counts as known.
   */
  isKnownAddress?(url: string): boolean;
  /**
   * True once this reply has read text from outside (a web page, a file). From then on
   * a note-to-self could be something that text told her to write, so saving one asks.
   */
  readOutsideText?: boolean;
  /**
   * True on turns where external MCP server tool schemas/descriptions are offered to the model.
   * Persistence and exfiltration built-ins escalate to `"ask"` so an adversarial MCP tool
   * description cannot silently write memories, reminders, agenda items, or clipboard contents,
   * while `readOnlyAutoAllow` MCP calls on a clean turn still proceed without prompt fatigue.
   */
  mcpSchemasOffered?: boolean;
  /**
   * Files she may only change through their own tool (the Deck Log), even though they
   * sit in her folder. Otherwise writing the file directly would dodge that tool's check.
   */
  protectedFiles?: readonly string[];
  /** The user has said she may look at the screen without asking each time. */
  maySeeScreen?: boolean;
  /** The user has taken her hands off the controls: she may look things up, and nothing else. */
  handsOff?: boolean;
  /**
   * Folders holding her own settings, memory and records, wherever they have been put.
   * Reading or writing inside them is treated like any other private place.
   */
  privateDirs?: readonly string[];
  /** The open windows, for the rules about working inside other programs. */
  windows?(): Promise<readonly WindowDetail[]>;
  /** The app's own windows, by program name. She never works her own controls. */
  ownApps?: readonly string[];
  /** Finds one of the user's other machines by name, or throws saying which there are. */
  findMachine?(name: string): Machine;
  /**
   * Looks on one of those machines for what a question is about to be put about: the
   * present text of a file she wants to replace, the copies she kept. For the user's
   * eyes only; see `remoteVerdict`.
   */
  remoteLook?: {
    text(machine: Machine, path: string): Promise<string | null>;
    backups(machine: Machine): Promise<Backup[]>;
    backupText(machine: Machine, id: string): Promise<string | null>;
  };
  /** The user's other machines, for a standing order that is to look at one of them. */
  machines?(): readonly Machine[];
  /**
   * The message being answered came from one of the user's other devices. Whoever holds
   * that device is not at the PC, so nothing that shows what is on it or what it played
   * goes ahead on standing permission.
   */
  away?: boolean;
  /** Optional policy hook evaluated for signed SDK `plugin:` tool calls. */
  pluginPolicy?(toolName: string, input: unknown): Verdict;
  /** Optional policy hook evaluated for native MCP `mcp:<server>.<tool>` calls. */
  mcpPolicy?(toolName: string, input: unknown): Verdict;
}

// ---------- the verdict ----------

export function stringField(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export interface RequestSummary {
  title: string;
  detail: string;
  note: string | null;
  diff?: string | null;
  rawCommand?: string | null;
}

/** The most text she may put on the clipboard: all of it has to fit in the question the user is shown. */
export const MAX_CLIPBOARD_CHARS = 600;

/** The tools the assistant has. Their names are what the model calls. */
export const TOOLS = {
  runCommand: "run_command",
  readFile: "read_file",
  writeFile: "write_file",
  webSearch: "web_search",
  readWebPage: "read_web_page",
  remember: "remember",
  recall: "recall",
  forget: "forget",
  findApps: "find_apps",
  openApp: "open_app",
  open: "open",
  shipStatus: "ship_status",
  setReminder: "set_reminder",
  reminders: "reminders",
  startMission: "start_mission",
  planMission: "plan_mission",
  missions: "missions",
  deckLog: "deck_log",
  calculate: "calculate",
  weather: "weather",
  findFiles: "find_files",
  lookAtScreen: "look_at_screen",
  windows: "windows",
  sound: "sound",
  clipboard: "clipboard",
  lockScreen: "lock_screen",
  research: "research",
  selfCheck: "self_check",
  tidyStorage: "tidy_storage",
  operate: "operate",
  listenToPc: "listen_to_pc",
  phone: "phone",
  remote: "remote",
  keepWatch: "keep_watch",
  notifications: "notifications",
  agenda: "agenda",
} as const;

const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  TOOLS.webSearch,
  TOOLS.recall,
  TOOLS.findApps,
  TOOLS.openApp,
  TOOLS.shipStatus,
  TOOLS.calculate,
  TOOLS.weather,
  TOOLS.sound,
  TOOLS.lockScreen,
  TOOLS.selfCheck,
  TOOLS.listenToPc,
  // Reading them is switched on by the user; the switch is the consent.
  TOOLS.notifications,
]);
/** Tools that never change anything, whatever they are given. */
const ONLY_LOOKS: ReadonlySet<string> = new Set([
  TOOLS.readFile,
  TOOLS.webSearch,
  TOOLS.readWebPage,
  TOOLS.recall,
  TOOLS.findApps,
  TOOLS.shipStatus,
  TOOLS.calculate,
  TOOLS.weather,
  TOOLS.findFiles,
  TOOLS.lookAtScreen,
  TOOLS.selfCheck,
  TOOLS.listenToPc,
  // Reading them is switched on by the user; the switch is the consent.
  TOOLS.notifications,
]);

/** The standing order the user was asked about for a keep_watch call, by its arguments object. */
const settledOrders = new WeakMap<object, StandingOrder>();
const settledMissions = new WeakMap<object, DurableMission>();

/** The mission that was put to the user for these arguments, or undefined when none was. */
export function missionFor(input: unknown): DurableMission | undefined {
  return typeof input === "object" && input !== null ? settledMissions.get(input) : undefined;
}

/** A plan_mission call's arguments in the form the mission rules take. */
export function missionRequest(input: unknown): MissionRequest {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const steps = Array.isArray(record["steps"]) ? (record["steps"] as unknown[]) : [];
  const startIn = record["start_in_minutes"];
  const cron = stringField(input, "cron")?.trim() ?? "";
  const afterOrder = stringField(input, "after_order")?.trim() ?? "";
  const waitIdleGpu = record["wait_for_idle_gpu"] === true;
  const repeatCron = record["repeat_cron"] === true;
  const pinToDevices = record["pin_to_devices"] === true;
  const wakeCount = (cron ? 1 : 0) + (afterOrder ? 1 : 0) + (waitIdleGpu ? 1 : 0);
  let wake: MissionWakeTrigger | null = null;
  let wakeError: string | undefined;
  if (wakeCount > 1) {
    wakeError =
      "Choose only one wake condition per mission (cron, after_order, or wait_for_idle_gpu).";
  } else if (cron !== "") {
    wake = { kind: "cron", expression: cron, repeat: repeatCron };
  } else if (afterOrder !== "") {
    wake = { kind: "standing_order", orderId: afterOrder };
  } else if (waitIdleGpu) {
    wake = { kind: "idle_gpu", maxBusyPercent: 25 };
  }
  return {
    title: stringField(input, "title") ?? "",
    goal: stringField(input, "goal") ?? "",
    steps: steps.slice(0, 40).map((step) => ({
      title: stringField(step, "title") ?? "",
      where: stringField(step, "where") ?? "",
      command: stringField(step, "command") ?? "",
      retries:
        typeof (step as Record<string, unknown> | null)?.["retries"] === "number"
          ? ((step as Record<string, unknown>)["retries"] as number)
          : 0,
    })),
    notBefore:
      typeof startIn === "number" && Number.isFinite(startIn) && startIn > 0
        ? new Date(Date.now() + Math.min(startIn, 60 * 24 * 30) * 60_000).toISOString()
        : null,
    wake,
    ...(wakeError ? { wakeError } : {}),
    pinnedToDevices: pinToDevices,
  };
}

/**
 * The steps of a mission as the user is shown them before it is taken on. A plan with
 * a character in a command that would not show is never made; should one reach here
 * all the same, the character is written out as its number rather than left unseen.
 */
export function describePlan(mission: DurableMission): string {
  const steps = mission.steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.title}${step.where === "here" ? "" : ` (on ${step.whereName})`}\n   ${shown(step.command)}${step.retries > 0 ? `\n   tried again up to ${step.retries} times if it fails` : ""}`,
    )
    .join("\n");
  const wake = mission.wake ? `\nWake trigger: ${describeWake(mission.wake)}.` : "";
  const when = mission.notBefore
    ? `\nNot before ${new Date(mission.notBefore).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.`
    : "";
  const shared = mission.pinnedToDevices
    ? "\nShared with your signed-in devices (only this mission's thread and steps)."
    : "";
  return `${mission.title}${mission.goal ? `\nFor: ${mission.goal}` : ""}\n\n${steps}${wake}${when}${shared}`;
}

/** The order that was put to the user for these arguments, or undefined when none was. */
export function orderFor(input: unknown): StandingOrder | undefined {
  return typeof input === "object" && input !== null ? settledOrders.get(input) : undefined;
}

/** A keep_watch call's arguments in the form the standing-order rules take. */
export function orderRequest(input: unknown): OrderRequest {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const every = record["every_minutes"];
  return {
    title: stringField(input, "title") ?? "",
    where: stringField(input, "where") ?? "",
    command: stringField(input, "command") ?? "",
    address: stringField(input, "address") ?? "",
    tellWhen: stringField(input, "tell_me_when") ?? "",
    value: stringField(input, "value") ?? "",
    ...(typeof every === "number" ? { everyMinutes: every } : {}),
    repeat: record["repeat"] === true,
  };
}

/**
 * True when a tool call would change something: on the computer, in her memory, or in
 * what she will do later. This is what "hands off" blocks. Anything not known to be
 * harmless counts as a change.
 */
/**
 * The mission a call to `missions` asks to have taken up again, or null. Her tools are
 * made to fill in every field, so "list them" arrives with an empty one: that is no
 * request to resume anything.
 */
export function missionToResume(input: unknown): string | null {
  const id = (stringField(input, "resume") ?? "").trim();
  return id === "" ? null : id;
}

export function missionToPin(input: unknown): string | null {
  const id = (stringField(input, "pin") ?? "").trim();
  return id === "" ? null : id;
}

export function missionWantsUnpin(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>)["unpin"] === true
  );
}

export function missionNote(input: unknown): string | null {
  const note = (stringField(input, "note") ?? "").trim();
  return note === "" ? null : note;
}

export function changesSomething(toolName: string, input: unknown): boolean {
  if (ONLY_LOOKS.has(toolName)) return false;
  const action = stringField(input, "action");
  switch (toolName) {
    case TOOLS.windows:
      return action !== "list";
    case TOOLS.sound:
      return action !== "now_playing" && action !== "get_volume";
    case TOOLS.clipboard:
      return action !== "read";
    case TOOLS.operate:
      return action !== "controls";
    case TOOLS.phone:
      return action !== "list";
    case TOOLS.remote:
      return remoteChangesSomething(input);
    case TOOLS.reminders:
      return stringField(input, "cancel") !== null;
    case TOOLS.agenda:
      return action === "add" || action === "remove";
    case TOOLS.missions:
      return (
        (stringField(input, "stop") ?? "").trim() !== "" ||
        missionToResume(input) !== null ||
        missionToPin(input) !== null ||
        missionWantsUnpin(input) ||
        missionNote(input) !== null
      );
    default:
      return true;
  }
}

const UNKNOWN_ADDRESS_REASON =
  "This address did not come from you or from a search result, so check it is one you expect.";

async function commandVerdict(command: string, context: PolicyContext): Promise<Verdict> {
  const commandRisk = await classifyCommand(command, context);
  switch (commandRisk) {
    case "sensitive":
      return { decision: "ask", sensitive: true, reason: SENSITIVE_REASON, commandRisk };
    case "broad":
      return { decision: "ask", sensitive: true, reason: BROAD_REASON, commandRisk };
    case "opaque":
      return {
        decision: "ask",
        sensitive: false,
        reason:
          "This command works out file names as it runs, so it is not clear up front what it will touch.",
        commandRisk,
      };
    case "plain":
      if (isReadOnlyCommand(command)) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: "This command can change things on your computer.",
        commandRisk,
      };
  }
}

/**
 * True when this command, run by her directly, would need no question: it only reads,
 * and it touches no private place. That is the bar for anything that is to run with
 * nobody watching.
 */
export async function runsWithoutAsking(command: string, context: PolicyContext): Promise<boolean> {
  return (await commandVerdict(command, context)).decision === "allow";
}

export async function toolVerdict(
  toolName: string,
  input: unknown,
  context: PolicyContext,
): Promise<Verdict> {
  // From another device she does not report what the PC shows or plays unless someone at
  // the PC says so; and nobody is there, so in practice this is a no.
  if (
    context.away &&
    (toolName === TOOLS.listenToPc ||
      toolName === TOOLS.lookAtScreen ||
      // What the desktop showed is likewise for whoever is at the PC.
      toolName === TOOLS.notifications)
  ) {
    return {
      decision: "ask",
      sensitive: false,
      reason: "This was asked for from another device, not at this PC.",
    };
  }
  if (ALWAYS_ALLOWED.has(toolName)) return { decision: "allow" };

  switch (toolName) {
    case TOOLS.readFile: {
      const raw = stringField(input, "path");
      if (!raw) return { decision: "ask", sensitive: false, reason: "No file path was given." };
      if (isPrivatePath(await resolvePath(raw, context), context)) {
        return { decision: "ask", sensitive: true, reason: SENSITIVE_REASON };
      }
      return { decision: "allow" };
    }
    case TOOLS.writeFile: {
      const raw = stringField(input, "path");
      if (!raw) return { decision: "ask", sensitive: false, reason: "No file path was given." };
      const target = await resolvePath(raw, context);
      if (isPrivatePath(target, context))
        return { decision: "ask", sensitive: true, reason: SENSITIVE_REASON };
      for (const file of context.protectedFiles ?? []) {
        if (target === (await canonical(file))) {
          return {
            decision: "ask",
            sensitive: false,
            reason: "This file is her Deck Log, which she normally only adds single lines to.",
          };
        }
      }
      if (isInside(target, await canonical(context.workspace))) return { decision: "allow" };
      const content = stringField(input, "content") ?? "";
      let diffText: string | null = null;
      let diffNote: string | null = `${content.length} characters.`;
      try {
        const info = await stat(target).catch(() => null);
        if (info?.isFile() && info.size <= 200_000) {
          const prevBytes = await readFile(target);
          if (!prevBytes.includes(0)) {
            const cmp = compareText(prevBytes.toString("utf8"), content, {
              context: 2,
              maxLines: 60,
            });
            diffText = cmp.same ? "(no line changes)" : cmp.text;
            diffNote = cmp.same
              ? `Same contents as current file (${content.length} characters).`
              : `${content.length} characters (+${cmp.added} / -${cmp.removed} lines vs existing file).`;
          }
        } else if (!info) {
          const cmp = compareText("", content, { context: 2, maxLines: 40 });
          diffText = cmp.text;
          diffNote = `New file (${content.length} characters, ${cmp.added} line${cmp.added === 1 ? "" : "s"}).`;
        }
      } catch {
        // Diff preview is best-effort; fallback note above suffices.
      }
      return {
        decision: "ask",
        sensitive: false,
        reason: "This file is outside AI-chan's own folder.",
        summary: {
          title: "Save this file?",
          detail: target,
          note: diffNote,
          ...(diffText !== null ? { diff: diffText } : {}),
        },
      };
    }
    case TOOLS.runCommand:
      return commandVerdict(stringField(input, "command") ?? "", context);
    // The screen can show anything: a password being typed, a private chat. She asks
    // before looking unless the user has said she need not.
    // Research only looks things up, but its question goes out in searches. Once she has
    // read outside text, that text could have put something of the user's into the question.
    case TOOLS.research:
      if (!context.readOutsideText && !context.mcpSchemasOffered) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: context.readOutsideText
          ? "She has read a web page, a file or a program's output in this conversation. The question below will be sent out in searches, so check it holds nothing private."
          : "External MCP tool descriptions are loaded on this turn. The question below will be sent out in searches, so check it holds nothing private.",
      };
    case TOOLS.operate:
      return operateVerdict(input, context);
    case TOOLS.remote:
      return remoteVerdict(input, context, {
        commandIsExact: (command) => !hasShellExpansion(command),
        localFile: async (path) => {
          const resolved = await resolvePath(path, context);
          const isPrivate = isPrivatePath(resolved, context);
          const size = await stat(resolved).then(
            (file) => (file.isFile() ? file.size : null),
            () => null,
          );
          let text: string | null = null;
          if (!isPrivate && size !== null && size <= 200_000) {
            const bytes = await readFile(resolved).catch(() => null);
            if (bytes && !bytes.includes(0)) {
              text = bytes.toString("utf8");
            }
          }
          return { private: isPrivate, size, text };
        },
        ...(context.remoteLook ? { look: context.remoteLook } : {}),
      });
    // The phone is the user's own, so reaching it is free. What goes to it is checked
    // once outside text is about, and a private file is asked about like reading one.
    case TOOLS.phone: {
      const action = stringField(input, "action");
      if (action === "list" || action === "ring") return { decision: "allow" };
      if (action === "send_file") {
        const raw = stringField(input, "path");
        if (raw && isPrivatePath(await resolvePath(raw, context), context)) {
          return { decision: "ask", sensitive: true, reason: SENSITIVE_REASON };
        }
      }
      if (!context.readOutsideText && !context.mcpSchemasOffered) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: context.readOutsideText
          ? "She has read a web page, a file or a program's output in this conversation, so check this is what you want sent to your phone."
          : "External MCP tool descriptions are loaded on this turn, so check this is what you want sent to your phone.",
      };
    }
    // Deleting several gigabytes is always the user's call, however sure she is.
    case TOOLS.tidyStorage:
      return {
        decision: "ask",
        sensitive: false,
        reason:
          "This deletes the brain models she is not using and the voice designer. All of it can be downloaded again later.",
      };
    case TOOLS.lookAtScreen:
      // Thinking back over what she saw while keeping watch takes no new picture; the
      // user allowed that seeing when they switched the watch on.
      if (stringField(input, "when") === "earlier") return { decision: "allow" };
      if (context.maySeeScreen) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: "She will see everything on your screen right now. Nothing leaves this computer.",
      };
    case TOOLS.windows:
      // Closing a window can lose unsaved work; the rest only rearranges the desktop.
      if (stringField(input, "action") !== "close") return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: "Unsaved work in that window could be lost.",
      };
    case TOOLS.clipboard:
      if (stringField(input, "action") === "read") {
        return {
          decision: "ask",
          sensitive: false,
          reason: "The clipboard may hold something private, like a password you just copied.",
        };
      }
      // What she puts there the user will paste somewhere, so it is checked once outside text or MCP schemas are present.
      if (!context.readOutsideText && !context.mcpSchemasOffered) return { decision: "allow" };
      if (context.readOutsideText && (stringField(input, "text") ?? "").length > MAX_CLIPBOARD_CHARS) {
        throw new Error(
          `That is too long to copy now (${MAX_CLIPBOARD_CHARS} characters at most once you have read outside text). Save it to a file with write_file instead.`,
        );
      }
      return {
        decision: "ask",
        sensitive: false,
        reason: context.readOutsideText
          ? "She has read a web page, a file or a program's output in this conversation, so check this is what you want to paste."
          : "External MCP tool descriptions are loaded on this turn, so check this is what you want to paste.",
      };
    case TOOLS.findFiles: {
      // Looking through the user's own folders is free; anywhere else, or a private
      // corner (keys, browser data), is asked about like reading a file there.
      const home = context.home ?? homedir();
      const folder = await resolvePath(stringField(input, "folder")?.trim() || home, context);
      if (isPrivatePath(folder, context)) {
        return { decision: "ask", sensitive: true, reason: SENSITIVE_REASON };
      }
      if (isInside(folder, await canonical(home))) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: "This folder is outside your home folder.",
      };
    }
    // Looking at these lists is free. Cancelling a reminder or stopping a job undoes
    // something the user set up, so it is checked like the other lasting changes.
    case TOOLS.reminders:
    case TOOLS.missions: {
      // Taking a stopped mission up again is the user's call every time, and theirs at
      // the PC: it reopens a step they said no to, or one that was cut off half-way
      // and that nobody has looked at since. She cannot decide that for them, and a
      // device that could ask for it could then answer the step's question itself.
      if (toolName === TOOLS.missions && missionToResume(input) !== null) {
        if (context.away) {
          throw new Error(
            "A stopped mission is taken up again at the PC only. Tell Captain to ask for it there.",
          );
        }
        return {
          decision: "ask",
          sensitive: false,
          rememberable: false,
          reason:
            "It stopped at a step that failed, was refused or was cut off. Taking it up runs or asks about that step again.",
        };
      }
      if (toolName === TOOLS.missions && missionToPin(input) !== null) {
        if (context.away) {
          throw new Error(
            "Pinning a mission for devices can only be done at the PC. Tell Captain to do it there.",
          );
        }
        return {
          decision: "ask",
          sensitive: false,
          rememberable: false,
          reason:
            "Sharing this mission lets your signed-in devices see only this mission's thread, step status, sanitized outputs, and approval cards (never your desktop chat or screen).",
          summary: {
            title: "Share this mission with your devices?",
            detail: missionToPin(input) ?? "",
            note: "Only one mission can be pinned at a time. You can unpin it anytime at the PC.",
          },
        };
      }
      if (toolName === TOOLS.missions && missionWantsUnpin(input)) {
        if (context.away) {
          throw new Error(
            "Unpinning a mission from devices can only be done at the PC. Tell Captain to do it there.",
          );
        }
        if (!context.readOutsideText && !context.mcpSchemasOffered) return { decision: "allow" };
        return {
          decision: "ask",
          sensitive: false,
          reason: context.readOutsideText
            ? "She has read a web page, a file or a program's output in this conversation, so check this is something you want."
            : "External MCP tool descriptions are loaded on this turn, so check this is something you want.",
        };
      }
      if (toolName === TOOLS.missions && missionNote(input) !== null) {
        if (!context.readOutsideText && !context.mcpSchemasOffered) return { decision: "allow" };
        return {
          decision: "ask",
          sensitive: false,
          reason: context.readOutsideText
            ? "She has read a web page, a file or a program's output in this conversation, so check this is something you want."
            : "External MCP tool descriptions are loaded on this turn, so check this is something you want.",
        };
      }
      const undo = stringField(input, "cancel") ?? stringField(input, "stop");
      if (!undo || (!context.readOutsideText && !context.mcpSchemasOffered)) {
        return { decision: "allow" };
      }
      return {
        decision: "ask",
        sensitive: false,
        reason: context.readOutsideText
          ? "She has read a web page, a file or a program's output in this conversation, so check this is something you want."
          : "External MCP tool descriptions are loaded on this turn, so check this is something you want.",
      };
    }
    // A standing order runs again and again with nobody watching, so making one is
    // always put to the user, with the exact check. One that could not be made anyway
    // needs no question: the tool says what is wrong with it and nothing is set.
    case TOOLS.keepWatch: {
      const made = makeOrder(orderRequest(input), context.machines?.() ?? [], new Date());
      if ("problem" in made) return { decision: "allow" };
      const { order } = made;
      // Nor for one that would read a private place: the tool refuses that too.
      if (
        order.check.kind === "command" &&
        order.check.where === "here" &&
        !(await runsWithoutAsking(order.check.command, context))
      ) {
        return { decision: "allow" };
      }
      // The order the user is shown is the order that is set: the tool takes this one
      // and does not work it out a second time, when a machine may have been renamed.
      if (typeof input === "object" && input !== null) settledOrders.set(input, order);
      const summary = {
        title: "Let her keep watch on this?",
        detail: `${order.everyMinutes === 1 ? "Every minute" : `Every ${order.everyMinutes} minutes`} she will ${describeCheck(order.check)},\nand tell you when ${describeCondition(order)}${order.repeat ? ", each time it does" : ""}.`,
        note: `For: "${order.title}"`,
      };
      const ends = order.repeat
        ? "It stops by itself after a week."
        : "It stops by itself once it has told you, or after a week.";
      if (order.check.kind === "address") {
        const { address } = order.check;
        // A web address is not a look at something of the user's own: every look sends
        // the whole address to somebody's server. Text she has read could have put
        // something in it, or chosen the server.
        const unknown = context.isKnownAddress ? !context.isKnownAddress(address) : false;
        return {
          decision: "ask",
          sensitive: context.readOutsideText === true || unknown,
          rememberable: false,
          reason: [
            `Each time, the whole address is sent to that server, so check that nothing in it is private. She learns only whether it answered. ${ends}`,
            isPlainWebAddress(address) ? null : "This address is on your own computer or network.",
            unknown ? UNKNOWN_ADDRESS_REASON : null,
            context.readOutsideText
              ? "She has read a web page, a file or a program's output in this conversation, so check this is something you asked for."
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
          summary,
        };
      }
      return {
        decision: "ask",
        sensitive: false,
        rememberable: false,
        reason: `It only looks. ${ends} You can ask her to list or cancel it.`,
        summary,
      };
    }
    // A mission is taken on only with the user's yes to the whole plan, shown step by
    // step. Each step that would be asked about in conversation is asked about again
    // when it is reached: this yes is to her carrying the plan, not to its commands.
    case TOOLS.planMission: {
      const made = planMission(missionRequest(input), context.machines?.() ?? [], new Date());
      // One that cannot be made is not put to the user: the tool says what is wrong.
      if ("problem" in made) return { decision: "allow" };
      if (context.away && made.mission.pinnedToDevices) {
        throw new Error(
          "Only a mission planned at the PC can be pinned to devices. Tell Captain to pin it at the PC.",
        );
      }
      if (typeof input === "object" && input !== null) settledMissions.set(input, made.mission);
      return {
        decision: "ask",
        sensitive: false,
        rememberable: false,
        reason:
          "She will carry this out step by step, also while you are away or she has been restarted. A step that changes something is put to you again, with its command, when she reaches it.",
        summary: {
          title: "Let her take on this mission?",
          detail: describePlan(made.mission),
          note: null,
        },
      };
    }
    // A background job is a command like any other; running unseen is no reason to ask less.
    case TOOLS.startMission:
      return commandVerdict(stringField(input, "command") ?? "", context);
    // Looking at the agenda is free, from another device too: it is the user's own day,
    // like their reminders. Putting something on her own list, or taking it off, is
    // checked like a reminder, since an invitation she has read could have asked for it.
    case TOOLS.agenda: {
      const action = stringField(input, "action");
      if (action !== "add" && action !== "remove") return { decision: "allow" };
      if (!context.readOutsideText && !context.mcpSchemasOffered) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: context.readOutsideText
          ? "She has read a calendar, a web page, a file or a program's output in this conversation, so check this is something you asked for."
          : "External MCP tool descriptions are loaded on this turn, so check this is something you asked for.",
      };
    }
    // These all write something she will read again later (a note, a reminder that comes
    // back as an event, a log line in the briefing), so they are checked the same way.
    case TOOLS.setReminder:
    case TOOLS.deckLog:
    case TOOLS.remember:
    case TOOLS.forget:
      if (!context.readOutsideText && !context.mcpSchemasOffered) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: context.readOutsideText
          ? "She has read a web page, a file or a program's output in this conversation, so check this is something you want her to keep."
          : "External MCP tool descriptions are loaded on this turn, so check this is something you want her to keep.",
      };
    case TOOLS.readWebPage: {
      const url = stringField(input, "url") ?? "";
      if (!isPlainWebAddress(url)) return { decision: "ask", sensitive: false, reason: WEB_REASON };
      if (context.isKnownAddress && !context.isKnownAddress(url)) {
        return { decision: "ask", sensitive: false, reason: UNKNOWN_ADDRESS_REASON };
      }
      return { decision: "allow" };
    }
    case TOOLS.open: {
      const target = stringField(input, "target") ?? "";
      if (/^https?:\/\//i.test(target)) {
        if (!isPlainWebAddress(target))
          return { decision: "ask", sensitive: false, reason: WEB_REASON };
        if (context.isKnownAddress && !context.isKnownAddress(target)) {
          return { decision: "ask", sensitive: false, reason: UNKNOWN_ADDRESS_REASON };
        }
        return { decision: "allow" };
      }
      return {
        decision: "ask",
        sensitive: false,
        reason: "Opening a file can run it, depending on its type.",
      };
    }
    default: {
      if (toolName.startsWith("plugin:")) {
        if (context.pluginPolicy) {
          const decided = context.pluginPolicy(toolName, input);
          if (decided.decision === "allow" && context.readOutsideText) {
            return {
              decision: "ask",
              sensitive: false,
              reason:
                "She has read outside text in this conversation, so check before running a plugin action.",
            };
          }
          return decided;
        }
        return {
          decision: "ask",
          sensitive: false,
          reason: `Plugin tool "${toolName}" has not been granted standing approval.`,
        };
      }
      if (toolName.startsWith("mcp:")) {
        if (context.mcpPolicy) {
          // `mcpPolicy` (`evaluateMcpToolVerdict`) already enforces `handsOff` and `readOutsideText`,
          // so trust its decision directly without re-escalating clean `readOnlyAutoAllow` calls.
          return context.mcpPolicy(toolName, input);
        }
        return {
          decision: "ask",
          sensitive: false,
          reason: `MCP tool "${toolName}" requires confirmation before connecting or running.`,
        };
      }
      return {
        decision: "ask",
        sensitive: false,
        reason: "AI-chan has not used this tool before.",
      };
    }
  }
}

/** Where a path given to a tool really points, for showing to the user and for acting on. */
export function resolveToolPath(raw: string, context: PolicyContext): Promise<string> {
  return resolvePath(raw, context);
}

export {
  auditSecurityRules,
  type RuleAuditFinding,
  type RuleAuditInput,
  type RuleAuditReport,
  type RuleAuditSeverity,
};

/** Static security policy & rule-conflict audit across configs, standing orders, and automation rules. */
export function auditPolicyConfiguration(input: RuleAuditInput): RuleAuditReport {
  return auditSecurityRules(input);
}
