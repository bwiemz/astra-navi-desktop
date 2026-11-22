import { describe, expect, it } from "vitest";
import {
  cleanExamples,
  clipForTrace,
  correctedPairs,
  describeCheck,
  describePick,
  describeTrace,
  forShow,
  SHOWN_CALL_TEXT,
  SHOWN_REPLY,
  SHOWN_SAID,
  TRACE_CLIP,
  TraceKeeper,
  type TracedCall,
  type TurnTrace,
} from "../src/core/trace.ts";

const call = (tool: string, outcome: TracedCall["outcome"] = "done"): TracedCall => ({
  tool,
  input: "{}",
  result: "ok",
  outcome,
  asked: false,
  ms: 5,
});

const trace = (patch: Partial<TurnTrace>): TurnTrace => ({
  at: "2026-11-22T01:00:00.000Z",
  kind: "user",
  said: "Pause the music.",
  spoken: false,
  brain: "Small",
  offered: ["sound", "remember"],
  calls: [],
  reply: "Paused.",
  checks: [],
  withheld: false,
  ms: { whole: 900, firstWord: 300 },
  tokens: { read: 40, written: 12, held: 8800 },
  ...patch,
});

describe("pairs of a reply sent back and the second go that put it right", () => {
  it("pairs a false 'done' with the reply that really did it", () => {
    const pairs = correctedPairs([
      trace({ reply: "Paused for Captain.", checks: [{ found: "claimed", did: "again" }] }),
      trace({
        kind: "again",
        said: "(the app's own message)",
        offered: ["sound", "remember", "weather"],
        calls: [call("sound")],
        reply: "It is paused now, Captain.",
      }),
    ]);
    expect(pairs).toEqual([
      {
        brain: "Small",
        said: "Pause the music.",
        offered: ["sound", "remember", "weather"],
        rejected: "Paused for Captain.",
        found: "claimed",
        accepted: { calls: [call("sound")], reply: "It is paused now, Captain." },
      },
    ]);
  });

  it("makes no pair of a second go that did nothing, was sent back again, or is not next", () => {
    const sentBack = trace({ checks: [{ found: "claimed", did: "again" }] });
    const again = (patch: Partial<TurnTrace>): TurnTrace =>
      trace({ kind: "again", calls: [call("sound")], reply: "Done now.", ...patch });
    expect(correctedPairs([sentBack, again({ calls: [] })])).toEqual([]);
    expect(correctedPairs([sentBack, again({ calls: [call("sound", "failed")] })])).toEqual([]);
    expect(
      correctedPairs([sentBack, again({ checks: [{ found: "claimed", did: "note" }] })]),
    ).toEqual([]);
    expect(correctedPairs([sentBack, trace({}), again({})])).toEqual([]);
    expect(correctedPairs([sentBack])).toEqual([]);
    // A note under a reply sends nobody back: there is no second go to pair it with.
    expect(
      correctedPairs([trace({ checks: [{ found: "wrong-sum", did: "note" }] }), again({})]),
    ).toEqual([]);
  });

  it("leaves out anything that may not be written down", () => {
    const sentBack = trace({ checks: [{ found: "looked", did: "again" }] });
    const again = trace({
      kind: "again",
      calls: [call("notifications")],
      reply: "",
      withheld: true,
    });
    expect(correctedPairs([sentBack, again])).toEqual([]);
    expect(
      correctedPairs([
        { ...sentBack, withheld: true },
        { ...again, withheld: false },
      ]),
    ).toEqual([]);
  });
});

