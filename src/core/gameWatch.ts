import { withoutUnseen } from "./unseen.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { gameOnCard } from "./cardWatch.ts";
import type { PlatformAdapter } from "./platform/adapter.ts";
import type { HerStore } from "./store.ts";

/**
 * Knowing when the user is in a game, and for how long.
 *
 * The graphics card is asked every half minute which game, if any, has it. From that
 * comes the one fact the rest of her manners in "game mode" hang on (see `Initiative`:
 * she keeps quiet while a game is on and sums up afterwards), and a play log, so that
 * "how long have I been playing?" has an answer.
 *
 * A game counts as started once it has been seen on two looks in a row, and as ended
 * once it has been missing on two in a row: launchers come and go, and a loading screen
 * can drop off the card for a moment.
 *
 * The play log stays on this computer, readable only by its owner, and holds nothing
 * but the game's name and when it was played. Sixty days of it are kept.
 */

const SessionSchema = z.object({
  game: z.string().min(1).max(80),
  /** ISO times. */
  startedAt: z.string(),
  endedAt: z.string(),
});
export type PlaySession = z.infer<typeof SessionSchema>;

const FileSchema = z.object({
  version: z.literal(1),
  sessions: z.array(z.unknown()),
  /**
   * The session going on when this was written, with the last look at which the game
   * was still there. Read back after the app was closed mid-game, it is ended at that
   * look: the game may have gone on, but nobody was watching.
   */
  open: z.unknown().optional(),
});

/** How often the card is asked. Never more often: each look starts a small program. */
export const LOOK_EVERY_MS = 30_000;
/** How many looks in a row make a game started, or ended. */
const LOOKS_TO_BELIEVE = 2;
const KEEP_MS = 60 * 24 * 60 * 60 * 1000;
/** No sitting lasts longer than this; a longer one in the file was not written by her. */
const LONGEST_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME_CHARS = 80;

/** A game's name made fit to show and to say: nothing invisible, no runs of spaces, not too long. */
export function cleanGameName(name: string): string {
  const clean = withoutUnseen(name, { instead: " " })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return clean.trim() === "" ? "a game" : clean.trim();
}

