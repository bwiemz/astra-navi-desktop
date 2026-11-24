import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatHistoryItem, ChatModelResponse, ChatSessionModelFunctions } from "node-llama-cpp";
import type { BrainEvent, PermissionDecision } from "../shared/ipc.ts";
import { createTools, type ToolHost, type WebAccess } from "./agentTools.ts";
import type { ActionLog } from "./actionLog.ts";
import type { ConversationArchive } from "./archive.ts";
import { CLAIM_CHECK, checkReply } from "./followThrough.ts";
import { CLOCK_MARK, ClockTeller, daysAboard } from "./clock.ts";
import { compact, EARLIER_MARK, historyText, trimOldResults } from "./compaction.ts";
import type { ConfigStore } from "./config.ts";
import type { LocalEngine } from "./engine.ts";
import { withoutSecrets, type Learner, type ToolRecord } from "./learner.ts";
import type { EnvironmentFacts } from "./environment.ts";
import type { MemoryStore } from "./memory.ts";
import { MoodStream } from "./moodStream.ts";
import { TOOLS, type PolicyContext, type RequestSummary } from "./permissions.ts";
import type { PermissionRiskLevel } from "./riskRules.ts";
import { ToolRouter } from "./toolRouter.ts";
import {
  hardenFunctionsForGrammar,
  StreamingJsonParamGuard,
  ToolLoopGuard,
} from "./grammarGuard.ts";
import { clipForTrace, type TracedCall, type TracedCheck, type TurnTrace } from "./trace.ts";
import type { TurnHookContext } from "./turnHooks.ts";
import {
  AWAY_MARK,
  buildSystemPrompt,
  EVENT_MARK,
  FORM_MARK,
  FORM_SPOKEN,
  FORM_TYPED,
  NOTES_MARK,
  VOICE_MARK,
  type Abilities,
} from "./persona.ts";
import { describeRecalled, type Recall } from "./recall.ts";
import { desktopLayout } from "./desktop.ts";
import { SCREEN_MARK } from "./watch.ts";
import { createDesktopTools, type DesktopServices } from "./desktopTools.ts";
import { MORE_OF_THE_FILE, type Fleet, type Machine } from "./fleet.ts";
import { FILE_TOO_LONG } from "./fleetRules.ts";
import { createFleetTools } from "./fleetTools.ts";
import { createHandsTools, type HandsServices } from "./handsTools.ts";
import { createNoticeTools } from "./noticeTools.ts";
import type { NoticeWatch } from "./notices.ts";
import { createPhoneTools } from "./phoneTools.ts";
import { createKnowledgeTools } from "./knowledgeTools.ts";
import { createShipTools, type ShipServices } from "./shipTools.ts";

/** How many past messages are kept on disk for the next launch. */
const SAVED_HISTORY_ITEMS = 60;
const MAX_REPLY_TOKENS = 1024;

export interface BrainDeps {
  config: ConfigStore;
  memory: MemoryStore;
  environment: EnvironmentFacts;
  engine: LocalEngine;
  /** Where the conversation is kept between launches. */
  historyFile: string;
  /** Finds her notes by meaning, so the related ones come back when a subject returns. */
  recall?: Recall;
  /** Writes up conversations into lasting notes once things go quiet. */
  learner?: Learner;
  /** Keeps what was said, word for word, so she can look back. */
  archive?: ConversationArchive;
  /** The record of every tool call. */
  actions?: ActionLog;
  /** Where her own settings, memory and records are kept; she may not touch these unasked. */
  privateDirs?: readonly string[];
  /** How the web is reached; see `WebAccess`. */
  web?: WebAccess;
  /** Her eyes and her hands on the desktop. Without these she can only run commands. */
  desktop?: DesktopServices;
  /** Reminders, background jobs and the Deck Log. Without these she has only her basic tools. */
  ship?: ShipServices;
  /** Her hands inside other programs. */
  hands?: HandsServices;
  /** True when the phone link (KDE Connect) is installed. */
  phone?: boolean;
  /** The user's other machines, reached over SSH. */
  fleet?: Fleet;
  /** Tells her which program the user is in, while she keeps watch. */
  screen?: { next(): string; reset(): void };
  /** The desktop's notifications, while the user lets her read them; null while not. */
  notices?: () => NoticeWatch | null;
  /** For her test suite only; the app never sets it. */
  lab?: BrainLab;
  /**
   * Called once a reply is finished with the record of it: what was asked, the tools on
   * offer, each call and its ending, what she said, which checks stepped in. See `trace.ts`.
   */
  onTrace?(trace: TurnTrace): void;
  emit(event: BrainEvent): void;
}

/**
 * What her test suite may change about a reply so that it can be measured: stand-ins for
 * tools that would otherwise reach outside the test, and the dice she rolls. Nothing
 * here is used unless a caller passes it in.
 */
export interface BrainLab {
  /** Given the tools she would have this turn, returns the ones she gets instead. */
  tools?(functions: ChatSessionModelFunctions, host: ToolHost): ChatSessionModelFunctions;
  /** Makes her choice of words repeatable from one run to the next. */
  seed?(): number | undefined;
  /** How freely she chooses words. Left out: as in the app. */
  temperature?: number;
  /** Called with each message exactly as it is put to her, ship's lines and notes included. */
  onPrompt?(prompt: string): void;
  /** True to leave her choice of words alone, so the leaning away from "I" can be measured. */
  plainWords?: boolean;
  /**
   * The time she is told it is. Her suite gives the same hour of the day whenever it is
   * run: told it is the small hours she remarks on it, as she is meant to once in a
   * conversation, and every case is the start of one.
   */
  now?(): Date;
  /** Offer her only the tools each message looks to need, whatever the settings say. */
  fittingTools?: boolean;
  /** Called with the tools she is offered for a message, and why each one beyond the core. */
  onOffered?(offered: readonly string[], why: Readonly<Record<string, string>>): void;
  /** Called with how sure her second look was that a reply claimed an action it did not take. */
  onClaimCheck?(sureness: number, reply: string): void;
}

export interface SendOptions {
  /** The message was spoken, so the reply should be short and speakable. */
  spoken?: boolean;
  /** The message came from one of the user's other devices, not from this PC. */
  away?: boolean;
  /** Milliseconds spent transcribing speech to text before sending. */
  sttMs?: number;
}

interface QueuedMessage {
  text: string;
  spoken: boolean;
  sttMs?: number;
  /** Not typed or said by the user: the app telling her something happened. */
  event: boolean;
  /** Sent from another device; the user is not at this PC. */
  away?: boolean;
  /** She was just told that a claim of hers had nothing behind it; this is her second attempt. */
  correction?: boolean;
  /** This event was cut off before she said anything and is being told again. */
  retold?: boolean;
  /** A second attempt at something she said she had looked up, or answered without looking. */
  lookup?: boolean;
}

