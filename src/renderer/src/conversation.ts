import type { PermissionRiskLevel, VoiceState } from "../../shared/ipc.ts";

/**
 * The parts of her window's conversation view that are plain reckoning, kept apart from
 * the page so they can be tested without one: the trail of steps in a reply, which
 * thing said belongs to which reply, the day lines of the log, and when an answer to an
 * approval question counts.
 */

// ---------- the steps she takes in a reply ----------

export interface Step {
  label: string;
  /** She did it; she is waiting to be allowed; the user allowed it; or it was not allowed. */
  kind: "did" | "asking" | "allowed" | "refused";
  /** The question this step is about, for a step that began as one. */
  question?: string;
  /** For a question that did not end in a yes: the user said no, or nobody answered. */
  refusal?: "said-no" | "not-answered";
  /** True once an allowed question's step carries the name of what she then did. */
  named?: boolean;
}

/**
 * The words on the mark that says how a question ended. The mark is an element of its
 * own, drawn by the page; nothing in a step's label can make one.
 */
export function stepAnswer(step: Step): string | null {
  if (step.kind === "allowed") return "You allowed it";
  if (step.kind !== "refused") return null;
  return step.refusal === "not-answered" ? "Not answered" : "You said no";
}

const TICKS_AND_CROSSES = /^[\s✓✔✕✖✗✘☑☒❌❎✅]+/u;
const BRACKETED_ENDING = /\s*[([{（【][^()[\]{}（）【】]*[)\]}）】]\s*$/u;
// "yes", "no" and "ok" are whole words here: "note", "now" and "okra" claim nothing.
const CLAIMS_AN_ANSWER =
  /\b(you|user|captain|owner)\b.*\b(allow\w*|approv\w*|permit\w*|agree\w*|said|say\w*|told|confirm\w*|accept\w*|grant\w*|ok|okay|yes|no)\b|\b(allowed|approved|permitted|authori[sz]ed|confirmed|granted|not answered|unanswered)\b/i;

/**
 * A step's label as it may be shown. Her tools name their own steps, and some of that
 * text comes from the model, so anything shaped like the marks the page itself draws is
 * taken off: a tick or cross in front, and an ending such as "(you allowed it)".
 */
export function cleanStepLabel(label: string): string {
  let text = label.replace(/\s+/g, " ").trim().replace(TICKS_AND_CROSSES, "");
  for (let i = 0; i < 4; i++) {
    const ending = BRACKETED_ENDING.exec(text);
    if (!ending || !CLAIMS_AN_ANSWER.test(ending[0])) break;
    text = text.slice(0, ending.index).trimEnd();
  }
  // The same claim without brackets, after a dash or a colon at the very end.
  text = text.replace(
    /\s*[-–—:,;]\s*(you|the user|captain)\s+(allowed|approved|said\s+(yes|no|ok)|agreed|confirmed)(\s+(it|this|that))?[.!]?$/i,
    "",
  );
  return text.slice(0, 200) || "A step";
}

/**
 * She asks before she does anything that needs asking, and only names the step once she
 * has been allowed. So a question always gets a step of its own: it is never laid over
 * a step that went before it, which was a different thing and needed no asking.
 */
export function stepAsked(steps: Step[], id: string, title: string): void {
  // "Run this command?" reads better in the trail without its question mark.
  steps.push({
    label: cleanStepLabel(title.replace(/\?\s*$/, "")),
    kind: "asking",
    question: id,
  });
}

/**
 * Records how a question ended, on the step that was made for it. `allowed` is how it
 * really ended, as her brain reports it; what was pressed in the window only tells a
 * no the user gave from one nobody gave. A yes pressed just as the reply was stopped
 * never reached her, so it is not shown as one.
 */
export function stepAnswered(
  steps: Step[],
  id: string,
  allowed: boolean,
  pressed: "allow" | "allow-session" | "deny" | undefined,
): void {
  const step = steps.find((candidate) => candidate.question === id);
  if (!step || step.kind !== "asking") return;
  if (allowed) {
    step.kind = "allowed";
  } else {
    step.kind = "refused";
    step.refusal = pressed === "deny" ? "said-no" : "not-answered";
  }
}

/**
 * A tool is about to run. Straight after a question was allowed, this is that same
 * step under its proper name, so the name replaces the question's and the mark of
 * having been allowed stays. Otherwise it is a step that needed no asking.
 */
export function stepDone(steps: Step[], label: string): void {
  const allowed = steps.find((step) => step.kind === "allowed" && step.named !== true);
  if (allowed) {
    allowed.label = cleanStepLabel(label);
    allowed.named = true;
    return;
  }
  steps.push({ label: cleanStepLabel(label), kind: "did" });
}

// ---------- which thing said belongs to which reply ----------

export interface Said {
  text: string;
  at: number;
  /** The device it came from, for something sent from one of the user's other devices. */
  from?: string;
  /** For something typed in her window: which of the things typed it was, counted from 1. */
  typed?: number;
}

