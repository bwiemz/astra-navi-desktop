import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionLog, describeActions, type ActionEntry } from "../src/core/actionLog.ts";
import { guarded, type ToolHost } from "../src/core/agentTools.ts";
import { MemoryStore } from "../src/core/memory.ts";
import {
  changesSomething,
  TOOLS,
  toolVerdict,
  type PolicyContext,
} from "../src/core/permissions.ts";
import {
  describeSelfCheck,
  removeSpareStorage,
  selfCheck,
  storageReport,
  spareStorage,
  type SelfCheckInputs,
} from "../src/core/selfCheck.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-trust-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (tool: string, extra: Partial<ActionEntry> = {}): ActionEntry => ({
  at: "2026-11-21T09:30:00.000Z",
  tool,
  detail: "",
  outcome: "done",
  asked: false,
  by: "her",
  ...extra,
});

describe("ActionLog", () => {
  it("keeps every call in order across a restart", async () => {
    const file = join(dir, "actions.jsonl");
    const log = new ActionLog(file);
    log.add(entry("run_command", { detail: "ffmpeg -i a.mp4 b.mp4", asked: true }));
    log.add(
      entry("write_file", { detail: "/home/sam/notes.md", outcome: "declined", asked: true }),
    );
    await log.flush();
    const again = new ActionLog(file);
    await again.load();
    expect(again.recent().map((line) => line.tool)).toEqual(["write_file", "run_command"]);
    expect(again.recent()[0]).toMatchObject({ outcome: "declined", asked: true });
  });

  it("stays within its limit, on disk too, and survives a damaged line", async () => {
    const file = join(dir, "small.jsonl");
    const log = new ActionLog(file, 5);
    for (let index = 0; index < 220; index++)
      log.add(entry("calculate", { detail: `sum ${index}` }));
    await log.flush();
    expect(log.recent(1000)).toHaveLength(5 + 14); // tidied at 205, then 14 more
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, "{broken\n");
    const again = new ActionLog(file, 5);
    await again.load();
    expect(again.recent(1000)).toHaveLength(5);
    expect(again.recent(1)[0]?.detail).toBe("sum 219");
  });

  it("writes a readable page, newest first, that a detail cannot break out of", () => {
    const page = describeActions(
      [
        entry("run_command", { detail: "echo `whoami`", asked: true }),
        entry("web_search", { detail: "lumen", by: "research", at: "2026-11-20T10:00:00.000Z" }),
        entry("sound", { detail: "set_volume to 0%", outcome: "refused" }),
      ],
      "/data/actions.jsonl",
    );
    expect(page).toContain("**run_command** `echo 'whoami'` (done, asked)");
    expect(page).toContain("(done, research)");
    expect(page).toContain("(blocked: hands off)");
    expect(page.match(/^## /gm)).toHaveLength(3); // the 21st, the 20th, the 21st again as listed
    expect(describeActions([], "/x")).toContain("Nothing yet.");
  });
});

describe("changesSomething", () => {
  it("knows which calls only look", () => {
    for (const [tool, input] of [
      [TOOLS.webSearch, { query: "x" }],
      [TOOLS.readFile, { path: "a.txt" }],
      [TOOLS.calculate, { expression: "1+1" }],
      [TOOLS.lookAtScreen, {}],
      [TOOLS.windows, { action: "list" }],
      [TOOLS.sound, { action: "now_playing" }],
      [TOOLS.sound, { action: "get_volume" }],
      [TOOLS.clipboard, { action: "read" }],
      [TOOLS.reminders, {}],
      [TOOLS.missions, {}],
    ] as const) {
      expect(changesSomething(tool, input), `${tool} ${JSON.stringify(input)}`).toBe(false);
    }
  });

  it("counts everything else as a change, including tools it has never heard of", () => {
    for (const [tool, input] of [
      [TOOLS.runCommand, { command: "ls" }],
      [TOOLS.writeFile, { path: "a.txt" }],
      [TOOLS.remember, { text: "x" }],
      [TOOLS.setReminder, { text: "x" }],
      [TOOLS.research, { question: "x" }],
      [TOOLS.windows, { action: "close" }],
      [TOOLS.windows, {}],
      [TOOLS.sound, { action: "set_volume", level: 0 }],
      [TOOLS.sound, { action: "pause" }],
      [TOOLS.clipboard, { action: "write", text: "x" }],
      [TOOLS.reminders, { cancel: "abc" }],
      [TOOLS.missions, { stop: "abc" }],
      [TOOLS.lockScreen, {}],
      ["some_new_tool", {}],
    ] as const) {
      expect(changesSomething(tool, input), `${tool} ${JSON.stringify(input)}`).toBe(true);
    }
  });
});

describe("the gate every tool passes through", () => {
  function makeHost(
    policy: Partial<PolicyContext>,
    answer = true,
  ): { host: ToolHost; audited: string[]; asked: number } {
    const state = { host: null as unknown as ToolHost, audited: [] as string[], asked: 0 };
    let steps = 0;
    state.host = {
      policy: () => ({ workspace: dir, home: dir, ...policy }),
      memory: new MemoryStore(join(dir, "memory.json")),
      learnAddresses: () => undefined,
      noteOutsideText: () => undefined,
      noteChange: () => undefined,
      signal: () => undefined,
      activity: () => undefined,
      ran: () => undefined,
      audit: (line) =>
        state.audited.push(`${line.tool}:${line.outcome}:${line.asked ? "asked" : "unasked"}`),
      ask: () => {
        state.asked += 1;
        return Promise.resolve(answer);
      },
      step: () => (steps += 1),
    };
    return state;
  }

  it("with hands off, refuses anything that changes something without even asking", async () => {
    const state = makeHost({ handsOff: true });
    let ran = false;
    const setVolume = guarded<{ action: string; level: number }>(
      state.host,
      TOOLS.sound,
      () => "x",
      () => {
        ran = true;
        return Promise.resolve("ok");
      },
    );
    expect(await setVolume({ action: "set_volume", level: 0 })).toContain("Hands off the controls");
    expect(ran).toBe(false);
    expect(state.asked).toBe(0);
    expect(state.audited).toEqual(["sound:refused:unasked"]);
  });

  it("with hands off, still lets her look things up", async () => {
    const state = makeHost({ handsOff: true });
    const sum = guarded<{ expression: string }>(
      state.host,
      TOOLS.calculate,
      () => "x",
      () => Promise.resolve("4"),
    );
    expect(await sum({ expression: "2+2" })).toBe("4");
    expect(state.audited).toEqual(["calculate:done:unasked"]);
  });

  it("records what was approved, what was declined, and what failed", async () => {
    const yes = makeHost({});
    const close = guarded<{ action: string; window: string }>(
      yes.host,
      TOOLS.windows,
      () => "x",
      () => Promise.resolve("Done."),
    );
    await close({ action: "close", window: "firefox" });
    const no = makeHost({}, false);
    const declined = guarded<{ action: string; window: string }>(
      no.host,
      TOOLS.windows,
      () => "x",
      () => Promise.resolve("Done."),
    );
    expect(await declined({ action: "close", window: "firefox" })).toContain("said no");
    const broken = guarded<{ expression: string }>(
      yes.host,
      TOOLS.calculate,
      () => "x",
      () => Promise.reject(new Error("boom")),
    );
    expect(await broken({ expression: "1/0" })).toContain("That failed: boom");
    expect(yes.audited).toEqual(["windows:done:asked", "calculate:failed:unasked"]);
    expect(no.audited).toEqual(["windows:declined:asked"]);
  });

  it("records a refusal for too many steps, for work with nobody to ask, and a failure for an action that did nothing", async () => {
    const busy = makeHost({});
    const sum = guarded<{ expression: string }>(
      busy.host,
      TOOLS.calculate,
      () => "x",
      () => Promise.resolve("4"),
    );
    for (let call = 0; call < 15; call++) await sum({ expression: `2+${call}` });
    expect(busy.audited.at(-1)).toBe("calculate:refused:unasked");
    expect(busy.audited.filter((line) => line.endsWith("done:unasked"))).toHaveLength(14);

    const alone = makeHost({}, false);
    alone.host.nobodyToAsk = true;
    const close = guarded<{ action: string; window: string }>(
      alone.host,
      TOOLS.windows,
      () => "x",
      () => Promise.resolve("Done."),
    );
    await close({ action: "close", window: "firefox" });
    expect(alone.audited).toEqual(["windows:refused:unasked"]);

    const nothing = makeHost({});
    const focus = guarded<{ action: string; window: string }>(
      nothing.host,
      TOOLS.windows,
      () => "x",
      () => Promise.resolve('No open window matches "spotify". Open ones: firefox.'),
    );
    await focus({ action: "focus", window: "spotify" });
    expect(nothing.audited).toEqual(["windows:failed:unasked"]);
  });

  it("writes the record through to disk", async () => {
    const file = join(dir, "actions.jsonl");
    const log = new ActionLog(file);
    const state = makeHost({});
    state.host.audit = (line) => log.add({ ...line, at: new Date().toISOString(), by: "her" });
    await guarded<{ expression: string }>(
      state.host,
      TOOLS.calculate,
      () => "x",
      () => Promise.resolve("4"),
    )({
      expression: "2+2",
    });
    await log.flush();
    expect(await readFile(file, "utf8")).toContain(
      '"tool":"calculate","detail":"2+2","outcome":"done"',
    );
  });
});

describe("knowing herself", () => {
  const inputs = (overrides: Partial<SelfCheckInputs> = {}): SelfCheckInputs => ({
    dataDir: dir,
    modelsDir: join(dir, "models"),
    brain: {
      label: "Standard (Qwen3.5 9B)",
      fileName: "Qwen3.5-9B-Q4_K_M.gguf",
      onDisk: true,
      loaded: false,
    },
    voice: { label: "Designed voice", ready: true },
    listening: false,
    handsOff: false,
    notes: { total: 12, topics: 3, skills: 2 },
    pastExchanges: 40,
    waitingToWriteUp: 1,
    actionsRecorded: 7,
    searchEngine: null,
    memoryInUse: 512 * 1024 * 1024,
    canReachTheWeb: () => Promise.resolve(true),
    ...overrides,
  });
  const seedModels = async (): Promise<void> => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "models", "speech"), { recursive: true });
    await writeFile(join(dir, "models", "Qwen3.5-4B-Q4_K_M.gguf"), Buffer.alloc(3000));
    await writeFile(join(dir, "models", "Qwen3.5-9B-Q4_K_M.gguf"), Buffer.alloc(6000));
    await writeFile(join(dir, "models", "speech", "a.onnx"), Buffer.alloc(1500));
    const hub = join(dir, "models", "voice-hf", "hub");
    await mkdir(join(hub, "models--Qwen--Qwen3-TTS-12Hz-1.7B-VoiceDesign"), { recursive: true });
    await writeFile(
      join(hub, "models--Qwen--Qwen3-TTS-12Hz-1.7B-VoiceDesign", "m"),
      Buffer.alloc(4000),
    );
    await mkdir(join(hub, "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base"));
    await writeFile(join(hub, "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base", "m"), Buffer.alloc(2000));
    await writeFile(join(dir, "memory.json"), "{}");
  };

  it("reports each system and says plainly what is wrong", async () => {
    const fine = describeSelfCheck(await selfCheck(inputs()));
    expect(fine).toContain("OK Brain: Standard (Qwen3.5 9B), asleep");
    expect(fine).toContain(
      "OK Memory: 12 notes (3 topics, 2 tasks), 40 past exchanges kept, 1 waiting",
    );
    expect(fine).toContain("OK Lookups: Online sources answer; no search engine of your own");
    const broken = describeSelfCheck(
      await selfCheck(
        inputs({
          brain: { label: "Standard (Qwen3.5 9B)", fileName: null, onDisk: false, loaded: false },
          voice: { label: "Light voice", ready: false },
          handsOff: true,
          canReachTheWeb: () => Promise.reject(new Error("offline")),
        }),
      ),
    );
    expect(broken).toContain("PROBLEM Brain: Standard (Qwen3.5 9B) is not downloaded yet");
    expect(broken).toContain("PROBLEM Voice: Light voice (not set up");
    expect(broken).toContain("PROBLEM Hands: Off the controls");
    expect(broken).toContain("PROBLEM Lookups: The online sources did not answer");
  });

  it("adds up what she keeps on disk and finds what is spare", async () => {
    await seedModels();
    const storage = await storageReport(dir, join(dir, "models"), "Qwen3.5-9B-Q4_K_M.gguf");
    expect(storage.map((item) => [item.label, item.bytes, item.inUse])).toEqual([
      ["Brain: Small (Qwen3.5 4B)", 3000, false],
      ["Brain: Standard (Qwen3.5 9B)", 6000, true],
      ["Voice designer (only used to invent new voices)", 4000, undefined],
      ["Designed-voice models", 2000, undefined],
      ["Hearing, sight and note-finding models", 1500, undefined],
      ["Her notes", 2, undefined],
    ]);
    expect(spareStorage(storage).map((item) => item.label)).toEqual([
      "Brain: Small (Qwen3.5 4B)",
      "Voice designer (only used to invent new voices)",
    ]);
    const text = describeSelfCheck({ lines: [], storage, freeBytes: 5e9 });
    expect(text).toContain("she takes up 17 kB on disk; 5.0 GB is free");
    expect(text).toContain(
      "Could be freed: 7 kB by removing what is not in use (Small (Qwen3.5 4B), Voice designer)",
    );
  });

  it("removes only what is spare, and no brain model when it cannot tell which is in use", async () => {
    await seedModels();
    const unknown = await storageReport(dir, join(dir, "models"), null);
    expect(spareStorage(unknown).map((item) => item.label)).toEqual([
      "Voice designer (only used to invent new voices)",
    ]);
    const known = await storageReport(dir, join(dir, "models"), "Qwen3.5-9B-Q4_K_M.gguf");
    expect((await removeSpareStorage(known)).map((item) => item.label)).toEqual([
      "Brain: Small (Qwen3.5 4B)",
      "Voice designer (only used to invent new voices)",
    ]);
    const after = await storageReport(dir, join(dir, "models"), "Qwen3.5-9B-Q4_K_M.gguf");
    expect(after.map((item) => item.label)).toEqual([
      "Brain: Standard (Qwen3.5 9B)",
      "Designed-voice models",
      "Hearing, sight and note-finding models",
      "Her notes",
    ]);
  });

  it("always asks before deleting, and never needs asking to check", async () => {
    const context = { workspace: dir, home: dir };
    expect(await toolVerdict(TOOLS.tidyStorage, {}, context)).toMatchObject({ decision: "ask" });
    expect(await toolVerdict(TOOLS.selfCheck, {}, context)).toEqual({ decision: "allow" });
    expect(changesSomething(TOOLS.tidyStorage, {})).toBe(true);
    expect(changesSomething(TOOLS.selfCheck, {})).toBe(false);
  });
});

