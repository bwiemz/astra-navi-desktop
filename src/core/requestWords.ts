import { describeRemoteForRecord, readRemoteInput } from "./fleetRules.ts";
import { describeStep, listedControl, readOperateInput, targetFor } from "./operateRules.ts";
import {
  describePlan,
  missionFor,
  missionToResume,
  orderFor,
  type RequestSummary,
  stringField,
  TOOLS,
} from "./permissions.ts";
import { describeCheck, describeCondition } from "./standingOrders.ts";

/**
 * How a tool call is put to the user: the plain question, with exactly what would
 * happen. The rules for whether to ask at all are in `permissions.ts`.
 */

function clipboardRequest(text: string): RequestSummary {
  // Line ends are shown, because a trailing one makes a pasted command run by itself.
  const shown = text.replaceAll("\r", "\\r").replaceAll("\n", "\\n\n");
  return {
    title: "Put this on your clipboard?",
    detail: shown.slice(0, 1200),
    note: `${text.length} character${text.length === 1 ? "" : "s"}. This is all of it.`,
  };
}

/** Turns a tool call into the plain question the user is asked. */
export function describeRequest(toolName: string, input: unknown): RequestSummary {
  switch (toolName) {
    case TOOLS.runCommand:
      return {
        title: "Run this command?",
        detail: stringField(input, "command") ?? "",
        note: stringField(input, "why"),
      };
    case TOOLS.writeFile: {
      const content = stringField(input, "content") ?? "";
      const preview = content.length > 280 ? `${content.slice(0, 280)}…` : content;
      return {
        title: "Save this file?",
        detail: stringField(input, "path") ?? "",
        note: `${content.length} characters. It starts:\n${preview}`,
      };
    }
    case TOOLS.readFile:
      return { title: "Read this file?", detail: stringField(input, "path") ?? "", note: null };
    case TOOLS.lookAtScreen:
      return {
        title: "Let her look at your screen?",
        detail: "The whole screen, as it is now",
        note: null,
      };
    case TOOLS.windows:
      return {
        title: `${stringField(input, "action") === "close" ? "Close" : "Change"} this window?`,
        detail: stringField(input, "window") ?? "",
        note: null,
      };
    case TOOLS.sound: {
      const level = (input as { level?: unknown } | null)?.level;
      const action = stringField(input, "action") ?? "";
      return {
        title: "Control the sound?",
        detail:
          action === "set_volume" && typeof level === "number" ? `set_volume to ${level}%` : action,
        note: null,
      };
    }
    case TOOLS.clipboard:
      return stringField(input, "action") === "read"
        ? { title: "Let her read your clipboard?", detail: "What you last copied", note: null }
        : clipboardRequest(stringField(input, "text") ?? "");
    case TOOLS.lockScreen:
      return { title: "Lock the screen?", detail: "", note: null };
    case TOOLS.selfCheck:
      return { title: "Check her own systems?", detail: "", note: null };
    case TOOLS.webSearch:
      return {
        title: "Look this up online?",
        detail: stringField(input, "query") ?? "",
        note: null,
      };
    case TOOLS.findApps:
      return {
        title: "Look through your apps?",
        detail: stringField(input, "query") ?? "",
        note: null,
      };
    case TOOLS.shipStatus:
      return { title: "Check the PC's state?", detail: "", note: null };
    case TOOLS.recall:
      return {
        title: "Search her memory?",
        detail: `${stringField(input, "query") ?? ""}${stringField(input, "where") === "conversations" ? " (in past conversations)" : ""}`,
        note: null,
      };
    case TOOLS.tidyStorage:
      return {
        title: "Delete what she keeps but does not use?",
        detail: "Every downloaded brain model except the one in use, and the voice designer",
        note: null,
      };
    case TOOLS.research:
      return {
        title: "Research this in the background?",
        detail: stringField(input, "question") ?? "",
        note: null,
      };
    case TOOLS.calculate:
      return {
        title: "Work this out?",
        detail: stringField(input, "expression") ?? "",
        note: null,
      };
    case TOOLS.weather:
      return {
        title: "Check the weather here?",
        detail: stringField(input, "place") ?? "",
        note: null,
      };
    case TOOLS.findFiles:
      return {
        title: "Look for files here?",
        detail: stringField(input, "folder") ?? "your home folder",
        note:
          [
            stringField(input, "name") ? `named like "${stringField(input, "name")}"` : "",
            stringField(input, "content") ? `containing "${stringField(input, "content")}"` : "",
          ]
            .filter(Boolean)
            .join(", ") || null,
      };
    case TOOLS.startMission:
      return {
        title: "Start this job in the background?",
        detail: stringField(input, "command") ?? "",
        note: stringField(input, "title"),
      };
    case TOOLS.agenda: {
      const action = stringField(input, "action");
      if (action === "add") {
        const end = stringField(input, "end");
        return {
          title: "Put this on her agenda?",
          detail: (stringField(input, "title") ?? "").slice(0, 200),
          note: `For ${stringField(input, "start") || "an unstated time"}${end ? `, until ${end}` : ""}.`,
        };
      }
      if (action === "remove") {
        return {
          title: "Take this off her agenda?",
          detail: (stringField(input, "id") ?? "").slice(0, 40),
          note: null,
        };
      }
      const record = (typeof input === "object" && input !== null ? input : {}) as Record<
        string,
        unknown
      >;
      const days = typeof record["days"] === "number" && record["days"] > 0 ? record["days"] : 1;
      return {
        title: "Look at the agenda",
        detail: `${stringField(input, "from") || "today"}, ${days} day${days === 1 ? "" : "s"}`,
        note: null,
      };
    }
    case TOOLS.setReminder: {
      const record = (typeof input === "object" && input !== null ? input : {}) as Record<
        string,
        unknown
      >;
      const when =
        typeof record["in_minutes"] === "number"
          ? `in ${record["in_minutes"]} minutes`
          : `at ${stringField(input, "at") ?? "an unstated time"}`;
      return {
        title: "Set this reminder?",
        detail: stringField(input, "text") ?? "",
        note: `For ${when}${record["daily"] === true ? ", repeating every day" : ""}.`,
      };
    }
    case TOOLS.reminders:
      return {
        title: (stringField(input, "cancel") ?? "").startsWith("w-")
          ? "Cancel this standing order?"
          : "Cancel this reminder?",
        detail: stringField(input, "cancel") ?? "",
        note: null,
      };
    case TOOLS.keepWatch: {
      const order = orderFor(input);
      return {
        title: "Keep watch",
        detail: order
          ? `${order.title}: ${describeCheck(order.check)}, until ${describeCondition(order)}`
          : // Never put to the user (it was refused): what she asked for, cut short.
            `${stringField(input, "title") ?? ""}: ${stringField(input, "command") || stringField(input, "address") || ""} on ${stringField(input, "where") || "this PC"}`.slice(
              0,
              300,
            ),
        note: null,
      };
    }
    case TOOLS.missions:
      if (missionToResume(input) !== null) {
        return {
          title: "Take this mission up again?",
          detail: missionToResume(input) ?? "",
          note: null,
        };
      }
      if (stringField(input, "pin")?.trim()) {
        return {
          title: "Share this mission with your devices?",
          detail: (stringField(input, "pin") ?? "").trim(),
          note: null,
        };
      }
      if (
        typeof input === "object" &&
        input !== null &&
        (input as Record<string, unknown>)["unpin"] === true
      ) {
        return {
          title: "Stop sharing the pinned mission with your devices?",
          detail: (stringField(input, "id") ?? "").trim(),
          note: null,
        };
      }
      if (stringField(input, "note")?.trim()) {
        return {
          title: "Add a steering note to this mission?",
          detail: (stringField(input, "note") ?? "").trim().slice(0, 600),
          note: stringField(input, "id"),
        };
      }
      return {
        title: "Stop this background job or mission?",
        detail: stringField(input, "stop") ?? "",
        note: null,
      };
    case TOOLS.planMission: {
      const mission = missionFor(input);
      return {
        title: "Plan a mission",
        detail: mission
          ? describePlan(mission)
          : // Never put to the user (it could not be made): what she asked for, cut short.
            (stringField(input, "title") ?? "").slice(0, 200),
        note: null,
      };
    }
    case TOOLS.deckLog:
      return {
        title: "Add this line to the Deck Log?",
        detail: stringField(input, "entry") ?? "",
        note: null,
      };
    case TOOLS.remember:
      return {
        title: "Keep this note about you?",
        detail: stringField(input, "text") ?? "",
        note: null,
      };
    case TOOLS.forget:
      return { title: "Delete this note?", detail: stringField(input, "id") ?? "", note: null };
    case TOOLS.readWebPage:
      return {
        title: "Open this web address?",
        detail: stringField(input, "url") ?? "",
        note: null,
      };
    case TOOLS.open:
      return { title: "Open this?", detail: stringField(input, "target") ?? "", note: null };
    case TOOLS.operate:
      try {
        const step = readOperateInput(input);
        // The program the rules settled on, once they have; before that, her own words.
        const target = typeof input === "object" && input !== null ? targetFor(input) : undefined;
        const chosen =
          target && step.which !== undefined && !step.name
            ? listedControl(target.id, step.which)
            : undefined;
        return {
          title: "Let her do this?",
          detail: describeStep(
            step,
            target?.app ?? (step.window ? `"${step.window}"` : "the window in front"),
            chosen ? `${chosen.kind} "${chosen.name}"` : undefined,
          ),
          note: null,
        };
      } catch {
        return { title: "Let her work in a program?", detail: "", note: null };
      }
    case TOOLS.phone: {
      const action = stringField(input, "action") ?? "";
      const what =
        stringField(input, "text") ?? stringField(input, "link") ?? stringField(input, "path");
      return {
        title: "Send this to your phone?",
        detail: [action.replace(/_/g, " "), what].filter(Boolean).join(": "),
        note: null,
      };
    }
    case TOOLS.listenToPc:
      return { title: "Let her listen to what the PC played?", detail: "", note: null };
    case TOOLS.notifications:
      return {
        title: "Let her read the desktop's notifications?",
        detail: (stringField(input, "app") ?? "").slice(0, 60),
        note: null,
      };
    case TOOLS.remote:
      try {
        const step = readRemoteInput(input);
        return {
          title: "Let her do this on another machine?",
          detail: describeRemoteForRecord(input),
          note: step.why ?? null,
        };
      } catch {
        return { title: "Let her work on another machine?", detail: "", note: null };
      }
    default:
      return {
        title: `Use ${toolName}?`,
        detail: JSON.stringify(input, null, 2).slice(0, 600),
        note: null,
      };
  }
}