/** Things said to her that she has not started answering yet, oldest first. */
export interface SaidWaiting {
  /** Typed or spoken at the PC. */
  here: Said[];
  /** Sent from another device. */
  away: Said[];
}

/** Where a reply came from: something said at the PC or from afar, or her own doing. */
export type Origin =
  | { kind: "here" }
  | { kind: "away"; from: string | null }
  | { kind: "herself" }
  | { kind: "correction" };

/** Something said at the PC is matched to her next reply only if that starts within this long. */
export const SAID_HERE_WAITS_MS = 2 * 60_000;
/** A message from another device can wait in line behind others, so it is kept longer. */
export const SAID_AWAY_WAITS_MS = 15 * 60_000;

function dropStale(queue: Said[], cutoff: number): void {
  while (queue[0] && queue[0].at < cutoff) queue.shift();
}

/**
 * Takes from the waiting lists what the reply now starting is an answer to. A reply to
 * another device takes only from that list, and one she starts herself (an event, or
 * putting her last answer right) takes nothing: what was typed at the PC meanwhile
 * still belongs to the reply that will answer it.
 */
export function takeSaid(
  waiting: SaidWaiting,
  turn: { initiated: boolean; away?: boolean; correction?: boolean },
  now: number,
): { said: string | null; origin: Origin } {
  dropStale(waiting.here, now - SAID_HERE_WAITS_MS);
  dropStale(waiting.away, now - SAID_AWAY_WAITS_MS);
  if (turn.correction === true) return { said: null, origin: { kind: "correction" } };
  if (turn.initiated) return { said: null, origin: { kind: "herself" } };
  if (turn.away === true) {
    const next = waiting.away.shift();
    return { said: next?.text ?? null, origin: { kind: "away", from: next?.from ?? null } };
  }
  return { said: waiting.here.shift()?.text ?? null, origin: { kind: "here" } };
}

/**
 * Her reply was stopped, and with it everything that was waiting behind it was dropped
 * unanswered. Those things are taken off the waiting lists, or the next reply would be
 * shown as the answer to one of them. The reply that was stopped took its own already.
 *
 * `typedTaken` is how many typed messages the app had received when it stopped her:
 * one typed since then is still on its way to her and will be answered, so it stays.
 * Everything else on the lists was put there by the app itself, before the stop.
 */
export function dropWaiting(waiting: SaidWaiting, typedTaken: number): void {
  waiting.here = waiting.here.filter((said) => said.typed !== undefined && said.typed > typedTaken);
  waiting.away = [];
}

/** The caption above a reply in the log: what was said, or why there is nothing to quote. */
export function saidCaption(
  said: string | null,
  origin: Origin,
): { text: string; from: string | null; isEvent: boolean } {
  switch (origin.kind) {
    case "correction":
      return { text: "She put her last answer right", from: null, isEvent: true };
    case "herself":
      return { text: "She spoke first", from: null, isEvent: true };
    case "away": {
      const from = `From ${origin.from ?? "another device"}`;
      return said === null
        ? { text: from, from: null, isEvent: true }
        : { text: said, from, isEvent: false };
    }
    case "here":
      return said === null
        ? { text: "Your message", from: null, isEvent: true }
        : { text: said, from: null, isEvent: false };
  }
}

/**
 * Whether a finished exchange has anything to put in the log. A message that was
 * stopped before she said or did anything is still kept: the user did say it.
 */
export function worthLogging(entry: {
  said: string | null;
  reply: string;
  steps: number;
  caution: string | null;
}): boolean {
  return entry.reply !== "" || entry.steps > 0 || entry.caution !== null || entry.said !== null;
}

// ---------- the day lines of the log ----------

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** The calendar day a moment falls on, in local time. Two moments share a day exactly when these match. */
export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * What a day is called as of `now`. This is worked out whenever the log is drawn, never
 * stored: the line that read "Today" last night is "Yesterday" this morning.
 */
