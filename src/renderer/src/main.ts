import "./style.css";
import { formatAttachedPrompt } from "../../core/dropRouter.ts";
import type { AiReportCategory } from "../../core/aiReport.ts";
import {
  BUILT_IN_EMOTE_PACKS,
  type IdleLoopPreset,
} from "../../shared/avatarMotion.ts";
import type {
  AichanBridge,
  AppState,
  BrainEvent,
  DroppedAttachment,
  Mood,
  PastExchange,
  PermissionRequest,
  PermissionRiskLevel,
  Presence,
  Senses,
  VoiceEvent,
  VoiceState,
  WindowLayout,
} from "../../shared/ipc.ts";
import {
  computeDragPan,
  computeWheelZoom,
  DEFAULT_MODEL_FRAMING,
  type ModelFraming,
} from "../../shared/spatialStage.ts";
import {
  Latest,
  type LogItemKind,
  type Origin,
  type SaidWaiting,
  type Step,
  computeStatusPill,
  dayKey,
  dayLabel,
  dropWaiting,
  mayAnswer,
  saidCaption,
  scrollHint,
  stepAnswer,
  stepAnswered,
  stepAsked,
  stepDone,
  takeSaid,
  trimOldest,
  worthLogging,
} from "./conversation.ts";
import { renderMarkdown } from "./markdown.ts";
import { Stage } from "./stage.ts";
import { VoiceIO } from "./voice.ts";

declare global {
  interface Window {
    aichan: AichanBridge;
    /** Developer aid used by AI_CHAN_DEBUG_CAPTURE. */
    aichanDebug?: () => unknown;
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const bridge = window.aichan;
const balloon = element<HTMLElement>("balloon");
const live = element<HTMLElement>("live");
const liveScroll = element<HTMLElement>("live-scroll");
const heard = element<HTMLElement>("heard");
const caution = element<HTMLElement>("caution");
const reply = element<HTMLElement>("reply");
const trail = element<HTMLOListElement>("trail");
const activity = element<HTMLElement>("activity");
const activityLabel = element<HTMLElement>("activity-label");
const permissionCard = element<HTMLElement>("permission");
const permissionTitle = element<HTMLElement>("permission-title");
const permissionRisk = element<HTMLElement>("permission-risk");
const permissionFlag = element<HTMLElement>("permission-flag");
const permissionDetail = element<HTMLElement>("permission-detail");
const permissionDetailMore = element<HTMLElement>("permission-detail-more");
const permissionPreview = element<HTMLDetailsElement>("permission-preview");
const permissionPreviewSummary = element<HTMLElement>("permission-preview-summary");
const permissionPreviewBody = element<HTMLElement>("permission-preview-body");
const permissionNote = element<HTMLElement>("permission-note");
const permissionNoteMore = element<HTMLElement>("permission-note-more");
const permissionGuardHint = element<HTMLElement>("permission-guard-hint");
const permissionAsk = element<HTMLElement>("permission-ask");
const replyAloud = element<HTMLElement>("reply-aloud");
const permissionSession = element<HTMLButtonElement>("permission-session");
const askForm = element<HTMLFormElement>("ask");
const askInput = element<HTMLTextAreaElement>("ask-input");
const attachmentsContainer = element<HTMLElement>("attachments");
const chips = element<HTMLElement>("chips");
const canvas = element<HTMLCanvasElement>("stage");
const standIn = element<HTMLElement>("stand-in");
const firstRun = element<HTMLElement>("first-run");
const grip = element<HTMLElement>("grip");
const micButton = element<HTMLButtonElement>("mic");
const badges = element<HTMLElement>("badges");
const logPanel = element<HTMLElement>("log");
const logList = element<HTMLOListElement>("log-list");
const logLive = element<HTMLElement>("log-live");
const logAsk = element<HTMLElement>("log-ask");
const logToggle = element<HTMLButtonElement>("log-toggle");
const liveFooter = element<HTMLElement>("live-footer");
const liveForgetLast = element<HTMLButtonElement>("live-forget-last");
const tbPtt = element<HTMLButtonElement>("tb-ptt");
const tbAvatarOnly = element<HTMLButtonElement>("tb-avatar-only");
const tbClickThrough = element<HTMLButtonElement>("tb-click-through");
const tbHandsOff = element<HTMLButtonElement>("tb-hands-off");
const autoFrameBtn = element<HTMLButtonElement>("auto-frame");
const framingTuneToggle = element<HTMLButtonElement>("framing-tune-toggle");
const framingPopover = element<HTMLElement>("framing-popover");
const framingRim = element<HTMLInputElement>("framing-rim");
const framingOutline = element<HTMLInputElement>("framing-outline");
const framingReset = element<HTMLButtonElement>("framing-reset");
const statusPill = element<HTMLElement>("status-pill");
const statusPillLabel = element<HTMLElement>("status-pill-label");
const statusStop = element<HTMLButtonElement>("status-stop");

const IDLE_FACE_RESET_MS = 25_000;
const PERMISSION_CLICK_GUARD_MS = 450;
/** The most exchanges kept on the page; older ones stay in her archive. */
const MAX_LOG_ENTRIES = 160;

let stage: Stage | null = null;
let replyText = "";
let renderQueued = false;
let busy = false;
let notice = "";
let faceResetTimer: number | undefined;
const permissionQueue: PermissionRequest[] = [];
const answeredPermissions = new Map<string, "allow" | "allow-session" | "deny">();
let permissionShownAt = 0;
/** When one of the question's buttons last took the focus, since the question appeared. */
let permissionButtonFocusedAt: number | null = null;
/** When a pointer last went down on one of the question's buttons, since the question appeared. */
let permissionPointerDownAt: number | null = null;
let shownPermissionId: string | null = null;
let lastTypedAt: number | null = null;
let lastPermissionKey: string | undefined;
let voiceState: VoiceState = "off";
let fixedSize = false;
let senses: Senses | null = null;
let asleep = false;
/** The game her brain was put away for, while that is why she is asleep. */
let asleepFor: string | null = null;
let activeJobsCount = 0;
let currentActivityLabel: string | null = null;
let avatarOnly = false;
let clickThrough = false;
const pendingAttachments: DroppedAttachment[] = [];
let loadedModelHash: string | null = null;
let framingSaveTimer: number | null = null;
/** What the live area shows is a finished reply that is already in the conversation list. */
let liveIsLogged = false;

// ---------- window size: small around her, larger only while something is open ----------

let logOpen = false;
let layout: WindowLayout | null = null;
function updateLayout(): void {
  const wanted: WindowLayout =
    avatarOnly
      ? "compact"
      : logOpen && !fixedSize
        ? "log"
        : logOpen || !balloon.hidden || !askForm.hidden
          ? "balloon"
          : "compact";
  document.body.dataset["layout"] = avatarOnly ? "compact" : logOpen ? "log" : wanted;
  document.body.dataset["avatarOnly"] = String(avatarOnly);
  // The badges move up out of the way of the message box while it floats at her feet.
  const floating = !avatarOnly && !askForm.hidden && !logOpen;
  document.body.style.setProperty(
    "--ask-clear",
    floating ? `${askForm.offsetHeight + 24}px` : "0px",
  );
  if (wanted === layout) return;
  layout = wanted;
  bridge.setLayout(wanted);
}

function updateStatusPill(): void {
  const pill = computeStatusPill({
    handsOff: senses?.handsOff ?? false,
    busy,
    activityLabel: currentActivityLabel,
    voiceState,
    activeJobs: activeJobsCount,
    asleep,
    asleepFor,
  });
  statusPill.dataset["kind"] = pill.kind;
  statusPillLabel.textContent = pill.label;
  statusStop.hidden = !pill.showStop;
  tbPtt.setAttribute("aria-pressed", String(voiceState !== "off"));
  tbAvatarOnly.setAttribute("aria-pressed", String(avatarOnly));
  tbClickThrough.setAttribute("aria-pressed", String(clickThrough));
  tbHandsOff.setAttribute("aria-pressed", String(senses?.handsOff ?? false));
}

// ---------- the balloon ----------

/** True when the live area has something in it worth a balloon. */
function liveHasContent(): boolean {
  return (
    replyText !== "" ||
    !heard.hidden ||
    !caution.hidden ||
    !trail.hidden ||
    !permissionCard.hidden ||
    !activity.hidden
  );
}

function showBalloon(): void {
  if (logOpen) {
    // With the conversation open, what is live is shown at its foot, not in a balloon.
    logLive.hidden = !liveHasContent();
    return;
  }
  balloon.hidden = false;
  updateLayout();
}

function hideBalloon(): void {
  if (permissionQueue.length > 0) return; // a pending question must stay visible
  balloon.hidden = true;
  updateLayout();
}

function setReply(text: string, isError = false): void {
  replyText = text;
  if (text) liveIsLogged = false;
  caution.hidden = true; // a caution belongs to the reply it was raised about
  reply.classList.toggle("is-error", isError);
  reply.innerHTML = renderMarkdown(text);
  enhanceCodeBlocks(reply, (code) => bridge.copyText(code));
  liveFooter.hidden = true;
  // Something put up whole (an error, the notice) is read out once; a reply that is
  // being written is read out when it is finished, not as each word lands.
  if (text && (isError || !busy)) replyAloud.textContent = reply.textContent ?? "";
  if (text) showBalloon();
}

/** What was said as the live line shows it: a message from another device says which. */
function heardLine(said: string | null, origin: Origin): string | null {
  if (said === null) return null;
  return origin.kind === "away" && origin.from !== null ? `${origin.from}: ${said}` : said;
}

function setHeard(text: string | null): void {
  heard.hidden = text === null;
  heard.textContent = text ?? ""; // the page's style puts "You said:" before it in the balloon
  if (text !== null) showBalloon();
}

function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const pinned = liveScroll.scrollTop + liveScroll.clientHeight >= liveScroll.scrollHeight - 24;
    reply.innerHTML = renderMarkdown(replyText);
    enhanceCodeBlocks(reply, (code) => bridge.copyText(code));
    if (pinned) liveScroll.scrollTop = liveScroll.scrollHeight;
  });
}

