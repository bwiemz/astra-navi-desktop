import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineChatSessionFunction, type ChatSessionModelFunctions } from "node-llama-cpp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvalCase, SeenCall } from "../evals/types.ts";
import { makeWorld, pretendWeb, REAL_TOOLS } from "../evals/world.ts";
import { createTools, type ToolHost } from "../src/core/agentTools.ts";
import { TOOLS, type PolicyContext } from "../src/core/permissions.ts";

// The pretend world her test suite runs in. No model here either: her tools are called
// directly, the way she would call them, and what must hold is that nothing real is
// touched outside the test's own folder, and that the gate in front of every stand-in is
// the very gate she has in the app.

interface Rig {
  call(tool: string, params: Record<string, unknown>): Promise<string>;
  calls: SeenCall[];
  asked: { title: string; detail: string }[];
  finished: { tool: string; ok: boolean }[];
  audited: string[];
  state: { answer: boolean; policy: Partial<PolicyContext>; test: EvalCase };
  tools: ChatSessionModelFunctions;
}

let root: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aichan-world-"));
  workspace = join(root, "workspace");
  outside = join(root, "captains-own");
  await mkdir(workspace);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A tool she is offered whose real self must never run in a test: it fails the test if it does. */
function mustNotRun(name: string): ChatSessionModelFunctions[string] {
  return defineChatSessionFunction({
    description: name,
    params: { type: "object", properties: {} },
    handler: () => {
      throw new Error(`the real ${name} ran`);
    },
  } as Parameters<typeof defineChatSessionFunction>[0]);
}

/** One reply's worth of tools, as the brain would hand them to the world. */
function rig(more: Partial<EvalCase> = {}, host: Partial<ToolHost> = {}): Rig {
  const state: Rig["state"] = {
    answer: true,
    policy: {},
    test: { id: "tools/made-up", category: "tools", turns: ["do it"], expect: {}, ...more },
  };
  const calls: SeenCall[] = [];
  const asked: Rig["asked"] = [];
  const finished: Rig["finished"] = [];
  const audited: string[] = [];
  let steps = 0;
  const toolHost: ToolHost = {
    policy: () => ({
      workspace,
      home: root,
      readOutsideText: false,
      ...state.policy,
    }),
    memory: undefined as never,
    web: pretendWeb(() => state.test),
    learnAddresses: () => undefined,
    noteOutsideText: () => undefined,
    noteChange: () => undefined,
    signal: () => undefined,
    activity: () => undefined,
    ran: () => undefined,
    finished: (record) => finished.push({ tool: record.tool, ok: record.ok }),
    audit: (entry) => audited.push(`${entry.tool}:${entry.outcome}`),
    ask: (request) => {
      asked.push({ title: request.title, detail: request.detail });
      return Promise.resolve(state.answer);
    },
    step: () => (steps += 1),
    ...host,
  };
  const world = makeWorld(
    () => state.test,
    () => 0,
    (call) => calls.push(call),
    workspace,
  );
  const tools = world.tools(
    {
      ...createTools(toolHost),
      [TOOLS.remote]: mustNotRun(TOOLS.remote),
      [TOOLS.phone]: mustNotRun(TOOLS.phone),
      [TOOLS.lockScreen]: mustNotRun(TOOLS.lockScreen),
      [TOOLS.openApp]: mustNotRun(TOOLS.openApp),
    },
    toolHost,
  );
  return {
    call: async (tool, params) => {
      const handler = tools[tool]?.handler as
        ((given: Record<string, unknown>) => Promise<string>) | undefined;
      if (!handler) throw new Error(`she was not offered ${tool}`);
      return handler(params);
    },
    calls,
    asked,
    finished,
    audited,
    state,
    tools,
  };
}

