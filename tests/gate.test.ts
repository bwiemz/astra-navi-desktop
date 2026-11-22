import { describe, expect, it } from "vitest";
import { guarded, type ToolHost } from "../src/core/agentTools.ts";
import type { TracedCall } from "../src/core/trace.ts";
import { TOOLS, type PolicyContext } from "../src/core/permissions.ts";

interface Seen {
  finished: { tool: string; ok: boolean; started: boolean }[];
  asked: string[];
  audited: string[];
  ran: string[];
}

function rig(
  options: { allow?: (title: string, note: string | null) => boolean; searches?: number } = {},
): {
  host: ToolHost;
  seen: Seen;
} {
  const seen: Seen = { finished: [], asked: [], audited: [], ran: [] };
  let steps = 0;
  const policy: PolicyContext = {
    workspace: "/tmp/aichan-gate-test",
    home: "/tmp/aichan-gate-test",
  };
  const host: ToolHost = {
    policy: () => policy,
    memory: undefined as never,
    learnAddresses: () => undefined,
    noteOutsideText: () => undefined,
    noteChange: () => undefined,
    signal: () => undefined,
    activity: () => undefined,
    ran: (tool) => seen.ran.push(tool),
    finished: (record) =>
      seen.finished.push({ tool: record.tool, ok: record.ok, started: record.started }),
    audit: (entry) => seen.audited.push(`${entry.tool}:${entry.outcome}`),
    ask: (request) => {
      seen.asked.push(`${request.title}|${String(request.detail)}`);
      return Promise.resolve(options.allow?.(request.title, request.note ?? null) ?? true);
    },
    step: () => (steps += 1),
    ...(options.searches === undefined ? {} : { searchesPerReply: options.searches }),
  };
  return { host, seen };
}

describe("the gate: what it tells the brain about how a call ended", () => {
  it("says a tool that ran and failed had started", async () => {
    const { host, seen } = rig();
    const tool = guarded(
      host,
      TOOLS.setReminder,
      () => "x",
      () => Promise.resolve("Nothing was set: the two times disagree."),
    );
    await tool({});
    expect(seen.ran).toEqual([TOOLS.setReminder]);
    expect(seen.finished).toEqual([{ tool: TOOLS.setReminder, ok: false, started: true }]);
  });

  it("says a call that was stopped by its own arguments never started", async () => {
    const { host, seen } = rig();
    // A file outside every allowed place with a path that cannot be resolved makes the
    // rules themselves throw, before anything is asked or run.
    const tool = guarded<{ action: string; machine: string }>(
      host,
      TOOLS.remote,
      () => "x",
      () => Promise.resolve("should not run"),
    );
    const result = await tool({ action: "run", machine: "nowhere" });
    expect(result).toMatch(/^That failed: /);
    expect(seen.ran).toEqual([]);
    expect(seen.finished).toEqual([{ tool: TOOLS.remote, ok: false, started: false }]);
  });
});

describe("the gate: every call is handed on for the trace of the reply", () => {
  it("says what was asked, what came back and how it ended, for each kind of ending", async () => {
    const traced: TracedCall[] = [];
    const { host } = rig({ allow: () => false });
    host.traced = (call) => traced.push(call);
    const weather = guarded<{ place: string }>(
      host,
      TOOLS.weather,
      () => "x",
      (input) =>
        input.place === "Atlantis"
          ? Promise.reject(new Error("no such place"))
          : Promise.resolve(`Weather for ${input.place}: 14°C`),
    );
    const command = guarded<{ command: string }>(
      host,
      TOOLS.runCommand,
      () => "x",
      () => Promise.resolve("ok"),
    );
    await weather({ place: "Kyoto" });
    await weather({ place: "Atlantis" });
    await command({ command: "rm -rf build" });
    await command({ command: "rm -rf dist" });
    expect(traced.map((call) => [call.tool, call.outcome, call.asked])).toEqual([
      [TOOLS.weather, "done", false],
      [TOOLS.weather, "failed", false],
      [TOOLS.runCommand, "declined", true],
      [TOOLS.runCommand, "refused", false],
    ]);
    expect(traced[0]).toMatchObject({
      input: '{"place":"Kyoto"}',
      result: "Weather for Kyoto: 14°C",
    });
    expect(traced[1]?.result).toBe("That failed: no such place");
    expect(traced.every((call) => call.ms >= 0)).toBe(true);
  });

  it("goes on when the record itself cannot be kept, and hands the text on whole", async () => {
    const { host } = rig({});
    const seen: TracedCall[] = [];
    host.traced = (call) => {
      seen.push(call);
      throw new Error("disk full");
    };
    const read = guarded<{ path: string }>(
      host,
      TOOLS.weather,
      () => "x",
      () => Promise.resolve("y".repeat(5000)),
    );
    expect(await read({ path: "a" })).toHaveLength(5000);
    // Whole: whoever keeps it takes secrets out first and cuts it short after.
    expect(seen[0]?.result).toHaveLength(5000);
  });
});

