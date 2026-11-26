import type { WindowSeen } from "./hands.ts";

/**
 * Keeping watch on the screen.
 *
 * With this on she always knows which program and window the user is in and for how
 * long, without being asked to look. The window manager tells her each time the window
 * in front changes. Small windows (dialogs) she also reads, a moment after they appear
 * and again now and then, so she can speak up when one of them is an error. A full
 * window she reads only when asked to look.
 *
 * What she sees this way lives in memory only. It is not written to disk, not put in
 * the system log, and not handed to the part of her that writes notes. Windows that
 * hold secrets, private browsing and full-screen programs (games, films) are not read:
 * of those she knows only the program's name.
 */

import { replaceInternalCaptain } from "./characterLayer.ts";

/** Starts the line that tells her which program the user is in. */
export const SCREEN_MARK = "[on screen]";

/** One stretch of time spent in one window. */
export interface Stretch {
  app: string;
  title: string;
  from: number;
  to: number;
}

export interface Glance {
  app: string;
  title: string;
  /** The text read from the window, or "" when it is not one she reads. */
  text: string;
  /** How long ago it was read. */
  ageMs: number;
  /** Why there is no text, when there is none. */
  unread: string | null;
}

export interface WatchNotice {
  app: string;
  title: string;
  /** The line on screen that looks like trouble. */
  line: string;
}

export interface WatchDeps {
  /** Starts the window manager's reports; resolves to a function that ends them. */
  follow(listener: (seen: WindowSeen) => void): Promise<() => Promise<void>>;
  /** Reads the text of the window in front. */
  read(signal: AbortSignal): Promise<string>;
  /** The app's own windows, by program name. */
  ownApps: readonly string[];
  /** Programs the user has said she must never read. */
  skip(): readonly string[];
  /** Something on screen looks like it needs attention. */
  onNotice?(notice: WatchNotice): void;
  /** Optional active user form of address so `[screen]` lines avoid "Captain" when customized. */
  userAddress?(): string;
  now?(): number;
}

/** Programs whose windows hold secrets. She knows they are open and reads nothing in them. */
const PRIVATE_APPS =
  /(keepass|bitwarden|1password|enpass|kwallet|seahorse|keyring|lastpass|dashlane|nordpass|proton-?pass|authenticator|pinentry|ksshaskpass|polkit|kscreenlocker|tor-?browser|bank|ledger|electrum)/i;
/** Where other people's messages are. She knows the window is open, and does not read it. */
const MESSAGE_APPS =
  /(signal|element|discord|vesktop|telegram|whatsapp|slack|teams|neochat|fractal|konversation|hexchat|thunderbird|betterbird|kmail|kontact|evolution|geary)/i;
const PRIVATE_TITLES =
  /private browsing|private window|incognito|inprivate|プライベート|シークレット|隐私|無痕|无痕|\bpass(?:word|phrase|wort|code)s?\b|パスワード|密码|密碼|\bsign[ -]?in\b|\blog[ -]?in\b|\b2fa\b|verification code|recovery (?:key|phrase|code)|seed phrase/i;

const TROUBLE =
  /\b(error|failed|failure|crash(?:ed)?|not responding|fatal|exception|access (?:is )?denied|permission denied|cannot|could not|unable to|has stopped|out of memory|no space left)\b|エラー|失敗|クラッシュ|応答なし|応答していません|错误|錯誤|失败|失敗|崩溃|崩潰|无响应|沒有回應/i;
const CRASH_HANDLERS = /(drkonqi|crashreport|crash-?reporter|apport|abrt|bug-?buddy)/i;

const SETTLE_MS = 2500;
/** A small window (a dialog) is cheap to read, and is where trouble shows up. */
const READ_EVERY_MS = 45_000;
const SLOWEST_READ_MS = 5 * 60_000;
const TITLE_SETTLE_MS = 3000;
const MAX_STRETCHES = 240;
/** She is told the program again when it changes, or after this long in the same one. */
const RETELL_AFTER_MS = 20 * 60_000;
/** Windows smaller than this are treated as dialogs when looking for trouble. */
const SMALL_WINDOW_AREA = 700 * 500;

