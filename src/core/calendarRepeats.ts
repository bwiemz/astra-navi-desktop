import {
  type CalendarEvent,
  DAY_MS,
  type Occurrence,
  type Rule,
  type WallTime,
  WORK_PER_CALENDAR,
  WORK_PER_ENTRY,
  dateOf,
  dayNumber,
  daysIn,
  toInstant,
  weekdayOfNumber,
} from "./calendarFile.ts";

/**
 * Working out when a calendar's entries fall: each repeat of a repeating entry, with
 * its exceptions, between two moments. The work is counted, so that a calendar written
 * to waste it is cut short and named as not fully read.
 */

// ---------- things that repeat ----------

/** The days of one month that a rule names, in order. A day the month lacks is simply not there. */
function daysOfMonth(rule: Rule, year: number, month: number, startDay: number): number[] {
  const last = daysIn(year, month);
  let byWeekday: Set<number> | null = null;
  if (rule.byDay.length > 0) {
    byWeekday = new Set();
    const first = weekdayOfNumber(dayNumber(year, month, 1));
    for (const { weekday, nth } of rule.byDay) {
      const matching: number[] = [];
      for (let day = 1 + ((weekday - first + 7) % 7); day <= last; day += 7) matching.push(day);
      if (nth === 0) for (const day of matching) byWeekday.add(day);
      else {
        const picked = nth > 0 ? matching[nth - 1] : matching[matching.length + nth];
        if (picked !== undefined) byWeekday.add(picked);
      }
    }
  }
  let byDate: Set<number> | null = null;
  if (rule.byMonthDay.length > 0) {
    byDate = new Set();
    for (const given of rule.byMonthDay) {
      const day = given > 0 ? given : last + 1 + given;
      if (day >= 1 && day <= last) byDate.add(day);
    }
  }
  let days: number[];
  // Both given means both must hold: "Friday the 13th".
  if (byWeekday && byDate) days = [...byWeekday].filter((day) => byDate.has(day));
  else if (byWeekday ?? byDate) days = [...(byWeekday ?? byDate ?? [])];
  else days = startDay <= last ? [startDay] : [];
  days.sort((a, b) => a - b);
  if (rule.bySetPos.length === 0) return days;
  const picked = new Set<number>();
  for (const position of rule.bySetPos) {
    const day = position > 0 ? days[position - 1] : days[days.length + position];
    if (day !== undefined) picked.add(day);
  }
  return [...picked].sort((a, b) => a - b);
}

/** What a look at one calendar may cost; shared by all its entries. */
interface Work {
  left: number;
}

class TooMuchWork extends Error {}

/**
 * Goes through the days a repeating entry lands on, as day numbers, from a little
 * before `fromDay` to `toDay`, and hands each to `take` until `take` says stop. Days
 * are counted with plain arithmetic; no clock is asked until a day is near enough to
 * matter. The "count" of a rule is kept by counting every day from the first, and
 * where a look left off is remembered, so the next look does not start over.
 */
