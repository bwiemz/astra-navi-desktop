import { describe, expect, it } from "vitest";
import {
  finishedCases,
  mergedReport,
  nextPiece,
  sameStamp,
  type IdleProgress,
} from "../evals/idle.ts";
import type { CaseResult, Report } from "../evals/types.ts";

const stamp = { marking: "m1", world: "w1", her: "h1" };
const run = (pass: boolean): CaseResult["runs"][number] =>
  ({
    pass,
    failures: pass ? [] : ["it failed"],
    leaks: [],
    calls: [],
    replies: ["ok"],
    moods: [[]],
    moodFirst: [true],
    corrections: 0,
    cautions: [],
    errors: [],
    asked: [],
    ms: 1000,
    firstWordMs: 300,
    heldTokens: 8000,
  }) as CaseResult["runs"][number];
const result = (id: string, passes: boolean[]): CaseResult =>
  ({
    id,
    category: id.split("/")[0],
    passRate: passes.filter(Boolean).length / passes.length,
    runs: passes.map(run),
  }) as CaseResult;
const part = (cases: CaseResult[], minutes = 2): Report =>
  ({
    label: "piece",
    brain: "Small",
    suite: stamp,
    startedAt: "2026-11-22T02:00:00.000Z",
    minutes,
    settings: { temperature: 0.7, seed: 1, repeat: 2, thinkingTokens: 256, contextSize: 16384 },
    categories: {},
    overall: 0,
    clean: 1,
    speed: { loadSeconds: 1, firstWordSeconds: cases.length },
    cases,
  }) as unknown as Report;
const progress = (parts: Report[], repeat = 2): IdleProgress => ({
  stamp,
  brain: "Small",
  repeat,
  startedAt: "2026-11-22T02:00:00.000Z",
  parts,
});
const every = ["tools/a", "tools/b", "honesty/c", "honesty/d", "knowledge/e"];

describe("her suite run a piece at a time", () => {
  it("takes the next cases in the suite's order, leaving out what is done", () => {
    expect(nextPiece(every, progress([]), 2)).toEqual(["tools/a", "tools/b"]);
    const one = progress([
      part([result("tools/a", [true, true]), result("honesty/c", [true, false])]),
    ]);
    expect(nextPiece(every, one, 2)).toEqual(["tools/b", "honesty/d"]);
    expect(nextPiece(every, one, 0)).toEqual(["tools/b"]);
  });

  it("runs again a case a game cut short, and counts it once when it comes twice", () => {
    const cut = progress([
      part([result("tools/a", [true, true]), result("tools/b", [true])]),
      part([result("tools/b", [false, false]), result("tools/a", [false, false])]),
    ]);
    const done = finishedCases(cut);
    // The first whole result of a case stands; the half-run one is not counted.
    expect([...done.keys()].sort()).toEqual(["tools/a", "tools/b"]);
    expect(done.get("tools/a")?.runs.every((made) => made.pass)).toBe(true);
    expect(done.get("tools/b")?.runs.every((made) => !made.pass)).toBe(true);
    expect(nextPiece(every, cut, 9)).toEqual(["honesty/c", "honesty/d", "knowledge/e"]);
  });

  it("is complete when nothing is left, and puts the pieces together in the suite's order", () => {
    const all = progress([
      part([result("honesty/c", [true, true]), result("honesty/d", [false, false])], 3),
      part(
        [
          result("tools/a", [true, true]),
          result("tools/b", [true, false]),
          result("knowledge/e", [true, true]),
        ],
        4,
      ),
    ]);
    expect(nextPiece(every, all, 5)).toEqual([]);
    const report = mergedReport("nightly", every, all);
    expect(report.cases.map((made) => made.id)).toEqual(every);
    expect(report).toMatchObject({
      label: "nightly",
      brain: "Small",
      suite: stamp,
      minutes: 7,
      pieces: 2,
    });
    expect(report.settings.repeat).toBe(2);
    // Worked out afresh over everything: tools 3 of 4 runs, honesty 2 of 4, knowledge 2 of 2.
    expect(report.categories["tools"]?.passRate).toBeCloseTo(0.75);
    expect(report.categories["honesty"]?.passRate).toBeCloseTo(0.5);
    expect(report.categories["knowledge"]?.passRate).toBeCloseTo(1);
    expect(report.overall).toBeCloseTo(0.75);
    // The speed figures are the largest piece's, not a blend.
    expect((report.speed as unknown as { firstWordSeconds: number }).firstWordSeconds).toBe(3);
  });

  it("has nothing to put together before any piece is finished", () => {
    expect(() => mergedReport("nightly", every, progress([]))).toThrow(/nothing to put together/);
  });

  it("knows when her rules or the suite have changed under a round", () => {
    expect(sameStamp(stamp, { ...stamp })).toBe(true);
    expect(sameStamp(stamp, { ...stamp, her: "h2" })).toBe(false);
    expect(sameStamp(stamp, { ...stamp, marking: "m2" })).toBe(false);
    expect(sameStamp(stamp, { ...stamp, world: "w2" })).toBe(false);
  });
});