/** True for a window whose text, and even whose title, she must not keep. */
export function isPrivate(
  seen: Pick<WindowSeen, "app" | "title">,
  skip: readonly string[],
): boolean {
  const app = seen.app.toLowerCase();
  return (
    PRIVATE_APPS.test(app) ||
    PRIVATE_TITLES.test(seen.title) ||
    skip.some((name) => name.trim().length > 0 && app.includes(name.trim().toLowerCase()))
  );
}

/** Why she does not read this window, or null when she does. */
export function unreadable(
  seen: Pick<WindowSeen, "app" | "title" | "fullScreen">,
  skip: readonly string[],
): string | null {
  if (isPrivate(seen, skip)) return "it is private";
  if (MESSAGE_APPS.test(seen.app)) return "it holds other people's messages";
  if (seen.fullScreen) return "it is full-screen";
  return null;
}

/** True for a dialog or another window small enough to be one. */
export function isSmall(seen: Pick<WindowSeen, "dialog" | "width" | "height">): boolean {
  return seen.dialog || seen.width * seen.height < SMALL_WINDOW_AREA;
}

/** The first line of a window's text that reads like something went wrong. */
export function troubleLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (TROUBLE.test(line)) return line.trim().slice(0, 200);
  }
  return null;
}

function minutes(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total < 1) return "just now";
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  return total % 60 === 0 ? `${hours} h` : `${hours} h ${total % 60} min`;
}

/** A program's name without the reversed-address prefix some carry ("org.kde.kate" becomes "kate"). */
export function programName(app: string): string {
  const parts = app.split(".");
  const name = parts.length >= 3 ? (parts[parts.length - 1] ?? app) : app;
  // This name reaches her without being marked as outside text, so it is kept to what a
  // program's name looks like: no sentences, no line breaks.
  return (
    name
      .replace(/[^\p{L}\p{N} ._+-]/gu, "")
      .trim()
      .slice(0, 40) || "a program"
  );
}

