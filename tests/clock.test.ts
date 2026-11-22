import { describe, expect, it } from "vitest";
import { clockLine, ClockTeller, daysAboard, partOfDay } from "../src/core/clock.ts";

const at = (hour: number, minute = 0, day = 21): Date => new Date(2026, 10, day, hour, minute);

describe("her sense of time", () => {
  it.each([
    [5, "early morning"],
    [9, "morning"],
    [12, "afternoon"],
    [18, "evening"],
    [22, "late night"],
    [0, "late night"],
    [3, "the small hours"],
  ])("calls %i o'clock %s", (hour, part) => {
    expect(partOfDay(at(hour))).toBe(part);
  });

  it("writes the time as one plain line", () => {
    expect(clockLine(at(0, 57))).toBe(
      "[ship's clock] Saturday 21 November 2026, 00:57 (late night)",
    );
  });

  it("tells her the time at the start, when the part of day changes, and after a long gap", () => {
    const teller = new ClockTeller();
    expect(teller.next(at(9, 0))).toContain("09:00 (morning)");
    expect(teller.next(at(9, 20))).toBe("");
    expect(teller.next(at(9, 50))).toContain("09:50"); // 50 minutes on
    expect(teller.next(at(12, 1))).toContain("(afternoon)");
    expect(teller.next(at(12, 5))).toBe("");
    teller.reset();
    expect(teller.next(at(12, 6))).toContain("12:06");
  });

  it("counts the days the two of them have known each other", () => {
    expect(daysAboard(null, at(10))).toBe(1);
    expect(daysAboard(at(23, 59, 21).toISOString(), at(0, 1, 22))).toBe(2);
    expect(daysAboard(at(8, 0, 1).toISOString(), at(8, 0, 30))).toBe(30);
    expect(daysAboard("not a date", at(10))).toBe(1);
    expect(daysAboard(at(10, 0, 25).toISOString(), at(10, 0, 21))).toBe(1); // a clock set back
  });
});