describe("the gate: a tool's own word that it failed is written down as a failure", () => {
  it("does not record an unreachable machine as a thing done", async () => {
    const { host, seen } = rig({});
    const remote = guarded<{ action: string; machine: string; command: string }>(
      host,
      TOOLS.remote,
      () => "x",
      () =>
        Promise.resolve(
          "That failed: The machine did not answer. It may be off, or not on this network.",
        ),
    );
    await remote({ action: "run", machine: "nas", command: "uptime" });
    expect(seen.finished.at(-1)).toMatchObject({ tool: TOOLS.remote, ok: false });
    expect(seen.audited.at(-1)).toBe("remote:failed");
  });
});

describe("the gate: a no stands for the rest of the reply", () => {
  it("does not put the same thing again in other words: a no to a file is a no to its next draft", async () => {
    const { host, seen } = rig({ allow: () => false });
    const write = guarded<{ path: string; content: string }>(
      host,
      TOOLS.writeFile,
      () => "x",
      () => Promise.resolve("Saved."),
    );
    const outside = "/etc/aichan-gate-test.conf";
    expect(await write({ path: outside, content: "first draft" })).toMatch(/^The user said no/);
    expect(await write({ path: outside, content: "first draft" })).toMatch(
      /already said no to exactly this/,
    );
    // Seen with the 9B model on a real machine: "touch file" refused, then "cat > file".
    expect(await write({ path: outside, content: "a different draft" })).toMatch(
      /another way of doing the same thing is still a no/,
    );
    const command = guarded<{ command: string }>(
      host,
      TOOLS.runCommand,
      () => "x",
      () => Promise.resolve("ok"),
    );
    expect(await command({ command: `touch ${outside}` })).toMatch(/^Not done, and not asked/);
    expect(seen.asked).toHaveLength(1);
    expect(seen.ran).toEqual([]);
  });

  it("still asks about a different kind of thing after a no", async () => {
    const { host, seen } = rig({ allow: () => false });
    const command = guarded<{ command: string }>(
      host,
      TOOLS.runCommand,
      () => "x",
      () => Promise.resolve("ok"),
    );
    const windows = guarded<{ action: string; window: string }>(
      host,
      TOOLS.windows,
      () => "x",
      () => Promise.resolve("Closed."),
    );
    expect(await command({ command: "rm -rf build" })).toMatch(/^The user said no/);
    expect(await windows({ action: "close", window: "kate" })).toMatch(/^The user said no/);
    expect(seen.asked).toHaveLength(2);
  });
});

describe("the gate: searching has an end", () => {
  it("lets the allowed number through and then says to answer from what she has", async () => {
    const { host, seen } = rig({ searches: 2 });
    const search = guarded<{ query: string }>(
      host,
      TOOLS.webSearch,
      () => "x",
      (input) => Promise.resolve(`results for ${input.query}`),
    );
    expect(await search({ query: "a" })).toBe("results for a");
    expect(await search({ query: "b" })).toBe("results for b");
    expect(await search({ query: "c" })).toMatch(/^Not searched: you have searched enough/);
    expect(seen.ran).toHaveLength(2);
    expect(seen.audited.at(-1)).toBe(`${TOOLS.webSearch}:refused`);
  });

  it("has no limit where none is set, as for her research", async () => {
    const { host } = rig();
    const search = guarded<{ query: string }>(
      host,
      TOOLS.webSearch,
      () => "x",
      () => Promise.resolve("results"),
    );
    for (let count = 0; count < 9; count++) {
      expect(await search({ query: `q${count}` })).toBe("results");
    }
  });
});