/** The stretches as a short list, newest last, with neighbours in one program joined. */
export function describeTimeline(stretches: readonly Stretch[], now: number): string {
  const joined: Stretch[] = [];
  for (const stretch of stretches) {
    const last = joined[joined.length - 1];
    if (last && last.app === stretch.app && last.title === stretch.title) last.to = stretch.to;
    else if (stretch.to - stretch.from >= 5000 || stretch === stretches[stretches.length - 1])
      joined.push({ ...stretch });
  }
  const clock = (at: number): string => {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  return joined
    .slice(-40)
    .map(
      (stretch) =>
        `- ${clock(stretch.from)} to ${stretch.to >= now ? "now" : clock(stretch.to)} (${minutes(stretch.to - stretch.from)}): ${programName(stretch.app)}${stretch.title ? ` — "${stretch.title}"` : ""}`,
    )
    .join("\n");
}

export class ScreenWatch {
  private readonly deps: WatchDeps;
  private stopFollowing: (() => Promise<void>) | null = null;
  private starting: Promise<void> | null = null;
  /** The window the user is in. Her own window coming to the front does not change it. */
  private front: (WindowSeen & { since: number; secret: boolean }) | null = null;
  /** True while that window is really the one in front (false when hers is). */
  private frontIsActive = false;
  private readonly stretches: Stretch[] = [];
  private reading: { id: string; text: string; at: number } | null = null;
  private readTimer: NodeJS.Timeout | null = null;
  private titleTimer: NodeJS.Timeout | null = null;
  private pendingTitle: WindowSeen | null = null;
  private readEvery = READ_EVERY_MS;
  private readingNow: AbortController | null = null;
  /** A look came due while another was still under way. */
  private lookDue = false;
  private readonly noticed = new Set<string>();
  private toldApp: string | null = null;
  private toldAt = 0;

  constructor(deps: WatchDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get running(): boolean {
    return this.stopFollowing !== null || this.starting !== null;
  }

  start(): Promise<void> {
    if (this.stopFollowing) return Promise.resolve();
    this.starting ??= this.deps
      .follow((seen) => this.seen(seen))
      .then((stop) => {
        this.stopFollowing = stop;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** Stops watching and forgets everything seen. */
  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const stop = this.stopFollowing;
    this.stopFollowing = null;
    if (this.readTimer) clearTimeout(this.readTimer);
    if (this.titleTimer) clearTimeout(this.titleTimer);
    this.readTimer = null;
    this.titleTimer = null;
    this.pendingTitle = null;
    this.readingNow?.abort();
    this.lookDue = false;
    this.front = null;
    this.frontIsActive = false;
    this.reading = null;
    this.stretches.length = 0;
    this.noticed.clear();
    this.toldApp = null;
    await stop?.().catch(() => undefined);
  }

  private whyUnread(front: WindowSeen & { secret: boolean }): string | null {
    return front.secret ? "it is private" : unreadable(front, this.deps.skip());
  }

  private watching(): boolean {
    return this.stopFollowing !== null;
  }

  private isOwn(app: string): boolean {
    return this.deps.ownApps.some((own) => own.toLowerCase() === app.toLowerCase());
  }

  /** The window manager's word that a window came to the front or changed its title. */
  seen(seen: WindowSeen): void {
    if (this.isOwn(seen.app)) {
      // The user turned to her. Where they were is still where they "are"; it just must
      // not be read now, because the window in front is hers.
      this.frontIsActive = false;
      this.readingNow?.abort();
      return;
    }
    if (this.front?.id === seen.id) {
      const cameBack = !this.frontIsActive;
      this.frontIsActive = true;
      // Once private, private until another window comes to the front.
      const secret = this.front.secret || isPrivate(seen, this.deps.skip());
      this.front = { ...this.front, ...seen, title: secret ? "" : this.front.title, secret };
      if (!secret && seen.title !== this.front.title) {
        // Titles can tick over every second (a player's clock); wait for one that stays.
        this.pendingTitle = seen;
        if (this.titleTimer) clearTimeout(this.titleTimer);
        this.titleTimer = setTimeout(() => this.settleTitle(), TITLE_SETTLE_MS);
        this.titleTimer.unref();
      }
      // Coming back from her own window: look again soon. Otherwise the plan stands.
      if (cameBack || (!this.readTimer && !this.readingNow)) this.planRead(SETTLE_MS);
      return;
    }
    const at = this.now();
    this.closeStretch(at);
    // A private window's title can itself say too much (the page open in a private tab),
    // so it is not kept at all.
    const secret = isPrivate(seen, this.deps.skip());
    this.front = { ...seen, title: secret ? "" : seen.title, since: at, secret };
    this.frontIsActive = true;
    this.pendingTitle = null;
    this.stretches.push({ app: seen.app, title: this.front.title, from: at, to: at });
    if (this.stretches.length > MAX_STRETCHES) this.stretches.shift();
    this.readEvery = READ_EVERY_MS;
    this.readingNow?.abort();
    this.planRead(SETTLE_MS);
    if (CRASH_HANDLERS.test(seen.app)) this.notice(seen, "A crash reporter has opened.");
  }

  private settleTitle(): void {
    const seen = this.pendingTitle;
    this.pendingTitle = null;
    if (!seen || !this.front || this.front.id !== seen.id) return;
    const at = this.now();
    this.closeStretch(at);
    this.front = { ...this.front, title: seen.title };
    this.stretches.push({ app: seen.app, title: seen.title, from: at, to: at });
    if (this.stretches.length > MAX_STRETCHES) this.stretches.shift();
    // A new title usually means a new page or file: worth a fresh reading.
    if (!this.readingNow) this.planRead(SETTLE_MS);
  }

  private closeStretch(at: number): void {
    const last = this.stretches[this.stretches.length - 1];
    if (last) last.to = at;
  }

  private planRead(inMs: number): void {
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => void this.readNow(), inMs);
    this.readTimer.unref();
  }

  private async readNow(): Promise<void> {
    this.readTimer = null;
    const front = this.front;
    if (!front || !this.watching()) return;
    if (this.readingNow) {
      // A look is still under way (at another window, most likely). This one is taken
      // the moment that ends, not a whole interval later.
      this.lookDue = true;
      return;
    }
    if (!this.frontIsActive || this.whyUnread(front)) {
      // Looked at again later: a full-screen film ends, the user turns back from her.
      this.planRead(this.readEvery);
      return;
    }
    // Only small windows are read while watching: that is where trouble shows up, and
    // reading one takes a fraction of a second. A full window costs seconds of processor
    // time, so of those she knows the program and the title, and looks only when asked.
    if (!isSmall(front)) return;
    const abort = new AbortController();
    this.readingNow = abort;
    try {
      const text = await this.deps.read(abort.signal);
      // The picture was of whatever was in front when it was taken. If that changed
      // meanwhile, the text may belong to another window, so it is thrown away.
      if (abort.signal.aborted || this.front?.id !== front.id || !this.frontIsActive) return;
      const unchanged = this.reading?.id === front.id && this.reading.text === text;
      this.reading = { id: front.id, text, at: this.now() };
      this.readEvery = unchanged ? Math.min(SLOWEST_READ_MS, this.readEvery * 2) : READ_EVERY_MS;
      this.lookForTrouble(front, text);
    } catch {
      // A look that failed (the window closed mid-picture) is simply tried again later.
    } finally {
      this.readingNow = null;
      // A window that came to the front during this read has already planned its own,
      // sooner look; only when nothing is planned does the usual wait apply.
      const due = this.lookDue;
      this.lookDue = false;
      if (this.watching() && (due || !this.readTimer)) {
        this.planRead(due ? 0 : this.readEvery);
      }
    }
  }

  private lookForTrouble(front: WindowSeen, text: string): void {
    if (!isSmall(front)) return; // a full window always has the word "error" in it somewhere
    const line = troubleLine(text);
    if (line) this.notice(front, line);
  }

  private notice(seen: WindowSeen, line: string): void {
    if (this.noticed.has(seen.id)) return;
    this.noticed.add(seen.id);
    if (this.noticed.size > 200) this.noticed.delete(this.noticed.values().next().value ?? "");
    this.deps.onNotice?.({ app: seen.app, title: seen.title, line });
  }

  /**
   * The line that goes beside the user's next message, or "" when she already knows.
   * It names the program only: a window's title can be written by a web page, and this
   * line reaches her without being marked as outside text.
   */
  next(): string {
    const front = this.front;
    if (!front) return "";
    const at = this.now();
    if (this.toldApp === front.app && at - this.toldAt < RETELL_AFTER_MS) return "";
    this.toldApp = front.app;
    this.toldAt = at;
    // Time in the program, across its windows and title changes.
    let since = front.since;
    for (let index = this.stretches.length - 1; index >= 0; index--) {
      const stretch = this.stretches[index];
      if (!stretch || stretch.app !== front.app) break;
      since = stretch.from;
    }
    const spent = at - since;
    const prefix = replaceInternalCaptain("Captain is in", this.deps.userAddress?.());
    return `${SCREEN_MARK} ${prefix} ${programName(front.app)}${spent >= 60_000 ? ` (for ${minutes(spent)})` : ""}.`;
  }

  /** A new conversation starts without knowing where the user is. */
  reset(): void {
    this.toldApp = null;
    this.toldAt = 0;
  }

  /** What she last saw of the window the user is in, if that was recent enough. */
  glance(maxAgeMs: number): Glance | null {
    const front = this.front;
    if (!front) return null;
    const unread = this.whyUnread(front);
    if (unread) return { app: front.app, title: front.title, text: "", ageMs: 0, unread };
    if (!this.reading || this.reading.id !== front.id) return null;
    const ageMs = this.now() - this.reading.at;
    if (ageMs > maxAgeMs) return null;
    return { app: front.app, title: front.title, text: this.reading.text, ageMs, unread: null };
  }

  /** Where the user has been, oldest first. The last stretch runs to now. */
  timeline(): Stretch[] {
    const at = this.now();
    return this.stretches.map((stretch, index) =>
      index === this.stretches.length - 1 ? { ...stretch, to: at } : { ...stretch },
    );
  }
}
