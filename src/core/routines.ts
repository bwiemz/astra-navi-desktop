import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { replaceInternalCaptain } from "./characterLayer.ts";

/**
 * Noticing habits. Each time she does a kind of task she already has a note for, the
 * time is written down. When the same task has been asked for on several different
 * days at about the same time of day, that is a routine, and she may offer (once) to
 * take it on: a daily reminder, or having it ready.
 */

const WINDOW_DAYS = 14;
const MIN_DAYS = 3;
/** How far from the usual time an occurrence may be and still belong to the routine. */
const SPREAD_MINUTES = 90;
const KEPT_PER_TASK = 30;

const FileSchema = z.object({
  version: z.literal(1),
  /** Times each task was done, by the id of its skill note. */
  seen: z.record(z.string(), z.object({ title: z.string(), at: z.array(z.string()) })),
  /** Tasks already offered as routines, so she asks only once. */
  offered: z.array(z.string()),
});
type RoutineFile = z.infer<typeof FileSchema>;

export interface Routine {
  /** The id of the skill note the routine is about. */
  id: string;
  title: string;
  /** The usual time of day, as "09:15". */
  usualTime: string;
  /** On how many different days of the last two weeks it was done near that time. */
  days: number;
}

/** The middle of a set of times of day, where 23:50 and 00:10 are twenty minutes apart. */
function usualMinute(minutes: readonly number[]): number {
  let x = 0;
  let y = 0;
  for (const minute of minutes) {
    const angle = (minute / 1440) * 2 * Math.PI;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  const mean = (Math.atan2(y, x) / (2 * Math.PI)) * 1440;
  return Math.round((mean + 1440) % 1440);
}

function apart(a: number, b: number): number {
  const gap = Math.abs(a - b) % 1440;
  return Math.min(gap, 1440 - gap);
}

export class RoutineWatch {
  private readonly file: string;
  private data: RoutineFile = { version: 1, seen: {}, offered: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      if (parsed.success) this.data = parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[routines] could not read what was noticed so far:", error);
      }
    }
  }

  /** Writes down that a task was done at a certain time. */
  async note(id: string, title: string, at: string): Promise<void> {
    if (Number.isNaN(Date.parse(at))) return;
    const entry = this.data.seen[id] ?? { title, at: [] };
    entry.title = title;
    if (!entry.at.includes(at)) entry.at.push(at);
    entry.at = entry.at.slice(-KEPT_PER_TASK);
    this.data.seen[id] = entry;
    await this.persist();
  }

  /** Routines that have shown up and have not been offered yet. */
  found(now: Date = new Date()): Routine[] {
    const since = now.getTime() - WINDOW_DAYS * 86_400_000;
    const routines: Routine[] = [];
    for (const [id, entry] of Object.entries(this.data.seen)) {
      if (this.data.offered.includes(id)) continue;
      const times = entry.at.map((at) => new Date(at)).filter((date) => date.getTime() >= since);
      const minutes = times.map((date) => date.getHours() * 60 + date.getMinutes());
      if (minutes.length < MIN_DAYS) continue;
      const usual = usualMinute(minutes);
      const days = new Set(
        times
          .filter((_date, index) => apart(minutes[index] ?? 0, usual) <= SPREAD_MINUTES)
          .map((date) => date.toDateString()),
      );
      if (days.size < MIN_DAYS) continue;
      routines.push({
        id,
        title: entry.title,
        usualTime: `${String(Math.floor(usual / 60)).padStart(2, "0")}:${String(usual % 60).padStart(2, "0")}`,
        days: days.size,
      });
    }
    return routines;
  }

  /** Records that a routine was put to the user, so it is not brought up again. */
  async markOffered(id: string): Promise<void> {
    if (!this.data.offered.includes(id)) this.data.offered.push(id);
    await this.persist();
  }

  /** Forgets a task that no longer has a note. */
  async drop(id: string): Promise<void> {
    if (!(id in this.data.seen)) return;
    this.data.seen = Object.fromEntries(
      Object.entries(this.data.seen).filter(([key]) => key !== id),
    );
    await this.persist();
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify(this.data);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((error: unknown) => console.warn("[routines] could not save:", error));
    return this.writeChain;
  }
}

/** What she is told when a routine shows up, so she can offer it in her own words. */
export function describeRoutine(routine: Routine, userAddress?: string): string {
  const lead = replaceInternalCaptain(
    `You have noticed a habit. On ${routine.days} different days in the last two weeks, around ${routine.usualTime}, Captain asked you to:`,
    userAddress,
  );
  return `${lead} "${routine.title}". Mention that you noticed, and offer, in one or two sentences, to remind them about it every day at that time. Ask; do not assume. If they say yes, set a daily reminder then.`;
}