function setActivity(label: string | null): void {
  currentActivityLabel = label;
  activity.hidden = label === null;
  if (label !== null) {
    activityLabel.textContent = label;
    showBalloon();
  } else if (logOpen) {
    logLive.hidden = !liveHasContent();
  }
  updateStatusPill();
  updateLayout();
}

// ---------- the steps she takes in a reply ----------

let steps: Step[] = [];

function stepElement(step: Step): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "step";
  item.dataset["kind"] = step.kind;
  const label = document.createElement("span");
  label.className = "step-label";
  label.textContent = step.label;
  item.append(label);
  const answer = stepAnswer(step);
  if (answer !== null) {
    // How a question ended is a mark of the page's own: no words in a step can draw one.
    const mark = document.createElement("span");
    mark.className = "step-answer";
    mark.textContent = answer;
    item.append(mark);
  }
  return item;
}

function renderSteps(): void {
  // A step she is still asking about is not listed yet: the question itself is on show.
  const settled = steps.filter((step) => step.kind !== "asking");
  trail.replaceChildren(...settled.map((step) => stepElement(step)));
  trail.hidden = settled.length === 0;
}

/** Draws the trail again after a step was added or changed, and keeps its end in view. */
function stepsChanged(): void {
  renderSteps();
  if (trail.hidden) return;
  showBalloon();
  liveScroll.scrollTop = liveScroll.scrollHeight;
}

function clearSteps(): void {
  steps = [];
  renderSteps();
}

// ---------- asking before she changes something ----------

/** How many lines the question's command and its reason have, as written. */
let permissionLines = { detail: 1, note: 1 };

/** Says in words when the command or the reason is longer than its box shows. */
function updatePermissionHints(): void {
  if (permissionCard.hidden) return;
  const boxes = [
    [permissionDetail, permissionDetailMore, permissionLines.detail],
    [permissionNote, permissionNoteMore, permissionLines.note],
  ] as const;
  for (const [box, more, lines] of boxes) {
    const hint = scrollHint(lines, box);
    more.hidden = hint === null;
    if (hint !== null && more.textContent !== hint) more.textContent = hint;
  }
}
permissionDetail.addEventListener("scroll", updatePermissionHints, { passive: true });
permissionNote.addEventListener("scroll", updatePermissionHints, { passive: true });
new ResizeObserver(updatePermissionHints).observe(permissionDetail);
new ResizeObserver(updatePermissionHints).observe(permissionNote);

const RISK_LABELS: Record<PermissionRiskLevel, string> = {
  "read-only": "Read-Only",
  modify: "Modify",
  "high-impact": "High-Impact",
};

function renderDiffPreview(body: HTMLElement, text: string): void {
  body.replaceChildren(
    ...text.split("\n").map((line) => {
      const div = document.createElement("div");
      div.className =
        line.startsWith("+") && !line.startsWith("+++")
          ? "diff-line diff-add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "diff-line diff-del"
            : line.startsWith("@@")
              ? "diff-line diff-hunk"
              : "diff-line";
      div.textContent = line === "" ? " " : line;
      return div;
    }),
  );
}

function showNextPermission(): void {
  const request = permissionQueue[0];
  permissionCard.hidden = request === undefined;
  const isNew = request !== undefined && request.id !== shownPermissionId;
  if (isNew) permissionShownAt = performance.now();
  shownPermissionId = request?.id ?? null;
  if (isNew || !request) {
    // No button of the card keeps the focus from one question into the next, so a key
    // pressed for the last one has nothing here to land on.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && permissionCard.contains(focused)) focused.blur();
    permissionButtonFocusedAt = null;
    // Nor does a button held down since the last one: letting go of it answers nothing.
    permissionPointerDownAt = null;
    permissionGuardHint.hidden = true;
    permissionGuardHint.textContent = "";
    // Emptied first, so that a question worded like the one before it is still said.
    permissionAsk.textContent = "";
  }
  if (request && isNew) {
    const risk: PermissionRiskLevel = request.risk ?? (request.sensitive ? "high-impact" : "modify");
    permissionTitle.textContent = request.title;
    permissionRisk.dataset["risk"] = risk;
    permissionRisk.textContent = RISK_LABELS[risk];
    permissionDetail.textContent = request.detail;
    permissionDetail.scrollTop = 0;
    permissionNote.textContent = request.note ?? "";
    permissionNote.scrollTop = 0;
    if (request.diff) {
      permissionPreviewSummary.textContent = "View file diff";
      renderDiffPreview(permissionPreviewBody, request.diff);
      permissionPreview.open = false;
      permissionPreview.hidden = false;
    } else if (request.rawCommand) {
      permissionPreviewSummary.textContent = "View raw command";
      renderDiffPreview(permissionPreviewBody, request.rawCommand);
      permissionPreview.open = false;
      permissionPreview.hidden = false;
    } else {
      permissionPreviewBody.replaceChildren();
      permissionPreview.open = false;
      permissionPreview.hidden = true;
    }
    permissionLines = {
      detail: request.detail.split("\n").length,
      note: (request.note ?? "").split("\n").length,
    };
    permissionCard.classList.toggle("is-sensitive", request.sensitive);
    permissionFlag.hidden = !request.sensitive;
    permissionSession.hidden = !request.canRemember;
    // Said once to a screen reader, without taking the focus from what the user is doing.
    const firstLine = request.detail.split("\n")[0] ?? "";
    const rest = permissionLines.detail - 1;
    const asking =
      `She is asking before she acts (${RISK_LABELS[risk]}). ${request.title} ${firstLine.slice(0, 300)}` +
      `${rest > 0 ? ` (and ${rest} more ${rest === 1 ? "line" : "lines"})` : ""}. ` +
      "Answer with the buttons in her window, or press Escape for no.";
    window.setTimeout(() => {
      if (shownPermissionId === request.id) permissionAsk.textContent = asking;
    }, 60);
    showBalloon();
    // The question takes room from her reply: keep the end of it, which led to the question, in view.
    liveScroll.scrollTop = liveScroll.scrollHeight;
  } else if (request) {
    showBalloon(); // the same question, still waiting: leave it as the user is reading it
  } else if (logOpen) {
    logLive.hidden = !liveHasContent();
    // The answer was given with a button that is gone now: typing goes on where it was.
    if (document.activeElement === document.body) askInput.focus();
  }
  updateLayout();
  updatePermissionHints();
}

