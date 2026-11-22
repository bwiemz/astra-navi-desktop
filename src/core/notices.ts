import { spawn } from "node:child_process";
import type { PlatformAdapter } from "./platform/adapter.ts";
import { withoutUnseen } from "./unseen.ts";

/**
 * The desktop's notifications, kept in mind for a while: "what was that notification?",
 * "did I miss anything?".
 *
 * Every program that puts up a notification does it by calling one method on the user's
 * session bus. This listens for those calls and keeps the last few. Three things about it
 * are deliberate:
 *
 * - It is off until the user switches it on. A notification carries other people's
 *   words (a message, the subject of a mail), and reading those is the user's to allow.
 * - What is kept lives in memory only. Nothing here is written to disk, to her notes
 *   or to her record, and it is all let go when the switch goes off or the app closes.
 * - Programs on the never-read list (password managers, wallets, sign-in prompts) are
 *   only counted: "a notification from KeePassXC, not read". Her own are left out.
 *
 * What a notification says was written by somebody else. It reaches her through a tool
 * whose answer is marked as information, and from then on the conversation counts as
 * holding outside text.
 */

/** One notification as it is kept. */
export interface Notice {
  /** The program that sent it, as it named itself. */
  app: string;
  /** Its headline. Empty for one that was not read. */
  summary: string;
  /** Its text. Empty for one that was not read. */
  body: string;
  /** When it came in, as an ISO time. */
  at: string;
  /** True for a program on the never-read list: only that it came is known. */
  notRead: boolean;
  /** The number the program gave for the notification it replaces, when it gave one. */
  replaces: number;
  /** The program's other name (its desktop entry), kept only to match the never-read list. */
  entry?: string;
}

/** A notification as the bus carried it, before anything is cut or left out. */
export interface NotifyCall {
  app: string;
  replaces: number;
  summary: string;
  body: string;
  /** The program's desktop file, when it said (`desktop-entry` among the hints). */
  desktopEntry: string;
}

export const KEPT_NOTICES = 30;
/** More notifications than this in one second are not read. */
export const MAX_PER_SECOND = 20;
/** A monitor that ran this long before dying is restarted promptly; a shorter-lived one less and less often. */
const STABLE_AFTER_MS = 60_000;
export const MAX_SUMMARY_CHARS = 120;
export const MAX_BODY_CHARS = 300;
const MAX_APP_CHARS = 60;
/** A line from the monitor longer than this is not a notification anyone meant to be read. */
const MAX_LINE_CHARS = 200_000;

/** Programs whose notifications are never read, whatever the user's own list says. */
export const NEVER_READ_BY_DEFAULT: readonly string[] = [
  "keepassxc",
  "bitwarden",
  "1password",
  "kwallet",
  "gnome-keyring",
  "polkit",
  "authenticator",
];

/** The command that shows the calls, and nothing else that passes on the bus. */
export const MONITOR_COMMAND = "busctl";
export const MONITOR_ARGS: readonly string[] = [
  "--user",
  "monitor",
  "--json=short",
  "--match",
  "type='method_call',interface='org.freedesktop.Notifications',member='Notify'",
];

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * A notification's text made fit to keep: its markup taken out, the few named
 * characters it may be written with put back, anything that does not show removed, and
 * the whole cut to length. What is left is plain words and stays plain words: a body
 * that spells out a tag with `&lt;` comes out as the letters, which nothing here reads
 * as markup again.
 */
