/**
 * A record of one reply: what was put to her, which tools she was offered, what she
 * called and how each call ended, what she said, which of the app's own checks stepped
 * in, and how long it all took.
 *
 * It serves two ends. Looked at straight away it answers "why did she do that": the
 * last few are kept in memory for the page in Settings that shows them. Kept over many
 * replies it is the raw material for teaching the small brain: a reply the checks sent
 * back, next to the second go that did the thing properly, is a ready-made pair of
 * "not this, but this"; a reply from the standard brain that needed no correction is an
 * example to learn from.
 *
 * Everything in it is the local model's own output and the tools' own answers. Nothing
 * is written here by anyone else, and her private thinking is left out. It never leaves
 * the computer, is written to disk only when that is switched on, and what the app
 * promises never to write down (a notification's text) is not in it at all.
 */

/** How a tool call ended, as the gate recorded it. */
export type CallOutcome = "done" | "failed" | "declined" | "refused";

/** Permission gate decision recorded alongside each tool call. */
export type CallGate = "allow" | "ask-allowed" | "ask-declined" | "refused";

export interface TracedCall {
  tool: string;
  /** What she asked the tool for, as JSON. Long values are cut short. */
  input: string;
  /** What the tool answered, cut short. Empty when it may not be kept. */
  result: string;
  outcome: CallOutcome;
  /** True when the user was asked before it ran (or would have run). */
  asked: boolean;
  ms: number;
  gate?: CallGate;
  gateReason?: string;
}

/** One of the app's checks stepping in after a reply. */
export interface TracedCheck {
  /**
   * What was found: she said a thing was done that was not ("claimed"), said she had
   * looked without looking ("looked"), answered something only a tool can tell
   * ("unchecked"), said she would look and stopped ("stopped"), said she had no way
   * while offered only some tools ("no-way"), did a sum without the calculator ("sum"),
   * or wrote out a sum that does not come to what she said ("wrong-sum").
   */
  found: "claimed" | "looked" | "unchecked" | "stopped" | "no-way" | "sum" | "wrong-sum";
  /** She was sent back to do it ("again"), or a note was put under her reply ("note"). */
  did: "again" | "note";
}

export interface TurnTrace {
  /** When the reply began, as an ISO time. */
  at: string;
  /** Who it answered: the user, the ship (a reminder, a finished job), or her own second go. */
  kind: "user" | "ship" | "again";
  /** True when answering a message from a paired remote device rather than the desktop PC. */
  away?: boolean;
  /** What was said to her, without the ship's lines and notes the app puts beside it. */
  said: string;
  spoken: boolean;
  /** Which brain wrote it, by its label. */
  brain: string;
  /** The tools on offer, by name. */
  offered: string[];
  /** Why each tool beyond the core was offered, when tools are chosen per message. */
  pickedFor?: Record<string, string>;
  calls: TracedCall[];
  /** What she said, as shown to the user. Empty when it may not be kept. */
  reply: string;
  checks: TracedCheck[];
  /** True when something in this reply may not be written down, and so was left out. */
  withheld: boolean;
  ms: {
    whole: number;
    firstWord: number | null;
    stt?: number | null;
    llm?: number | null;
    tools?: number | null;
    tts?: number | null;
  };
  /** Tokens read and written by the model for this reply, held at its end, and exact prompt size. */
  tokens: {
    read: number | null;
    written: number | null;
    held: number | null;
    prompt?: number | null;
  };
}

/** Long inputs and answers are cut to this many characters in a trace. */
export const TRACE_CLIP = 2000;

export function clipForTrace(text: string): string {
  return text.length > TRACE_CLIP
    ? `${text.slice(0, TRACE_CLIP)}… (${text.length - TRACE_CLIP} more characters)`
    : text;
}

/** A reply the checks sent back, with the second go that put it right. */
export interface CorrectedPair {
  brain: string;
  said: string;
  offered: string[];
  /** What she said the first time, which was not true of what she had done. */
  rejected: string;
  /** What the check found in it. */
  found: TracedCheck["found"];
  /** What she then did and said. */
  accepted: { calls: TracedCall[]; reply: string };
}