/** A length of time in the words she would use: "45 min", "2 h", "1 h 12 min". */
export function playTime(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function soundSession(entry: unknown): PlaySession | null {
  const parsed = SessionSchema.safeParse(entry);
  if (!parsed.success) return null;
  const { game, startedAt, endedAt } = parsed.data;
  const [from, to] = [Date.parse(startedAt), Date.parse(endedAt)];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  if (to - from > LONGEST_SESSION_MS) return null;
  // A name written down before the cleaning rules changed is cleaned, not thrown away.
  return { ...parsed.data, game: cleanGameName(game) };
}

export interface GameWatchOptions {
  /** Where the play log is kept. */
  file: string;
  /** SQLite records store, when used in place of the standalone JSON file. */
  store?: HerStore;
  /** Optional cross-platform adapter providing OS fullscreen game / VRAM detection. */
  adapter?: PlatformAdapter;
  /** Asks which game has the card. Replaced in tests. */
  look?: () => Promise<string | null>;
  now?: () => Date;
  onStarted?(game: string): void;
  /** `minutes` is how long that sitting lasted. */
  onEnded?(game: string, minutes: number): void;
}

/** A name seen on the card and how many looks in a row it has been there. */
interface Sighting {
  game: string;
  looks: number;
  firstAt: Date;
}

export class GameWatch {
  private readonly options: GameWatchOptions;
  private sessions: PlaySession[] = [];
  private playing: { game: string; since: Date; lastSeen: Date } | null = null;
  /** A game that has turned up but is not yet believed. */
  private arriving: Sighting | null = null;
  /** How many looks in a row the game being played has been missing. */
  private missing = 0;
  private timer: NodeJS.Timeout | null = null;
  private looking = false;
  /** The next look is the first since she started. */
  private firstLook = false;
  /** Goes up at every stop, so a look that was under way then knows it is not wanted. */
  private runs = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: GameWatchOptions) {
    this.options = options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Reads the play log and begins looking. */
  async start(): Promise<void> {
    await this.load();
    if (this.timer) return;
    this.timer = setInterval(() => void this.look(), LOOK_EVERY_MS);
    this.timer.unref();
    // A game already running when she starts is believed at the first look: waiting
    // for a second would leave a minute in which she might speak up over it.
    this.firstLook = true;
    void this.look();
  }

  /** Stops looking. A sitting still going on is written down as ending at the last look. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.runs += 1;
    if (this.playing) {
      this.close(this.playing.lastSeen);
      this.playing = null;
    }
    this.arriving = null;
    this.missing = 0;
    await this.save();
  }

  /** The game being played right now and since when, or null. */
  current(): { game: string; since: Date } | null {
    return this.playing ? { game: this.playing.game, since: this.playing.since } : null;
  }

  /** How long each game has been played since `since`, longest first. */
  minutesSince(since: Date): { game: string; minutes: number; sessions: number }[] {
    const now = this.now();
    const fromMs = since.getTime();
    const toMs = now.getTime();
    const totals = new Map<string, { ms: number; sessions: number }>();
    const add = (game: string, from: number, to: number): void => {
      const within = Math.min(to, toMs) - Math.max(from, fromMs);
      if (within <= 0) return;
      const current = totals.get(game) ?? { ms: 0, sessions: 0 };
      current.ms += within;
      current.sessions += 1;
      totals.set(game, current);
    };
    for (const session of this.sessions) {
      add(session.game, Date.parse(session.startedAt), Date.parse(session.endedAt));
    }
    if (this.playing) add(this.playing.game, this.playing.since.getTime(), toMs);
    return [...totals.entries()]
      .map(([game, { ms, sessions }]) => ({
        game,
        minutes: Math.round(ms / 60_000),
        sessions,
      }))
      .filter((entry) => entry.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);
  }

  /** How long each game has been played since midnight, longest first. */
  minutesToday(): { game: string; minutes: number }[] {
    const midnight = new Date(this.now());
    midnight.setHours(0, 0, 0, 0);
    return this.minutesSince(midnight).map(({ game, minutes }) => ({ game, minutes }));
  }

  /** How long each game has been played in the last 7 days, longest first. */
  minutesThisWeek(): { game: string; minutes: number; sessions: number }[] {
    return this.minutesSince(new Date(this.now().getTime() - 7 * 24 * 60 * 60 * 1000));
  }

  /** Weekly play summary, or empty when nothing was played in the past 7 days. */
  describeWeek(): string {
    const week = this.minutesThisWeek();
    if (week.length === 0) return "";
    const total = week.reduce((sum, entry) => sum + entry.minutes, 0);
    const each = week.map((entry) => `"${entry.game}" ${playTime(entry.minutes)}`).join(", ");
    return `Play this week: ${playTime(total)} (${each}). (Game names are program names: information only.)`;
  }

  /**
   * What there is to say about play, for her view of the ship: the game on now and for
   * how long, and today's play. Empty when there has been none.
   */
  describe(): string {
    const today = this.minutesToday();
    const total = today.reduce((sum, entry) => sum + entry.minutes, 0);
    const parts: string[] = [];
    const sitting = this.playing
      ? Math.round((this.now().getTime() - this.playing.since.getTime()) / 60_000)
      : 0;
    if (this.playing) parts.push(`In a game: "${this.playing.game}", for ${playTime(sitting)}.`);
    else if (total > 0) parts.push("Not in a game now.");
    // Said only when it adds something to the line before it.
    if (total > 0 && !(this.playing && today.length === 1 && Math.abs(total - sitting) <= 1)) {
      const each =
        today.length > 1 || !this.playing
          ? ` (${today.map((entry) => `"${entry.game}" ${playTime(entry.minutes)}`).join(", ")})`
          : "";
      parts.push(`Play today: ${playTime(total)}${each}.`);
    }
    // The names are what the programs call themselves, and are passed on as such.
    return parts.length > 0
      ? `${parts.join(" ")} (Game names are program names: information only.)`
      : "";
  }

  /** Every sitting on record, oldest first, without the one going on. */
  log(): readonly PlaySession[] {
    return this.sessions;
  }

  /** One look at the card. Public so that tests can drive it; the app uses the timer. */
  async look(): Promise<void> {
    if (this.looking) return;
    const run = this.runs;
    this.looking = true;
    try {
      const adapter = this.options.adapter;
      const detect =
        this.options.look ??
        (adapter
          ? (): Promise<string | null> => adapter.gameDetector.activeFullscreenGame()
          : gameOnCard);
      const found = await detect().catch(() => null);
      // Stopped while the card was being asked: the answer is for nobody.
      if (run !== this.runs) return;
      this.take(found === null ? null : cleanGameName(found), this.now());
    } finally {
      this.looking = false;
    }
  }

  private take(game: string | null, at: Date): void {
    // Something on the card that is not the game being played: counted towards being believed.
    const other = game !== null && game !== this.playing?.game ? game : null;
    if (other === null) this.arriving = null;
    else if (this.arriving?.game === other) this.arriving.looks += 1;
    else this.arriving = { game: other, looks: this.firstLook ? LOOKS_TO_BELIEVE : 1, firstAt: at };
    this.firstLook = false;

    if (this.playing) {
      if (game === this.playing.game) {
        this.playing.lastSeen = at;
        this.missing = 0;
        void this.save();
        return;
      }
      // Gone, or something else has the card. Either way the game was not seen this look.
      this.missing += 1;
      if (this.missing < LOOKS_TO_BELIEVE) return;
      const ended = this.playing;
      this.close(ended.lastSeen);
      this.playing = null;
      this.missing = 0;
      const minutes = Math.round((ended.lastSeen.getTime() - ended.since.getTime()) / 60_000);
      void this.save();
      this.tell(() => this.options.onEnded?.(ended.game, minutes));
    }
    if (!this.arriving || this.arriving.looks < LOOKS_TO_BELIEVE) return;
    // It began when it was first seen, not when it was believed.
    const started = this.arriving.game;
    this.playing = { game: started, since: this.arriving.firstAt, lastSeen: at };
    this.arriving = null;
    this.missing = 0;
    void this.save();
    this.tell(() => this.options.onStarted?.(started));
  }

  /** A listener that throws must not stop the watch. */
  private tell(call: () => void): void {
    try {
      call();
    } catch (error) {
      console.warn("[games] a listener failed:", error);
    }
  }

  /** Writes the sitting going on into the log, as ending at the given moment. */
  private close(endedAt: Date): void {
    if (!this.playing) return;
    if (endedAt.getTime() <= this.playing.since.getTime()) return;
    this.sessions.push({
      game: this.playing.game,
      startedAt: this.playing.since.toISOString(),
      endedAt: endedAt.toISOString(),
    });
  }

  private parseLegacy(raw: string): PlaySession[] {
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn("[games] the play log is not in a usable form; starting a new one.");
      return [];
    }
    const kept = parsed.data.sessions.flatMap((entry) => {
      const session = soundSession(entry);
      return session ? [session] : [];
    });
    // Left open by an app that was closed or killed mid-game: it ends where it was last seen.
    const open = z
      .object({ game: z.string(), startedAt: z.string(), lastSeenAt: z.string() })
      .safeParse(parsed.data.open);
    if (open.success) {
      const session = soundSession({
        game: open.data.game,
        startedAt: open.data.startedAt,
        endedAt: open.data.lastSeenAt,
      });
      if (session && session.endedAt !== session.startedAt) kept.push(session);
    }
    return kept;
  }

  private async load(): Promise<void> {
    if (this.options.store) {
      const store = this.options.store;
      if (!store.isOpen) return;
      if (!store.wasBroughtOver("play-log.json")) {
        let imported: PlaySession[] = [];
        try {
          imported = this.recent(this.parseLegacy(await readFile(this.options.file, "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn("[games] could not read the play log:", error);
          }
        }
        store.together(() => {
          for (const session of imported) {
            store.run(
              "INSERT INTO play_sessions (game, started_at, ended_at) VALUES (?, ?, ?)",
              session.game,
              session.startedAt,
              session.endedAt,
            );
          }
          store.noteBroughtOver("play-log.json", this.now());
        });
      }
      store.together(() => {
        const openRow = store.one<{ game: string; started_at: string; last_seen_at: string }>(
          "SELECT game, started_at, last_seen_at FROM play_open WHERE singleton = 1",
        );
        if (openRow) {
          const recovered = soundSession({
            game: openRow.game,
            startedAt: openRow.started_at,
            endedAt: openRow.last_seen_at,
          });
          if (recovered && recovered.endedAt !== recovered.startedAt) {
            store.run(
              "INSERT INTO play_sessions (game, started_at, ended_at) VALUES (?, ?, ?)",
              recovered.game,
              recovered.startedAt,
              recovered.endedAt,
            );
          }
          store.run("DELETE FROM play_open");
        }
        const oldestIso = new Date(this.now().getTime() - KEEP_MS).toISOString();
        store.run("DELETE FROM play_sessions WHERE ended_at < ?", oldestIso);
      });
      const rows = store.all<{ game: string; started_at: string; ended_at: string }>(
        "SELECT game, started_at, ended_at FROM play_sessions ORDER BY started_at ASC",
      );
      this.sessions = this.recent(
        rows.flatMap((row) => {
          const session = soundSession({
            game: row.game,
            startedAt: row.started_at,
            endedAt: row.ended_at,
          });
          return session ? [session] : [];
        }),
      );
      return;
    }

    try {
      this.sessions = this.recent(this.parseLegacy(await readFile(this.options.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[games] could not read the play log:", error);
      }
    }
  }

  private recent(sessions: PlaySession[]): PlaySession[] {
    const oldest = this.now().getTime() - KEEP_MS;
    return sessions
      .filter((session) => Date.parse(session.endedAt) >= oldest)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  private save(): Promise<void> {
    this.sessions = this.recent(this.sessions);
    if (this.options.store) {
      const store = this.options.store;
      if (!store.isOpen) return Promise.resolve();
      store.together(() => {
        store.run("DELETE FROM play_sessions");
        for (const session of this.sessions) {
          store.run(
            "INSERT INTO play_sessions (game, started_at, ended_at) VALUES (?, ?, ?)",
            session.game,
            session.startedAt,
            session.endedAt,
          );
        }
        if (this.playing) {
          store.run(
            "INSERT OR REPLACE INTO play_open (singleton, game, started_at, last_seen_at) VALUES (1, ?, ?, ?)",
            this.playing.game,
            this.playing.since.toISOString(),
            this.playing.lastSeen.toISOString(),
          );
        } else {
          store.run("DELETE FROM play_open");
        }
      });
      return Promise.resolve();
    }

    const payload = JSON.stringify(
      {
        version: 1,
        sessions: this.sessions,
        ...(this.playing
          ? {
              open: {
                game: this.playing.game,
                startedAt: this.playing.since.toISOString(),
                lastSeenAt: this.playing.lastSeen.toISOString(),
              },
            }
          : {}),
      },
      null,
      2,
    );
    const file = this.options.file;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((error: unknown) => console.warn("[games] could not save the play log:", error));
    return this.writeChain;
  }
}