function answerPermission(
  decision: "allow" | "allow-session" | "deny",
  by: "pointer" | "key-on-button" | "escape",
  key?: string,
): void {
  const request = permissionQueue[0];
  if (!request || answeredPermissions.has(request.id)) return;
  const risk: PermissionRiskLevel = request.risk ?? (request.sensitive ? "high-impact" : "modify");
  // A second click (or key) meant for another question must not land on this one,
  // and Enter never confirms high-impact actions automatically.
  const counts = mayAnswer({
    now: performance.now(),
    shownAt: permissionShownAt,
    guardMs: PERMISSION_CLICK_GUARD_MS,
    by,
    buttonFocusedAt: permissionButtonFocusedAt,
    pointerDownAt: permissionPointerDownAt,
    risk,
    decision,
    lastTypedAt,
    inputFocused: document.activeElement === askInput,
    ...(key ? { key } : {}),
  });
  if (!counts) {
    if (by === "key-on-button" && risk === "high-impact" && decision !== "deny") {
      permissionGuardHint.textContent =
        "High-impact action: click the button to confirm, or press Esc to deny.";
      permissionGuardHint.hidden = false;
    }
    return;
  }
  answeredPermissions.set(request.id, decision);
  bridge.answerPermission(request.id, decision);
}

permissionCard.addEventListener("focusin", (event) => {
  if (event.target instanceof HTMLButtonElement) permissionButtonFocusedAt = performance.now();
});
permissionCard.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLButtonElement && (event.key === "Enter" || event.key === " ")) {
    lastPermissionKey = event.key;
    window.setTimeout(() => {
      if (lastPermissionKey === event.key) lastPermissionKey = undefined;
    }, 300);
  }
});
permissionCard.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) {
    permissionPointerDownAt = performance.now();
  }
});

/** A click made with Space or Enter on a focused button carries no click count. */
function answerWith(decision: "allow" | "allow-session" | "deny"): (event: MouseEvent) => void {
  return (event) => {
    const key = lastPermissionKey;
    lastPermissionKey = undefined;
    answerPermission(decision, event.detail === 0 ? "key-on-button" : "pointer", key);
  };
}

element("permission-allow").addEventListener("click", answerWith("allow"));
permissionSession.addEventListener("click", answerWith("allow-session"));
element("permission-deny").addEventListener("click", answerWith("deny"));
element("balloon-close").addEventListener("click", hideBalloon);
element("stop").addEventListener("click", () => bridge.interrupt());

function openLinkIn(container: HTMLElement): void {
  container.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[data-href]");
    if (!link) return;
    event.preventDefault();
    if (link.dataset["href"]) bridge.openLink(link.dataset["href"]);
  });
}
openLinkIn(reply);
openLinkIn(logList);

// ---------- the conversation so far ----------

interface LogEntry {
  at: number;
  /** What was said to her; null when she spoke first, or when it was not caught. */
  said: string | null;
  /** Whether this answers the PC or another device, or is her own doing. */
  origin: Origin;
  reply: string;
  steps: Step[];
  caution: string | null;
  isError: boolean;
}

/** Things said to her that she has not started answering yet. */
const saidWaiting: SaidWaiting = { here: [], away: [] };
let entryInProgress: { at: number; said: string | null; origin: Origin } | null = null;
let entriesShown = 0;
/** The day of the newest exchange in the list, as a calendar day and never as a label. */
let lastDayKey = "";
let historyLoaded = false;
/** Tells an answer about past conversations that came back too late to be used. */
const historyAsked = new Latest();
const sessionStartedAt = Date.now();

/** A line that names a day. It carries the day itself, so its words can be put right later. */
function dayLine(key: string): HTMLLIElement {
  const line = logItem("log-day");
  line.dataset["day"] = key;
  line.textContent = dayLabel(key, Date.now());
  return line;
}

/** "Today" stops being true at midnight: every day line is named afresh as of now. */
function relabelDays(): void {
  const now = Date.now();
  for (const line of logList.querySelectorAll<HTMLElement>(".log-day[data-day]")) {
    const label = dayLabel(line.dataset["day"] ?? "", now);
    if (line.textContent !== label) line.textContent = label;
  }
}
window.setInterval(() => {
  if (logOpen) relabelDays();
}, 60_000);

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function logItem(className: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = className;
  return item;
}

let latestTurnNodes: HTMLElement[] = [];
let latestTurnActionsBar: HTMLElement | null = null;

async function handleForgetLastTurn(putInInput: boolean): Promise<void> {
  const res = await bridge.forgetLastTurn();
  if (!res.removed) return;
  if (latestTurnNodes.length > 0) {
    for (const node of latestTurnNodes) node.remove();
    latestTurnNodes = [];
    entriesShown = Math.max(0, entriesShown - 1);
    if (logList.lastElementChild?.classList.contains("log-day")) {
      logList.lastElementChild.remove();
    }
    const lastSaid = [...logList.querySelectorAll<HTMLElement>(".log-said[data-day]")].at(-1);
    lastDayKey = lastSaid?.dataset["day"] ?? "";
  }
  latestTurnActionsBar?.remove();
  latestTurnActionsBar = null;
  clearLive();
  if (!logOpen) hideBalloon();
  if (putInInput && res.userText) {
    openAsk();
    askInput.value = res.userText;
    growInput();
    askInput.focus();
    askInput.setSelectionRange(askInput.value.length, askInput.value.length);
  }
}

liveForgetLast.addEventListener("click", () => {
  void handleForgetLastTurn(false);
});

/** The list items for one exchange: a day line when the day changes, the caption, her steps, her balloon. */
function entryElements(entry: LogEntry): HTMLLIElement[] {
  const items: HTMLLIElement[] = [];
  const day = dayKey(entry.at);
  if (day !== lastDayKey) {
    lastDayKey = day;
    items.push(dayLine(day));
  }
  const caption = saidCaption(entry.said, entry.origin);
  const said = logItem(caption.isEvent ? "log-said is-event" : "log-said");
  if (caption.from !== null) {
    const from = document.createElement("small");
    from.className = "log-from";
    from.textContent = caption.from;
    said.append(from);
  }
  said.append(caption.text);
  // Kept on the caption, so a day line can be put above it if the one it stood under goes.
  said.dataset["day"] = day;
  said.title = new Date(entry.at).toLocaleString();
  items.push(said);
  if (entry.reply === "" && entry.caution === null && entry.steps.length === 0) {
    // Stopped before she said or did anything: what was asked is still part of the record.
    const stopped = logItem("log-note");
    stopped.textContent = "Stopped before she answered.";
    items.push(stopped);
  }
  if (entry.steps.length > 0) {
    const list = document.createElement("ol");
    list.className = "log-steps";
    list.append(...entry.steps.map((step) => stepElement(step)));
    const holder = logItem("log-steps-holder");
    holder.append(list);
    items.push(holder);
  }
  if (entry.reply !== "" || entry.caution !== null) {
    const her = logItem("log-her");
    const words = document.createElement("div");
    words.className = entry.isError ? "reply is-error" : "reply";
    words.innerHTML = renderMarkdown(entry.reply);
    enhanceCodeBlocks(words, (code) => bridge.copyText(code));
    her.append(words);
    if (entry.caution !== null) {
      const note = document.createElement("p");
      note.className = "caution";
      note.textContent = entry.caution;
      her.append(note);
    }
    const meta = document.createElement("div");
    meta.className = "log-meta";
    const time = document.createElement("time");
    time.dateTime = new Date(entry.at).toISOString();
    time.textContent = clockTime(entry.at);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      bridge.copyText(entry.reply);
      copy.textContent = "Copied";
      window.setTimeout(() => (copy.textContent = "Copy"), 1400);
    });
    meta.append(time, copy);
    her.append(meta);
    items.push(her);
  }
  return items;
}

