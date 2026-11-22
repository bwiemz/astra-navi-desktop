import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainEvent } from "../src/shared/ipc.ts";
import { takeAwayMessage } from "../src/core/awayMessage.ts";
import { Brain } from "../src/core/brain.ts";
import { ConfigStore } from "../src/core/config.ts";
import type { LocalEngine } from "../src/core/engine.ts";
import type { EnvironmentFacts } from "../src/core/environment.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { AWAY_MARK, EVENT_MARK } from "../src/core/persona.ts";
import { Reach, type ReachDeps } from "../src/core/reach.ts";
import { type SaidWaiting, takeSaid } from "../src/renderer/src/conversation.ts";
import type { Sight } from "../src/core/sight.ts";
import type { PairedDevice, StationDeps, StationEvent } from "../src/core/station.ts";

/**
 * Messages from the user's other devices, end to end but for the model itself: what her
 * brain lets such a message set going, and what of her replies the station passes on.
 * The station is stood in for (no port is opened), and so is the window manager.
 */

interface StandInStation {
  deps: StationDeps;
  running: boolean;
  stopped: number;
  broadcasts: StationEvent[];
}

const made = vi.hoisted(() => ({
  stations: [] as unknown[],
  /** While set, a station being started waits for this. */
  gate: null as Promise<void> | null,
  /** While set, starting fails with this. */
  failure: null as Error | null,
}));

vi.mock("../src/core/station.ts", () => ({
  Station: class {
    deps: unknown;
    running = false;
    stopped = 0;
    broadcasts: unknown[] = [];
    constructor(deps: unknown) {
      this.deps = deps;
      made.stations.push(this);
    }
    async start(): Promise<void> {
      if (made.gate) await made.gate;
      if (made.failure) throw made.failure;
      this.running = true;
    }
    stop(): Promise<void> {
      this.running = false;
      this.stopped += 1;
      return Promise.resolve();
    }
    broadcast(event: unknown): void {
      this.broadcasts.push(event);
    }
    addresses(): string[] {
      return this.running ? ["https://192.168.1.20:47821"] : [];
    }
    devices(): unknown[] {
      return [];
    }
    fingerprint(): string | null {
      return null;
    }
  },
}));

const desk = vi.hoisted(() => ({ reportFrontWindow: vi.fn() }));
vi.mock("../src/core/desktop.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...desk,
}));

const stations = (): StandInStation[] => made.stations as StandInStation[];
const station = (): StandInStation => {
  const last = stations()[stations().length - 1];
  if (!last) throw new Error("no station was made");
  return last;
};

const PHONE: PairedDevice = {
  id: "phone-1",
  name: "Phone",
  pairedAt: "2026-11-21T10:00:00.000Z",
  lastSeenAt: null,
};

let root = "";
let folders = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-chan-away-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  made.stations.length = 0;
  made.gate = null;
  made.failure = null;
  desk.reportFrontWindow.mockReset();
});

// ---------- her reach: what the station is given ----------

interface ReachRig {
  reach: Reach;
  config: ConfigStore;
  problems: string[];
  taken: { text: string; device: PairedDevice }[];
  /** Whether the next message from a device is taken. */
  state: { taking: boolean };
  stops: number[];
  /** One entry for every time she said the station, or who is paired with it, had changed. */
  changes: number[];
}

function reachRig(): ReachRig {
  const dir = join(root, `reach-${(folders += 1)}`);
  const config = new ConfigStore(join(dir, "config.json"));
  const problems: string[] = [];
  const taken: ReachRig["taken"] = [];
  const state = { taking: true };
  const stops: number[] = [];
  const changes: number[] = [];
  const deps: ReachDeps = {
    config,
    sight: { readFrontWindow: () => Promise.resolve("") } as unknown as Sight,
    scriptDir: join(dir, "scratch"),
    modelsCacheDir: join(dir, "models"),
    handsScript: join(dir, "hands.py"),
    ownApps: ["ai-chan-desktop"],
    stationDir: join(dir, "station"),
    onNotice: () => undefined,
    onAwayMessage: (text, device) => {
      if (state.taking) taken.push({ text, device });
      return state.taking;
    },
    onAwayStop: () => stops.push(1),
    onProblem: (message) => problems.push(message),
    onStationChanged: () => changes.push(1),
  };
  return { reach: new Reach(deps), config, problems, taken, state, stops, changes };
}

