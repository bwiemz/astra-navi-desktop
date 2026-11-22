import { describe, expect, it } from "vitest";
import { describeCron, nextCronTime, parseCron } from "../src/core/cron.ts";

describe("cron schedule parsing and next run calculation", () => {
  it("parses wildcards, steps, ranges, lists, and Sunday 0/7 normalization", () => {
    const schedule = parseCron("*/15 9-11 1,15 * 0,7");
    expect("problem" in schedule).toBe(false);
    if ("problem" in schedule) throw new Error(schedule.problem);
    expect(schedule.minutes).toEqual([0, 15, 30, 45]);
    expect(schedule.hours).toEqual([9, 10, 11]);
    expect(schedule.daysOfMonth).toEqual([1, 15]);
    expect(schedule.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(schedule.daysOfWeek).toEqual([0]);
    expect(schedule.dayOfMonthWild).toBe(false);
    expect(schedule.dayOfWeekWild).toBe(false);
  });

  it("rejects invalid expressions, out-of-range values, and hidden characters", () => {
    for (const bad of [
      "",
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-2 * * * *",
      "0 3 * * *\u200B",
      `${"0 ".repeat(45)}0`,
    ]) {
      const result = parseCron(bad);
      expect("problem" in result, bad).toBe(true);
    }
  });

  it("advances strictly past the reference minute", () => {
    const everyFive = parseCron("*/5 * * * *");
    if ("problem" in everyFive) throw new Error(everyFive.problem);

    const exact = new Date(2026, 10, 22, 10, 15, 0, 0);
    const afterExact = nextCronTime(everyFive, exact);
    expect(afterExact?.getHours()).toBe(10);
    expect(afterExact?.getMinutes()).toBe(20);

    const midMinute = new Date(2026, 10, 22, 10, 14, 45, 0);
    const afterMid = nextCronTime(everyFive, midMinute);
    expect(afterMid?.getHours()).toBe(10);
    expect(afterMid?.getMinutes()).toBe(15);
  });

  it("uses union semantics when both day-of-month and day-of-week are restricted", () => {
    // Either the 15th of the month OR any Sunday.
    const either = parseCron("0 8 15 * 0");
    if ("problem" in either) throw new Error(either.problem);
    // 2026-11-14 is a Saturday; next day 2026-11-15 is both Sunday and 15th;
    // try 2026-11-10 (Tuesday): next Sunday is 2026-11-15, next Friday 13th test:
    const fri13OrSun = parseCron("30 9 13 * 0");
    if ("problem" in fri13OrSun) throw new Error(fri13OrSun.problem);
    // From 2026-11-12 10:00 (Thursday): Friday Nov 13 09:30 matches dom=13 even though dow=5.
    const nextDom = nextCronTime(fri13OrSun, new Date(2026, 10, 12, 10, 0, 0, 0));
    expect(nextDom?.getFullYear()).toBe(2026);
    expect(nextDom?.getMonth()).toBe(10);
    expect(nextDom?.getDate()).toBe(13);
    // Then after Fri Nov 13 09:30 comes Sunday Nov 15 09:30 (dow=0).
    const nextDow = nextCronTime(fri13OrSun, nextDom as Date);
    expect(nextDow?.getDate()).toBe(15);
  });

  it("handles leap days and returns null for impossible calendar dates like Feb 31", () => {
    const leap = parseCron("0 0 29 2 *");
    if ("problem" in leap) throw new Error(leap.problem);
    const nextLeap = nextCronTime(leap, new Date(2026, 0, 1, 0, 0, 0, 0));
    expect(nextLeap?.getFullYear()).toBe(2028);
    expect(nextLeap?.getMonth()).toBe(1);
    expect(nextLeap?.getDate()).toBe(29);

    const impossible = parseCron("0 0 31 2 *");
    if ("problem" in impossible) throw new Error(impossible.problem);
    expect(nextCronTime(impossible, new Date(2026, 0, 1, 0, 0, 0, 0))).toBeNull();
  });

  it("summarises common schedules cleanly", () => {
    expect(describeCron("0 3 * * *")).toBe("daily at 03:00 (0 3 * * *)");
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes (*/15 * * * *)");
    expect(describeCron("15 4 * * 1")).toBe("15 4 * * 1");
  });
});