function attachLatestTurnActions(nodes: HTMLLIElement[]): void {
  latestTurnActionsBar?.remove();
  latestTurnActionsBar = null;
  latestTurnNodes = nodes;
  const target = [...nodes].reverse().find((n) => n.classList.contains("log-her") || n.classList.contains("log-said"));
  if (!target || target.classList.contains("is-event")) return;
  const bar = document.createElement("div");
  bar.className = "log-turn-actions";
  const editResend = document.createElement("button");
  editResend.type = "button";
  editResend.className = "copy";
  editResend.textContent = "Edit & Resend";
  editResend.addEventListener("click", () => {
    void handleForgetLastTurn(true);
  });
  const forgetBtn = document.createElement("button");
  forgetBtn.type = "button";
  forgetBtn.className = "copy";
  forgetBtn.textContent = "Forget Last Turn";
  forgetBtn.addEventListener("click", () => {
    void handleForgetLastTurn(false);
  });
  bar.append(editResend, forgetBtn);
  target.append(bar);
  latestTurnActionsBar = bar;
}

/**
 * Whether the list is following its newest entry. Only the user scrolling back up stops
 * that. The list is also squeezed, sometimes to nothing, while a question is up: that
 * leaves it short of its end without anyone having scrolled, and it must come back
 * showing its end. Being squeezed never moves the list up, which is how the two are told apart.
 */
let logPinned = true;
let logLastTop = 0;
logList.addEventListener(
  "scroll",
  () => {
    const top = logList.scrollTop;
    if (logList.clientHeight > 0) {
      if (top + logList.clientHeight >= logList.scrollHeight - 40) logPinned = true;
      else if (top < logLastTop) logPinned = false;
    }
    logLastTop = top;
  },
  { passive: true },
);
new ResizeObserver(() => {
  if (logPinned) logList.scrollTop = logList.scrollHeight;
}).observe(logList);

/** Shows the newest entry, and keeps to it. */
function logToEnd(): void {
  logPinned = true;
  logList.scrollTop = logList.scrollHeight;
}

function logItemKind(item: Element): LogItemKind {
  if (item.classList.contains("log-day")) return { kind: "day" };
  if (!item.classList.contains("log-said")) return { kind: "other" };
  const day = item instanceof HTMLElement ? item.dataset["day"] : undefined;
  return day === undefined ? { kind: "said" } : { kind: "said", day };
}

function appendEntry(entry: LogEntry): void {
  relabelDays();
  const nodes = entryElements(entry);
  logList.append(...nodes);
  attachLatestTurnActions(nodes);
  entriesShown += 1;
  // The page holds the recent ones; her archive holds the rest.
  while (entriesShown > MAX_LOG_ENTRIES) {
    // The oldest exchange goes whole. If the next one was on the same day it stood under
    // the same day line, which has just gone: it gets one of its own.
    const { remove, dayLineFor } = trimOldest([...logList.children].map(logItemKind));
    if (remove === 0) break;
    for (let gone = 0; gone < remove; gone++) logList.firstElementChild?.remove();
    if (dayLineFor !== null) logList.prepend(dayLine(dayLineFor));
    entriesShown -= 1;
  }
  if (logPinned) logList.scrollTop = logList.scrollHeight;
}

/** Puts the latest exchanges of earlier sessions above this one's, the first time the log is opened. */
async function loadHistory(): Promise<void> {
  if (historyLoaded) return;
  historyLoaded = true;
  const ticket = historyAsked.begin();
  let past: PastExchange[] = [];
  try {
    past = await bridge.history();
  } catch (error) {
    console.error(error);
  }
  // Asked for before the conversations were forgotten: it holds what was just erased.
  if (!historyAsked.isLatest(ticket)) return;
  const earlier = past.filter((exchange) => Date.parse(exchange.at) < sessionStartedAt);
  if (earlier.length === 0) return;
  const sessionItems = [...logList.children];
  const sessionLastDay = lastDayKey;
  logList.replaceChildren();
  lastDayKey = "";
  entriesShown = 0;
  let lastPastNodes: HTMLLIElement[] = [];
  for (const exchange of earlier) {
    lastPastNodes = entryElements({
      at: Date.parse(exchange.at),
      said: exchange.said,
      origin: { kind: "here" },
      reply: exchange.reply,
      steps: [],
      caution: null,
      isError: false,
    });
    logList.append(...lastPastNodes);
    entriesShown += 1;
  }
  // Then a line, and what has been said since she was started. That line stands in for
  // the day line this session began with.
  const line = logItem("log-day");
  line.textContent = "This session";
  const firstSaid = sessionItems.findIndex((item) => !item.classList.contains("log-day"));
  logList.append(line, ...(firstSaid === -1 ? [] : sessionItems.slice(firstSaid)));
  const sessionEntries = sessionItems.filter((item) => item.classList.contains("log-said"));
  if (sessionEntries.length === 0 && lastPastNodes.length > 0) {
    attachLatestTurnActions(lastPastNodes);
  }
  entriesShown += sessionEntries.length;
  // The line stands for today until something is said on another day.
  lastDayKey = sessionEntries.length > 0 ? sessionLastDay : dayKey(Date.now());
  relabelDays();
  logToEnd();
}

/** Past conversations were erased on purpose: nothing of them stays on the page either. */
function forgetLog(): void {
  resetAiReportDialog();
  historyAsked.callOff();
  latestTurnNodes = [];
  latestTurnActionsBar = null;
  logList.replaceChildren();
  entriesShown = 0;
  lastDayKey = "";
  historyLoaded = false;
  if (logOpen) void loadHistory();
}

/** Called when a reply is over: what was said, what she did and what she answered become one entry. */
function finishEntry(): void {
  const started = entryInProgress;
  entryInProgress = null;
  if (!started) return;
  const cautionText = caution.hidden ? null : (caution.textContent ?? "");
  // A question still open when the reply ended was never settled, so it is no step.
  const settled = steps.filter((step) => step.kind !== "asking");
  const worth = worthLogging({
    said: started.said,
    reply: replyText,
    steps: settled.length,
    caution: cautionText,
  });
  if (!worth) return;
  appendEntry({
    at: started.at,
    said: started.said,
    origin: started.origin,
    reply: replyText,
    steps: settled,
    caution: cautionText,
    isError: reply.classList.contains("is-error"),
  });
  liveIsLogged = true;
}

let resetAiReportDialog: () => void = () => undefined;
let refreshAiReportOnNewReply: () => void = () => undefined;

/** Clears what is live. In the panel a finished reply is already in the list above. */
function clearLive(): void {
  resetAiReportDialog();
  setReply("");
  setHeard(null);
  clearSteps();
  logLive.hidden = !liveHasContent();
}

function openLog(): void {
  if (logOpen) return;
  logOpen = true;
  logToggle.setAttribute("aria-pressed", "true");
  logPanel.hidden = false;
  // What is live moves to the foot of the panel, and so does the message box.
  logLive.append(live);
  logAsk.append(askForm);
  balloon.hidden = true;
  askForm.hidden = false;
  grip.hidden = false;
  // A finished reply is in the list above, so it is not shown twice. Anything else that is
  // up (her reply in progress, a question, the notice) comes along to the foot of the panel.
  if (liveIsLogged && !busy && permissionQueue.length === 0) clearLive();
  else if (entryInProgress?.said) {
    setHeard(heardLine(entryInProgress.said, entryInProgress.origin));
  }
  logLive.hidden = !liveHasContent();
  updateLayout();
  relabelDays();
  void loadHistory();
  logToEnd();
  askInput.focus();
}

function closeLog(): void {
  if (!logOpen) return;
  logOpen = false;
  logToggle.setAttribute("aria-pressed", "false");
  logPanel.hidden = true;
  balloon.append(live);
  document.body.append(askForm);
  askForm.hidden = true;
  balloon.hidden = !liveHasContent();
  updateLayout();
}

logToggle.addEventListener("click", () => (logOpen ? closeLog() : openLog()));
element("log-close").addEventListener("click", closeLog);

// ---------- typing to her ----------

const sentBefore: string[] = [];
let recallIndex = -1;
/** How many messages this window has sent her. The app counts them as they arrive. */
let typedSent = 0;

function growInput(): void {
  askInput.style.height = "auto";
  askInput.style.height = `${Math.min(askInput.scrollHeight, 116)}px`;
  askForm.dataset["typing"] = String(askInput.value.trim() !== "");
  updateLayout();
}

function openAsk(): void {
  if (!logOpen) {
    askForm.hidden = false;
    grip.hidden = true;
  }
  growInput();
  askInput.focus();
  updateLayout();
}