describe("replies that needed nothing put right", () => {
  it("keeps a reply to the user that used its tools to the end and was not corrected", () => {
    const good = trace({ calls: [call("sound")], reply: "Paused, Captain." });
    expect(cleanExamples([good])).toEqual([
      {
        brain: "Small",
        said: "Pause the music.",
        offered: ["sound", "remember"],
        calls: [call("sound")],
        reply: "Paused, Captain.",
      },
    ]);
  });

  it("leaves out small talk, failed or refused calls, the ship's messages and corrected replies", () => {
    const withTool = (patch: Partial<TurnTrace>): TurnTrace =>
      trace({ calls: [call("sound")], ...patch });
    expect(cleanExamples([trace({ calls: [] })])).toEqual([]);
    expect(cleanExamples([withTool({ calls: [call("sound", "failed")] })])).toEqual([]);
    expect(
      cleanExamples([withTool({ calls: [call("sound"), call("windows", "declined")] })]),
    ).toEqual([]);
    expect(cleanExamples([withTool({ kind: "ship" })])).toEqual([]);
    expect(cleanExamples([withTool({ checks: [{ found: "wrong-sum", did: "note" }] })])).toEqual(
      [],
    );
    expect(cleanExamples([withTool({ withheld: true })])).toEqual([]);
    expect(cleanExamples([withTool({}), trace({ kind: "again" })])).toEqual([]);
  });
});

describe("keeping the last few", () => {
  it("drops the oldest past its limit and hands out a copy", () => {
    const keeper = new TraceKeeper(3);
    for (let index = 0; index < 5; index += 1) keeper.add(trace({ said: `message ${index}` }));
    const listed = keeper.list();
    expect(listed.map((kept) => kept.said)).toEqual(["message 2", "message 3", "message 4"]);
    listed.pop();
    expect(keeper.list()).toHaveLength(3);
    keeper.clear();
    expect(keeper.list()).toEqual([]);
  });

  it("cuts long text short and says how much was cut", () => {
    expect(clipForTrace("short")).toBe("short");
    const long = "x".repeat(TRACE_CLIP + 25);
    expect(clipForTrace(long)).toBe(`${"x".repeat(TRACE_CLIP)}… (25 more characters)`);
  });
});

