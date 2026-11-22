import { describe, expect, it } from "vitest";
import { calculate } from "../src/core/calc.ts";

const TODAY = new Date(2026, 10, 21); // Saturday 21 November 2026

describe("calculate", () => {
  it.each([
    ["2 + 2", "4"],
    ["2 + 3 * 4", "14"],
    ["(2 + 3) * 4", "20"],
    ["2 ^ 3 ^ 2", "512"],
    ["2 ** 10", "1,024"],
    ["-3 ^ 2", "-9"],
    ["(-3) ^ 2", "9"],
    ["2 ^ -2", "0.25"],
    ["2 * 3 ** 2", "18"],
    ["10 / 2 ** 2", "2.5"],
    ["2 ** 3 ** 2", "512"],
    ["-2 ** 2", "-4"],
    ["2 * -3", "-6"],
    ["10% + 5", "5.1"],
    ["100 - 10% - 10%", "81"],
    ["2 * 15%", "0.3"],
    ["(80 + 15%)", "92"],
    ["10 / 4", "2.5"],
    ["0.1 + 0.2", "0.3"],
    ["1,234.5 * 2", "2,469"],
    ["1e3 * 3", "3,000"],
    ["sqrt(144) + abs(-3)", "15"],
    ["round(3.14159, 2)", "3.14"],
    ["max(3, 9, 4) - min(3, 9, 4)", "6"],
    ["max(1,200)", "200"],
    ["1,200 + 1", "1,201"],
    ["log(1000)", "3"],
    ["5!", "120"],
    ["17 mod 5", "2"],
    ["2 * pi", "6.28318530718"],
    ["15% of 80", "12"],
    ["80 + 15%", "92"],
    ["200 - 10%", "180"],
    ["50% * 8", "4"],
    ["what is 7 × 6?", "42"],
    ["1234567 * 7654321 =", "9,449,772,114,007"],
  ])("%s is %s", (sum, answer) => {
    expect(calculate(sum, TODAY)).toBe(answer);
  });

  it.each([
    ["5 miles in km", "8.04672 km"],
    ["72 f to c", "22.2222222222 c"],
    ["100 c to fahrenheit", "212 fahrenheit"],
    ["0 k to c", "-273.15 c"],
    ["2 cups to ml", "473.176473 ml"],
    ["1.5 hours in minutes", "90 minutes"],
    ["(3 + 4) kg to lb", "15.4323583529 lb"],
    ["500 gb in gib", "465.661287308 gib"],
    ["60 mph to km/h", "96.56064 km/h"],
    ["100 Mb to MB", "12.5 MB"],
    ["1 GB to Gb", "8 Gb"],
    ["1024 mb to gb", "1.024 gb"],
  ])("converts %s", (sum, answer) => {
    expect(calculate(sum, TODAY)).toBe(answer);
  });

  it.each([
    ["days until 2027-04-01", "131 days until Thursday 2027-04-01"],
    ["until tomorrow", "1 day until Sunday 2026-11-22"],
    ["days since 2026-01-01", "324 days since Thursday 2026-01-01"],
    [
      "between 2026-12-01 and 2026-12-25",
      "24 days (3.4 weeks) from Tuesday 2026-12-01 to Friday 2026-12-25",
    ],
    ["today + 10 days", "Tuesday 2026-12-01"],
    ["2026-01-31 + 1 month", "Tuesday 2026-03-03"],
    ["today - 2 weeks", "Saturday 2026-11-07"],
    ["what day is 2027-01-01", "Friday 2027-01-01"],
    ["2026-11-21", "Saturday 2026-11-21"],
  ])("does the date sum %s", (sum, answer) => {
    expect(calculate(sum, TODAY)).toBe(answer);
  });

  it.each([
    ["1 / 0", /no finite answer/],
    ["0 / 0", /no answer/],
    ["2 +", /ends too soon/],
    ["(2 + 3", /bracket/],
    ["process.exit(1)", /do not/],
    ["constructor", /do not know/],
    ["5 miles in kg", /different things/],
    ["", /nothing to work out/],
    ["2 2", /do not understand/],
    ["until 2027-13-45", /not a date/],
    ["sqrt(2, 5)", /takes one number/],
    ["today / 5 days", /do not/],
  ])("explains what is wrong with %s", (sum, problem) => {
    expect(() => calculate(sum, TODAY)).toThrow(problem);
  });

  it("never runs code", () => {
    for (const sum of ["require('fs')", "globalThis", "(() => 1)()", "`x`", "a = 1"]) {
      expect(() => calculate(sum, TODAY)).toThrow();
    }
  });
});