function closeAsk(): void {
  if (logOpen) return; // in the panel the box is always there
  askForm.hidden = true;
  grip.hidden = false;
  updateLayout();
}

function renderAttachments(): void {
  attachmentsContainer.hidden = pendingAttachments.length === 0;
  attachmentsContainer.replaceChildren(
    ...pendingAttachments.map((att, idx) => {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.title = att.path;
      const label = document.createElement("span");
      label.textContent = `${att.kind === "image" ? "Img:" : "Doc:"} ${att.name}`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "attachment-remove";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Remove ${att.name}`);
      rm.addEventListener("click", () => {
        pendingAttachments.splice(idx, 1);
        renderAttachments();
      });
      chip.append(label, rm);
      return chip;
    }),
  );
  updateLayout();
}

function sendMessage(text: string): void {
  const message =
    pendingAttachments.length > 0 ? formatAttachedPrompt(text, pendingAttachments) : text.trim();
  if (!message) return;
  pendingAttachments.length = 0;
  renderAttachments();
  if (sentBefore[sentBefore.length - 1] !== message) sentBefore.push(message);
  if (sentBefore.length > 50) sentBefore.shift();
  recallIndex = -1;
  askInput.value = "";
  growInput();
  setHeard(null);
  typedSent += 1;
  saidWaiting.here.push({ text: message, at: Date.now(), typed: typedSent });
  bridge.send(message);
}

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(askInput.value);
});

askInput.addEventListener("input", () => {
  lastTypedAt = performance.now();
  recallIndex = -1;
  growInput();
});

askInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== "Escape") lastTypedAt = performance.now();
  // Enter sends; Shift+Enter makes a new line. Composing text (Japanese, Chinese) is left alone.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage(askInput.value);
    return;
  }
  // Up and Down walk back and forth through what was sent before, while the box holds
  // nothing of its own or something recalled.
  const recalling = recallIndex !== -1 && askInput.value === sentBefore[recallIndex];
  if (event.key === "ArrowUp" && (askInput.value === "" || recalling) && sentBefore.length > 0) {
    event.preventDefault();
    recallIndex = recallIndex === -1 ? sentBefore.length - 1 : Math.max(0, recallIndex - 1);
    askInput.value = sentBefore[recallIndex] ?? "";
    growInput();
  } else if (event.key === "ArrowDown" && recalling) {
    event.preventDefault();
    recallIndex += 1;
    if (recallIndex >= sentBefore.length) recallIndex = -1;
    askInput.value = recallIndex === -1 ? "" : (sentBefore[recallIndex] ?? "");
    growInput();
  }
});

/** A suggestion that is sent as it stands, or (ending in a space) put in the box to be finished. */
function renderChips(): void {
  const offered = [
    "How's the ship?",
    "What's on my screen?",
    "Summarize my clipboard",
    "Check my schedule today",
    "Remind me in 20 minutes to ",
  ];
  const machine = senses?.machines[0];
  if (machine) offered.push(`How is ${machine} doing?`);
  chips.replaceChildren(
    ...offered.map((text) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = text.endsWith(" ") ? `${text.trim()}…` : text;
      chip.addEventListener("click", () => {
        if (text.endsWith(" ")) {
          askInput.value = text;
          growInput();
          askInput.focus();
          askInput.setSelectionRange(text.length, text.length);
        } else {
          sendMessage(text);
        }
      });
      return chip;
    }),
  );
}

// A file dropped on her window puts its path in the message box, ready to be asked about.
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}
window.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  document.body.dataset["dropping"] = "true";
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) delete document.body.dataset["dropping"];
});
window.addEventListener("drop", (event) => {
  delete document.body.dataset["dropping"];
  if (!carriesFiles(event)) return;
  event.preventDefault();
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => bridge.pathForFile(file))
    .filter((path) => path !== "")
    .slice(0, 8);
  if (paths.length === 0) return;
  void bridge.handleDroppedFiles(paths).then((res) => {
    for (const att of res.attachments) {
      if (!pendingAttachments.some((existing) => existing.path === att.path) && pendingAttachments.length < 6) {
        pendingAttachments.push(att);
      }
    }
    renderAttachments();
    if (res.attachments.length > 0) {
      openAsk();
      askInput.focus();
    }
    const notices: string[] = [];
    if (res.avatarsLoaded.length > 0) {
      notices.push(`Loaded avatar: ${res.avatarsLoaded.join(", ")}.`);
    }
    if (res.calendarAdded.length > 0) {
      notices.push(`Added calendar to agenda: ${res.calendarAdded.join(", ")}.`);
    }
    if (res.notes.length > 0) {
      notices.push(...res.notes);
    }
    if (notices.length > 0) {
      if (busy || permissionQueue.length > 0) {
        caution.textContent = notices.join(" ");
        caution.hidden = false;
        showBalloon();
      } else {
        setReply(notices.join("\n\n"));
      }
    }
  });
});

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "l" && event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    if (logOpen) closeLog();
    else openLog();
    return;
  }
  if (event.key !== "Escape") return;
  // While text is being composed (Japanese, Chinese), Escape belongs to the composing: it
  // closes the list of candidates, and must not also turn down a question.
  if (event.isComposing || event.keyCode === 229) return;
  // One press, one step back. A key held down must not go on to turn down the next
  // question, or stop the reply that follows the one it was pressed for.
  if (event.repeat) return;
  // Escape always means "no" or "less": the question, then her reply, then whatever is open.
  if (permissionQueue.length > 0) answerPermission("deny", "escape");
  else if (busy) bridge.interrupt();
  else if (logOpen) closeLog();
  else if (!askForm.hidden) closeAsk();
  else hideBalloon();
});

// ---------- what she is sensing ----------

const BADGES: {
  kind: string;
  shows(now: Senses, isAsleep: boolean): boolean;
  says(now: Senses, asleepFor: string | null): string;
  icon: string;
}[] = [
  {
    kind: "hands-off",
    shows: (now) => now.handsOff,
    says: () => "Hands off the controls: she can talk and look things up, and change nothing.",
    icon: '<path d="M8 11V6.5a1.5 1.5 0 0 1 3 0V10m0-4.5a1.5 1.5 0 0 1 3 0V10m0-3a1.5 1.5 0 0 1 3 0v6c0 4-2.5 7-6 7-2.6 0-4.3-1.4-5.6-4L4 13.5c-.6-1.2.9-2.4 2-1.4l2 1.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  },
  {
    kind: "watching",
    shows: (now) => now.watching,
    says: () => "Keeping an eye on the screen: she knows which window you are in.",
    icon: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  },
  {
    kind: "hearing-pc",
    shows: (now) => now.hearingPc,
    says: () => "Remembering the last minute and a half of what the PC played.",
    icon: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  },
  {
    kind: "station",
    shows: (now) => now.station.open,
    says: (now) =>
      now.station.paired === 0
        ? "Open to your other devices. None is paired yet."
        : `Open to your other devices: ${now.station.paired} paired.`,
    icon: '<rect x="7" y="3" width="10" height="18" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M10.5 17.5h3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  },
  {
    kind: "waiting-for-name",
    shows: (now) => now.waitingForName,
    says: () => "The microphone stays on, waiting for her name.",
    icon: '<path d="M7.5 20c2.2 1.4 4.6.3 5.2-2.2.5-2 2.8-2.8 3.6-5A6.2 6.2 0 1 0 4.8 10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.2 10a2.8 2.8 0 0 1 5.6 0c0 1.2-1.3 1.5-1.8 2.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  },
  {
    kind: "do-not-disturb",
    shows: (now) => now.doNotDisturb,
    says: () => "Do not disturb: she only speaks first about things you asked to be told.",
    icon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" fill="currentColor"/>',
  },
  {
    kind: "asleep",
    shows: (_now, isAsleep) => isAsleep,
    says: (_now, forGame) =>
      forGame
        ? `Resting: she gave the graphics card back to ${forGame}. She wakes when spoken to.`
        : "Her brain is put away to free the graphics card. She wakes when spoken to.",
    icon: '<path d="M5 7h6l-6 7h6M13.5 12h5l-5 6h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
];

function renderBadges(): void {
  const now = senses;
  if (!now) {
    badges.replaceChildren();
    return;
  }
  badges.replaceChildren(
    ...BADGES.filter((badge) => badge.shows(now, asleep)).map((badge) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "badge";
      button.dataset["kind"] = badge.kind;
      const words = `${badge.says(now, asleepFor)} Click for Settings.`;
      button.title = words;
      button.setAttribute("aria-label", words);
      // The icons are fixed drawings written above; nothing from outside goes into them.
      button.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">${badge.icon}</svg>`;
      if (badge.kind === "station" && now.station.paired > 0) {
        const count = document.createElement("span");
        count.className = "badge-count";
        count.textContent = String(now.station.paired);
        button.append(count);
      }
      button.addEventListener("click", () => bridge.openSettings());
      return button;
    }),
  );
}