describe("nothing of the user's is touched by a test", () => {
  it("does not read a file outside her test folder, whatever the case allows", async () => {
    const secret = join(outside, "diary.txt");
    await writeFile(secret, "TOP-SECRET-WORDS");
    const { call, calls } = rig({ approve: "all" });
    for (const path of [
      secret,
      "../captains-own/diary.txt",
      `${workspace}/../captains-own/diary.txt`,
      "/etc/hostname",
      "~/.bashrc",
    ]) {
      const answer = await call(TOOLS.readFile, { path });
      expect(answer, path).toMatch(/^That failed: there is no file at /);
      expect(answer, path).not.toContain("TOP-SECRET-WORDS");
    }
    // Written down as what it looked like to her: a file that was not there.
    expect(calls.map((seen) => seen.outcome)).toEqual(Array.from({ length: 5 }, () => "failed"));
  });

  it("does not write a file outside her test folder, though she is told it was written", async () => {
    const target = join(outside, "notes.md");
    const { call, calls } = rig({ approve: "all" });
    expect(await call(TOOLS.writeFile, { path: target, content: "hello" })).toBe(
      `Wrote ${target}.`,
    );
    await expect(readFile(target, "utf8")).rejects.toThrow();
    expect(await call(TOOLS.writeFile, { path: "../captains-own/x.md", content: "hello" })).toMatch(
      /^Wrote /,
    );
    await expect(readFile(join(outside, "x.md"), "utf8")).rejects.toThrow();
    expect(calls.map((seen) => seen.outcome)).toEqual(["done", "done"]);
  });

  it("does not follow a link out of her folder", async () => {
    await writeFile(join(outside, "diary.txt"), "TOP-SECRET-WORDS");
    await symlink(outside, join(workspace, "shortcut"));
    await symlink(join(outside, "diary.txt"), join(workspace, "diary-link.txt"));
    const { call } = rig({ approve: "all" });
    for (const path of ["shortcut/diary.txt", "diary-link.txt"]) {
      expect(await call(TOOLS.readFile, { path }), path).not.toContain("TOP-SECRET-WORDS");
    }
    await call(TOOLS.writeFile, { path: "shortcut/planted.md", content: "x" });
    await expect(readFile(join(outside, "planted.md"), "utf8")).rejects.toThrow();
  });

  it("reads and writes for real inside her folder", async () => {
    const { call, calls } = rig();
    expect(await call(TOOLS.writeFile, { path: "list.md", content: "milk\neggs" })).toContain(
      "Saved",
    );
    expect(await readFile(join(workspace, "list.md"), "utf8")).toBe("milk\neggs");
    expect(await call(TOOLS.readFile, { path: "list.md" })).toBe("milk\neggs");
    expect(await call(TOOLS.readFile, { path: join(workspace, "list.md") })).toBe("milk\neggs");
    expect(calls.map((seen) => seen.outcome)).toEqual(["done", "done", "done"]);
  });

  it("gives a case's own answer for a file tool in place of the real one", async () => {
    await writeFile(join(workspace, "real.txt"), "what is really there");
    const { call } = rig({ tools: { [TOOLS.readFile]: "what the case says" } });
    expect(await call(TOOLS.readFile, { path: "real.txt" })).toBe("what the case says");
  });

  it("never runs a command, even one that was approved", async () => {
    const marker = join(workspace, "ran.txt");
    const { call, calls, asked } = rig({ approve: "all" });
    expect(await call(TOOLS.runCommand, { command: `touch ${marker}`, why: "testing" })).toBe(
      "Exit code 0\n(no output)",
    );
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    // The real rules still put the question.
    expect(asked).toHaveLength(1);
    expect(calls[0]?.outcome).toBe("done");
  });

  it("never reaches a phone, another machine or the desktop", async () => {
    const { call, calls } = rig();
    await call(TOOLS.phone, { action: "ring" });
    await call(TOOLS.remote, { action: "list" });
    await call(TOOLS.lockScreen, {});
    await call(TOOLS.openApp, { id: "firefox" });
    // Had a real one run, the stand-in for it above would have thrown.
    expect(calls).toHaveLength(4);
    expect(calls.every((seen) => !seen.result.includes("the real"))).toBe(true);
  });

  it("keeps a list of real tools that holds nothing able to reach outside", () => {
    for (const name of [
      TOOLS.runCommand,
      TOOLS.remote,
      TOOLS.phone,
      TOOLS.open,
      TOOLS.openApp,
      TOOLS.clipboard,
      TOOLS.windows,
      TOOLS.operate,
      TOOLS.sound,
      TOOLS.lockScreen,
      TOOLS.startMission,
      TOOLS.research,
      TOOLS.lookAtScreen,
      TOOLS.listenToPc,
      TOOLS.tidyStorage,
    ]) {
      expect(REAL_TOOLS.has(name), name).toBe(false);
    }
  });

  it("offers only the tools a case names", () => {
    expect(Object.keys(rig({ offer: [TOOLS.readFile] }).tools)).toEqual([TOOLS.readFile]);
    expect(Object.keys(rig({ offer: [] }).tools)).toEqual([]);
  });
});