/** One reply as her brain reports it, from the first thought to the last word. */
function reply(start: { away?: boolean; initiated?: boolean }, words: string): BrainEvent[] {
  return [
    {
      type: "status",
      state: "thinking",
      spoken: false,
      initiated: start.initiated === true,
      away: start.away === true,
    },
    { type: "reply-start" },
    { type: "mood", mood: "happy" },
    { type: "text", delta: words.slice(0, 5) },
    { type: "text", delta: words.slice(5) },
    { type: "reply-end" },
  ];
}
const IDLE: BrainEvent = { type: "status", state: "idle" };

describe("what the devices on the station are shown", () => {
  it("shows her answer to a message that came from a device, and keeps it for the next device", async () => {
    const { reach, taken } = reachRig();
    await reach.setStation(true);
    expect(station().deps.onSay("is the render done?", PHONE)).toBe(true);
    expect(taken).toEqual([{ text: "is the render done?", device: PHONE }]);
    for (const event of [...reply({ away: true }, "Not yet, Captain."), IDLE]) {
      reach.onBrainEvent(event);
    }
    expect(station().broadcasts).toEqual([
      { type: "status", state: "thinking" },
      { type: "reply-start" },
      { type: "mood", mood: "happy" },
      { type: "text", delta: "Not y" },
      { type: "text", delta: "et, Captain." },
      { type: "reply-end" },
      { type: "status", state: "idle" },
    ]);
    expect(station().deps.recent?.()).toEqual([
      { said: "is the render done?", reply: "Not yet, Captain.", at: expect.any(String) as string },
    ]);
  });

  it("shows nothing of what is said between her and whoever is at the PC", async () => {
    const { reach } = reachRig();
    await reach.setStation(true);
    const atThePc: BrainEvent[] = [
      ...reply({}, "Your bank statement says 1,204.16, Captain."),
      { type: "activity", label: "Reading a file" },
      {
        type: "permission",
        request: {
          id: "p1",
          title: "Run this command?",
          detail: "cat ~/statement.txt",
          note: null,
          sensitive: false,
          canRemember: false,
        },
      },
      { type: "caution", message: "She said that was done, but it was not." },
      IDLE,
    ];
    for (const event of atThePc) reach.onBrainEvent(event);
    expect(station().broadcasts).toEqual([]);
    expect(station().deps.recent?.()).toEqual([]);
  });

  it("stops showing again once a reply at the PC follows one to a device", async () => {
    const { reach } = reachRig();
    await reach.setStation(true);
    station().deps.onSay("hello", PHONE);
    for (const event of reply({ away: true }, "Hello from the ship!")) reach.onBrainEvent(event);
    const shown = station().broadcasts.length;
    // No idle in between: the next message was already waiting its turn.
    for (const event of [...reply({}, "Private words at the PC."), IDLE]) reach.onBrainEvent(event);
    expect(station().broadcasts).toHaveLength(shown);
    expect(station().deps.recent?.()).toHaveLength(1);
  });

  it("shows what she brings up herself, with nothing said before it", async () => {
    const { reach } = reachRig();
    await reach.setStation(true);
    for (const event of [...reply({ initiated: true }, "Captain, the oven!"), IDLE]) {
      reach.onBrainEvent(event);
    }
    expect(station().broadcasts.map((event) => event.type)).toEqual([
      "status",
      "reply-start",
      "mood",
      "text",
      "text",
      "reply-end",
      "status",
    ]);
    expect(station().deps.recent?.()).toEqual([
      { said: "", reply: "Captain, the oven!", at: expect.any(String) as string },
    ]);
  });

  it("puts each answer under the message it answers, in the order they were taken", async () => {
    const { reach, state } = reachRig();
    await reach.setStation(true);
    station().deps.onSay("first", PHONE);
    state.taking = false;
    expect(station().deps.onSay("turned away", PHONE)).toBe(false);
    state.taking = true;
    station().deps.onSay("second", PHONE);
    for (const event of reply({ away: true }, "Answer one.")) reach.onBrainEvent(event);
    // A reminder comes due between the two: it is nobody's message.
    for (const event of reply({ initiated: true }, "A reminder.")) reach.onBrainEvent(event);
    for (const event of reply({ away: true }, "Answer two.")) reach.onBrainEvent(event);
    expect(
      station()
        .deps.recent?.()
        .map(({ said, reply: hers }) => [said, hers]),
    ).toEqual([
      ["first", "Answer one."],
      ["", "A reminder."],
      ["second", "Answer two."],
    ]);
  });

  it("keeps the last ten exchanges, and none after a new conversation is started", async () => {
    const { reach } = reachRig();
    await reach.setStation(true);
    for (let count = 1; count <= 12; count++) {
      station().deps.onSay(`message ${count}`, PHONE);
      for (const event of reply({ away: true }, `Answer number ${count}.`)) {
        reach.onBrainEvent(event);
      }
    }
    const kept = station().deps.recent?.() ?? [];
    expect(kept).toHaveLength(10);
    expect(kept[0]?.said).toBe("message 3");
    expect(kept[9]?.said).toBe("message 12");
    station().deps.onSay("still waiting", PHONE);
    reach.forgetExchanges();
    expect(station().deps.recent?.()).toEqual([]);
    // The message that was waiting belonged to the old conversation too.
    for (const event of reply({ away: true }, "A fresh start.")) reach.onBrainEvent(event);
    expect(station().deps.recent?.()).toEqual([
      { said: "", reply: "A fresh start.", at: expect.any(String) as string },
    ]);
  });

  it("passes a device's stop on, and keeps a reply without words out of the record", async () => {
    const { reach, stops } = reachRig();
    await reach.setStation(true);
    station().deps.onStop(PHONE);
    expect(stops).toHaveLength(1);
    station().deps.onSay("hm", PHONE);
    for (const event of reply({ away: true }, "   ")) reach.onBrainEvent(event);
    expect(station().deps.recent?.()).toEqual([]);
  });
});