function onPresence(presence: Presence): void {
  stage?.setVisible(presence.visible);
  stage?.setAsleep(presence.asleep);
  asleep = presence.asleep;
  asleepFor = presence.asleep ? (presence.asleepFor ?? null) : null;
  activeJobsCount = presence.activeJobs ?? 0;
  senses = presence.senses;
  renderBadges();
  renderChips();
  updateStatusPill();
}

// ---------- her brain's events ----------

function setMood(mood: Mood): void {
  stage?.setMood(mood);
  document.body.dataset["mood"] = mood;
}

function onBrainEvent(event: BrainEvent): void {
  switch (event.type) {
    case "status":
      busy = event.state === "thinking";
      stage?.setThinking(busy && replyText === "");
      if (event.state === "thinking") {
        liveFooter.hidden = true;
        window.clearTimeout(faceResetTimer);
        // What was said to her is matched to this reply: from the PC or from another device,
        // each from its own list. A thing she brings up herself has none.
        entryInProgress = { at: Date.now(), ...takeSaid(saidWaiting, event, Date.now()) };
        replyAloud.textContent = "";
        setReply("");
        clearSteps();
        if (logOpen) setHeard(heardLine(entryInProgress.said, entryInProgress.origin));
        setActivity("Thinking");
      } else {
        setActivity(null);
        reply.classList.remove("is-streaming");
        finishEntry();
        liveFooter.hidden = replyText === "" || reply.classList.contains("is-error");
        if (logOpen) clearLive();
        else if (!liveHasContent()) hideBalloon();
        window.clearTimeout(faceResetTimer);
        faceResetTimer = window.setTimeout(() => setMood("neutral"), IDLE_FACE_RESET_MS);
      }
      updateStatusPill();
      break;
    case "setup":
      // Only the first message ever waits on a download; say so, it can take minutes.
      if (event.stage === "downloading") {
        const percent = event.progress === null ? "" : ` ${Math.floor(event.progress * 100)}%`;
        setActivity(`Downloading her brain${percent}. This happens once.`);
      } else if (event.stage === "loading") {
        setActivity("Waking up");
      } else if (busy) {
        setActivity("Thinking");
      }
      break;
    case "reply-start":
      refreshAiReportOnNewReply();
      setReply("");
      break;
    case "text":
      replyText += event.delta;
      reply.classList.toggle("is-streaming", busy);
      stage?.setThinking(false);
      stage?.talk();
      showBalloon();
      queueRender();
      break;
    case "reply-end":
      reply.classList.remove("is-streaming");
      // The whole reply, read out once now that it is finished.
      reply.innerHTML = renderMarkdown(replyText);
      enhanceCodeBlocks(reply, (code) => bridge.copyText(code));
      liveFooter.hidden = replyText === "" || reply.classList.contains("is-error");
      replyAloud.textContent = reply.textContent ?? "";
      break;
    case "mood":
      setMood(event.mood);
      break;
    case "activity":
      // A tool is about to run: it joins the trail, and is what she is doing right now.
      stepDone(steps, event.label);
      stepsChanged();
      setActivity(event.label);
      break;
    case "permission":
      permissionQueue.push(event.request);
      // A question is a step of its own, and stays off the trail until it is answered.
      stepAsked(steps, event.request.id, event.request.title);
      stage?.triggerEventReaction("approval-needed");
      showNextPermission();
      break;
    case "permission-resolved": {
      const index = permissionQueue.findIndex((request) => request.id === event.id);
      const [resolved] = index === -1 ? [] : permissionQueue.splice(index, 1);
      if (resolved) {
        // How it ended is her brain's word; what was pressed here only tells a no from silence.
        stepAnswered(steps, resolved.id, event.allowed, answeredPermissions.get(resolved.id));
        answeredPermissions.delete(resolved.id);
        stepsChanged();
      }
      showNextPermission();
      break;
    }
    case "caution":
      caution.textContent = event.message;
      caution.hidden = false;
      showBalloon();
      stage?.play("shake");
      break;
    case "error":
      setReply(`Something went wrong: ${event.message}`, true);
      setMood("worried");
      break;
  }
}

// ---------- talking with her ----------

const voice = new VoiceIO({
  onMicAudio: (samples) => bridge.sendAudio(samples),
  onSpeakingChange: (speaking) => bridge.setSpeaking(speaking),
  onLevel: (level) => stage?.setVoiceLevel(level),
});

const MIC_LABELS: Record<VoiceState, string> = {
  off: "Talk to her by voice",
  starting: "Getting voice ready (the first time downloads it)",
  listening: "Listening. Click to stop",
  hearing: "Hearing you",
  transcribing: "Working out what you said",
};

function setVoiceState(state: VoiceState): void {
  voiceState = state;
  micButton.dataset["state"] = state;
  micButton.title = MIC_LABELS[state];
  micButton.setAttribute("aria-label", MIC_LABELS[state]);
  micButton.setAttribute("aria-pressed", String(state !== "off"));
  // She leans in while someone is speaking to her.
  stage?.setListening(state === "hearing");
  updateStatusPill();
}

/** Switches the microphone to the state asked for, if it is not already there. */
async function setVoice(on: boolean): Promise<void> {
  if (on !== (voiceState !== "off")) await toggleVoice();
}

async function toggleVoice(): Promise<void> {
  if (voiceState !== "off") {
    voice.stopMic();
    voice.stopPlayback();
    bridge.setListening(false);
    setVoiceState("off");
    return;
  }
  try {
    setVoiceState("starting");
    await voice.startMic();
    bridge.setListening(true);
  } catch (error) {
    setVoiceState("off");
    const reason = error instanceof Error ? error.message : String(error);
    setReply(`The microphone could not be opened: ${reason}`, true);
  }
}

micButton.addEventListener("click", () => void toggleVoice());

function onVoiceEvent(event: VoiceEvent): void {
  switch (event.type) {
    case "state":
      // The app may switch voice off by itself, for example when it fails to start.
      if (event.state === "off" && voice.micOn) voice.stopMic();
      setVoiceState(event.state);
      break;
    case "heard": {
      setHeard(event.from === undefined ? event.text : `${event.from}: ${event.text}`);
      // Her name alone gets no reply, so it waits for none.
      if (event.noReply === true) {
        stage?.triggerEventReaction("wake-word");
      } else {
        const queue = event.from === undefined ? saidWaiting.here : saidWaiting.away;
        queue.push({
          text: event.text,
          at: Date.now(),
          ...(event.from === undefined ? {} : { from: event.from }),
        });
        if (queue.length > 24) queue.shift();
      }
      stage?.play("perk"); // she was spoken to: a small bounce of attention
      break;
    }
    case "audio":
      voice.play(event.samples, event.sampleRate);
      break;
    case "stop":
      voice.stopPlayback();
      break;
    case "error":
      setReply(event.message, true);
      break;
  }
}

// ---------- hover mini-toolbar, status pill, and per-model framing ----------

function syncFramingInputs(framing: ModelFraming): void {
  framingRim.value = String(framing.rimLight);
  framingOutline.value = String(framing.outlineThickness);
}

function scheduleFramingSave(framing: ModelFraming): void {
  if (!loadedModelHash) return;
  const targetHash = loadedModelHash;
  if (framingSaveTimer !== null) window.clearTimeout(framingSaveTimer);
  framingSaveTimer = window.setTimeout(() => {
    framingSaveTimer = null;
    bridge.saveModelFraming(targetHash, framing);
  }, 350);
}