describe("the records as the settings page shows them", () => {
  it("puts the newest first and cuts long text short", () => {
    const shown = forShow([
      trace({ said: "first" }),
      trace({
        said: "s".repeat(SHOWN_SAID + 40),
        reply: "r".repeat(SHOWN_REPLY + 40),
        calls: [
          {
            ...call("read_file"),
            input: "i".repeat(SHOWN_CALL_TEXT + 40),
            result: "o".repeat(SHOWN_CALL_TEXT + 40),
          },
        ],
      }),
    ]);
    expect(shown.map((one) => one.said.slice(0, 5))).toEqual(["sssss", "first"]);
    expect(shown[0]?.said).toBe(`${"s".repeat(SHOWN_SAID)}…`);
    expect(shown[0]?.reply).toBe(`${"r".repeat(SHOWN_REPLY)}…`);
    expect(shown[0]?.calls[0]?.input).toBe(`${"i".repeat(SHOWN_CALL_TEXT)}…`);
    expect(shown[0]?.calls[0]?.result).toBe(`${"o".repeat(SHOWN_CALL_TEXT)}…`);
    // Text that fits is given whole, with no mark added.
    expect(shown[1]?.said).toBe("first");
    expect(shown[1]?.reply).toBe("Paused.");
  });

  it("does not change the records it was given", () => {
    const kept = [trace({ said: "one" }), trace({ said: "two" })];
    forShow(kept);
    expect(kept.map((one) => one.said)).toEqual(["one", "two"]);
  });

  it("says how each call ended and whether the user was asked", () => {
    const [shown] = forShow([
      trace({
        calls: [
          call("sound"),
          call("sound", "failed"),
          { ...call("run_command", "declined"), asked: true },
          call("write_file", "refused"),
        ],
      }),
    ]);
    expect(shown?.calls.map((one) => one.ended)).toEqual([
      "worked",
      "ran and failed",
      "you said no",
      "not run: the app's rules stopped it",
    ]);
    expect(shown?.calls.map((one) => one.asked)).toEqual([false, false, true, false]);
    expect(shown?.summary).toBe("4 calls, 1 failed, 1 you said no to, 1 not allowed");
  });

  it("sums a reply up in a few words", () => {
    expect(describeTrace(trace({}))).toBe("no tools used");
    expect(describeTrace(trace({ calls: [call("sound")] }))).toBe("1 call");
    expect(describeTrace(trace({ checks: [{ found: "claimed", did: "again" }] }))).toBe(
      "no tools used, sent back once",
    );
    expect(
      describeTrace(
        trace({ calls: [call("calculate")], checks: [{ found: "wrong-sum", did: "note" }] }),
      ),
    ).toBe("1 call, a note put under it");
    // Her second go is summed up like any other reply: the page says which it is.
    expect(describeTrace(trace({ kind: "again", calls: [call("sound"), call("sound")] }))).toBe(
      "2 calls",
    );
  });

  it("puts every check the app can make into a sentence of its own", () => {
    const sentences = (
      [
        ["claimed", "again"],
        ["claimed", "note"],
        ["looked", "again"],
        ["looked", "note"],
        ["unchecked", "again"],
        ["unchecked", "note"],
        ["stopped", "again"],
        ["stopped", "note"],
        ["no-way", "again"],
        ["sum", "again"],
        ["wrong-sum", "note"],
      ] as const
    ).map(([found, did]) => describeCheck({ found, did }));
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z].*: .*\.$/);
    expect(describeCheck({ found: "claimed", did: "again" })).toBe(
      "She said it was done, or under way, with nothing done: sent back to do it properly.",
    );
    expect(describeCheck({ found: "wrong-sum", did: "note" })).toBe(
      "A sum she wrote out does not come to what she said: the right figure was put under her reply.",
    );
    expect(describeCheck({ found: "no-way", did: "again" })).toContain("given every tool");
  });

  it("says why a tool was picked out, and how many were on offer", () => {
    const [shown] = forShow([
      trace({
        offered: ["sound", "remember", "weather"],
        pickedFor: { sound: "words", weather: "meaning +2.1", reminders: "goes with keep_watch" },
      }),
    ]);
    expect(shown?.offered).toBe(3);
    expect(shown?.picked).toEqual([
      { tool: "sound", why: "named in what you said" },
      { tool: "weather", why: "close in meaning to what you said" },
      { tool: "reminders", why: "goes with keep_watch" },
    ]);
    expect(describePick("used just now")).toBe("used or called for a moment ago");
    expect(describePick("names a machine")).toBe("you named one of your machines");
    expect(describePick("no hints")).toBe("always offered");
    // With every tool always offered there is nothing to list.
    expect(forShow([trace({})])[0]?.picked).toEqual([]);
  });

  it("carries the mark for what is never written down, with nothing in its place", () => {
    const [shown] = forShow([trace({ reply: "", withheld: true })]);
    expect(shown).toMatchObject({ withheld: true, reply: "" });
  });

  it("preserves offeredTools, gate/gateReason, prompt tokens, stage latencies, and TraceKeeper.noteTts()", async () => {
    const { TraceKeeper } = await import("../src/core/trace.ts");
    const [shown] = forShow([
      trace({
        offered: ["fleet_check", "agenda"],
        calls: [
          {
            tool: "fleet_check",
            input: "{}",
            outcome: "done",
            result: "ok",
            asked: false,
            ms: 18,
            gate: "allow",
            gateReason: "read-only status",
          },
        ],
        tokens: { read: 50, written: 12, held: 62, prompt: 780 },
        ms: { whole: 215, firstWord: 60, stt: 95, llm: 40, tools: 18, tts: 62 },
      }),
    ]);

    expect(shown).toMatchObject({
      offeredTools: ["fleet_check", "agenda"],
      tokens: { read: 50, written: 12, held: 62, prompt: 780 },
      ms: { whole: 215, firstWord: 60, stt: 95, llm: 40, tools: 18, tts: 62 },
    });
    expect(shown?.calls[0]).toMatchObject({
      tool: "fleet_check",
      gate: "allowed automatically",
      gateReason: "read-only status",
    });

    const keeper = new TraceKeeper(10);
    keeper.add(trace({ ms: { whole: 90, firstWord: 30, stt: 50, llm: 30, tools: 10 } }));
    keeper.noteTts(44);
    keeper.noteTts(16);
    const afterTts = forShow(keeper.list())[0];
    expect(afterTts?.ms.tts).toBe(60);
  });
});