describe("the gate: the same call over and over has an end", () => {
  it("makes a call twice running and not a third time, until something else is done", async () => {
    const { host, seen } = rig({});
    const weather = guarded<{ place: string }>(
      host,
      TOOLS.weather,
      () => "x",
      (input) => Promise.resolve(`Weather for ${input.place}: 14°C`),
    );
    expect(await weather({ place: "Kyoto" })).toBe("Weather for Kyoto: 14°C");
    expect(await weather({ place: "Kyoto" })).toBe("Weather for Kyoto: 14°C");
    expect(await weather({ place: "Kyoto" })).toMatch(/^Not run again: you have just made this/);
    expect(await weather({ place: "Kyoto" })).toMatch(/^Not run again/);
    // Another place is another question, and after it the first may be asked again.
    expect(await weather({ place: "Osaka" })).toBe("Weather for Osaka: 14°C");
    expect(await weather({ place: "Kyoto" })).toBe("Weather for Kyoto: 14°C");
    expect(seen.ran).toHaveLength(4);
  });

  it("lets a call that does something be made as often as asked: three skips are three skips", async () => {
    const { host, seen } = rig({});
    const sound = guarded<{ action: string }>(
      host,
      TOOLS.sound,
      () => "x",
      () => Promise.resolve("Skipped to the next track."),
    );
    for (let skip = 0; skip < 4; skip += 1) {
      expect(await sound({ action: "next" })).toBe("Skipped to the next track.");
    }
    expect(seen.ran).toHaveLength(4);
  });

  it("asks before a stopped mission is taken up again, and does not do it for another device", async () => {
    let resumed = 0;
    const atPc = rig({ allow: () => false });
    const resume = (host: ToolHost): ((input: { resume: string }) => Promise<string>) =>
      guarded<{ resume: string }>(
        host,
        TOOLS.missions,
        () => "x",
        () => Promise.resolve(`resumed ${(resumed += 1)}`),
      );
    // At the PC it is the user's call, with no outside text needed to make it one.
    await resume(atPc.host)({ resume: "m-abc123" });
    expect(atPc.seen.asked).toEqual(["Take this mission up again?|m-abc123"]);
    expect(resumed).toBe(0);

    // From a paired device it is not done at all, and nobody is asked.
    const away = rig({});
    const policy = away.host.policy();
    away.host.policy = () => ({ ...policy, away: true });
    expect(await resume(away.host)({ resume: "m-abc123" })).toMatch(
      /^That failed: A stopped mission is taken up again at the PC only/,
    );
    expect(away.seen.asked).toEqual([]);
    expect(resumed).toBe(0);
  });

  it("takes an empty resume for none: her tools fill in every field, and listing is not resuming", async () => {
    let listed = 0;
    const list = (host: ToolHost): ((input: { stop: string; resume: string }) => Promise<string>) =>
      guarded<{ stop: string; resume: string }>(
        host,
        TOOLS.missions,
        () => "x",
        () => Promise.resolve(`listed ${(listed += 1)}`),
      );
    const atPc = rig({ allow: () => false });
    expect(await list(atPc.host)({ stop: "", resume: "" })).toBe("listed 1");
    expect(await list(atPc.host)({ stop: "", resume: "  " })).toBe("listed 2");
    expect(atPc.seen.asked).toEqual([]);
    // From a paired device too: asking how the missions stand is not refused.
    const away = rig({});
    const policy = away.host.policy();
    away.host.policy = () => ({ ...policy, away: true });
    expect(await list(away.host)({ stop: "", resume: "" })).toBe("listed 3");
  });

  it("lets her ask again while the answer keeps changing, and stops a look that fails the same way", async () => {
    const waiting = rig({});
    let percent = 0;
    const job = guarded<{ id: string }>(
      waiting.host,
      TOOLS.missions,
      () => "x",
      () => Promise.resolve(`Render: ${(percent += 20)}% done`),
    );
    for (let look = 0; look < 5; look += 1) expect(await job({ id: "m1" })).toMatch(/% done$/);

    const failing = rig({});
    const weather = guarded<{ place: string }>(
      failing.host,
      TOOLS.weather,
      () => "x",
      () => Promise.reject(new Error("no such place")),
    );
    expect(await weather({ place: "Atlantis" })).toBe("That failed: no such place");
    expect(await weather({ place: "Atlantis" })).toBe("That failed: no such place");
    expect(await weather({ place: "Atlantis" })).toMatch(/^Not run again/);
  });
});

describe("what is never written down", () => {
  it("leaves notification text out of the conversation saved for the next launch", async () => {
    const { withoutUnsavedResults } = await import("../src/core/brain.ts");
    const secret = "Mika: the door code is 4471";
    const history = [
      { type: "user" as const, text: "did I miss anything?" },
      {
        type: "model" as const,
        response: [
          {
            type: "segment",
            segmentType: "thought",
            text: `She got ${secret}`,
            ended: true,
          } as never,
          {
            type: "functionCall" as const,
            name: TOOLS.notifications,
            params: { app: "", count: 0 },
            result: `Notifications, newest first:\n1. 16:02 Discord: ${secret}`,
          },
          `[[happy]] One from Discord, Captain. ${secret}.`,
        ],
      },
      { type: "user" as const, text: "what is 2+2" },
      {
        type: "model" as const,
        response: [
          {
            type: "functionCall" as const,
            name: TOOLS.calculate,
            params: { expression: "2+2" },
            result: "4",
          },
          "[[smug]] Four.",
        ],
      },
    ];
    const saved = withoutUnsavedResults(history);
    expect(JSON.stringify(saved)).not.toContain("4471");
    expect(JSON.stringify(saved)).not.toContain("Mika");
    // The exchange keeps its shape, and says what is missing.
    expect(saved).toHaveLength(4);
    expect(JSON.stringify(saved[1])).toContain("not kept");
    expect(JSON.stringify(saved[1])).toContain(TOOLS.notifications);
    // Everything else is word for word what it was, and the original is not touched.
    expect(saved[0]).toBe(history[0]);
    expect(saved[3]).toBe(history[3]);
    expect(JSON.stringify(history)).toContain("4471");
  });
});
