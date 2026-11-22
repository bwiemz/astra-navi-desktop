import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const ReminderSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** When it is due, as an ISO time. */
  dueAt: z.string(),
  /** A daily reminder comes back at the same time tomorrow after it fires. */
  daily: z.boolean().default(false),
  createdAt: z.string(),
});
export type Reminder = z.infer<typeof ReminderSchema>;
const FileSchema = z.object({ version: z.literal(1), reminders: z.array(ReminderSchema) });

/**
 * The clock is looked at again at least this often. A single long timer would run late
 * after the computer sleeps, because timers do not count the time spent asleep.
 */
const CHECK_EVERY_MS = 30_000;

export interface WhenInput {
  /** "in 20 minutes": minutes from now. */
  in_minutes?: number;
  /** A clock time today ("17:30", "5:30pm") or a full date and time ("2026-11-21 09:00"). */
  at?: string;
}

/**
 * Works out the moment a reminder is for. A clock time that has already passed today
 * means tomorrow. Returns null when the input makes no sense.
 */
export function resolveWhen(when: WhenInput, now: Date): Date | null {
  return fromMinutes(when, now) ?? fromClock(when, now);
}

/** No reminder is set further ahead than this; a larger number is a slip, not a wish. */
const MAX_MINUTES_AHEAD = 366 * 24 * 60;

function fromMinutes(when: WhenInput, now: Date): Date | null {
  const minutes = when.in_minutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes > MAX_MINUTES_AHEAD) return null;
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * True for a clock time that could be either half of the day: "5:30" with no am or pm
 * and an hour a twelve-hour clock also has. It is read as the twenty-four-hour clock
 * reads it; whoever set it should hear which that was.
 */
export function isAmbiguousClock(at: string | undefined): boolean {
  const clock = /^(?:(?:today|tomorrow)\s+(?:at\s+)?)?(\d{1,2})(?::\d{2})?$/i.exec(
    (at ?? "").trim(),
  );
  if (!clock) return false;
  const hours = Number(clock[1]);
  return hours >= 1 && hours <= 12;
}