function walk(
  event: CalendarEvent,
  rule: Rule,
  fromDay: number,
  toDay: number,
  work: Work,
  take: (day: number) => boolean,
): void {
  const { start } = event;
  const startDay = dayNumber(start.year, start.month, start.day);
  // A whole-day entry ends on the day named. For one with a time the last day is
  // settled by the moment itself (see `expand`), so a day's leeway is left here.
  const untilDay = rule.until
    ? dayNumber(rule.until.year, rule.until.month, rule.until.day) + (start.dateOnly ? 0 : 1)
    : Infinity;
  const lastDay = Math.min(toDay, untilDay);
  if (lastDay < startDay) return;
  const monthsOf = start.year * 12 + (start.month - 1);
  const weekBegins = startDay - ((weekdayOfNumber(startDay) - rule.weekStart + 7) % 7);

  /** The first day number that period `k` could hold. */
  const opens = (k: number): number => {
    if (rule.every === "DAILY") return startDay + k * rule.interval;
    if (rule.every === "WEEKLY") return weekBegins + 7 * rule.interval * k;
    if (rule.every === "MONTHLY") {
      const at = monthsOf + k * rule.interval;
      return dayNumber(Math.floor(at / 12), (at % 12) + 1, 1);
    }
    return dayNumber(start.year + k * rule.interval, 1, 1);
  };
  /** The days in period `k`, in order. */
  const landsOn = (k: number): number[] => {
    if (rule.every === "DAILY") {
      const day = startDay + k * rule.interval;
      const { month, day: dayOfMonth, year } = dateOf(day);
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) return [];
      if (rule.byDay.length > 0) {
        const weekday = weekdayOfNumber(day);
        if (!rule.byDay.some((entry) => entry.weekday === weekday)) return [];
      }
      if (rule.byMonthDay.length > 0) {
        const last = daysIn(year, month);
        const named = rule.byMonthDay.some(
          (given) => (given > 0 ? given : last + 1 + given) === dayOfMonth,
        );
        if (!named) return [];
      }
      return [day];
    }
    if (rule.every === "WEEKLY") {
      const begins = weekBegins + 7 * rule.interval * k;
      const weekdays =
        rule.byDay.length > 0
          ? rule.byDay.map((entry) => entry.weekday)
          : [weekdayOfNumber(startDay)];
      const days = [...new Set(weekdays)]
        .map((weekday) => begins + ((weekday - rule.weekStart + 7) % 7))
        .sort((a, b) => a - b);
      return rule.byMonth.length > 0
        ? days.filter((day) => rule.byMonth.includes(dateOf(day).month))
        : days;
    }
    if (rule.every === "MONTHLY") {
      const at = monthsOf + k * rule.interval;
      const [year, month] = [Math.floor(at / 12), (at % 12) + 1];
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) return [];
      return daysOfMonth(rule, year, month, start.day).map((day) => dayNumber(year, month, day));
    }
    const year = start.year + k * rule.interval;
    const months =
      rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [start.month];
    return months.flatMap((month) =>
      daysOfMonth(rule, year, month, start.day).map((day) => dayNumber(year, month, day)),
    );
  };

  let period = 0;
  let made = 0;
  if (rule.count === null) {
    // No count to keep: whole periods are skipped to just before the stretch asked for.
    const span =
      rule.every === "DAILY"
        ? 1
        : rule.every === "WEEKLY"
          ? 7
          : rule.every === "MONTHLY"
            ? 31
            : 366;
    const behind = fromDay - startDay - span * rule.interval;
    if (behind > 0) period = Math.floor(behind / (span * rule.interval));
  } else {
    // Where an earlier look left off, if this one begins no earlier.
    const kept = event.memo.resume;
    if (kept && opens(kept.period) <= fromDay) ({ period, made } = kept);
    else if (
      rule.every === "DAILY" &&
      rule.byDay.length === 0 &&
      rule.byMonth.length === 0 &&
      rule.byMonthDay.length === 0
    ) {
      // "Every N days, so many times" lands once in each period, so the count up to the
      // stretch asked for is plain arithmetic and nothing has to be walked through.
      const before = Math.floor((fromDay - startDay) / rule.interval);
      if (before > 0) {
        if (before >= rule.count) return;
        period = before;
        made = before;
      }
    }
  }
  for (; ; period++) {
    const first = opens(period);
    // Past the stretch asked for, or past the last date there is.
    if (!(first <= lastDay)) return;
    work.left -= 1;
    if (work.left <= 0) throw new TooMuchWork();
    // Everything in this period lies before the stretch asked for: counted, not handed over.
    const whole = opens(period + 1) <= fromDay;
    if (rule.count !== null && whole) event.memo.resume = { period, made };
    for (const day of landsOn(period)) {
      if (day < startDay) continue;
      if (day > lastDay) return;
      if (rule.count !== null && made >= rule.count) return;
      made += 1;
      work.left -= 1;
      if (day >= fromDay && !take(day)) return;
    }
    if (rule.count !== null && made >= rule.count) return;
  }
}