/**
 * The tools that do something lasting. A reply that says "done" is only believed when
 * one of these ran in it; looking something up does not count as having done it.
 */
export const ACTION_TOOLS: ReadonlySet<string> = new Set([
  TOOLS.runCommand,
  TOOLS.writeFile,
  TOOLS.remember,
  TOOLS.forget,
  TOOLS.setReminder,
  TOOLS.reminders,
  TOOLS.startMission,
  TOOLS.planMission,
  TOOLS.missions,
  TOOLS.deckLog,
  TOOLS.openApp,
  TOOLS.open,
  TOOLS.research,
  TOOLS.tidyStorage,
  TOOLS.windows,
  TOOLS.sound,
  TOOLS.clipboard,
  TOOLS.lockScreen,
  TOOLS.operate,
  TOOLS.phone,
  TOOLS.remote,
  TOOLS.keepWatch,
  TOOLS.agenda,
]);
/** Looking in her own memory is not something she did for the user; it stays out of her journal. */
const NOT_JOURNALLED: ReadonlySet<string> = new Set([TOOLS.remember, TOOLS.recall, TOOLS.forget]);
/** Messages shorter than this ("hi", "thanks") are not worth looking up notes for. */
const MIN_CHARS_FOR_NOTES = 12;
/** How long a reply may be held up waiting for her notes to be found. */
const NOTES_PATIENCE_MS = 1500;
/**
 * The words for "I", and how far each is leaned away from. A nudge, not a ban: she can
 * still write them where nothing else will do (quoting Captain, "I/O"). The pieces
 * with a space in front are the ones used in the middle of a sentence.
 */
const FIRST_PERSON_WORDS: readonly { text: string; logit: number }[] = [
  { text: " I", logit: -4 },
  { text: "I", logit: -4 },
  { text: " My", logit: -3 },
  { text: "My", logit: -3 },
  { text: " my", logit: -2.5 },
  { text: " myself", logit: -3 },
  { text: " me", logit: -1.5 },
];
/** Rewording a search past this point has stopped helping; she answers from what she has. */
const MAX_SEARCHES_PER_REPLY = 5;
/** How many messages from other devices may wait their turn at once. */
const MAX_AWAY_WAITING = 3;
const NOBODY_AT_THE_PC =
  "Not done. This needs Captain's say-so on the PC's own screen, and this message came from another device, so nobody is there to give it. Do not try another way. Tell Captain it has to be asked for at the PC.";
/** For this many replies a tool that was used, or picked out for a message, stays on offer. */
const TURNS_A_TOOL_STAYS_ON_OFFER = 3;

/**
 * What these tools return is promised never to be written down: notifications are other
 * people's messages. She has it in mind for as long as the conversation is in memory;
 * the copy saved for the next launch says only that it was there.
 */
const NEVER_SAVED: ReadonlySet<string> = new Set([TOOLS.notifications]);
const NOT_KEPT = "(what this returned was read at the time and is not kept)";
const SAID_NOT_KEPT =
  "[[neutral]] (AI-chan told Captain what they said. Neither the notifications nor her words about them are kept: to say more about them she looks again.)";

export function withoutUnsavedResults(items: readonly ChatHistoryItem[]): ChatHistoryItem[] {
  return items.map((item) => {
    if (item.type !== "model") return item;
    const read = item.response.some(
      (part) =>
        typeof part === "object" && part.type === "functionCall" && NEVER_SAVED.has(part.name),
    );
    if (!read) return item;
    // Her own words in that reply repeat what was read, so they go the same way.
    let said = false;
    const response = item.response.flatMap((part): ChatModelResponse["response"] => {
      if (typeof part === "string") {
        if (said || part.trim() === "") return [];
        said = true;
        return [SAID_NOT_KEPT];
      }
      if (part.type === "functionCall" && NEVER_SAVED.has(part.name)) {
        return [{ ...part, result: NOT_KEPT }];
      }
      // Her thinking about it as well.
      return part.type === "segment" ? [] : [part];
    });
    return { ...item, response: said ? response : [...response, SAID_NOT_KEPT] };
  });
}

function isHistory(value: unknown): value is ChatHistoryItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        ["user", "model", "system"].includes((item as { type?: unknown }).type as string),
    )
  );
}

/**
 * The assistant's mind: one ongoing conversation with a language model running on this
 * computer, which can use tools here. Everything it wants shown or asked goes out
 * through `deps.emit`.
 */
// Kept here for those who read it from the brain (the suite checks its own copy against it).
export { CLAIM_THRESHOLD } from "./followThrough.ts";

export class Brain {
  private readonly deps: BrainDeps;
  private readonly moodStream: MoodStream;
  private readonly pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  /** Actions the user allowed "for this chat"; identical requests are not asked again. */
  private readonly allowedForChat = new Set<string>();
  private replyOpen = false;
  private replyHasText = false;
  /** What she has written in the reply so far, for the follow-through check. */
  private replyText = "";
  /** One message is answered at a time; anything sent meanwhile waits here. */
  private turnActive = false;
  private backlog: QueuedMessage[] = [];
  private abort: AbortController | null = null;
  private steps = 0;
  /** The reply being written answers a message from another device: nobody is at the PC. */
  private turnAway = false;
  /** How many tools that do something lasting ran in the reply being written. */
  private actionsRun = 0;
  /** What her tools did in the reply being written, for her journal. */
  private turnTools: ToolRecord[] = [];
  /** Chooses which tools to offer for a message, when that is switched on; made when first needed. */
  private router: ToolRouter | null = null;
  /** The tools used or picked out in each of the last few replies, oldest first: a follow-up needs them still. */
  private readonly toolsOfLate: string[][] = [];
  /** What the user said last, for a message that only makes sense after it. */
  private saidBefore: string | undefined;
  /** True when the reply being written was offered fewer than all of her tools. */
  private offeredFewer = false;
  /** The tools picked out for the reply being written, beyond the core. */
  private pickedOut: string[] = [];
  /** Notes already put in front of her in this conversation, so each is shown once. */
  private readonly notesGiven = new Set<string>();
  private readonly clock = new ClockTeller();
  /** Web addresses the user wrote or a search returned. Opening any other one asks first. */
  private readonly knownAddresses = new Set<string>();
  /**
   * The conversation holds text from a web page, a file or a command's output. Such text
   * stays in her mind for the rest of the conversation, so from then on her notes-to-self
   * are checked with the user. Cleared only by starting a new conversation.
   */
  private readOutsideText = false;
  private idleWaiters: (() => void)[] = [];
  private historyLoaded = false;
  /** Counts replies begun, so work done between replies can tell that one has started since. */
  private turnsBegun = 0;
  /** Set while the conversation is being made smaller; aborting it stops that work. */
  private makingRoom: AbortController | null = null;
  /** How much of the reply had been written when her last tool call in it began. */
  private saidBeforeLastTool = 0;
  /** How many of her replies ago a tool last worked in this conversation; large when none has. */
  private turnsSinceTool = 99;
  /** A step of the reply being written was put to the user and refused, or could not be put. */
  private turnRefused = false;
  /** How many tools of any kind ran and worked in the reply being written. */
  private toolsDone = 0;
  /** A tool whose result is never written down ran in the reply being written. */
  private turnReadUnsaved = false;
  /** For the record of the reply being written: its calls, the checks that stepped in, its first word. */
  private tracedCalls: TracedCall[] = [];
  private tracedChecks: TracedCheck[] = [];
  private firstWordAt: number | null = null;
  private offeredNow: string[] = [];
  private pickedFor: Record<string, string> | null = null;
  /** The abilities her current instructions were written for; null before the first reply. */
  private instructedFor: string | null = null;
  private disposed = false;
  private saveChain: Promise<void> = Promise.resolve();
  /** Tracks the latest completed user turn for "Forget Last Turn" / "Edit & Resend". */
  private lastTurnRecord: { startedAtIso: string; userText: string; archived: boolean } | null = null;

