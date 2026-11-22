import { describe, expect, it } from "vitest";
import { describeWrongSums, wrongSums } from "../src/core/sums.ts";

const right = (reply: string): void => expect(wrongSums(reply), reply).toEqual([]);

describe("checking the sums she states", () => {
  it("leaves right figures alone, however they are written", () => {
    for (const reply of [
      "18 percent of 240 is 43.2.",
      "AI-chan's got this. 18% of 240 is **43.2**.",
      "18% of 240 is 43",
      "1499 times 0.85 is 1,274.15, Captain.",
      "1499 * 0.85 = 1274",
      "1,499 × 0.85 comes to about 1,270",
      "26.2 miles is exactly 42.164708 kilometres, Captain.",
      "26.2 miles is 42.2 km",
      "26.2 miles is **42.17 km**.",
      "5 kg is about 11 lb",
      "100 divided by 8 is 12.5",
      "7 minus 10 is -3",
      "3 x 4 is 12",
      "72°F is 22.2°C",
    ]) {
      right(reply);
    }
  });

  it("finds a wrong figure and gives the right one", () => {
    expect(wrongSums("18% of 240 is 44.")).toEqual([{ said: "18% of 240 is 44", right: "43.2" }]);
    expect(wrongSums("Easy: 12 + 30 is 43, Captain!")).toEqual([
      { said: "12 + 30 is 43", right: "42" },
    ]);
    expect(wrongSums("1,000 plus 250 equals 1,350")).toEqual([
      { said: "1,000 plus 250 equals 1,350", right: "1,250" },
    ]);
    expect(wrongSums("3 x 4 is 13")).toEqual([{ said: "3 x 4 is 13", right: "12" }]);
    expect(wrongSums("26.2 miles is 45 km")).toEqual([
      { said: "26.2 miles is 45 km", right: "42.1648 km" },
    ]);
    expect(wrongSums("5 kg is 12 lb")).toEqual([{ said: "5 kg is 12 lb", right: "11.0231 lb" }]);
    expect(wrongSums("72°F is 30°C")).toHaveLength(1);
    expect(wrongSums("It is about 60: 18% of 240 is about 60.")).toHaveLength(1);
  });

  it("does not read a sum into dates, ranges, versions or ordinary talk", () => {
    for (const reply of [
      "The 2026-11-21 release is 3 days late.",
      "It is 10 - 12 degrees out, Captain.",
      "The shop is open 24/7 and is 5 minutes away.",
      "Version 2.5 is 3 times faster.",
      "Chapter 3 plus the appendix is 40 pages.",
      "You have 3 windows open and 2 is the calculator.",
      "Set for 16:10 today: 10 minutes is 600 seconds away",
      "A 4 x 4 is a kind of car.",
      "",
    ]) {
      right(reply);
    }
  });

  it("leaves alone what it cannot be sure is a whole sum of hers", () => {
    for (const reply of [
      // the tail of a longer sum
      "2 + 3 + 4 is 9",
      "2 + 3 × 4 is 14",
      "2 × 3 × 4 is 24",
      "10² + 5 is 105",
      // other ways of writing numbers
      "1,5 + 2 = 3,5",
      "1.000 + 250 = 1.250",
      "1 000 + 250 = 1 250",
      // more places than the calculator keeps
      "0.1 + 0.2 is 0.30000000000000004",
      "1 / 3 is 0.3333333333333",
      // somebody else's sum, or one she is correcting
      "You said 12 + 30 is 43, but it's 42.",
      "A common mistake is thinking 2 + 2 is 5",
      // ranges, clock times, fractions as percentages
      "Pages 10 - 20 are 10 pages",
      "The years 2020 – 2024 is 4 years",
      "9:15 + 30 = 9:45",
      "3 / 5 is 60%",
      // her figure goes on
      "1,500,000 + 500,000 is 2 million",
      "1,500 + 300 is 1.8k",
      "6 + 6 is 4 more than 8",
      // too large for plain figures
      "1,000,000 × 1,000,000,000 is 1,000,000,000,000,000",
    ]) {
      right(reply);
    }
  });

  it("leaves alone a sum too large or too small for the calculator to give exactly", () => {
    // The calculator answers these to seven figures; she may rightly have more.
    for (const reply of [
      "123456789 × 987654321 is 121932631112635269",
      "0.0001 × 0.0001 is 0.00000001",
    ]) {
      expect(wrongSums(reply), reply).toEqual([]);
    }
  });

  it("reports each sum once, and no more than three", () => {
    const reply = "2 + 2 is 5. Again: 2 + 2 is 5. And 3 + 3 is 7, 4 + 4 is 9, 5 + 5 is 11.";
    expect(wrongSums(reply).map((sum) => sum.said)).toEqual([
      "2 + 2 is 5",
      "3 + 3 is 7",
      "4 + 4 is 9",
    ]);
  });

  it("is not slowed by a very long reply", () => {
    const started = performance.now();
    wrongSums(`${"12 + 30 is 42. ".repeat(4000)}${"9".repeat(5000)} `);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("words the note so it is clear who worked it out", () => {
    expect(describeWrongSums([{ said: "18% of 240 is 44", right: "43.2" }])).toBe(
      'Check the figures in that reply: "18% of 240 is 44" should be 43.2. (Worked out by the calculator, not by her.)',
    );
  });
});