function sameClock(a: WallTime, b: WallTime): boolean {
  return a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * True when this occurrence is one of the dates in `dates`. A date written without a
 * time takes out whatever falls on that day; one with a time must name the same moment.
 */
function isAmong(
  dates: readonly WallTime[],
  byDay: Map<number, WallTime[]>,
  event: CalendarEvent,
  day: number,
  instant: number | null,
): boolean {
  if (dates.length === 0) return false;
  for (const near of [day - 1, day, day + 1]) {
    for (const date of byDay.get(near) ?? []) {
      if (date.dateOnly || event.start.dateOnly) {
        if (near === day) return true;
      } else if (date.zone === event.start.zone) {
        if (near === day && sameClock(date, event.start)) return true;
      } else if (instant !== null && toInstant(date) === instant) return true;
    }
  }
  return false;
}

function byDayNumber(dates: readonly WallTime[]): Map<number, WallTime[]> {
  const map = new Map<number, WallTime[]>();
  for (const date of dates) {
    const day = dayNumber(date.year, date.month, date.day);
    const list = map.get(day);
    if (list) list.push(date);
    else map.set(day, [date]);
  }
  return map;
}

/** How long a timed entry lasts, in milliseconds, or null when the calendar did not say. */
function lengthOf(event: CalendarEvent): number | null {
  if (event.memo.lengthMs !== undefined) return event.memo.lengthMs;
  const length = event.end
    ? Math.max(0, toInstant(event.end) - toInstant(event.start))
    : event.durationMs;
  event.memo.lengthMs = length;
  return length;
}

/** How many days a whole-day entry covers. */
function daysOf(event: CalendarEvent): number {
  const { start, end } = event;
  if (end) {
    return Math.max(
      1,
      dayNumber(end.year, end.month, end.day) - dayNumber(start.year, start.month, start.day),
    );
  }
  return event.durationMs ? Math.max(1, Math.round(event.durationMs / DAY_MS)) : 1;
}

export type Found = Omit<Occurrence, "calendar" | "own">;

/**
 * Everything in these events that falls between two moments, soonest first. A repeating
 * entry that would cost more work than any real one, or that comes after the calendar
 * as a whole has used up its share, is left out and `skipped` says so; everything else
 * in the calendar is still found.
 */
export function expand(
  events: readonly CalendarEvent[],
  from: number,
  to: number,
  work: Work,
): { found: Found[]; skipped: boolean } {
  const out: Found[] = [];
  let skipped = false;
  // An entry that replaces one occurrence takes that occurrence out of its series.
  const replaced = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (!event.replaces || event.uid === "") continue;
    const list = replaced.get(event.uid);
    if (list) list.push(event);
    else replaced.set(event.uid, [event]);
  }
  // Day numbers are reckoned in UTC, so the stretch is widened by more than any zone differs.
  const fromDayAt = Math.floor(from / DAY_MS) - 2;
  const toDay = Math.floor(to / DAY_MS) + 2;

  for (const event of events) {
    if (event.cancelled) continue;
    const allDay = event.start.dateOnly;
    const spanDays = allDay
      ? daysOf(event)
      : event.end
        ? Math.max(
            1,
            dayNumber(event.end.year, event.end.month, event.end.day) -
              dayNumber(event.start.year, event.start.month, event.start.day) +
              1,
          )
        : Math.ceil((event.durationMs ?? 0) / DAY_MS) + 1;
    const fromDay = fromDayAt - spanDays;

    const overrides = event.replaces ? [] : (replaced.get(event.uid) ?? []);
    const overridden = overrides.flatMap((entry) => (entry.replaces ? [entry.replaces] : []));
    const overriddenByDay = byDayNumber(overridden);
    event.memo.exceptByDay ??= byDayNumber(event.except);
    const exceptByDay = event.memo.exceptByDay;
    // "This and every one after": the series is shown up to there and no further.
    let cutDay = Infinity;
    let cutAt = Infinity;
    for (const entry of overrides) {
      if (!entry.andAfter || !entry.replaces) continue;
      const { replaces } = entry;
      cutDay = Math.min(cutDay, dayNumber(replaces.year, replaces.month, replaces.day));
      if (!replaces.dateOnly && !allDay) cutAt = Math.min(cutAt, toInstant(replaces));
    }

    const untilAt = !allDay && event.rule?.until ? toInstant(event.rule.until) : Infinity;
    const give = (day: number): boolean => {
      const { year, month, day: dayOfMonth } = dateOf(day);
      if (allDay) {
        if (day >= cutDay) return false;
        if (isAmong(event.except, exceptByDay, event, day, null)) return true;
        if (isAmong(overridden, overriddenByDay, event, day, null)) return true;
        const days = daysOf(event);
        // Midnights by this computer's clock, reckoned through the calendar, so a
        // change of clocks neither stretches a day into the next nor cuts it short.
        const start = new Date(year, month - 1, dayOfMonth);
        const end = new Date(year, month - 1, dayOfMonth + days);
        if (end.getTime() <= from || start.getTime() > to) return true;
        out.push({ title: event.title, start, end, allDay: true, location: event.location });
        return true;
      }
      const instant = toInstant({ ...event.start, year, month, day: dayOfMonth });
      if (!Number.isFinite(instant)) return false;
      if (instant >= cutAt || (cutAt === Infinity && day >= cutDay)) return false;
      if (instant > untilAt) return false;
      if (instant > to) return true;
      if (isAmong(event.except, exceptByDay, event, day, instant)) return true;
      if (isAmong(overridden, overriddenByDay, event, day, instant)) return true;
      const length = lengthOf(event);
      // Still going at `from` counts: a night shift that began yesterday is on today.
      if (instant + Math.max(length ?? 0, 1) <= from) return true;
      out.push({
        title: event.title,
        start: new Date(instant),
        end: length === null ? null : new Date(instant + length),
        allDay: false,
        location: event.location,
      });
      return true;
    };

    if (!event.rule) {
      const day = dayNumber(event.start.year, event.start.month, event.start.day);
      if (day >= fromDay && day <= toDay) give(day);
      continue;
    }
    // Nothing left of the calendar's share: its remaining repeats are not gone into.
    if (work.left <= 0) {
      skipped = true;
      continue;
    }
    const share: Work = { left: Math.min(WORK_PER_ENTRY, work.left) };
    const granted = share.left;
    const sofar = out.length;
    try {
      walk(event, event.rule, fromDay, toDay, share, give);
    } catch (error) {
      if (!(error instanceof TooMuchWork)) throw error;
      // Half of a series is not shown: the entry is left out whole, and said to be.
      out.length = sofar;
      skipped = true;
    }
    work.left -= granted - Math.max(0, share.left);
  }
  return { found: out.sort((a, b) => a.start.getTime() - b.start.getTime()), skipped };
}

/** Everything in these events that falls between two moments, soonest first. */
export function occurrencesIn(
  events: readonly CalendarEvent[],
  calendar: string,
  from: Date,
  to: Date,
): Occurrence[] {
  const { found } = expand(events, from.getTime(), to.getTime(), { left: WORK_PER_CALENDAR });
  return found.map((item) => ({ ...item, calendar, own: false }));
}
