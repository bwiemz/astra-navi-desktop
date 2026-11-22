import { hasUnseen } from "./unseen.ts";

/**
 * Pure 5-field cron schedule parser and next-run calculator (`minute hour dom month dow`).
 * Keeps to standard local-time cron rules with Sunday accepted as both `0` and `7`.
 */

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  dayOfMonthWild: boolean;
  dayOfWeekWild: boolean;
  expression: string;
}

const MAX_CRON_CHARS = 80;
const PLAIN_INTEGER = /^\d+$/;

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
  normalize?: (value: number) => number,
): number[] | { problem: string } {
  const values = new Set<number>();
  const parts = raw.split(",");
  for (const part of parts) {
    if (part === "") return { problem: `Cron ${label} field "${raw}" has an empty entry.` };
    const slash = part.indexOf("/");
    const rangePart = slash === -1 ? part : part.slice(0, slash);
    const stepPart = slash === -1 ? null : part.slice(slash + 1);
    let step = 1;
    if (stepPart !== null) {
      if (!PLAIN_INTEGER.test(stepPart)) {
        return { problem: `Cron ${label} step "${stepPart}" is not a whole number.` };
      }
      step = Number(stepPart);
      if (step < 1) return { problem: `Cron ${label} step must be at least 1.` };
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      const rawStart = bounds[0] ?? "";
      const rawEnd = bounds[1] ?? "";
      if (bounds.length !== 2 || !PLAIN_INTEGER.test(rawStart) || !PLAIN_INTEGER.test(rawEnd)) {
        return { problem: `Cron ${label} range "${rangePart}" could not be read.` };
      }
      start = Number(rawStart);
      end = Number(rawEnd);
      if (start < min || end > max || start > end) {
        return {
          problem: `Cron ${label} range "${rangePart}" must stay within ${min}..${max}.`,
        };
      }
    } else {
      if (!PLAIN_INTEGER.test(rangePart)) {
        return { problem: `Cron ${label} value "${rangePart}" is not a whole number.` };
      }
      const single = Number(rangePart);
      if (single < min || single > max) {
        return { problem: `Cron ${label} value "${rangePart}" must stay within ${min}..${max}.` };
      }
      start = single;
      end = stepPart === null ? single : max;
    }

    for (let current = start; current <= end; current += step) {
      values.add(normalize ? normalize(current) : current);
    }
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a 5-field cron expression (`minute hour dom month dow`) or explains what is wrong. */
export function parseCron(expression: string): CronSchedule | { problem: string } {
  if (typeof expression !== "string" || hasUnseen(expression)) {
    return { problem: "Cron expression contains hidden or unreadable characters." };
  }
  const normalized = expression.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > MAX_CRON_CHARS) {
    return { problem: "Cron expression must be 1 to 80 characters long." };
  }
  const fields = normalized.split(" ");
  if (fields.length !== 5) {
    return {
      problem: `Cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}.`,
    };
  }
  const [minRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseField(minRaw, 0, 59, "minute");
  if ("problem" in minutes) return minutes;
  const hours = parseField(hourRaw, 0, 23, "hour");
  if ("problem" in hours) return hours;
  const daysOfMonth = parseField(domRaw, 1, 31, "day-of-month");
  if ("problem" in daysOfMonth) return daysOfMonth;
  const months = parseField(monthRaw, 1, 12, "month");
  if ("problem" in months) return months;
  const daysOfWeek = parseField(dowRaw, 0, 7, "day-of-week", (value) => (value === 7 ? 0 : value));
  if ("problem" in daysOfWeek) return daysOfWeek;

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthWild: domRaw === "*",
    dayOfWeekWild: dowRaw === "*",
    expression: normalized,
  };
}

/** Finds the next whole-minute local timestamp matching `schedule` strictly after `after`, or null. */
export function nextCronTime(schedule: CronSchedule, after: Date): Date | null {
  const minuteSet = new Set(schedule.minutes);
  const hourSet = new Set(schedule.hours);
  const domSet = new Set(schedule.daysOfMonth);
  const monthSet = new Set(schedule.months);
  const dowSet = new Set(schedule.daysOfWeek);

  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(after.getTime());
  limit.setFullYear(limit.getFullYear() + 4);
  const limitMs = limit.getTime();

  for (let steps = 0; steps < 50_000 && cursor.getTime() <= limitMs; steps += 1) {
    if (!monthSet.has(cursor.getMonth() + 1)) {
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      cursor.setMonth(cursor.getMonth() + 1);
      continue;
    }

    const domOk = domSet.has(cursor.getDate());
    const dowOk = dowSet.has(cursor.getDay());
    const dayMatches =
      schedule.dayOfMonthWild && schedule.dayOfWeekWild
        ? true
        : schedule.dayOfMonthWild
          ? dowOk
          : schedule.dayOfWeekWild
            ? domOk
            : domOk || dowOk;
    if (!dayMatches) {
      cursor.setHours(0, 0, 0, 0);
      cursor.setDate(cursor.getDate() + 1);
      continue;
    }

    if (!hourSet.has(cursor.getHours())) {
      cursor.setMinutes(0, 0, 0);
      cursor.setHours(cursor.getHours() + 1);
      continue;
    }

    if (!minuteSet.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }

    if (cursor.getTime() <= after.getTime()) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }

  return null;
}

/** A short readable summary of a cron schedule alongside its raw 5-field expression. */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression);
  if ("problem" in parsed) return expression;
  const two = (n: number): string => String(n).padStart(2, "0");
  const fields = parsed.expression.split(" ");
  if (fields[1] === "*" && fields[2] === "*" && fields[3] === "*" && fields[4] === "*") {
    const stepMatch = /^\*\/(\d+)$/.exec(fields[0] ?? "");
    if (stepMatch) return `every ${stepMatch[1]} minutes (${parsed.expression})`;
    if (fields[0] === "*") return `every minute (${parsed.expression})`;
  }
  if (
    parsed.minutes.length === 1 &&
    parsed.hours.length === 1 &&
    parsed.dayOfMonthWild &&
    fields[3] === "*" &&
    parsed.dayOfWeekWild
  ) {
    return `daily at ${two(parsed.hours[0] ?? 0)}:${two(parsed.minutes[0] ?? 0)} (${parsed.expression})`;
  }
  return parsed.expression;
}