tbPtt.addEventListener("click", () => void toggleVoice());
tbAvatarOnly.addEventListener("click", () => {
  avatarOnly = !avatarOnly;
  updateLayout();
  updateStatusPill();
});
tbClickThrough.addEventListener("click", () => bridge.setClickThrough(!clickThrough));
tbHandsOff.addEventListener("click", () => bridge.setHandsOff(!(senses?.handsOff ?? false)));
statusStop.addEventListener("click", () => {
  bridge.interrupt();
  if (voiceState !== "off") void setVoice(false);
});

autoFrameBtn.addEventListener("click", () => {
  if (!stage) return;
  const reset = stage.autoFrame();
  syncFramingInputs(reset);
  scheduleFramingSave(reset);
});
framingReset.addEventListener("click", () => {
  if (!stage) return;
  const reset = stage.autoFrame();
  syncFramingInputs(reset);
  scheduleFramingSave(reset);
});
framingTuneToggle.addEventListener("click", () => {
  const open = framingPopover.hidden;
  framingPopover.hidden = !open;
  document.body.dataset["framingOpen"] = String(open);
  framingTuneToggle.setAttribute("aria-expanded", String(open));
});
framingRim.addEventListener("input", () => {
  if (!stage) return;
  const updated = stage.setFraming({ rimLight: Number(framingRim.value) });
  scheduleFramingSave(updated);
});
framingOutline.addEventListener("input", () => {
  if (!stage) return;
  const updated = stage.setFraming({ outlineThickness: Number(framingOutline.value) });
  scheduleFramingSave(updated);
});

// ---------- the character: click her to type; wheel zooms & drag repositions ----------

let stageDrag: { x: number; y: number; moved: boolean } | null = null;
let suppressNextStageClick = false;

canvas.addEventListener(
  "wheel",
  (event) => {
    if (!stage || !stage.hasModel) return;
    event.preventDefault();
    const scale = computeWheelZoom(stage.getFraming().scale, event.deltaY);
    const updated = stage.setFraming({ scale });
    scheduleFramingSave(updated);
  },
  { passive: false },
);

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !stage?.hasModel) return;
  stageDrag = { x: event.clientX, y: event.clientY, moved: false };
});

window.addEventListener("pointermove", (event) => {
  stage?.lookAt(
    (event.clientX / window.innerWidth) * 2 - 1,
    (event.clientY / window.innerHeight) * 2 - 1,
  );
  if (!stageDrag || !stage) return;
  const dx = event.clientX - stageDrag.x;
  const dy = event.clientY - stageDrag.y;
  if (!stageDrag.moved && Math.hypot(dx, dy) < 5) return;
  stageDrag.moved = true;
  suppressNextStageClick = true;
  stageDrag.x = event.clientX;
  stageDrag.y = event.clientY;
  const cur = stage.getFraming();
  const panned = computeDragPan(
    { offsetX: cur.offsetX, offsetY: cur.offsetY },
    dx,
    dy,
    canvas.clientHeight || 430,
    cur.scale,
  );
  stage.setFraming(panned);
});

const finishStageDrag = (): void => {
  if (!stageDrag) return;
  if (stageDrag.moved && stage) scheduleFramingSave(stage.getFraming());
  stageDrag = null;
};
window.addEventListener("pointerup", finishStageDrag);
window.addEventListener("pointercancel", finishStageDrag);

canvas.addEventListener("click", () => {
  if (suppressNextStageClick) {
    suppressNextStageClick = false;
    return;
  }
  if (logOpen) askInput.focus();
  else if (askForm.hidden) openAsk();
  else closeAsk();
});
document.documentElement.addEventListener("pointerleave", () => stage?.lookAt(0, 0));

element("import-model").addEventListener("click", () => bridge.importModel());

// ---------- start-up ----------

let loadedModelUrl: string | null = null;

async function applyState(state: AppState): Promise<void> {
  notice = state.modelCredit
    ? `${state.notice}\n\nCharacter model in use: **${state.modelCredit.name}**. Its own notes and terms:\n\n${state.modelCredit.terms}`
    : state.notice;
  fixedSize = state.fixedSize;
  clickThrough = state.clickThrough;
  loadedModelHash = state.modelHash;
  document.body.dataset["fixed"] = String(fixedSize);
  document.body.dataset["windowMode"] = state.windowMode;
  document.body.dataset["clickThrough"] = state.clickThrough ? "true" : "false";
  stage?.setLowPowerMode(state.lowPowerStage);
  stage?.setSolidBackdrop(state.windowMode === "solid-docked");
  const remoteBadge = document.getElementById("remote-inference-badge");
  if (remoteBadge) {
    const inf = state.inferenceBackend;
    if (inf && inf.leavesMachine) {
      remoteBadge.hidden = false;
      remoteBadge.dataset["scope"] = inf.scope;
      remoteBadge.textContent =
        inf.scope === "private-lan"
          ? `Off-PC LAN: ${inf.host ?? "LAN"}`
          : `External API: ${inf.host ?? "remote"}`;
      remoteBadge.title = `Inference is leaving this machine: ${inf.label}`;
    } else {
      remoteBadge.hidden = true;
      remoteBadge.textContent = "";
    }
  }
  updateStatusPill();
  // The invitation to import a model is only for when there is none, not for one still loading.
  firstRun.hidden = state.modelUrl !== null;
  if (!stage) {
    standIn.hidden = false;
    return;
  }
  if (state.modelUrl === null) {
    loadedModelUrl = null;
    stage.clearModel();
    standIn.hidden = false;
    return;
  }
  if (state.modelUrl === loadedModelUrl) return;
  try {
    // A load that was overtaken by a newer one (or by "Remove") must not touch the stand-in.
    if (await stage.loadModel(state.modelUrl)) {
      loadedModelUrl = state.modelUrl;
      const framing = stage.setFraming(state.modelFraming ?? DEFAULT_MODEL_FRAMING);
      syncFramingInputs(framing);
      standIn.hidden = true;
      stage.play("wave"); // hello
    }
  } catch (error) {
    loadedModelUrl = null;
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    bridge.reportModelError(message);
    standIn.hidden = false;
    setReply(`The character model could not be shown: ${message}`, true);
  }
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function wireEmotePopover(): void {
  const toggleBtn = document.getElementById("emote-popover-toggle");
  const popover = document.getElementById("emote-popover");
  const idleSelect = document.getElementById("emote-idle-preset") as HTMLSelectElement | null;
  const grid = document.getElementById("emote-grid");
  const loadClipBtn = document.getElementById("emote-load-clip") as HTMLButtonElement | null;
  const stopClipBtn = document.getElementById("emote-stop-clip") as HTMLButtonElement | null;
  const loopClipBox = document.getElementById("emote-loop-clip") as HTMLInputElement | null;
  const statusEl = document.getElementById("emote-status");
  if (!toggleBtn || !popover || !grid) return;

  toggleBtn.addEventListener("click", () => {
    const opening = popover.hidden;
    const framingPop = document.getElementById("framing-popover");
    if (opening && framingPop) framingPop.hidden = true;
    popover.hidden = !opening;
    toggleBtn.setAttribute("aria-expanded", String(opening));
  });

  if (idleSelect) {
    idleSelect.addEventListener("change", () => {
      const preset = idleSelect.value as IdleLoopPreset;
      stage?.setIdleLoopPreset(preset);
      if (statusEl) statusEl.textContent = `Idle loop: ${idleSelect.selectedOptions[0]?.textContent ?? preset}`;
    });
  }

  const pack = BUILT_IN_EMOTE_PACKS[0];
  if (pack) {
    grid.replaceChildren(
      ...pack.emotes.map((emote) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "emote-btn";
        btn.textContent = emote.label;
        btn.addEventListener("click", () => {
          stage?.playEmote(emote);
          if (statusEl) statusEl.textContent = `Playing emote: ${emote.label}`;
        });
        return btn;
      }),
    );
  }

  if (loadClipBtn) {
    loadClipBtn.addEventListener("click", () => {
      loadClipBtn.disabled = true;
      if (statusEl) statusEl.textContent = "Choose a .vrma (VRM) or .vmd (MMD) motion clip…";
      void bridge
        .pickMotionClip()
        .then(async (picked) => {
          if (!picked.ok) {
            if (statusEl) statusEl.textContent = picked.canceled ? "" : (picked.error ?? "Could not open clip.");
            return;
          }
          if (!stage) {
            if (statusEl) statusEl.textContent = "3D stage is not active.";
            return;
          }
          const bytes = decodeBase64Bytes(picked.bytesBase64);
          const result = await stage.playMotionBytes(bytes, {
            name: picked.name,
            format: picked.format,
            loop: loopClipBox?.checked === true,
          });
          if (result.ok) {
            if (stopClipBtn) stopClipBtn.hidden = false;
            if (statusEl) statusEl.textContent = `Playing ${result.kind.toUpperCase()}: ${result.name}`;
          } else if (statusEl) {
            statusEl.textContent = result.reason;
          }
        })
        .catch((error: unknown) => {
          if (statusEl) statusEl.textContent = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          loadClipBtn.disabled = false;
        });
    });
  }

  if (stopClipBtn) {
    stopClipBtn.addEventListener("click", () => {
      stage?.stopMotionClip();
      stopClipBtn.hidden = true;
      if (statusEl) statusEl.textContent = "Returned to idle loop.";
    });
  }
}

