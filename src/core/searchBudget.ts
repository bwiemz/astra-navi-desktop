import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Keeps count of the searches she sends to a search engine the user pays for or has a
 * monthly allowance with, and stops her at a limit. The engine's own replies do not
 * always say how much is left, and an allowance spent in the first week by a few
 * research jobs is no use for the rest of the month. Past the limit she falls back to
 * the open sources and says so in her self-check.
 */

interface Count {
  /** The month the count is for, as "2026-11". */
  month: string;
  used: number;
}

function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function isCount(value: unknown): value is Count {
  if (typeof value !== "object" || value === null) return false;
  const count = value as Record<string, unknown>;
  return (
    typeof count["month"] === "string" &&
    typeof count["used"] === "number" &&
    Number.isInteger(count["used"]) &&
    count["used"] >= 0
  );
}

export class SearchBudget {
  private readonly file: string;
  private readonly limit: () => number;
  private readonly now: () => Date;
  private count: Count;
  private saving: Promise<void> = Promise.resolve();

  /**
   * @param file Where the count is kept between runs.
   * @param limit The most searches in one calendar month; 0 means no limit.
   */
  constructor(file: string, limit: () => number, now: () => Date = () => new Date()) {
    this.file = file;
    this.limit = limit;
    this.now = now;
    this.count = { month: monthOf(now()), used: 0 };
  }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (isCount(parsed)) this.count = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[search] the count of searches could not be read:", error);
      }
    }
  }

  private current(): Count {
    const month = monthOf(this.now());
    if (this.count.month !== month) this.count = { month, used: 0 };
    return this.count;
  }

  /** How many have been used this month, and out of how many (0: no limit). */
  status(): { used: number; limit: number } {
    return { used: this.current().used, limit: Math.max(0, Math.floor(this.limit())) };
  }

  /**
   * Asks to make one search. True means go ahead, and it has been counted; false means
   * this month's allowance is spent. Counted before the search is sent, so a burst of
   * searches cannot all slip under the limit together.
   */
  take(): boolean {
    const count = this.current();
    const limit = Math.max(0, Math.floor(this.limit()));
    if (limit > 0 && count.used >= limit) return false;
    count.used += 1;
    this.save();
    return true;
  }

  private save(): void {
    const snapshot = JSON.stringify(this.count);
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((error: unknown) =>
        console.warn("[search] the count of searches could not be saved:", error),
      );
  }

  /** Resolves once the count is on disk. */
  flush(): Promise<void> {
    return this.saving;
  }
}