function fromClock(when: WhenInput, now: Date): Date | null {
  const text = (typeof when.at === "string" ? when.at : "").trim();
  if (!text) return null;

  const clock = /^(?:(today|tomorrow)\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (clock) {
    const day = clock[1]?.toLowerCase();
    let hours = Number(clock[2]);
    const minutes = Number(clock[3] ?? "0");
    const half = clock[4]?.toLowerCase();
    if (half === "pm" && hours < 12) hours += 12;
    if (half === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    const due = new Date(now);
    due.setHours(hours, minutes, 0, 0);
    if (day === "tomorrow") due.setDate(due.getDate() + 1);
    else if (due.getTime() <= now.getTime()) {
      // "Today at nine" said at ten cannot be kept; a bare "nine" means the next nine.
      if (day === "today") return null;
      due.setDate(due.getDate() + 1);
    }
    return due;
  }

  // The whole text must be the date and time: a trailing "pm" or time zone would be
  // dropped unnoticed otherwise, and the reminder set for another hour.
  const full = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (full) {
    const [year, month, day, hours, minutes] = full.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const due = new Date(year, month - 1, day, hours, minutes);
    // A date that does not exist (30 February, 25 o'clock) rolls over to one that does.
    const real =
      due.getFullYear() === year &&
      due.getMonth() === month - 1 &&
      due.getDate() === day &&
      due.getHours() === hours &&
      due.getMinutes() === minutes;
    return !real || due.getTime() <= now.getTime() ? null : due;
  }
  return null;
}

/**
 * How far apart "in N minutes" and "at HH:MM" may be and still mean the same moment:
 * a tenth of the wait, but never less than two minutes or more than fifteen. A slip of
 * five minutes is nothing in a reminder for this evening and a great deal in a
 * twelve-minute timer.
 */
function sameMomentMs(minutes: number): number {
  return Math.min(15, Math.max(2, minutes * 0.1)) * 60_000;
}

export type Settled = { due: Date } | { problem: string };

/**
 * Decides the moment when a model has filled in both ways of saying it, which the
 * local models always do: their tool calls must name every field, so "at 8 tomorrow"
 * arrives with a guessed number of minutes beside it, and "in 90 minutes" with a
 * guessed clock time. One of the two is what the user said and the other is sums done
 * in her head. When they roughly agree, the one that looks like what a person says
 * wins; when they do not, nothing is set and she is told to choose.
 */
export function settleWhen(when: WhenInput & { daily?: boolean }, now: Date): Settled {
  const byMinutes = fromMinutes(when, now);
  const byClock = fromClock(when, now);
  if (!byMinutes && !byClock) {
    return {
      problem:
        'That time could not be understood. Give in_minutes (and leave at empty), or give at as "17:30", "tomorrow 8:00" or "2026-11-21 09:00" (and set in_minutes to 0).',
    };
  }
  if (!byMinutes || !byClock) return { due: (byMinutes ?? byClock) as Date };
  // A daily reminder is for a time of day, so the clock time is the one that was meant.
  if (when.daily === true) return { due: byClock };
  if (Math.abs(byMinutes.getTime() - byClock.getTime()) > sameMomentMs(when.in_minutes ?? 0)) {
    return {
      problem: `Nothing was set: in_minutes (${when.in_minutes}, which is ${stamp(byMinutes)}) and at (${stamp(byClock)}) are different times. Call set_reminder again with only the one Captain actually said: for "in N minutes" leave at empty; for a clock time or a date set in_minutes to 0.`,
    };
  }
  // People say "in 20 minutes" and "at half past five": round numbers. The other value
  // is her arithmetic, and that is the one that tends to be a little off.
  const minutes = when.in_minutes ?? 0;
  const roundMinutes = Number.isInteger(minutes) && (minutes <= 10 || minutes % 5 === 0);
  const roundClock = byClock.getMinutes() % 5 === 0;
  return { due: roundClock && !roundMinutes ? byClock : byMinutes };
}

function stamp(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * Reminders and timers. They are kept on disk, so one set before a restart still fires
 * after it, and one that came due while the app was closed is delivered at the next start.
 */
export class ReminderStore {
  private readonly file: string;
  private readonly onDue: (reminder: Reminder, lateByMs: number) => void;
  private reminders: Reminder[] = [];
  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private started = false;

  constructor(file: string, onDue: (reminder: Reminder, lateByMs: number) => void) {
    this.file = file;
    this.onDue = onDue;
  }

  /** Loads saved reminders and starts watching the clock. */
  async start(): Promise<void> {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      if (parsed.success) this.reminders = parsed.data.reminders;
      else console.warn("[reminders] the saved reminders are not readable; starting with none.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[reminders]", error);
    }
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  list(): Reminder[] {
    return [...this.reminders].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  async add(text: string, due: Date, daily = false): Promise<Reminder> {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) throw new Error("A reminder needs to say what it is for.");
    const reminder: Reminder = {
      id: randomBytes(3).toString("hex"),
      text: trimmed.slice(0, 300),
      dueAt: due.toISOString(),
      daily,
      createdAt: new Date().toISOString(),
    };
    this.reminders.push(reminder);
    try {
      await this.persist();
    } catch (error) {
      // Not saved means not set: do not leave a reminder that vanishes on restart.
      this.reminders = this.reminders.filter((other) => other.id !== reminder.id);
      throw error;
    }
    this.schedule();
    return reminder;
  }

  async cancel(id: string): Promise<boolean> {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((reminder) => reminder.id !== id);
    if (this.reminders.length === before) return false;
    await this.persist();
    this.schedule();
    return true;
  }

  /** Delivers everything that is due, then waits for the next one. */
  private fire(): void {
    const now = Date.now();
    const due = this.reminders.filter((reminder) => Date.parse(reminder.dueAt) <= now);
    for (const reminder of due) {
      const dueAt = Date.parse(reminder.dueAt);
      if (reminder.daily) {
        // The same clock time on the next day that is still ahead. Stepping the calendar
        // day, not 24 hours, keeps it at that time across a daylight-saving change.
        const next = new Date(dueAt);
        do next.setDate(next.getDate() + 1);
        while (next.getTime() <= now);
        reminder.dueAt = next.toISOString();
      } else {
        this.reminders = this.reminders.filter((other) => other.id !== reminder.id);
      }
      try {
        this.onDue({ ...reminder, dueAt: new Date(dueAt).toISOString() }, now - dueAt);
      } catch (error) {
        // One reminder that could not be told must not stop the clock for the rest.
        console.warn("[reminders] a reminder could not be delivered:", error);
      }
    }
    if (due.length > 0) {
      void this.persist().catch((error: unknown) =>
        console.warn("[reminders] could not save:", error),
      );
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const next = this.reminders.reduce<number | null>((soonest, reminder) => {
      const at = Date.parse(reminder.dueAt);
      return soonest === null || at < soonest ? at : soonest;
    }, null);
    if (next === null) return;
    const wait = Math.max(0, Math.min(next - Date.now(), CHECK_EVERY_MS));
    this.timer = setTimeout(() => this.fire(), wait);
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify({ version: 1, reminders: this.reminders }, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, this.file);
      });
    return this.writeChain;
  }
}