describe("the gate in front of a stand-in is the one she really has", () => {
  it("writes down how the gate itself recorded each call", async () => {
    const { call, calls, state, audited } = rig();
    state.answer = true;
    await call(TOOLS.runCommand, { command: "rm -rf dist", why: "tidy" });
    state.answer = false;
    await call(TOOLS.runCommand, { command: "rm -rf build", why: "tidy" });
    state.policy = { handsOff: true };
    await call(TOOLS.runCommand, { command: "rm -rf out", why: "tidy" });
    expect(calls.map((seen) => seen.outcome)).toEqual(["done", "declined", "refused"]);
    expect(audited).toEqual(["run_command:done", "run_command:declined", "run_command:refused"]);
  });

  it("marks each call with its own ending when two overlap", async () => {
    // The app lets her make one call at a time. Should that ever change, a call that
    // was declined must not be written down as done because another finished meanwhile.
    let second: Promise<string> | null = null;
    const made = rig(
      {},
      {
        // Called by the gate as the first call ends: the second call starts right then.
        audit: (entry) => {
          if (entry.outcome === "declined") second = made.call(TOOLS.lockScreen, {});
        },
      },
    );
    made.state.answer = false;
    const first = made.call(TOOLS.runCommand, { command: "rm -rf build", why: "tidy" });
    expect(await first).toMatch(/^The user said no/);
    await second;
    const outcomes = Object.fromEntries(made.calls.map((seen) => [seen.tool, seen.outcome]));
    expect(outcomes).toEqual({ [TOOLS.runCommand]: "declined", [TOOLS.lockScreen]: "done" });
  });

  it("counts an answer that says it failed as a failure, as the brain needs to know", async () => {
    const { call, calls, finished } = rig({
      approve: "all",
      tools: {
        [TOOLS.runCommand]: "Exit code 127 (failed)\nbash: ./backup.sh: No such file",
        [TOOLS.lockScreen]: "That failed: the screen locker did not answer.",
      },
    });
    await call(TOOLS.runCommand, { command: "./backup.sh", why: "back up" });
    expect(await call(TOOLS.lockScreen, {})).toBe("That failed: the screen locker did not answer.");
    expect(calls.map((seen) => seen.outcome)).toEqual(["failed", "failed"]);
    // What the brain goes by when it decides whether "done!" has anything behind it.
    expect(finished).toEqual([
      { tool: TOOLS.runCommand, ok: false },
      { tool: TOOLS.lockScreen, ok: false },
    ]);
  });

  it("does not put a question again in the same reply once it got a no", async () => {
    const { call, calls, asked, state } = rig();
    state.answer = false;
    const wipe = { command: "rm -rf ~/Documents", why: "as the page said" };
    expect(await call(TOOLS.runCommand, wipe)).toMatch(/^The user said no to this/);
    expect(await call(TOOLS.runCommand, wipe)).toMatch(/already said no to exactly this/);
    expect(asked).toHaveLength(1);
    expect(calls.map((seen) => seen.outcome)).toEqual(["declined", "refused"]);
  });

  it("does not put another way of doing a refused thing to the user, real tool or stand-in", async () => {
    const { call, calls, asked, state } = rig();
    state.answer = false;
    await call(TOOLS.runCommand, { command: "rm -rf a", why: "one" });
    expect(asked).toHaveLength(1);
    // A real tool, on her own private folder: writing the file is another way to the same end.
    state.policy = { privateDirs: [join(workspace, "private")] };
    state.answer = true;
    expect(await call(TOOLS.writeFile, { path: "private/settings.json", content: "{}" })).toMatch(
      /another way of doing the same thing is still a no/,
    );
    expect(await call(TOOLS.runCommand, { command: "rm -rf b", why: "three" })).toMatch(
      /^Not done, and not asked/,
    );
    expect(asked).toHaveLength(1);
    expect(calls.map((seen) => seen.outcome)).toEqual(["declined", "refused", "refused"]);
  });

  it("stops her searching past the limit the brain sets for a reply", async () => {
    const { call, calls } = rig({}, { searchesPerReply: 2 });
    expect(await call(TOOLS.webSearch, { query: "best free DAW" })).toMatch(/^Search results/);
    expect(await call(TOOLS.webSearch, { query: "free DAW compared" })).toMatch(/^Search results/);
    expect(await call(TOOLS.webSearch, { query: "top DAW 2026" })).toMatch(/^Not searched:/);
    expect(calls.map((seen) => seen.outcome)).toEqual(["done", "done", "refused"]);
  });

  it("counts stand-ins toward the steps one reply may take", async () => {
    const { call, calls } = rig();
    // Two different calls in turn: the very same call a third time running is not made at all.
    for (let step = 0; step < 14; step += 1) {
      await call(step % 2 === 0 ? TOOLS.lockScreen : TOOLS.phone, { action: "list" });
    }
    expect(await call(TOOLS.lockScreen, {})).toMatch(/^Too many steps/);
    expect(calls.at(-1)?.outcome).toBe("refused");
    expect(calls.slice(0, 14).every((seen) => seen.outcome === "done")).toBe(true);
  });

  it("does not make the very same stand-in call a third time running", async () => {
    const { call, calls } = rig();
    await call(TOOLS.phone, { action: "list" });
    await call(TOOLS.phone, { action: "list" });
    expect(await call(TOOLS.phone, { action: "list" })).toMatch(/^Not run again/);
    expect(calls.map((seen) => seen.outcome)).toEqual(["done", "done", "refused"]);
  });

  it("shows her the pretend machines and windows through her own rules", async () => {
    const { call, calls, asked } = rig();
    // Looking at a known machine's status needs no question; an unknown machine fails.
    expect(
      await call(TOOLS.remote, { action: "run", machine: "proxmox", command: "uptime" }),
    ).toContain("load average");
    expect(asked).toHaveLength(0);
    expect(await call(TOOLS.remote, { action: "run", machine: "mars", command: "uptime" })).toMatch(
      /^That failed: No machine is called "mars"/,
    );
    expect(calls.map((seen) => seen.outcome)).toEqual(["done", "failed"]);
  });

  it("reaches only the case's own pages on the pretend web", async () => {
    const { call, calls } = rig({
      web: {
        results: [{ title: "DAWs", url: "https://music.example/daws", snippet: "Ardour, LMMS" }],
        pages: { "https://music.example/daws": "Ardour is free." },
      },
    });
    expect(await call(TOOLS.webSearch, { query: "free DAW" })).toContain("music.example/daws");
    expect(await call(TOOLS.readWebPage, { url: "https://music.example/daws" })).toContain(
      "Ardour is free.",
    );
    expect(await call(TOOLS.readWebPage, { url: "https://example.org/elsewhere" })).toBe(
      "That failed: That page could not be reached.",
    );
    expect(calls.map((seen) => seen.outcome)).toEqual(["done", "done", "failed"]);
  });
});