describe("switching the station and the watch on and off", () => {
  it("makes one station when asked twice at the same moment", async () => {
    const { reach } = reachRig();
    let open: () => void = () => undefined;
    made.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = reach.setStation(true);
    const second = reach.setStation(true);
    await Promise.resolve();
    open();
    await Promise.all([first, second]);
    expect(stations()).toHaveLength(1);
    expect(reach.station).toBe(station());
    expect(station().running).toBe(true);
  });

  it("ends up closed when switched off while it was still opening", async () => {
    const { reach } = reachRig();
    let open: () => void = () => undefined;
    made.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const opening = reach.setStation(true);
    const closing = reach.setStation(false);
    await Promise.resolve();
    expect(reach.station).toBeNull(); // not open yet, and not to be taken for open
    open();
    await Promise.all([opening, closing]);
    expect(stations()).toHaveLength(1);
    expect(reach.station).toBeNull();
    expect(station().running).toBe(false);
    expect(station().stopped).toBe(1);
  });

  it("ends up open when switched off and on again in quick succession", async () => {
    const { reach } = reachRig();
    await reach.setStation(true);
    const first = station();
    const off = reach.setStation(false);
    const on = reach.setStation(true);
    await Promise.all([off, on]);
    expect(first.stopped).toBe(1);
    expect(stations()).toHaveLength(2);
    expect(reach.station).toBe(station());
    expect(station().running).toBe(true);
  });

  it("reports a station that could not open, stays closed, and can be tried again", async () => {
    const { reach, problems } = reachRig();
    made.failure = new Error("Port 47821 is already in use by another program.");
    await expect(reach.setStation(true)).rejects.toThrow("Port 47821 is already in use");
    expect(reach.station).toBeNull();
    expect(problems).toEqual([
      "The station for other devices could not open: Port 47821 is already in use by another program.",
    ]);
    // A change that failed does not hold up the ones after it.
    made.failure = null;
    await reach.setStation(true);
    expect(reach.station?.running).toBe(true);
    expect(stations()).toHaveLength(2);
  });

  // The badge beside her counts the paired devices; it was only redrawn when a setting changed.
  it("says so when the station opens, when a device is paired or unpaired, and when it closes", async () => {
    const { reach, changes } = reachRig();
    await reach.setStation(true);
    expect(changes).toHaveLength(1);
    station().deps.onDevicesChanged?.();
    expect(changes).toHaveLength(2);
    await reach.setStation(false);
    expect(changes).toHaveLength(3);
    // Closing what is already closed changes nothing.
    await reach.setStation(false);
    expect(changes).toHaveLength(3);
  });

  it("does not say the station opened when it could not", async () => {
    const { reach, changes } = reachRig();
    made.failure = new Error("Port 47821 is already in use");
    await expect(reach.setStation(true)).rejects.toThrow();
    expect(changes).toEqual([]);
  });

  it("opens with the port the settings name, and passes nothing on while closed", async () => {
    const { reach, config } = reachRig();
    await config.update({ devices: { ...config.value.devices, stationPort: 50123 } });
    for (const event of reply({ away: true }, "Nobody to hear this.")) reach.onBrainEvent(event);
    await reach.setStation(true);
    expect(station().deps.port).toBe(50123);
    expect(station().broadcasts).toEqual([]);
    await reach.setStation(false);
    for (const event of reply({ away: true }, "Nor this.")) reach.onBrainEvent(event);
    expect(station().broadcasts).toEqual([]);
  });

  it("asks the window manager once when the watch is switched on twice at the same moment", async () => {
    const { reach } = reachRig();
    const follow = vi
      .spyOn(reach.hands, "followWindows")
      .mockResolvedValue({ bus: ":1.99", path: "/Watch", interface: "moe.aichan.Watch" });
    const unfollow = vi.spyOn(reach.hands, "unfollowWindows").mockResolvedValue(undefined);
    const stopReports = vi.fn(() => Promise.resolve());
    desk.reportFrontWindow.mockResolvedValue(stopReports);
    await Promise.all([reach.setWatching(true), reach.setWatching(true)]);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(desk.reportFrontWindow).toHaveBeenCalledTimes(1);
    expect(desk.reportFrontWindow.mock.calls[0]?.[1]).toEqual({
      bus: ":1.99",
      path: "/Watch",
      interface: "moe.aichan.Watch",
    });
    expect(reach.desktopExtras.watch?.()?.running).toBe(true);
    // Off while on, then on again at once: the old reports end before new ones begin.
    await Promise.all([reach.setWatching(false), reach.setWatching(true)]);
    expect(stopReports).toHaveBeenCalledTimes(1);
    expect(unfollow).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenCalledTimes(2);
    expect(stopReports.mock.invocationCallOrder[0]).toBeLessThan(
      follow.mock.invocationCallOrder[1] ?? 0,
    );
    await reach.setWatching(false);
    expect(reach.desktopExtras.watch?.()).toBeNull();
  });

  it("says why she cannot keep watch, and is not left half watching", async () => {
    const { reach, problems } = reachRig();
    vi.spyOn(reach.hands, "followWindows").mockRejectedValue(
      new Error("Following the window in front needs python-gobject, which is not installed."),
    );
    const unfollow = vi.spyOn(reach.hands, "unfollowWindows").mockResolvedValue(undefined);
    await expect(reach.setWatching(true)).rejects.toThrow(
      "She cannot keep watch on the screen: Following the window in front needs python-gobject",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^She cannot keep watch on the screen: /);
    expect(reach.desktopExtras.watch?.()).toBeNull();
    expect(unfollow).toHaveBeenCalledTimes(1);
    expect(reach.screen.next()).toBe("");
  });
});