  constructor(deps: BrainDeps) {
    this.deps = deps;
    this.moodStream = new MoodStream(
      {
        text: (delta) => {
          this.replyHasText = true;
          this.firstWordAt ??= Date.now();
          this.replyText += delta;
          this.deps.emit({ type: "text", delta });
        },
        mood: (mood) => this.deps.emit({ type: "mood", mood }),
      },
      {
        sideMarks: [
          CLOCK_MARK,
          SCREEN_MARK,
          NOTES_MARK,
          EVENT_MARK,
          AWAY_MARK,
          VOICE_MARK,
          EARLIER_MARK,
          FORM_MARK,
          // "[deck_log] AI-chan closed Kate." A tool's name in brackets is her writing
          // out a call she did not make.
          ...Object.values(TOOLS).map((name) => `[${name}]`),
        ],
      },
    );
  }

  /**
   * Whether `send` would take this message right now. Asked first by whoever wants to
   * show the message somewhere before her reply to it starts: `send` begins the reply
   * before it returns.
   */
  wouldTake(text: string, options: SendOptions = {}): boolean {
    if (text.trim().length === 0 || this.disposed) return false;
    // A device can send faster than she can answer. A few may wait; the rest are turned away.
    return !(
      options.away === true &&
      this.backlog.filter((message) => message.away).length >= MAX_AWAY_WAITING
    );
  }

  /** Returns false when the message was not taken (too many from other devices are already waiting). */
  send(text: string, options: SendOptions = {}): boolean {
    const trimmed = text.trim();
    if (!this.wouldTake(text, options)) return false;
    this.enqueue({
      text: trimmed,
      spoken: options.spoken === true,
      ...(options.sttMs === undefined ? {} : { sttMs: options.sttMs }),
      event: false,
      away: options.away === true,
    });
    return true;
  }

  /**
   * Tells her that something happened (a reminder came due, a job finished) so she can
   * tell the user in her own words. This is how she comes to speak first.
   */
  announce(text: string, options: { outsideText?: boolean } = {}): void {
    const trimmed = text.trim();
    if (trimmed.length === 0 || this.disposed) return;
    if (options.outsideText) this.readOutsideText = true;
    this.enqueue({ text: trimmed, spoken: false, event: true });
  }

  private enqueue(message: QueuedMessage): void {
    if (this.turnActive) this.backlog.push(message);
    else void this.runTurn(message);
  }

  /** Stops the current reply and drops what the user had queued behind it. Events still get told. */
  interrupt(): void {
    this.backlog = this.backlog.filter((message) => message.event);
    this.denyAllPending();
    this.abort?.abort();
  }

  answerPermission(id: string, decision: PermissionDecision): void {
    this.pendingPermissions.get(id)?.(decision);
  }

