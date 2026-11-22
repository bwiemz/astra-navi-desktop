import type { TurnTrace } from "../src/core/trace.ts";
/**
 * The shapes her test suite is written in: a case (what she is told and what should
 * come of it), what was seen when the case was run, and the report made from many.
 * Nothing here runs a model; see `scripts/eval.ts` for that.
 */

export const CATEGORIES = [
  "tools",
  "honesty",
  "injection",
  "character",
  "memory",
  "knowledge",
  "multistep",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_NAMES: Record<Category, string> = {
  tools: "Tool choice and arguments",
  honesty: "Follow-through honesty",
  injection: "Safe under injected text",
  character: "Character and form",
  memory: "Using what she knows",
  knowledge: "Reasoning and knowledge",
  multistep: "Multi-step",
};

export type Language = "en" | "ja" | "zh";

/** A rule for one argument of a tool call. */
export type ArgCheck =
  | RegExp
  /** Exactly this value. */
  | { is: string | number | boolean }
  /** A number within `within` of `near`. */
  | { near: number; within: number }
  /** Holds this text, whatever the capitals. */
  | { has: string }
  /** Left out, or empty. */
  | { absent: true };

export type ArgChecks = Record<string, ArgCheck>;

/** A rule for one tool call. */
export interface CallCheck {
  /** The tool's name, or several when any of them will do. */
  tool: string | string[];
  /** Rules for its arguments; with several sets, any one set may hold. */
  args?: ArgChecks | ArgChecks[];
  /** What the tool answered must match this (for tools that really run, like the calculator). */
  result?: RegExp;
}

/** Rules for what she said in answer to the last message of a case. */
export interface ReplyCheck {
  /** Every one of these must be found. */
  matches?: RegExp[];
  /** At least one of these must be found. */
  anyOf?: RegExp[];
  /** None of these may be found. */
  lacks?: RegExp[];
  /** One of these answers must appear, compared without capitals or punctuation. */
  answer?: (string | RegExp)[];
  maxSentences?: number;
  /** The language the reply must be written in, told by its script. */
  language?: Language;
  /** Exactly one mood tag, before anything else. */
  oneMood?: boolean;
  /** She speaks of herself by name, not as "I". */
  byName?: boolean;
  /** No emoji, headings or tables. */
  plain?: boolean;
  /** Nothing that sounds odd read aloud: no lists, code or formatting. */
  speakable?: boolean;
}

export interface Expectation {
  /** Calls she must make and have carried out. */
  calls?: CallCheck[];
  /** The calls must come in the order given (others may come between). */
  inOrder?: boolean;
  /** She may make no more calls than this, whatever they are (so a loop of retries fails). */
  maxCalls?: number;
  /** She may call no tool at all, except the ones named here. */
  noCallsExcept?: string[];
  /**
   * Calls that must not be carried out. A case passes when none was; whether she even
   * tried is recorded beside it as "resisted".
   */
  forbidden?: CallCheck[];
  reply?: ReplyCheck;
  /**
   * She may not say something was done unless a tool that does things was carried out
   * for that message, and the app's own follow-through check must not have had to step in.
   */
  honest?: boolean;
}

export interface NoteSeed {
  kind: "profile" | "preference" | "project" | "fact" | "episode" | "topic" | "skill";
  text: string;
  /** For a topic or a task: its key points or steps. */
  points?: string[];
}

export interface EvalCase {
  id: string;
  category: Category;
  /** The language she is set to. English when left out. */
  language?: Language;
  /** Notes she already has when the conversation starts. */
  notes?: NoteSeed[];
  /** Files in her own folder when the conversation starts: name and content. */
  files?: Record<string, string>;
  /** What the pretend web gives back. */
  web?: {
    results?: { title: string; url: string; snippet: string }[];
    /** Page text by address. An address not listed "cannot be reached". */
    pages?: Record<string, string>;
  };
  /**
   * What pretend tools answer, by tool name: a text, or a function of the arguments.
   * Tools not named here answer with the world's stock reply. `{folder}` in an answer
   * becomes the path of her own folder for this test.
   */
  tools?: Record<string, string | ((params: Record<string, unknown>) => string)>;
  /** Which approval questions get a yes: all, or those whose title and detail match. Default: none. */
  approve?: "all" | RegExp;
  /** The tools she is offered. Left out: all of them. An empty list: none. */
  offer?: string[];
  /** "Hands off the controls" is switched on. */
  handsOff?: boolean;
  /**
   * Her notes are not handed to her beside the message, as happens for real when the
   * model that matches notes by meaning is not ready in time. She has to look for them.
   */
  quietNotes?: boolean;
  /** What the user says, in order. A message starting with "voice:" is spoken. */
  turns: string[];
  expect: Expectation;
}

export type Outcome = "done" | "failed" | "declined" | "refused";

/** One tool call she made. */
export interface SeenCall {
  /** Which of the case's messages it was made for, counting from 0. */
  turn: number;
  tool: string;
  params: Record<string, unknown>;
  outcome: Outcome;
  /** What the tool answered her, shortened. */
  result: string;
  /**
   * How much of her reply to that message she had written when the call was made, in
   * characters. What comes after it is what she said knowing how the call ended.
   * Missing in reports written before this was recorded.
   */
  at?: number;
}

/** Everything seen while a case was run once. */
export interface Seen {
  calls: SeenCall[];
  /** What she said, per message. */
  replies: string[];
  /** The mood tags she gave, per message. */
  moods: string[][];
  /** Whether a mood tag came before any words, per message. */
  moodFirst: boolean[];
  /** How many times the app's follow-through check made her do it over. */
  corrections: number;
  /** Notes from the app shown under her reply (a claim that was not true, an error). */
  cautions: string[];
  errors: string[];
  /** Approval questions put to the user, and how the case answered each. */
  asked: { title: string; detail: string; allowed: boolean }[];
  /** Whole time taken, and time until her first word, in milliseconds. */
  ms: number;
  firstWordMs: number | null;
  /** How much she held in mind when the case ended, in tokens. */
  heldTokens: number | null;
  /**
   * How many tokens the model read during the case: little when it picks up from what
   * it had already read, her whole instructions when it has to start over.
   */
  readTokens?: number | null;
  /**
   * Each time the app's follow-through check took a second look at a reply: how sure it
   * was that the reply claimed an action nothing had carried out (0 to 1), and how the
   * reply began. Missing in reports written before this was recorded.
   */
  claimChecks?: ClaimCheck[];
  /**
   * The app's own record of each reply in the case, in order, her second goes included:
   * what was asked, the tools on offer, each call, what she said, which checks stepped
   * in. Missing in reports made before 2026-11-22.
   */
  traces?: TurnTrace[];
}

export interface ClaimCheck {
  sureness: number;
  /** The start of the reply that was looked at. */
  reply: string;
}

export interface Score {
  pass: boolean;
  /** Why it failed, one line per rule broken. */
  failures: string[];
  /** For cases with forbidden calls: true when she did not even try one. */
  resisted?: boolean;
  /**
   * Things that showed in her words and never should: her private thinking, or a line the
   * app wrote for her eyes only. Counted for every case and reported in a column of its
   * own; a case fails for it only where the case is about how she speaks.
   */
  leaks: string[];
}

export interface CaseResult {
  id: string;
  category: Category;
  language: Language;
  runs: (Score & Seen)[];
  /** The share of runs that passed. */
  passRate: number;
}

export interface SpeedReport {
  /** Loading the model from disk, in seconds. */
  loadSeconds: number | null;
  /** From sending the first message after loading to her first word. */
  firstReplySeconds: number | null;
  /** Median wait for her first word over replies that used no tool. */
  firstWordSeconds: number | null;
  /** Words written per second in a plain writing task, in tokens. */
  tokensPerSecond: number | null;
  /** Her standing instructions, and everything read for a first message (tools included). */
  instructionTokens: number | null;
  firstTurnTokens: number | null;
  /** Median of what she held in mind at the end of a case: instructions, tools, the exchange. */
  caseTokens: number | null;
  /** Tokens read in a case (median): see `Seen.readTokens`. */
  readTokens?: number | null;
  /** Graphics memory in use on the whole card: before loading, once loaded, and at its highest. */
  /**
   * Graphics memory held by the test process alone: once loaded, and at its highest
   * while the cases ran. Unlike the whole-card readings, other programs do not show in it.
   */
  ownVramLoadedMiB: number | null;
  ownVramPeakMiB: number | null;
  vramBeforeMiB: number | null;
  vramLoadedMiB: number | null;
  vramPeakMiB: number | null;
  /** Memory of the test process itself (the model's share on the processor side). */
  residentMiB: number;
}

/** What the app's follow-through check did over a whole run of the suite. */
export interface FollowThrough {
  /** Runs in all, and those in which the check took a second look at least once. */
  runs: number;
  checkedRuns: number;
  /** Second looks in all. One run can have two: the reply, then her attempt to put it right. */
  checks: number;
  /** Second looks that were sure enough to make her do it over or to warn the user. */
  sureEnough: number;
  /** Runs in which she was made to do it over. */
  correctedRuns: number;
  /** Every sureness seen, lowest first. */
  sureness: number[];
}

/**
 * Marks of the suite a report was made with, so that two reports can be told to have
 * been run on the same cases and marked by the same rules.
 */
export interface SuiteStamp {
  /** What she was given: the cases' set-up and the pretend world. Fixed when the run was made. */
  world: string;
  /** How a run is marked: the rules and what each case expects. Renewed when marked again. */
  marking: string;
  /**
   * She herself as she was for the run: her instructions, the rules her tools pass
   * through, and what filters her replies. Fixed when the run was made. A difference
   * here is often the very change being measured, so it is noted, not warned about.
   * Missing in reports stamped before this was kept.
   */
  her?: string;
}

export interface Report {
  label: string;
  brain: string;
  /** Present when the run was stopped before every case was done: how far it got. */
  partial?: { done: number; of: number };
  /** Present when the report was put together from this many pieces run at different times. */
  pieces?: number;
  /** Present when only some of the suite was asked for (--only, --limit). */
  subset?: { only: string[]; limit: number | null };
  /** Missing in reports written before stamps were kept. */
  suite?: SuiteStamp;
  /** When the marks were last made again from what was seen, if they were. */
  rescoredAt?: string;
  startedAt: string;
  minutes: number;
  settings: {
    temperature: number;
    seed: number;
    repeat: number;
    thinkingTokens: number;
    /** The most working memory she was allowed, in tokens. */
    contextSize: number;
    /**
     * The working memory she really got: less than allowed when the graphics card was
     * short of room. Null when the engine does not say; missing in older reports.
     */
    contextUsed?: number | null;
    /** The smaller way of holding the conversation in graphics memory was on. Missing in older reports. */
    lean?: boolean;
    /** A trial: each case was offered only a small core of tools and its own. */
    itsToolsOnly?: boolean;
    /** The app's own choosing of tools per message was switched on. */
    fittingTools?: boolean;
    /** A trial: the leaning away from first-person words was switched off. */
    plainWords?: boolean;
    /** Run on the processor alone with this many threads. Missing: on the graphics card. */
    cpu?: number;
  };
  categories: Record<
    string,
    { cases: number; passRate: number; resistedRate: number | null; cleanRate: number }
  >;
  overall: number;
  /** The share of all runs in which nothing leaked into her words. */
  clean: number;
  /** Missing in reports written before it was recorded. */
  followThrough?: FollowThrough;
  speed: SpeedReport;
  cases: CaseResult[];
}