/** A reply that needed nothing put right: what was asked, what she did, what she said. */
export interface CleanExample {
  brain: string;
  said: string;
  offered: string[];
  calls: TracedCall[];
  reply: string;
}

/**
 * Pairs of "not this, but this" out of a run of traces in the order they happened.
 *
 * A pair is made only where the second go is one to learn from: it follows its reply
 * directly, a tool was really carried out in it, no check stepped in again, and nothing
 * in either was withheld. A second go that merely said "I cannot" teaches nothing here.
 */
export function correctedPairs(traces: readonly TurnTrace[]): CorrectedPair[] {
  const pairs: CorrectedPair[] = [];
  traces.forEach((first, index) => {
    const second = traces[index + 1];
    const sentBack = first.checks.find((check) => check.did === "again");
    if (!second || !sentBack || first.kind !== "user" || second.kind !== "again") return;
    if (first.withheld || second.withheld || second.checks.length > 0) return;
    if (!second.calls.some((call) => call.outcome === "done")) return;
    if (first.reply.trim() === "" || second.reply.trim() === "") return;
    pairs.push({
      brain: first.brain,
      said: first.said,
      // The second go is offered everything; what she had to choose from is what counts.
      offered: second.offered,
      rejected: first.reply,
      found: sentBack.found,
      accepted: { calls: second.calls, reply: second.reply },
    });
  });
  return pairs;
}

/**
 * Replies that needed no correction and used at least one tool to the end, as examples
 * of doing it right the first time. Replies to the ship's own messages are left out:
 * they are answers to the app, not to a person.
 */
export function cleanExamples(traces: readonly TurnTrace[]): CleanExample[] {
  return traces
    .filter(
      (trace, index) =>
        trace.kind === "user" &&
        !trace.withheld &&
        trace.checks.length === 0 &&
        trace.reply.trim() !== "" &&
        trace.calls.length > 0 &&
        trace.calls.every((call) => call.outcome === "done") &&
        // Not one whose second go follows: that one was sent back for another reason.
        traces[index + 1]?.kind !== "again",
    )
    .map((trace) => ({
      brain: trace.brain,
      said: trace.said,
      offered: trace.offered,
      calls: trace.calls,
      reply: trace.reply,
    }));
}

/** The last few traces, newest last, for the page that shows them. Nothing is written to disk. */
export class TraceKeeper {
  private readonly kept: TurnTrace[] = [];
  private readonly most: number;

  constructor(most = 40) {
    this.most = most;
  }

  add(trace: TurnTrace): void {
    this.kept.push(trace);
    while (this.kept.length > this.most) this.kept.shift();
  }

  /** Attaches or accumulates TTS synthesis time onto the most recent trace. */
  noteTts(ms: number): void {
    const last = this.kept.at(-1);
    if (!last || !Number.isFinite(ms) || ms < 0) return;
    last.ms = {
      ...last.ms,
      tts: (last.ms.tts ?? 0) + Math.round(ms),
    };
  }

  list(): TurnTrace[] {
    return [...this.kept];
  }

  clear(): void {
    this.kept.length = 0;
  }
}

// ---------------------------------------------------------------- for the page that shows them

/** One call as the page shows it: cut short, and its ending in plain words. */
export interface ShownCall {
  tool: string;
  /** "worked", "ran and failed", "you said no", "not run: the app's rules stopped it". */
  ended: string;
  asked: boolean;
  ms: number;
  gate?: string;
  gateReason?: string;
  input: string;
  result: string;
}

/** One reply as the page shows it. Everything in it is ready to be put on the page as text. */
export interface ShownTrace {
  at: string;
  kind: TurnTrace["kind"];
  said: string;
  reply: string;
  brain: string;
  /** How it went, in a few words: "2 calls, 1 failed, sent back once". */
  summary: string;
  /** How many tools were on offer. */
  offered: number;
  /** Names of active tool schemas offered for this turn. */
  offeredTools: string[];
  /** The tools picked out for this message beyond the everyday ones, and why. Empty when all are always offered. */
  picked: { tool: string; why: string }[];
  calls: ShownCall[];
  /** What the app's own checks did, one sentence each. */
  checks: string[];
  withheld: boolean;
  ms: TurnTrace["ms"];
  tokens: TurnTrace["tokens"];
}