// ---------- her brain: what a message from a device may set going ----------

interface Prompted {
  text: string;
  functions: Record<string, { handler(input: unknown): Promise<string> }>;
  say(words: string): void;
}

interface BrainRig {
  brain: Brain;
  config: ConfigStore;
  events: BrainEvent[];
  prompts: Prompted[];
  /** What each prompt does before her reply is taken as finished. */
  script: { onPrompt(prompt: Prompted): Promise<void> | void };
  decide: ReturnType<typeof vi.fn>;
  look: ReturnType<typeof vi.fn>;
}

function brainRig(listener?: (event: BrainEvent) => void): BrainRig {
  const dir = join(root, `brain-${(folders += 1)}`);
  const config = new ConfigStore(join(dir, "config.json"));
  const events: BrainEvent[] = [];
  const prompts: Prompted[] = [];
  const script: BrainRig["script"] = { onPrompt: () => undefined };
  const decide = vi.fn(() => Promise.resolve({ claimed: { value: 0 } }));
  const look = vi.fn(() => Promise.resolve({ description: "a desk", text: "secret" }));
  const session = {
    prompt: async (
      text: string,
      options: { functions: Prompted["functions"]; onTextChunk(chunk: string): void },
    ): Promise<string> => {
      const prompt: Prompted = {
        text,
        functions: options.functions,
        say: (words) => options.onTextChunk(words),
      };
      prompts.push(prompt);
      await script.onPrompt(prompt);
      return "";
    },
    decide,
  };
  // Everything else her brain asks of the engine (history, unloading, resting) is a no-op.
  const engine = new Proxy(
    { getHistory: () => [], session: () => Promise.resolve(session) } as Record<string, unknown>,
    {
      get: (target, key: string) =>
        key === "then" ? undefined : (target[key] ?? ((): undefined => undefined)),
    },
  );
  const environment: EnvironmentFacts = {
    userName: "tester",
    home: dir,
    workspace: join(dir, "workspace"),
    osName: "Linux",
    desktop: "KDE Plasma",
    commands: new Set(),
  };
  const brain = new Brain({
    config,
    memory: new MemoryStore(join(dir, "memory.json")),
    environment,
    engine: engine as unknown as LocalEngine,
    historyFile: join(dir, "conversation.json"),
    desktop: {
      sight: { lookAtScreen: look } as unknown as Sight,
      scriptDir: join(dir, "scratch"),
    },
    emit: (event) => {
      events.push(event);
      listener?.(event);
    },
  });
  return { brain, config, events, prompts, script, decide, look };
}