export function plainText(text: string, max: number): string {
  const plain = text
    .slice(0, 8000)
    .replace(/<[^<>]{0,300}>/g, " ")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isInteger(code) && code > 0x1f && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : " ";
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[\n\r\t]+/g, " ");
  const seen = withoutUnseen(plain).replace(/\s+/g, " ").trim();
  // Cut between characters, not through the middle of one written as a pair.
  const letters = [...seen];
  return letters.length > max
    ? `${letters
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : seen;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one line of the monitor's output. Returns the notification it carries, or null
 * for anything else: another method, a line that is not JSON, arguments of the wrong
 * kind. Nothing is trusted to be in the shape it should be.
 */
export function parseNotifyLine(line: string): NotifyCall | null {
  if (line.length === 0 || line.length > MAX_LINE_CHARS || !line.startsWith("{")) return null;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(message)) return null;
  if (
    message["type"] !== "method_call" ||
    message["interface"] !== "org.freedesktop.Notifications" ||
    message["member"] !== "Notify"
  ) {
    return null;
  }
  const payload = message["payload"];
  if (!isRecord(payload) || !Array.isArray(payload["data"])) return null;
  const [app, replaces, , summary, body, , hints] = payload["data"] as unknown[];
  if (typeof app !== "string" || typeof summary !== "string" || typeof body !== "string") {
    return null;
  }
  const entry = isRecord(hints) ? hints["desktop-entry"] : undefined;
  return {
    app,
    replaces:
      typeof replaces === "number" && Number.isInteger(replaces) && replaces > 0 ? replaces : 0,
    summary,
    body,
    desktopEntry: isRecord(entry) && typeof entry["data"] === "string" ? entry["data"] : "",
  };
}

/** True when one of the listed words is part of the program's name, whatever the capitals. */
export function isListed(names: readonly string[], listed: readonly string[]): boolean {
  const lowered = names.map((name) => name.toLowerCase()).filter(Boolean);
  return listed.some((word) => {
    const wanted = word.trim().toLowerCase();
    return wanted !== "" && lowered.some((name) => name.includes(wanted));
  });
}

/** The monitor as the watch sees it: something that gives lines and ends. Replaced in tests. */
export interface MonitorChild {
  /** Called with every line it prints. */
  onLine(listener: (line: string) => void): void;
  /** Called once when it ends. `missing` means the program could not be started at all. */
  onExit(listener: (how: { missing: boolean }) => void): void;
  /** Ends it. Only ever this one process, by its own handle. */
  kill(): void;
}

/** Starts the real monitor. */
export function startMonitor(): MonitorChild {
  const child = spawn(MONITOR_COMMAND, [...MONITOR_ARGS], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Lines are cut out by hand, not by a line reader: a reader keeps the whole of a line
  // in memory until its end, and one notification can be many megabytes. A line that
  // grows past the limit is dropped as it arrives and skipped to its end.
  let heard: ((line: string) => void) | null = null;
  let pending = "";
  let skipping = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    let rest = chunk;
    for (let at = rest.indexOf("\n"); at !== -1; at = rest.indexOf("\n")) {
      const line = pending + rest.slice(0, at);
      rest = rest.slice(at + 1);
      pending = "";
      if (skipping) skipping = false;
      else if (line.length <= MAX_LINE_CHARS) heard?.(line);
    }
    if (skipping) return;
    pending += rest;
    if (pending.length > MAX_LINE_CHARS) {
      pending = "";
      skipping = true;
    }
  });
  let ended = false;
  let listener: ((how: { missing: boolean }) => void) | null = null;
  let how: { missing: boolean } | null = null;
  const end = (missing: boolean): void => {
    if (ended) return;
    ended = true;
    heard = null;
    how = { missing };
    listener?.(how);
  };
  child.on("error", (error: NodeJS.ErrnoException) => end(error.code === "ENOENT"));
  child.on("exit", () => end(false));
  return {
    onLine: (listen) => {
      heard = listen;
    },
    onExit: (ended_) => {
      listener = ended_;
      if (how) ended_(how);
    },
    kill: () => {
      if (!ended) child.kill("SIGTERM");
    },
  };
}

export interface NoticeWatchOptions {
  /** Optional cross-platform adapter providing OS notification stream monitoring. */
  adapter?: PlatformAdapter;
  /** The user's own never-read list, read afresh for every notification. */
  skip(): readonly string[];
  /** How this app names itself in its own notifications: those are left out. */
  ownNames: readonly string[];
  /** Starts the monitor. Left out: the real one. */
  start?: () => MonitorChild;
  now?: () => Date;
}

/** A monitor that ends sooner than this after starting did not really start. */
const QUICK_EXIT_MS = 2000;
/** After this many quick exits in a row it is taken as refused, and left alone. */
const QUICK_EXITS_BEFORE_GIVING_UP = 3;
const FIRST_RETRY_MS = 2000;
const LONGEST_RETRY_MS = 60_000;

export class NoticeWatch {
  private floodSecond = 0;
  private floodCount = 0;
  private readonly options: NoticeWatchOptions;
  /** Oldest first. */
  private kept: Notice[] = [];
  private child: MonitorChild | null = null;
  private retry: NodeJS.Timeout | null = null;
  private retryMs = FIRST_RETRY_MS;
  private quickExits = 0;
  private wanted = false;
  private since: Date | null = null;
  private problem: string | null = null;

  constructor(options: NoticeWatchOptions) {
    this.options = options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** True while she is listening for notifications. */
  get running(): boolean {
    return this.child !== null;
  }

  /** Since when she has been listening, or null while she is not. */
  get listeningSince(): Date | null {
    return this.since;
  }

  /** Why she is not listening although she was asked to, in plain words, or null. */
  get trouble(): string | null {
    return this.problem;
  }

  /** How many are held right now. */
  get held(): number {
    return this.kept.length;
  }

  /** The notifications held, newest first. */
  recent(): Notice[] {
    // The never-read list as it stands now, not as it stood when each one arrived: a
    // program added to it a moment ago is not read out from what was already held.
    const listed = [...NEVER_READ_BY_DEFAULT, ...this.options.skip()];
    return [...this.kept]
      .reverse()
      .map((notice) =>
        !notice.notRead && isListed([notice.app, notice.entry ?? ""], listed)
          ? { ...notice, summary: "", body: "", notRead: true }
          : notice,
      );
  }

  /** Starts listening. Does nothing when already listening. */
  start(): void {
    this.wanted = true;
    this.problem = null;
    this.quickExits = 0;
    this.retryMs = FIRST_RETRY_MS;
    if (this.child || this.retry) return;
    this.since = this.now();
    this.launch();
  }

  /** Stops listening and lets go of everything that was held. */
  stop(): void {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.kept = [];
    this.since = null;
    this.problem = null;
  }

  dispose(): void {
    this.stop();
  }

  private launch(): void {
    if (!this.wanted || this.child) return;
    const startedAt = Date.now();
    let child: MonitorChild;
    try {
      const starter =
        this.options.start ?? this.options.adapter?.systemNotices.spawnMonitor ?? startMonitor;
      child = starter();
    } catch {
      this.giveUp("The program that listens for notifications (busctl) could not be started.");
      return;
    }
    this.child = child;
    child.onLine((line) => {
      // A line from a monitor that has been replaced or stopped is nobody's any more.
      if (this.child === child) this.hear(line);
    });
    child.onExit(({ missing }) => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      if (!this.wanted) return;
      if (missing) {
        this.giveUp(
          "Notifications cannot be read on this system: the program that listens for them (busctl) is not installed.",
        );
        return;
      }
      if (Date.now() - startedAt < QUICK_EXIT_MS) {
        this.quickExits += 1;
        if (this.quickExits >= QUICK_EXITS_BEFORE_GIVING_UP) {
          this.giveUp(
            "Notifications cannot be read: the desktop would not let her listen for them.",
          );
          return;
        }
      } else {
        this.quickExits = 0;
        // Only a monitor that held up for a good while earns a quick restart; one that
        // keeps dying after a few seconds is tried less and less often.
        if (Date.now() - startedAt >= STABLE_AFTER_MS) this.retryMs = FIRST_RETRY_MS;
      }
      const wait = this.retryMs;
      this.retryMs = Math.min(LONGEST_RETRY_MS, this.retryMs * 2);
      this.retry = setTimeout(() => {
        this.retry = null;
        this.launch();
      }, wait);
      this.retry.unref();
    });
  }

  /** Stops trying. The reason is kept for her self-check; switching off and on tries again. */
  private giveUp(why: string): void {
    this.problem = why;
    this.since = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  /**
   * A line as it comes from the monitor, with a limit on how many are read in a second.
   * A program (or a web page, through the browser) can send notifications by the
   * thousand. Past a handful a second the rest are let go unread: nobody was shown
   * them either, and reading each one would stall the app.
   */
  hear(line: string): void {
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.floodSecond) {
      this.floodSecond = second;
      this.floodCount = 0;
    }
    this.floodCount += 1;
    if (this.floodCount <= MAX_PER_SECOND) this.take(line);
  }

  /** Takes one line. Public so that tests can hand lines in. */
  take(line: string): void {
    const call = parseNotifyLine(line);
    if (!call) return;
    const names = [call.app, call.desktopEntry];
    if (isListed(names, this.options.ownNames)) return;
    const app = plainText(call.app || call.desktopEntry || "an unnamed program", MAX_APP_CHARS);
    const notRead = isListed(names, [...NEVER_READ_BY_DEFAULT, ...this.options.skip()]);
    const summary = notRead ? "" : plainText(call.summary, MAX_SUMMARY_CHARS);
    const body = notRead ? "" : plainText(call.body, MAX_BODY_CHARS);
    // A program clearing its own notification sends an empty one; there is nothing to keep.
    if (!notRead && summary === "" && body === "") return;
    const notice: Notice = {
      app,
      summary,
      body,
      at: this.now().toISOString(),
      notRead,
      replaces: call.replaces,
      entry: plainText(call.desktopEntry, MAX_APP_CHARS),
    };
    // A program that updates a notification (a download's progress, a song changing)
    // names the one it replaces. That one is rewritten in place, so the list does not
    // fill with forty stages of one download.
    if (call.replaces > 0) {
      let earlier = this.kept.findLastIndex(
        (entry) => entry.app === app && entry.replaces === call.replaces,
      );
      // The first of a run was sent without a number (the desktop gives it one in its
      // answer, which is not listened to). It is known by being that program's latest,
      // with the same headline.
      if (earlier === -1) {
        const latest = this.kept.findLastIndex((entry) => entry.app === app);
        const first = this.kept[latest];
        if (first && first.replaces === 0 && first.summary === summary) earlier = latest;
      }
      if (earlier !== -1) this.kept.splice(earlier, 1);
    }
    this.kept.push(notice);
    if (this.kept.length > KEPT_NOTICES) this.kept.splice(0, this.kept.length - KEPT_NOTICES);
  }
}

function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** One notification as a line for her. */
export function describeNotice(notice: Notice): string {
  if (notice.notRead) {
    return `${clockTime(notice.at)} ${notice.app}: (not read: this program is on the never-read list)`;
  }
  const words = [notice.summary, notice.body].filter(Boolean).join(" — ");
  return `${clockTime(notice.at)} ${notice.app}: ${words}`;
}