function wireAiReportDialog(): void {
  const openBtn = document.getElementById("live-report-output");
  const dialogEl = document.getElementById("ai-report-dialog");
  const categoryEl = document.getElementById("ai-report-category") as HTMLSelectElement | null;
  const detailsEl = document.getElementById("ai-report-details") as HTMLTextAreaElement | null;
  const includeBox = document.getElementById("ai-report-include-excerpt") as HTMLInputElement | null;
  const saveBtn = document.getElementById("ai-report-save") as HTMLButtonElement | null;
  const githubBtn = document.getElementById("ai-report-github") as HTMLButtonElement | null;
  const closeBtn = document.getElementById("ai-report-close");
  const statusEl = document.getElementById("ai-report-status");
  if (!openBtn || !dialogEl || !categoryEl || !detailsEl || !includeBox || !saveBtn) return;

  let lastIssueUrl = "";
  let snapshotReply = "";
  let snapshotHeard = "";
  let inFlight = false;
  let lastSavedKey = "";
  const buildReportKey = (): string =>
    `${categoryEl.value}\0${includeBox.checked ? "1" : "0"}\0${detailsEl.value.trim()}\0${snapshotReply}\0${snapshotHeard}`;
  const markReportDirty = (): void => {
    lastSavedKey = "";
    if (!inFlight) saveBtn.disabled = false;
  };
  detailsEl.addEventListener("input", markReportDirty);
  categoryEl.addEventListener("change", markReportDirty);
  includeBox.addEventListener("change", markReportDirty);

  resetAiReportDialog = (): void => {
    dialogEl.hidden = true;
    snapshotReply = "";
    snapshotHeard = "";
    lastIssueUrl = "";
    lastSavedKey = "";
    detailsEl.value = "";
    if (statusEl) statusEl.textContent = "";
    if (githubBtn) githubBtn.hidden = true;
    if (!inFlight) saveBtn.disabled = false;
  };
  refreshAiReportOnNewReply = (): void => {
    // Only refresh when the dialog is closed so incoming proactive reminders/events never
    // close the dialog or wipe a note the user is currently typing.
    if (!dialogEl.hidden) return;
    snapshotReply = "";
    snapshotHeard = "";
    lastIssueUrl = "";
    lastSavedKey = "";
    if (statusEl) statusEl.textContent = "";
    if (githubBtn) githubBtn.hidden = true;
  };
  openBtn.addEventListener("click", () => {
    dialogEl.hidden = !dialogEl.hidden;
    if (!dialogEl.hidden) {
      // Snapshot the visible reply & prompt when the dialog OPENS so incoming events or
      // new replies arriving while the user types a note never overwrite what they reported.
      snapshotReply = document.getElementById("reply")?.textContent ?? "";
      snapshotHeard = document.getElementById("heard")?.textContent ?? "";
      lastSavedKey = "";
      if (!inFlight) saveBtn.disabled = false;
      if (statusEl) statusEl.textContent = "";
      if (githubBtn) githubBtn.hidden = true;
      lastIssueUrl = "";
      detailsEl.focus();
    }
  });
  closeBtn?.addEventListener("click", () => {
    dialogEl.hidden = true;
  });
  githubBtn?.addEventListener("click", () => {
    if (lastIssueUrl) bridge.openLink(lastIssueUrl);
  });
  saveBtn.addEventListener("click", () => {
    if (inFlight) return;
    const reportKey = buildReportKey();
    if (lastSavedKey && reportKey === lastSavedKey) {
      if (statusEl) statusEl.textContent = "Already saved locally (edit details to save another report).";
      return;
    }
    inFlight = true;
    saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = "Saving scrubbed report locally…";
    void bridge
      .reportAiOutput({
        category: categoryEl.value as AiReportCategory,
        note: detailsEl.value.trim(),
        includeExcerpt: includeBox.checked,
        replyExcerpt: snapshotReply,
        userPromptExcerpt: snapshotHeard,
      })
      .then((res) => {
        if (res.ok) {
          lastIssueUrl = res.issueUrl;
          lastSavedKey = buildReportKey();
          if (githubBtn) githubBtn.hidden = false;
          if (statusEl) statusEl.textContent = `Saved locally: ${res.filePath}`;
          detailsEl.value = "";
          // Update key after clearing textarea so a second immediate Save click cannot write a duplicate.
          lastSavedKey = buildReportKey();
        } else if (statusEl) {
          statusEl.textContent = res.error;
        }
      })
      .catch((error: unknown) => {
        if (statusEl) statusEl.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        inFlight = false;
        saveBtn.disabled = false;
      });
  });
}

async function start(): Promise<void> {
  setVoiceState("off");
  logToggle.title = "The conversation so far (Ctrl+L)";
  logToggle.setAttribute("aria-label", "The conversation so far");
  renderChips();
  bridge.onBrainEvent(onBrainEvent);
  bridge.onVoiceEvent(onVoiceEvent);
  bridge.onAppState((state) => void applyState(state));
  bridge.onShowNotice(() => setReply(notice));
  bridge.onFocusInput(openAsk);
  bridge.onListenRequest((on) => void setVoice(on));
  bridge.onPresence(onPresence);
  bridge.onForgotten(forgetLog);
  // Her reply was stopped: what was waiting behind it gets no answer, so nothing waits for one.
  bridge.onDropped((typedTaken) => dropWaiting(saidWaiting, typedTaken));
  bridge.onAvatarReaction(({ event }) => {
    stage?.triggerEventReaction(event);
  });
  wireEmotePopover();
  wireAiReportDialog();
  new ResizeObserver(updateLayout).observe(balloon);
  new ResizeObserver(updateLayout).observe(askForm);

  // If 3D could not start at all, the stand-in is all there is to show.
  standIn.hidden = false;
  try {
    stage = await Stage.create(canvas);
    stage.setOnMotionClipEnded(() => {
      const stopClipBtn = document.getElementById("emote-stop-clip") as HTMLButtonElement | null;
      const statusEl = document.getElementById("emote-status");
      if (stopClipBtn) stopClipBtn.hidden = true;
      if (statusEl) statusEl.textContent = "Clip finished — returned to idle loop.";
    });
  } catch (error) {
    console.error(error);
    bridge.reportModelError(error instanceof Error ? error.message : String(error));
  }

  const state = await bridge.ready();
  if (stage && state.modelUrl !== null) standIn.hidden = true;
  await applyState(state);
  // With no model, the card where she will stand says what to do; the notice still gets its turn.
  if (state.showNotice) setReply(state.notice);
  updateLayout();
  if (state.autoListen) void setVoice(true);
}

/** Adds one-click Copy buttons to fenced code blocks without altering renderMarkdown(). */
function enhanceCodeBlocks(container: HTMLElement, onCopy: (code: string) => void): void {
  for (const pre of container.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code || pre.parentElement?.classList.contains("code-block-wrap")) continue;
    const wrap = document.createElement("div");
    wrap.className = "code-block-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code block");
    btn.addEventListener("click", () => {
      onCopy(code.textContent ?? "");
      btn.textContent = "Copied";
      window.setTimeout(() => {
        btn.textContent = "Copy";
      }, 1400);
    });
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.append(pre, btn);
  }
}

window.aichanDebug = () => stage?.debugSnapshot() ?? null;

void start();