// A command the rules always ask about. It names a folder that does not exist, so it
// could change nothing even if it were ever let through.
const NEEDS_ASKING = { command: "touch /nonexistent-ai-chan-test/marker", why: "a trial" };

describe("a message from another device", () => {
  let open: BrainRig | null = null;
  afterEach(async () => {
    await open?.brain.dispose();
    open = null;
  });

  it("is marked as such to her, and is told that nobody is at the PC when it needs a yes", async () => {
    const rig = (open = brainRig());
    await rig.config.update({ sight: { ...rig.config.value.sight, withoutAsking: true } });
    const results: string[] = [];
    rig.script.onPrompt = async (prompt) => {
      const run = prompt.functions[TOOLS.runCommand];
      const see = prompt.functions[TOOLS.lookAtScreen];
      if (!run || !see) throw new Error("her tools were not handed over");
      results.push(await run.handler(NEEDS_ASKING));
      // "She may look without asking" is for whoever is at the PC.
      results.push(await see.handler({}));
      results.push(await see.handler({ when: "earlier" }));
    };
    expect(rig.brain.send("tidy up for me", { away: true })).toBe(true);
    await rig.brain.whenIdle();

    expect(rig.prompts).toHaveLength(1);
    expect(rig.prompts[0]?.text.startsWith(`${AWAY_MARK} tidy up for me`)).toBe(true);
    expect(rig.events[0]).toEqual({
      type: "status",
      state: "thinking",
      spoken: false,
      initiated: false,
      away: true,
    });
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toMatch(/^Not done\. This needs Captain's say-so on the PC's own screen/);
    }
    // Nothing was put on the PC's screen for a passer-by to wave through, and nothing ran.
    expect(rig.events.some((event) => event.type === "permission")).toBe(false);
    expect(rig.look).not.toHaveBeenCalled();
  });

  it("leaves a message typed at the PC as it always was: the question goes on screen", async () => {
    const rig = (open = brainRig());
    let result = "";
    rig.script.onPrompt = async (prompt) => {
      const run = prompt.functions[TOOLS.runCommand];
      if (!run) throw new Error("her tools were not handed over");
      const running = run.handler(NEEDS_ASKING);
      await vi.waitFor(() =>
        expect(rig.events.some((event) => event.type === "permission")).toBe(true),
      );
      const question = rig.events.find((event) => event.type === "permission");
      if (question?.type === "permission") rig.brain.answerPermission(question.request.id, "deny");
      result = await running;
    };
    rig.brain.send("tidy up for me");
    await rig.brain.whenIdle();
    expect(rig.prompts[0]?.text.startsWith("tidy up for me")).toBe(true);
    expect(rig.events[0]).toMatchObject({ type: "status", state: "thinking", away: false });
    expect(result).toMatch(/^The user said no to this\./);
  });

  it("does not carry its standing over to the message answered next", async () => {
    const rig = (open = brainRig());
    const seen: boolean[] = [];
    rig.script.onPrompt = async (prompt) => {
      const run = prompt.functions[TOOLS.runCommand];
      if (!run) throw new Error("her tools were not handed over");
      const before = rig.events.filter((event) => event.type === "permission").length;
      const running = run.handler(NEEDS_ASKING);
      // Either it is turned away at once, or a question appears and is answered no.
      const outcome = await Promise.race([
        running.then(() => "answered" as const),
        vi
          .waitFor(() =>
            expect(rig.events.filter((event) => event.type === "permission").length).toBe(
              before + 1,
            ),
          )
          .then(() => "asked" as const),
      ]);
      seen.push(outcome === "asked");
      if (outcome === "asked") {
        const questions = rig.events.filter((event) => event.type === "permission");
        const last = questions[questions.length - 1];
        if (last?.type === "permission") rig.brain.answerPermission(last.request.id, "deny");
        await running;
      }
    };
    rig.brain.send("from the phone", { away: true });
    rig.brain.send("typed at the PC");
    rig.brain.send("from the phone again", { away: true });
    await rig.brain.whenIdle();
    expect(seen).toEqual([false, true, false]);
    const starts = rig.events.filter(
      (event) => event.type === "status" && event.state === "thinking",
    );
    expect(starts.map((event) => (event.type === "status" ? event.away : null))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("is turned away once three from devices are already waiting their turn", async () => {
    const rig = (open = brainRig());
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig.script.onPrompt = () => held;
    expect(rig.brain.send("typed at the PC, being answered now")).toBe(true);
    expect(rig.brain.send("one", { away: true })).toBe(true);
    expect(rig.brain.send("two", { away: true })).toBe(true);
    expect(rig.brain.send("three", { away: true })).toBe(true);
    expect(rig.brain.send("four", { away: true })).toBe(false);
    expect(rig.brain.send("five", { away: true })).toBe(false);
    // Whoever is at the PC is never turned away for it.
    expect(rig.brain.send("typed at the PC meanwhile")).toBe(true);
    expect(rig.brain.send("spoken at the PC meanwhile", { spoken: true })).toBe(true);
    expect(rig.brain.send("   ", { away: true })).toBe(false);
    release();
    await rig.brain.whenIdle();
    // Everything that was taken was answered, in order; the two turned away never were.
    expect(rig.prompts.map((prompt) => prompt.text.split("\n")[0])).toEqual([
      "typed at the PC, being answered now",
      `${AWAY_MARK} one`,
      `${AWAY_MARK} two`,
      `${AWAY_MARK} three`,
      "typed at the PC meanwhile",
      "[voice] spoken at the PC meanwhile",
    ]);
    // With the line clear again, a device is heard as before.
    expect(rig.brain.send("six", { away: true })).toBe(true);
    await rig.brain.whenIdle();
  });

  it("gives her no hands in other programs unless that has been switched on", async () => {
    const rig = (open = brainRig());
    rig.brain.send("press play", { away: true });
    await rig.brain.whenIdle();
    expect(Object.keys(rig.prompts[0]?.functions ?? {})).not.toContain(TOOLS.operate);
  });
});

describe("her reply put right, and who gets to see it", () => {
  let open: BrainRig | null = null;
  afterEach(async () => {
    await open?.brain.dispose();
    open = null;
  });

  /** Runs a message whose first reply claims something no tool did, so it is put right. */
  async function claimThenCorrect(away: boolean): Promise<{ rig: BrainRig; reach: ReachRig }> {
    const reach = reachRig();
    await reach.reach.setStation(true);
    const rig = (open = brainRig((event) => reach.reach.onBrainEvent(event)));
    rig.decide.mockResolvedValue({ claimed: { value: 0.95 } });
    rig.script.onPrompt = (prompt) => {
      prompt.say(
        prompt.text.startsWith(EVENT_MARK)
          ? "[[worried]] Sorry Captain, that was not done. Shall I set it now?"
          : "[[happy]] Timer set for ten minutes, Captain!",
      );
    };
    if (away) station().deps.onSay("set a timer for ten minutes", PHONE);
    rig.brain.send("set a timer for ten minutes", { away });
    await rig.brain.whenIdle();
    expect(rig.prompts).toHaveLength(2); // the reply, then the correction
    return { rig, reach };
  }

  it("lets the device that asked see the correction too", async () => {
    const { rig } = await claimThenCorrect(true);
    const starts = rig.events.filter(
      (event) => event.type === "status" && event.state === "thinking",
    );
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ initiated: true, away: true });
    const words = station()
      .broadcasts.filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.delta : ""))
      .join("");
    expect(words).toContain("Timer set for ten minutes");
    expect(words).toContain("that was not done");
  });

  // Source bug (brain.ts runTurn, the status event; reach.ts onBrainEvent): a correction is
  // queued as an event, so its "thinking" status goes out with `initiated: true`, and the
  // station forwards every reply whose status says so. When the reply being put right was
  // to a message typed at the PC, her second attempt at that PC conversation is shown on
  // every paired device and kept in the list a newly connected device is sent.
  it("keeps a correction of something said at the PC at the PC", async () => {
    await claimThenCorrect(false);
    expect(station().broadcasts).toEqual([]);
    expect(station().deps.recent?.()).toEqual([]);
  });
});