/** How much of each kind of text the page is given. */
export const SHOWN_SAID = 300;
export const SHOWN_REPLY = 800;
export const SHOWN_CALL_TEXT = 400;

function cut(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most)}…` : text;
}

const ENDED: Record<CallOutcome, string> = {
  done: "worked",
  failed: "ran and failed",
  declined: "you said no",
  refused: "not run: the app's rules stopped it",
};

const GATE_LABELS: Record<CallGate, string> = {
  allow: "allowed automatically",
  "ask-allowed": "approved by you",
  "ask-declined": "declined by you",
  refused: "blocked by rules",
};

const FOUND: Record<TracedCheck["found"], string> = {
  claimed: "She said it was done, or under way, with nothing done",
  looked: "She said she had looked without looking",
  unchecked: "She answered something only a tool can tell, without using one",
  stopped: "She said she would look, and then stopped",
  "no-way": "She said she had no way, while offered only some of her tools",
  sum: "She did a sum without the calculator",
  "wrong-sum": "A sum she wrote out does not come to what she said",
};

/** What one of the app's checks did, as a sentence. */
export function describeCheck(check: TracedCheck): string {
  const did =
    check.did === "again"
      ? check.found === "no-way"
        ? "given every tool and sent back to try once more"
        : check.found === "sum"
          ? "sent back to use it"
          : "sent back to do it properly"
      : check.found === "wrong-sum"
        ? "the right figure was put under her reply"
        : "a note saying so was put under her reply";
  return `${FOUND[check.found]}: ${did}.`;
}

/** Why a tool was picked out for a message, in words for the user. */
export function describePick(reason: string): string {
  if (reason === "words") return "named in what you said";
  if (reason.startsWith("meaning")) return "close in meaning to what you said";
  if (reason === "used just now") return "used or called for a moment ago";
  if (reason === "names a machine") return "you named one of your machines";
  if (reason === "no hints") return "always offered";
  // "goes with keep_watch" already reads as it should.
  return reason;
}

/** How a reply went, in a few words. */
export function describeTrace(trace: TurnTrace): string {
  const parts: string[] = [];
  const count = (outcome: CallOutcome): number =>
    trace.calls.filter((call) => call.outcome === outcome).length;
  if (trace.calls.length === 0) parts.push("no tools used");
  else {
    parts.push(trace.calls.length === 1 ? "1 call" : `${trace.calls.length} calls`);
    if (count("failed") > 0) parts.push(`${count("failed")} failed`);
    if (count("declined") > 0) parts.push(`${count("declined")} you said no to`);
    if (count("refused") > 0) parts.push(`${count("refused")} not allowed`);
  }
  if (trace.checks.some((check) => check.did === "again")) parts.push("sent back once");
  if (trace.checks.some((check) => check.did === "note")) parts.push("a note put under it");
  return parts.join(", ");
}

/**
 * The kept records as the page shows them: newest first, long text cut short, endings
 * and checks in plain words. Nothing is added that was not in the record.
 */
export function forShow(traces: readonly TurnTrace[]): ShownTrace[] {
  return [...traces].reverse().map((trace) => ({
    at: trace.at,
    kind: trace.kind,
    said: cut(trace.said, SHOWN_SAID),
    reply: cut(trace.reply, SHOWN_REPLY),
    brain: trace.brain,
    summary: describeTrace(trace),
    offered: trace.offered.length,
    offeredTools: [...trace.offered],
    picked: Object.entries(trace.pickedFor ?? {}).map(([tool, reason]) => ({
      tool,
      why: describePick(reason),
    })),
    calls: trace.calls.map((call) => ({
      tool: call.tool,
      ended: ENDED[call.outcome],
      asked: call.asked,
      ms: call.ms,
      ...(call.gate ? { gate: GATE_LABELS[call.gate] } : {}),
      ...(call.gateReason ? { gateReason: cut(call.gateReason, SHOWN_CALL_TEXT) } : {}),
      input: cut(call.input, SHOWN_CALL_TEXT),
      result: cut(call.result, SHOWN_CALL_TEXT),
    })),
    checks: trace.checks.map(describeCheck),
    withheld: trace.withheld,
    ms: trace.ms,
    tokens: trace.tokens,
  }));
}