describe("her own settings and records", () => {
  const context = {
    workspace: "/home/sam/Documents/AI-chan",
    home: "/home/sam",
    privateDirs: ["/srv/ai-chan-data"],
  };

  it("asks, as for any private place, before reading or changing them", async () => {
    for (const path of [
      "/home/sam/.local/share/ai-chan/config.json",
      "~/.local/share/ai-chan/actions.jsonl",
      "/srv/ai-chan-data/config.json",
      "~/.config/autostart/evil.desktop",
      "~/.config/systemd/user/evil.service",
    ]) {
      expect(
        await toolVerdict(TOOLS.writeFile, { path, content: "x" }, context),
        path,
      ).toMatchObject({
        decision: "ask",
        sensitive: true,
      });
      expect(await toolVerdict(TOOLS.readFile, { path }, context), path).toMatchObject({
        decision: "ask",
        sensitive: true,
      });
    }
    expect(
      await toolVerdict(TOOLS.findFiles, { name: "config", folder: "/srv/ai-chan-data" }, context),
    ).toMatchObject({
      decision: "ask",
      sensitive: true,
    });
  });

  it("asks before a command that names them, even a look-only one", async () => {
    for (const command of [
      "cat ~/.local/share/ai-chan/config.json",
      "cat /srv/ai-chan-data/config.json",
      "ls /srv/ai-chan-data",
    ]) {
      expect(await toolVerdict(TOOLS.runCommand, { command }, context), command).toMatchObject({
        decision: "ask",
        sensitive: true,
      });
    }
    expect(
      await toolVerdict(TOOLS.runCommand, { command: "ls /srv/ai-chan-database" }, context),
    ).not.toMatchObject({
      sensitive: true,
    });
  });
});