describe("a message from another device, as her window comes to hear of it", () => {
  let open: BrainRig | null = null;
  afterEach(async () => {
    await open?.brain.dispose();
    open = null;
  });

  // Her brain starts on a message before `send` returns. The message used to be shown
  // only after that, so her window had nothing to match the reply to: the reply was
  // logged with no words above it, and the words went to the next reply instead.
  it("is shown at the PC before her reply to it starts, when she was idle", async () => {
    const order: string[] = [];
    const rig = (open = brainRig((event) => {
      if (event.type === "status") order.push(`status:${event.state}`);
    }));
    const taken = takeAwayMessage(rig.brain, "is the render done?", () => order.push("heard"));
    expect(taken).toBe(true);
    // Both have happened by the time the call returns, and in this order.
    expect(order).toEqual(["heard", "status:thinking"]);
    await rig.brain.whenIdle();
    expect(rig.prompts.map((prompt) => prompt.text.split("\n")[0])).toEqual([
      `${AWAY_MARK} is the render done?`,
    ]);
  });

  it("is matched by her window to the reply that answers it", async () => {
    // Her window's own reckoning, fed in the order the app really sends things.
    const waiting: SaidWaiting = { here: [], away: [] };
    const matched: (string | null)[] = [];
    const rig = (open = brainRig((event) => {
      if (event.type === "status" && event.state === "thinking") {
        matched.push(takeSaid(waiting, event, Date.now()).said);
      }
    }));
    const heard = (text: string) => (): void => {
      waiting.away.push({ text, at: Date.now(), from: "Pixel" });
    };
    expect(takeAwayMessage(rig.brain, "first", heard("first"))).toBe(true);
    await rig.brain.whenIdle();
    expect(takeAwayMessage(rig.brain, "second", heard("second"))).toBe(true);
    await rig.brain.whenIdle();
    expect(matched).toEqual(["first", "second"]);
    expect(waiting.away).toEqual([]);
  });

  it("is not shown at all when she will not take it", async () => {
    const rig = (open = brainRig());
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig.script.onPrompt = () => held;
    const shown: string[] = [];
    const show = (text: string) => (): void => void shown.push(text);
    rig.brain.send("typed at the PC, being answered now");
    for (const text of ["one", "two", "three", "four"]) {
      expect(takeAwayMessage(rig.brain, text, show(text))).toBe(text !== "four");
    }
    expect(takeAwayMessage(rig.brain, "   ", show("blank"))).toBe(false);
    expect(takeAwayMessage(null, "nobody home", show("nobody home"))).toBe(false);
    expect(shown).toEqual(["one", "two", "three"]);
    // Asking whether she would take one takes nothing.
    expect(rig.brain.wouldTake("five", { away: true })).toBe(false);
    expect(rig.brain.wouldTake("typed at the PC")).toBe(true);
    release();
    await rig.brain.whenIdle();
    expect(rig.prompts).toHaveLength(4);
  });
});

