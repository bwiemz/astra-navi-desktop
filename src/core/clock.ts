/**
 * Her sense of time. A language model has none of its own: without being told, it will
 * wish someone good morning at midnight. The app tells her the time in a short line
 * beside the user's message, and she is told how long the two of them have known each other.
 */

/** Starts the line that tells her the time. */
export const CLOCK_MARK = "[ship's clock]";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]; // prettier-ignore

export type PartOfDay =
  "early morning" | "morning" | "afternoon" | "evening" | "late night" | "the small hours";

export function partOfDay(date: Date): PartOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 8) return "early morning";
  if (hour >= 8 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  if (hour >= 22 || hour < 2) return "late night";
  return "the small hours";
}

/** The time as she is told it: "[ship's clock] Saturday 21 November 2026, 00:57 (late night)". */
export function clockLine(date: Date): string {
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${CLOCK_MARK} ${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${time} (${partOfDay(date)})`;
}

/** How many days the two of them have known each other, counting the first day as day 1. */
export function daysAboard(firstMet: string | null, now: Date): number {
  const start = firstMet ? new Date(firstMet) : now;
  if (Number.isNaN(start.getTime())) return 1;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(1, Math.round((today - startDay) / 86_400_000) + 1);
}

/**
 * Decides when she is told the time again. Not on every message (it would crowd the
 * conversation): at its start, when the part of the day changes, and after a long gap.
 */
export class ClockTeller {
  private lastToldAt = 0;
  private lastPart: PartOfDay | null = null;

  /** The line to put beside the next message, or "" when she already knows near enough. */
  next(now: Date = new Date()): string {
    const part = partOfDay(now);
    const stale = now.getTime() - this.lastToldAt > 45 * 60_000;
    if (!stale && part === this.lastPart) return "";
    this.lastToldAt = now.getTime();
    this.lastPart = part;
    return clockLine(now);
  }

  /** A new conversation starts without knowing the time. */
  reset(): void {
    this.lastToldAt = 0;
    this.lastPart = null;
  }
}