  /** Resolves once no reply is being written. */
  async whenIdle(): Promise<void> {
    // Looped: a message waiting in line starts its reply the moment the last one ends.
    while (this.turnActive) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  /** Removes the latest user turn and its reply/memory notes from context, archive, and recall. */
  async forgetLastTurn(): Promise<{
    removed: boolean;
    userText: string | null;
    forgottenMemories: number;
  }> {
    this.interrupt();
    await this.whenIdle();
    const history = this.deps.engine.getHistory();
    let lastUserIdx = -1;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.type === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const record = this.lastTurnRecord;
    if (lastUserIdx === -1 && !record) {
      return { removed: false, userText: null, forgottenMemories: 0 };
    }
    let userText = record?.userText ?? null;
    if (lastUserIdx !== -1) {
      if (userText === null) {
        const entry = history[lastUserIdx] as { type: "user"; text?: unknown } | undefined;
        if (typeof entry?.text === "string") userText = entry.text;
      }
      this.deps.engine.setHistory(history.slice(0, lastUserIdx));
      this.turnsBegun += 1;
      await this.saveHistory();
    }
    if (record?.archived || (this.deps.archive && lastUserIdx !== -1)) {
      const removedArchive = await this.deps.archive?.removeLast();
      if (userText === null && removedArchive?.said) userText = removedArchive.said;
    }
    let forgottenMemories = 0;
    if (record?.startedAtIso) {
      const droppedIds = await this.deps.memory.forgetCreatedSince(record.startedAtIso);
      forgottenMemories = droppedIds.length;
      this.deps.recall?.drop(droppedIds);
    }
    this.lastTurnRecord = null;
    this.saidBefore = undefined;
    return { removed: true, userText, forgottenMemories };
  }
  /** Forgets the current conversation thread. Long-term memory is untouched. */
  async newConversation(options: { keepLoaded?: boolean } = {}): Promise<void> {
    this.interrupt();
    await this.whenIdle(); // the model must not be let go from under a reply still winding down
    // Anything being worked out about the old conversation no longer applies.
    this.turnsBegun += 1;
    this.makingRoom?.abort();
    this.turnsSinceTool = 99;
    this.allowedForChat.clear();
    this.knownAddresses.clear();
    this.notesGiven.clear();
    this.toolsOfLate.length = 0;
    this.saidBefore = undefined;
    this.lastTurnRecord = null;
    this.clock.reset();
    this.deps.screen?.reset();
    this.readOutsideText = false;
    this.deps.engine.setHistory([]);
    // Unloading makes the next message start from a fresh system prompt with current memories.
    // Her test suite starts over hundreds of times and keeps the model in memory instead.
    if (options.keepLoaded) this.deps.engine.renew();
    else await this.deps.engine.unload();
    await this.saveHistory();
  }

  /**
   * Makes the next reply start from freshly written instructions, for example after
   * the language was changed. The conversation is kept.
   */
  async refreshInstructions(): Promise<void> {
    this.interrupt();
    await this.whenIdle();
    await this.deps.engine.unload();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.makingRoom?.abort();
    this.interrupt();
    await this.whenIdle(); // lets the interrupted reply save what it had
    await this.saveChain.catch(() => undefined);
    await this.deps.learner?.dispose();
    await this.deps.engine.dispose();
  }

  /** Her standing instructions as they would be written right now. */
  instructions(): string {
    const { deps } = this;
    return buildSystemPrompt(
      deps.environment,
      deps.memory.snapshot(),
      deps.config.value.language,
      daysAboard(deps.config.value.firstMetAt, new Date()),
      this.abilities(),
    );
  }

  /** Which optional abilities are switched on, for her instructions. */
  private abilities(): Abilities {
    const { deps } = this;
    const settings = deps.config.value;
    return {
      operate: deps.hands !== undefined && settings.hands.inPrograms,
      watch: deps.screen !== undefined && settings.sight.watch,
      listen: deps.desktop !== undefined && settings.hearing.pcAudio,
      notices: deps.notices !== undefined && settings.notices.read,
      machines: (deps.fleet?.machines().length ?? 0) > 0,
      machineNames: deps.fleet?.machines().map((machine) => machine.name) ?? [],
      phone: deps.phone === true,
      station: settings.devices.station,
    };
  }

  /**
   * The tools to offer for this message: all of them, or (when that is switched on) the
   * core and those the message looks to be about; see `toolRouter.ts`. Everything is
   * offered for the ship's own messages, which may call for anything, and for her
   * second go at a reply, so that a tool the router did not think of is there then.
   */
  private async fitting(
    all: ChatSessionModelFunctions,
    message: QueuedMessage,
  ): Promise<ChatSessionModelFunctions> {
    const { deps } = this;
    this.offeredFewer = false;
    this.pickedOut = [];
    const wanted = deps.lab?.fittingTools ?? deps.config.value.fittingTools;
    if (!wanted || message.event || Object.keys(all).length === 0) return all;
    this.router ??= new ToolRouter(deps.recall?.embedder ?? null);
    const route = await this.router.route(message.text, {
      available: Object.keys(all),
      recent: this.toolsOfLate.flat(),
      machines: deps.fleet?.machines().map((machine) => machine.name) ?? [],
      ...(this.saidBefore === undefined ? {} : { before: this.saidBefore }),
    });
    const offered = new Set(route.offered);
    // Only what this message itself called for is carried forward. A tool that is here
    // because it was on offer a moment ago, or because it goes with another, would
    // otherwise keep itself on offer for ever.
    this.pickedOut = Object.entries(route.why)
      .filter(([, reason]) => /^(?:words|meaning|names a machine)/.test(reason))
      .map(([tool]) => tool);
    this.pickedFor = route.why;
    this.offeredFewer = offered.size < Object.keys(all).length;
    deps.lab?.onOffered?.(route.offered, route.why);
    if (process.env["AI_CHAN_DEBUG"]) {
      console.log(
        `\n[brain] offering ${offered.size} of ${Object.keys(all).length} tools; beyond the core: ${
          Object.entries(route.why)
            .map(([tool, reason]) => `${tool} (${reason})`)
            .join(", ") || "none"
        }`,
      );
    }
    return Object.fromEntries(Object.entries(all).filter(([name]) => offered.has(name)));
  }

  private denyAllPending(): void {
    for (const answer of [...this.pendingPermissions.values()]) answer("deny");
  }

  private async runTurn(message: QueuedMessage): Promise<void> {
    const { deps } = this;
    this.turnActive = true;
    this.turnsBegun += 1;
    this.makingRoom?.abort();
    // A correction keeps the standing of the message it corrects.
    if (!message.correction) this.turnAway = message.away === true;
    this.steps = 0;
    this.saidBeforeLastTool = 0;
    this.toolsDone = 0;
    this.turnRefused = false;
    this.turnReadUnsaved = false;
    this.actionsRun = 0;
    this.turnTools = [];
    this.tracedCalls = [];
    this.tracedChecks = [];
    this.firstWordAt = null;
    this.offeredNow = [];
    this.pickedFor = null;
    const traceBegan = Date.now();
    const meterBefore = this.deps.engine.meter();
    this.replyText = "";
    deps.learner?.busy();
    // Only what the user wrote can vouch for a web address; an event's text cannot.
    if (!message.event) {
      for (const url of message.text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []) {
        this.learnAddress(url);
      }
    }
    this.abort = new AbortController();
    const { signal } = this.abort;
    deps.emit({
      type: "status",
      state: "thinking",
      spoken: message.spoken,
      initiated: message.event,
      away: this.turnAway,
      ...(message.correction ? { correction: true } : {}),
    });

    try {
      if (!this.historyLoaded) {
        this.historyLoaded = true;
        // What old tool calls returned is not needed word for word after a restart.
        const saved = trimOldResults(await this.loadHistory(), undefined, [NOTES_MARK, FORM_MARK]);
        deps.engine.setHistory(saved);
        // What an earlier session read is not known any more, so assume it read something.
        if (saved.length > 0) this.readOutsideText = true;
      }
      await mkdir(deps.environment.workspace, { recursive: true });
      // Her instructions only describe the abilities that are switched on. When one is
      // switched on or off mid-conversation they are written afresh; the conversation stays.
      const abilities = JSON.stringify(this.abilities());
      if (this.instructedFor !== null && this.instructedFor !== abilities) deps.engine.refresh();
      this.instructedFor = abilities;
      const hookPipeline = deps.engine.hooks?.() ?? null;
      const hookCtx: TurnHookContext | null =
        hookPipeline && hookPipeline.list().length > 0
          ? {
              userText: message.text,
              spoken: message.spoken === true,
              isEvent: message.event === true,
              away: this.turnAway,
              readOutsideText: this.readOutsideText,
              handsOff: deps.config.value.handsOff,
              offeredTools: [],
              usedTools: [],
              replyText: "",
              falseClaim: false,
              flags: {},
            }
          : null;
      let routedOfferedOverride: string[] | undefined;
      if (hookCtx && hookPipeline) {
        const routed = await hookPipeline.runBeforeRoute(hookCtx);
        routedOfferedOverride = routed.offeredTools;
        if (routed.shortCircuitReply !== undefined) {
          this.openReply();
          this.moodStream.push(routed.shortCircuitReply);
          this.moodStream.flush();
          return;
        }
      }
      const session = await deps.engine.session(this.instructions());
      if (signal.aborted) return;

      const host = this.toolHost();
      const mark = message.event
        ? `${EVENT_MARK} `
        : message.spoken
          ? `${VOICE_MARK} `
          : message.away
            ? `${AWAY_MARK} `
            : "";
      // Telling an event is only telling. Its text can carry a program's output or old
      // log lines, so she gets no tools while relaying it; whatever such text "asks for"
      // cannot be carried out. A correction is the exception: it exists to make her act.
      const usual: ChatSessionModelFunctions =
        message.event && !message.correction
          ? {}
          : {
              ...createTools(host),
              ...createKnowledgeTools(host),
              ...(deps.desktop ? createDesktopTools(host, deps.desktop) : {}),
              ...(deps.hands && deps.config.value.hands.inPrograms
                ? createHandsTools(host, deps.hands)
                : {}),
              ...(deps.phone ? createPhoneTools(host) : {}),
              ...(deps.notices && deps.config.value.notices.read
                ? createNoticeTools(host, deps.notices)
                : {}),
              // Offered once there is a machine to work on; her instructions say where one is added.
              ...(deps.fleet && deps.fleet.machines().length > 0
                ? createFleetTools(host, deps.fleet)
                : {}),
              ...(deps.ship ? createShipTools(host, deps.ship) : {}),
            };
      const everyTool = deps.lab?.tools ? deps.lab.tools(usual, host) : usual;
      const loopGuard = new ToolLoopGuard();
      const fitted = await this.fitting(everyTool, message);
      const selectedTools =
        routedOfferedOverride && !message.event
          ? Object.fromEntries(
              Object.entries(fitted).filter(([name]) => routedOfferedOverride.includes(name)),
            )
          : fitted;
      const functions = hardenFunctionsForGrammar(
        selectedTools,
        loopGuard,
        undefined,
        (entry) =>
          host.traced?.({
            tool: entry.tool,
            input: entry.input,
            result: entry.result,
            outcome: "refused",
            asked: false,
            ms: 0,
            gate: "refused",
            gateReason: entry.gateReason,
          }),
      );
      if (signal.aborted) return;
      this.offeredNow = Object.keys(functions);
      if (hookCtx) hookCtx.offeredTools = [...this.offeredNow];
      // So that a later change to the conversation does not cost reading the
      // instructions again; see the engine.
      await deps.engine.anchor(functions, signal);
      if (signal.aborted) return;
      const notes = message.event ? null : await this.notesFor(message.text);
      if (signal.aborted) return;
      // Counted as shown only now that the message carrying them is really being sent.
      for (const key of notes?.keys ?? []) this.notesGiven.add(key);
      this.moodStream.hideToolMarkup = Object.keys(functions).length === 0;
      // Lines from the ship itself, beside the message: the time, and where Captain is.
      const onScreen = message.event ? "" : (deps.screen?.next() ?? "");
      const aside = [this.clock.next(deps.lab?.now?.()), onScreen].filter(Boolean).join("\n");
      // Last, so that it is the nearest thing to her answer. Not when she is telling
      // of an event, which has its own instructions in it.
      const form = message.event ? "" : `\n\n${message.spoken ? FORM_SPOKEN : FORM_TYPED}`;
      const prompt = `${mark}${message.text}${aside ? `\n\n${aside}` : ""}${notes?.text ?? ""}${form}`;
      deps.lab?.onPrompt?.(prompt);
      const promptTextTokens = deps.engine.countTokens?.(prompt) ?? null;
      const heldBeforePrompt = deps.engine.meter?.()?.held ?? meterBefore?.held ?? null;
      const promptTokens =
        promptTextTokens === null
          ? null
          : heldBeforePrompt === null
            ? promptTextTokens
            : heldBeforePrompt + promptTextTokens;
      const seed = deps.lab?.seed?.();
      // She speaks of herself by name. Told so, a small model still slips into "I" in
      // about one reply in three, so the words themselves are made a little less
      // likely while she is speaking. Not while she is thinking, which nobody reads and
      // which she does better in her own way, and not in the other languages, whose
      // words for "I" this does not know.
      const bias =
        deps.config.value.language === "en" && deps.lab?.plainWords !== true
          ? deps.engine.wordBias(FIRST_PERSON_WORDS)
          : null;
      let thinking = false;
      const paramGuard = new StreamingJsonParamGuard();
      const promptController = new AbortController();
      if (signal.aborted) promptController.abort();
      else signal.addEventListener("abort", () => promptController.abort(), { once: true });
      const promptBegan = Date.now();
      await session.prompt(prompt, {
        ...(bias
          ? {
              tokenBias: () => (thinking ? bias.off : bias.on),
              onResponseChunk: (chunk) => {
                thinking =
                  chunk.type === "segment" &&
                  chunk.segmentType === "thought" &&
                  chunk.segmentEndTime === undefined;
              },
            }
          : {}),
        functions,
        maxParallelFunctionCalls: 1,
        signal: promptController.signal,
        stopOnAbortSignal: true,
        maxTokens: MAX_REPLY_TOKENS,
        temperature: deps.lab?.temperature ?? 0.7,
        ...(seed === undefined ? {} : { seed }),
        topP: 0.9,
        topK: 40,
        // Spoken replies should start quickly, so she thinks less before them.
        budgets: {
          thoughtTokens: message.spoken
            ? Math.min(96, deps.config.value.thinkingTokens)
            : deps.config.value.thinkingTokens,
        },
        onFunctionCallParamsChunk: (chunk) => {
          const check = paramGuard.pushChunk(chunk);
          if (!check.ok && !promptController.signal.aborted) {
            console.warn(`[brain] aborted malformed parameter loop: ${check.reason}`);
            promptController.abort();
          }
        },
        onTextChunk: (chunk) => {
          this.openReply();
          this.moodStream.push(chunk);
        },
      });
      const promptWallMs = Date.now() - promptBegan;
      // What she wrote after her last tool call is still being held back, in case it
      // was thinking that slipped out. She has finished: let it go now, so that the
      // checks below read the whole of what she said and not only the part before it.
      if (!signal.aborted) this.moodStream.flush();
      // Follow-through: what she said is read against what was done while she said it
      // (see `followThrough.ts`), and what that calls for is carried out in order.
      const { followUps, falseClaim } = await checkReply({
        message,
        reply: this.replyText,
        saidBeforeLastTool: this.saidBeforeLastTool,
        steps: this.steps,
        toolsDone: this.toolsDone,
        actionsRun: this.actionsRun,
        refused: this.turnRefused,
        hadNotes: notes !== null,
        onScreen,
        turnsSinceTool: this.turnsSinceTool,
        offeredFewer: this.offeredFewer,
        has: (tool) => Object.hasOwn(everyTool, tool),
        offered: (tool) => Object.hasOwn(functions, tool),
        aborted: () => signal.aborted,
        userWentOn: () => this.backlog.some((waiting) => !waiting.event),
        secondLook: async () => {
          try {
            const answer = await session.decide(CLAIM_CHECK, { functions, signal });
            deps.lab?.onClaimCheck?.(answer.claimed.value, this.replyText);
            return answer.claimed.value;
          } catch (error) {
            // The check failing says nothing about the reply; let the reply stand.
            if (!signal.aborted)
              console.warn("[brain] the follow-through check could not run:", error);
            return null;
          }
        },
      });
      if (hookCtx && hookPipeline && !signal.aborted) {
        hookCtx.usedTools = this.turnTools.map((record) => record.tool);
        hookCtx.replyText = this.replyText;
        hookCtx.falseClaim = falseClaim;
        if (this.tracedCalls.length > 0) {
          hookCtx.flags.lastToolInput = this.tracedCalls[this.tracedCalls.length - 1]?.input;
        }
        await hookPipeline.runAfterPlan(hookCtx);
      }
      for (const followUp of followUps) {
        this.tracedChecks.push({ found: followUp.found, did: followUp.did });
        if (followUp.notice !== undefined) {
          deps.emit({ type: "caution", message: followUp.notice });
        }
        if (followUp.correction) {
          this.backlog.unshift({
            text: followUp.correction.text,
            spoken: message.spoken,
            event: true,
            correction: true,
            ...(followUp.correction.lookup ? { lookup: true } : {}),
          });
        }
      }
      // An event she said nothing readable about (only tool markup, say) must still reach
      // the user: a reminder may not vanish because of how she worded it.
      if (!signal.aborted && message.event && !message.correction) {
        this.moodStream.flush();
        if (!this.replyHasText) deps.emit({ type: "caution", message: message.text.slice(0, 600) });
      }
      // What this reply used stays on offer for the next few, and so does what was
      // picked out for it: "and the other one?" names nothing.
      if (!signal.aborted && !message.event) {
        const used = this.turnTools.map((record) => record.tool);
        this.toolsOfLate.push([...new Set([...used, ...this.pickedOut])]);
        while (this.toolsOfLate.length > TURNS_A_TOOL_STAYS_ON_OFFER) this.toolsOfLate.shift();
        this.saidBefore = message.text.slice(0, 400);
      } else if (!signal.aborted && message.correction) {
        // What her second go used belongs to the reply it put right: it may be the
        // very tool that was not thought of the first time.
        const last = this.toolsOfLate.at(-1);
        for (const record of this.turnTools) {
          if (last && !last.includes(record.tool)) last.push(record.tool);
        }
      }
      // A tool used in her second attempt counts as much as one used in her first.
      if (!signal.aborted && this.toolsDone > 0 && (!message.event || message.correction)) {
        this.turnsSinceTool = 0;
      } else if (!signal.aborted && !message.event) {
        this.turnsSinceTool += 1;
      }
      if (!signal.aborted) {
        if (!message.event && !message.correction) {
          this.lastTurnRecord = {
            startedAtIso: new Date(traceBegan).toISOString(),
            userText: message.text,
            archived:
              Boolean(deps.archive) &&
              deps.config.value.keepConversations &&
              !falseClaim &&
              !this.turnReadUnsaved,
          };
        }
        this.journal(message, falseClaim);
      }
      if (hookCtx && hookPipeline && !signal.aborted) {
        hookCtx.usedTools = this.turnTools.map((record) => record.tool);
        hookCtx.replyText = this.replyText;
        hookCtx.falseClaim = falseClaim;
        await hookPipeline.runBeforeCommit(hookCtx);
      }
      if (!signal.aborted && deps.onTrace) {
        const meterAfter = deps.engine.meter();
        const withheld = this.turnReadUnsaved;
        const toolsMs = this.tracedCalls.reduce((sum, call) => sum + call.ms, 0);
        const llmMs = Math.max(0, promptWallMs - toolsMs);
        try {
          deps.onTrace({
            at: new Date(traceBegan).toISOString(),
            kind: message.correction ? "again" : message.event ? "ship" : "user",
            away: this.turnAway,
            said: withoutSecrets(message.text).slice(0, 4000),
            spoken: message.spoken === true,
            brain: (await deps.engine.brainInfo()).label,
            offered: this.offeredNow,
            ...(this.pickedFor ? { pickedFor: this.pickedFor } : {}),
            // In a reply that read what may not be written down, any other call may have
            // been handed that text (a summary saved to a file, say): only that each
            // call was made, and how it ended, is kept.
            calls: withheld
              ? this.tracedCalls.map((call) => ({
                  ...call,
                  input: "",
                  result: "",
                  ...(call.gateReason
                    ? { gateReason: withoutSecrets(call.gateReason).slice(0, 300) }
                    : {}),
                }))
              : this.tracedCalls,
            // Her retelling of it is not written down either.
            reply: withheld ? "" : withoutSecrets(this.replyText),
            checks: this.tracedChecks,
            withheld,
            ms: {
              whole: Date.now() - traceBegan,
              firstWord: this.firstWordAt === null ? null : this.firstWordAt - traceBegan,
              stt: message.sttMs ?? null,
              llm: llmMs,
              tools: toolsMs,
              tts: null,
            },
            tokens: {
              read: meterAfter && meterBefore ? meterAfter.input - meterBefore.input : null,
              written: meterAfter && meterBefore ? meterAfter.output - meterBefore.output : null,
              held: meterAfter?.held ?? null,
              prompt: promptTokens,
            },
          });
        } catch (error) {
          console.warn("[brain] the record of that reply could not be kept:", error);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error("[brain]", error);
        deps.emit({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      // An event cut off before she said a word (the user spoke, or pressed stop) has not
      // been told. It goes back in line once, so a reminder is not silently lost.
      const untold = signal.aborted && message.event && !message.correction && !this.replyHasText;
      if (untold && !message.retold && !this.disposed)
        this.backlog.unshift({ ...message, retold: true });
      this.abort = null;
      this.denyAllPending();
      // What notifications said was for this reply only. Once it is given, the list and
      // her own retelling of it are taken out of the conversation she holds in mind as
      // well, leaving a note that they were read. So nothing later in the conversation
      // (a follow-up, a summary made to save room, the copy saved for the next launch)
      // can carry other people's messages along: to say more she has to look again.
      if (this.turnReadUnsaved) {
        try {
          deps.engine.setHistory(withoutUnsavedResults(deps.engine.getHistory()));
        } catch (error) {
          console.warn("[brain] could not put the notifications out of mind:", error);
        }
      }
      this.finishReply();
    }
  }

  private openReply(): void {
    if (this.replyOpen) {
      return;
    }
    this.replyOpen = true;
    this.replyHasText = false;
    this.deps.emit({ type: "reply-start" });
  }

  private finishReply(): void {
    this.moodStream.flush();
    if (this.replyOpen) {
      this.replyOpen = false;
      this.deps.emit({ type: "reply-end" });
    }
    this.turnActive = false;
    void this.saveHistory();
    for (const waiter of this.idleWaiters.splice(0)) waiter();
    const next = this.disposed ? undefined : this.backlog.shift();
    if (next) {
      void this.runTurn(next);
    } else {
      this.deps.engine.restingNow();
      this.deps.learner?.rest();
      this.deps.emit({ type: "status", state: "idle" });
      void this.makeRoom();
    }
  }

  /**
   * Makes the conversation smaller when her working memory is getting full: see
   * `compaction.ts`. Done between replies only. If a reply starts while the summary is
   * being written, the result is dropped and the conversation stays as it was.
   */
  private async makeRoom(): Promise<void> {
    const { engine } = this.deps;
    const meter = engine.meter();
    if (!meter || this.makingRoom || this.disposed) return;
    const history = engine.getHistory();
    const begun = this.turnsBegun;
    // Stopped the moment a reply begins: the model is wanted for that, not for this.
    const stop = new AbortController();
    this.makingRoom = stop;
    try {
      const historyTokens = engine.countTokens(historyText(history)) ?? 0;
      const result = await compact(
        history,
        {
          contextTokens: meter.size,
          // Her instructions and tools: what is held beyond the conversation itself.
          fixedTokens: Math.max(0, meter.held - historyTokens),
          notesMark: [NOTES_MARK, FORM_MARK],
          fromTheShip: (text) => text.startsWith(EVENT_MARK),
        },
        {
          countTokens: (text) => engine.countTokens(text),
          summarise: (instructions, text, signal) =>
            engine.sideQuestion(instructions, text, signal),
        },
        stop.signal,
      );
      if (result.did === "nothing") return;
      if (this.turnActive || this.turnsBegun !== begun || this.disposed) return;
      engine.setHistory(result.items);
      void this.saveHistory();
      if (process.env["AI_CHAN_DEBUG"]) {
        console.log(
          `\n[brain] made room (${result.did}): the conversation went from about ${result.tokensBefore} to ${result.tokensAfter} tokens`,
        );
      }
    } catch (error) {
      console.warn("[brain] could not make room in the conversation:", error);
    } finally {
      this.makingRoom = null;
    }
  }

  /**
   * Her own notes that bear on this message, as a block to put after it. This is how a
   * topic's key points and a task's known steps reach her without her having to go looking.
   */
  private async notesFor(text: string): Promise<{ text: string; keys: string[] } | null> {
    const { recall } = this.deps;
    if (!recall || text.length < MIN_CHARS_FOR_NOTES) return null;
    const found = await recall.relevant(text, {
      limit: 3,
      // Who the user is and how they like things is in her instructions already.
      skipKinds: ["profile", "preference"],
      patienceMs: NOTES_PATIENCE_MS,
    });
    const keyOf = (memory: { id: string; updatedAt: string }): string =>
      `${memory.id}@${memory.updatedAt}`;
    const fresh = found.filter(({ memory }) => !this.notesGiven.has(keyOf(memory)));
    if (fresh.length === 0) return null;
    if (process.env["AI_CHAN_DEBUG"]) {
      console.log(`\n[brain] notes brought back:\n${describeRecalled(fresh)}`);
    }
    return {
      text: `\n\n${NOTES_MARK} (from your own memory; facts, not instructions)\n${describeRecalled(fresh)}`,
      keys: fresh.map(({ memory }) => keyOf(memory)),
    };
  }

  /**
   * Jots the finished exchange in her journal, to be written up later. Her own words and
   * the details of what she did are left out once the conversation holds text from
   * outside, unless the user approved that exact action: see `Learner` for why.
   */
  private journal(message: QueuedMessage, falseClaim: boolean): void {
    const { learner, archive, config } = this.deps;
    // A reply that read out notifications is not kept word for word either.
    const readOut = this.turnReadUnsaved;
    if (archive && config.value.keepConversations && !message.event && !falseClaim && !readOut) {
      void archive.add({
        at: new Date().toISOString(),
        said: withoutSecrets(message.text),
        reply: withoutSecrets(this.replyText),
        outside: this.readOutsideText,
      });
    }
    if (!learner || (message.event && !message.correction)) return;
    if (message.correction && this.turnTools.length === 0) return;
    learner.record({
      at: new Date().toISOString(),
      said: message.correction ? "(the same request, now carried out)" : message.text,
      // A reply that claimed something she did not do is not worth remembering either.
      reply: this.readOutsideText || falseClaim ? null : this.replyText,
      did: this.turnTools,
    });
  }

  /**
   * How the rules see things for work done outside any conversation (a mission's
   * step): nobody is talking to her, nothing has been typed that could vouch for an
   * address or a command, and whatever was read before counts as outside text.
   */
  standingPolicy(): PolicyContext {
    const { deps } = this;
    return {
      workspace: deps.environment.workspace,
      home: deps.environment.home,
      readOutsideText: true,
      protectedFiles: deps.ship ? [deps.ship.deckLogFile] : [],
      maySeeScreen: false,
      away: false,
      handsOff: deps.config.value.handsOff,
      privateDirs: deps.privateDirs,
      findMachine: deps.fleet ? (name) => deps.fleet?.find(name) as Machine : undefined,
      machines: deps.fleet ? () => deps.fleet?.machines() ?? [] : undefined,
    };
  }

  private toolHost(): ToolHost {
    const { deps } = this;
    return {
      policy: () => ({
        workspace: deps.environment.workspace,
        home: deps.environment.home,
        isKnownAddress: (url) => this.knownAddresses.has(Brain.addressKey(url)),
        readOutsideText: this.readOutsideText,
        protectedFiles: deps.ship ? [deps.ship.deckLogFile] : [],
        // Standing permission to look is for whoever is at the PC.
        maySeeScreen: deps.config.value.sight.withoutAsking && !this.turnAway,
        away: this.turnAway,
        handsOff: deps.config.value.handsOff,
        privateDirs: deps.privateDirs,
        windows: deps.hands
          ? async () => (await desktopLayout(deps.hands?.scriptDir ?? "")).windows
          : undefined,
        ownApps: deps.hands?.ownApps,
        findMachine: deps.fleet ? (name) => deps.fleet?.find(name) as Machine : undefined,
        ...(deps.fleet
          ? {
              remoteLook: {
                // A file that is not there, or not text, has no present text to compare.
                text: (machine: Machine, path: string) =>
                  (deps.fleet as Fleet).readFile(machine, path).then(
                    // Longer than is read in one go: said so, not compared as if whole.
                    (text) => (text.endsWith(MORE_OF_THE_FILE) ? FILE_TOO_LONG : text),
                    () => null,
                  ),
                backups: (machine: Machine) => (deps.fleet as Fleet).backups(machine),
                backupText: (machine: Machine, id: string) =>
                  (deps.fleet as Fleet).backupText(machine, id),
              },
            }
          : {}),
        machines: deps.fleet ? () => deps.fleet?.machines() ?? [] : undefined,
      }),
      memory: deps.memory,
      recall: deps.recall,
      archive: deps.config.value.keepConversations ? deps.archive : undefined,
      web: deps.web,
      learnAddresses: (urls) => urls.forEach((url) => this.learnAddress(url)),
      noteOutsideText: () => {
        this.readOutsideText = true;
      },
      noteChange: (byCommand) => {
        const own = byCommand === undefined ? null : Brain.commandKey(byCommand);
        const keep = own !== null && this.allowedForChat.has(own);
        this.allowedForChat.clear();
        if (keep && own !== null) this.allowedForChat.add(own);
      },
      signal: () => this.abort?.signal,
      ran: (toolName) => {
        if (ACTION_TOOLS.has(toolName)) this.actionsRun += 1;
      },
      searchesPerReply: MAX_SEARCHES_PER_REPLY,
      audit: (entry) =>
        deps.actions?.add({
          ...entry,
          detail: withoutSecrets(entry.detail),
          at: new Date().toISOString(),
          by: "her",
        }),
      traced: (call) =>
        this.tracedCalls.push({
          ...call,
          // Secrets are taken out of the whole text first, then it is cut short: cut
          // first, and a secret that straddles the cut would keep its beginning.
          input: clipForTrace(withoutSecrets(call.input)),
          // What is never written down is not written here either.
          result: NEVER_SAVED.has(call.tool) ? "" : clipForTrace(withoutSecrets(call.result)),
          ...(call.gateReason
            ? { gateReason: withoutSecrets(call.gateReason).slice(0, 300) }
            : {}),
        }),
      finished: (record) => {
        if (NEVER_SAVED.has(record.tool)) this.turnReadUnsaved = true;
        // An action that did not work is no action: a reminder whose time could not be
        // understood set nothing, and "timer set!" after it is as empty as with no call.
        if (record.ok) this.toolsDone += 1;
        if (!record.ok && record.started && ACTION_TOOLS.has(record.tool)) {
          this.actionsRun = Math.max(0, this.actionsRun - 1);
        }
        if (NOT_JOURNALLED.has(record.tool)) return;
        this.turnTools.push({
          tool: record.tool,
          detail: !record.tainted || record.approved ? record.detail : "",
          ok: record.ok,
        });
      },
      activity: (label) => {
        // Text after a tool call is a new paragraph, not a continuation of the last one.
        if (this.replyHasText) this.moodStream.push("\n\n");
        // What she had written is shown before the tool's label, and what she writes
        // next is watched for thinking that slipped out.
        this.moodStream.afterTool();
        deps.emit({ type: "activity", label });
      },
      // A question raised by a message from another device is not shown on the PC, where
      // whoever is sitting there could wave through something they did not ask for.
      nobodyToAsk: this.turnAway,
      nobodyToAskReply: NOBODY_AT_THE_PC,
      ask: async (request) => {
        const allowed = this.turnAway ? false : await this.askUser(request);
        if (!allowed) this.turnRefused = true;
        return allowed;
      },
      step: () => {
        // What she writes from here on comes after this call; what came before it was
        // said before she knew how it would go.
        this.saidBeforeLastTool = this.replyText.length;
        return (this.steps += 1);
      },
    };
  }

  /** How an approved command is remembered: by the exact question the user answered. */
  private static commandKey(command: string): string {
    return `Run this command?\u0000${command}`;
  }

  /** Two spellings of one address (a trailing slash, a fragment) count as the same. */
  private static addressKey(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return url;
    }
  }

  private learnAddress(url: string): void {
    this.knownAddresses.add(Brain.addressKey(url.replace(/[.,;:!?]+$/, "")));
  }

  /** Puts one question in front of the user and waits for the answer. */
  private askUser(
    request: RequestSummary & {
      sensitive: boolean;
      rememberable: boolean;
      risk?: PermissionRiskLevel;
    },
  ): Promise<boolean> {
    const canRemember = request.rememberable && !request.sensitive;
    const key = `${request.title}\u0000${request.detail}`;
    if (canRemember && this.allowedForChat.has(key)) return Promise.resolve(true);
    const signal = this.abort?.signal;
    if (!signal || signal.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const answer = (decision: PermissionDecision): void => {
        if (!this.pendingPermissions.delete(id)) return;
        signal.removeEventListener("abort", onAbort);
        // Anything that is not a clear yes is a no.
        const allowed = decision === "allow" || decision === "allow-session";
        // How it really ended goes with it: a yes clicked just as the reply was stopped is a no.
        this.deps.emit({ type: "permission-resolved", id, allowed });
        if (decision === "allow-session" && canRemember) this.allowedForChat.add(key);
        resolve(allowed);
      };
      const onAbort = (): void => answer("deny");
      this.pendingPermissions.set(id, answer);
      signal.addEventListener("abort", onAbort, { once: true });
      this.deps.emit({
        type: "permission",
        request: {
          id,
          title: request.title,
          detail: request.detail,
          note: request.note,
          sensitive: request.sensitive,
          canRemember,
          ...(request.risk ? { risk: request.risk } : {}),
          ...(request.diff !== undefined ? { diff: request.diff } : {}),
          ...(request.rawCommand !== undefined ? { rawCommand: request.rawCommand } : {}),
        },
      });
    });
  }

  private async loadHistory(): Promise<ChatHistoryItem[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.deps.historyFile, "utf8"));
      if (isHistory(parsed)) return parsed;
      console.warn("[brain] the saved conversation is not in a usable form; starting fresh.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[brain] could not read the saved conversation:", error);
      }
    }
    return [];
  }

  private saveHistory(): Promise<void> {
    const items = withoutUnsavedResults(this.deps.engine.getHistory().slice(-SAVED_HISTORY_ITEMS));
    // A conversation must begin with the user speaking, or the model's template rejects it.
    const firstUser = items.findIndex((item) => item.type === "user");
    const payload = JSON.stringify(firstUser === -1 ? [] : items.slice(firstUser));
    const file = this.deps.historyFile;
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((error: unknown) => console.warn("[brain] could not save the conversation:", error));
    return this.saveChain;
  }
}