export function dayLabel(key: string, now: number): string {
  if (key === dayKey(now)) return "Today";
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "Yesterday";
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** What the list of the log holds, as far as trimming it goes. */
export interface LogItemKind {
  kind: "day" | "said" | "other";
  /** The calendar day of the exchange a caption opens. */
  day?: string;
}

/**
 * Taking the oldest exchange off the top of the log: how many items go (a day line
 * above it, its caption, and what follows up to where the next exchange starts), and
 * the day to name above what is left when that would otherwise start without a day
 * line (the next exchange was on the same day, so it never had one of its own).
 */
export function trimOldest(items: readonly LogItemKind[]): {
  remove: number;
  dayLineFor: string | null;
} {
  let remove = 0;
  let pastCaption = false;
  for (const item of items) {
    if (pastCaption && item.kind !== "other") break;
    pastCaption ||= item.kind === "said";
    remove += 1;
  }
  const next = items[remove];
  return { remove, dayLineFor: next?.kind === "said" ? (next.day ?? null) : null };
}

// ---------- asking for something that may be overtaken ----------

/**
 * Tells the latest request from the ones it replaced. An answer that comes back after
 * a newer request was made, or after the whole thing was called off, is not to be used:
 * the history asked for before "forget" must not put back what was just erased.
 */
export class Latest {
  private current = 0;

  /** Starts a request; any still under way are overtaken. Returns its ticket. */
  begin(): number {
    this.current += 1;
    return this.current;
  }

  /** Overtakes whatever is under way, without starting anything. */
  callOff(): void {
    this.current += 1;
  }

  isLatest(ticket: number): boolean {
    return ticket === this.current;
  }
}

// ---------- an approval question ----------

/**
 * Says, in words, that a box holds more than it shows. Null when all of it is on show.
 * `lines` is how many lines the text has as written (a long line wraps into several).
 */
export function scrollHint(
  lines: number,
  box: { scrollTop: number; clientHeight: number; scrollHeight: number },
): string | null {
  if (box.scrollHeight <= box.clientHeight + 1) return null;
  const size = lines > 1 ? `${lines} lines` : "One long line";
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
  if (atEnd) return `${size}. This is the end.`;
  return `${size}. Scroll to read the rest.`;
}

/**
 * Whether a click or a key press may answer the question on show.
 *
 * Nothing counts in the first moment after a question appears: a click or key meant for
 * the one before it must not land on this one. A key press on a button only counts when
 * the button was reached after the question appeared, so Space or Enter on a button
 * that happened to hold the focus already can never answer it. And a pointer click only
 * counts when the button was pressed down after that first moment: a button held down
 * since the question before, and let go on this one, answers nothing.
 */
export interface StatusPillState {
  kind: "ready" | "listening" | "thinking" | "job" | "vram-yielded" | "hands-off";
  label: string;
  showStop: boolean;
}

/** Computes the always-visible avatar status pill from runtime senses, voice, and brain state. */
export function computeStatusPill(input: {
  handsOff: boolean;
  busy: boolean;
  activityLabel: string | null;
  voiceState: VoiceState;
  activeJobs: number;
  asleep: boolean;
  asleepFor: string | null;
}): StatusPillState {
  if (input.handsOff) {
    return {
      kind: "hands-off",
      label: "Hands Off",
      showStop: input.busy || input.voiceState !== "off",
    };
  }
  if (input.busy) {
    return {
      kind: "thinking",
      label: input.activityLabel?.trim() || "Thinking",
      showStop: true,
    };
  }
  if (input.voiceState === "listening" || input.voiceState === "hearing" || input.voiceState === "transcribing" || input.voiceState === "starting") {
    const label =
      input.voiceState === "hearing"
        ? "Hearing you"
        : input.voiceState === "transcribing"
          ? "Transcribing"
          : input.voiceState === "starting"
            ? "Starting mic"
            : "Listening";
    return { kind: "listening", label, showStop: true };
  }
  if (input.activeJobs > 0) {
    return {
      kind: "job",
      label: input.activeJobs === 1 ? "Background Job" : `${input.activeJobs} Background Jobs`,
      showStop: false,
    };
  }
  if (input.asleep) {
    return {
      kind: "vram-yielded",
      label: input.asleepFor ? `VRAM Yielded (${input.asleepFor})` : "VRAM Yielded",
      showStop: false,
    };
  }
  return { kind: "ready", label: "Ready", showStop: false };
}

export function mayAnswer(attempt: {
  now: number;
  shownAt: number;
  guardMs: number;
  /** A pointer click on a button, Space or Enter on a focused button, or the Escape key. */
  by: "pointer" | "key-on-button" | "escape";
  /** When one of the question's buttons last took the focus; null if none has since it appeared. */
  buttonFocusedAt: number | null;
  /** When a pointer last went down on one of the question's buttons; null if none has since it appeared. */
  pointerDownAt: number | null;
  /** Optional risk level of the pending request. */
  risk?: PermissionRiskLevel;
  /** Optional button decision being attempted. */
  decision?: "allow" | "allow-session" | "deny";
  /** When the user last typed in the chat box, for high-impact typing guardrails. */
  lastTypedAt?: number | null;
  typingGuardMs?: number;
  /** True while the chat textarea is focused. */
  inputFocused?: boolean;
  /** Optional keyboard key name when `by === "key-on-button"`. */
  key?: string;
}): boolean {
  if (attempt.now - attempt.shownAt < attempt.guardMs) return false;
  if (attempt.by === "escape") return true;
  if (attempt.by === "key-on-button") {
    if (attempt.buttonFocusedAt === null || attempt.buttonFocusedAt < attempt.shownAt) {
      return false;
    }
    if (attempt.decision !== "deny") {
      if (attempt.inputFocused === true) return false;
      if (attempt.risk === "high-impact") {
        if (attempt.key === "Enter") return false;
        const guardWindow = attempt.typingGuardMs ?? 1500;
        if (
          attempt.lastTypedAt !== null &&
          attempt.lastTypedAt !== undefined &&
          attempt.now - attempt.lastTypedAt < guardWindow
        ) {
          return false;
        }
      }
    }
    return true;
  }
  return (
    attempt.pointerDownAt !== null && attempt.pointerDownAt >= attempt.shownAt + attempt.guardMs
  );
}