describe("how a question is reported to have ended", () => {
  let open: BrainRig | null = null;
  afterEach(async () => {
    await open?.brain.dispose();
    open = null;
  });

  /** Runs one reply that asks one question, and settles it the way `settle` says. */
  async function ask(
    rig: BrainRig,
    settle: (id: string) => void,
  ): Promise<{ allowed: boolean | null; result: string }> {
    let result = "";
    rig.script.onPrompt = async (prompt) => {
      const run = prompt.functions[TOOLS.runCommand];
      if (!run) throw new Error("her tools were not handed over");
      const running = run.handler(NEEDS_ASKING);
      await vi.waitFor(() =>
        expect(rig.events.some((event) => event.type === "permission")).toBe(true),
      );
      const question = rig.events.find((event) => event.type === "permission");
      if (question?.type === "permission") settle(question.request.id);
      result = await running;
    };
    rig.brain.send("tidy up for me");
    await rig.brain.whenIdle();
    const resolved = rig.events.find((event) => event.type === "permission-resolved");
    return {
      allowed: resolved?.type === "permission-resolved" ? resolved.allowed : null,
      result,
    };
  }

  it("says no when the user said no", async () => {
    const rig = (open = brainRig());
    const { allowed, result } = await ask(rig, (id) => rig.brain.answerPermission(id, "deny"));
    expect(allowed).toBe(false);
    expect(result).toMatch(/^The user said no to this\./);
  });

  it("says yes when the user said yes, once or for the chat", async () => {
    for (const decision of ["allow", "allow-session"] as const) {
      const rig = (open = brainRig());
      const { allowed } = await ask(rig, (id) => rig.brain.answerPermission(id, decision));
      expect(allowed, decision).toBe(true);
      await rig.brain.dispose();
    }
  });

  // The window records "allow" the moment the button is pressed. If her reply was
  // stopped just before, the question had already been answered no on the user's
  // behalf: the trail goes by this event, so it must say what really happened.
  it("says no when the reply was stopped first, though yes was pressed after", async () => {
    const rig = (open = brainRig());
    const { allowed, result } = await ask(rig, (id) => {
      rig.brain.interrupt();
      rig.brain.answerPermission(id, "allow");
    });
    expect(allowed).toBe(false);
    expect(result).toMatch(/^The user said no to this\./);
    // One report per question, however many answers arrive.
    expect(rig.events.filter((event) => event.type === "permission-resolved")).toHaveLength(1);
  });
});
