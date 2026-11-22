import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Hands,
  HandsRefusal,
  NoControls,
  NoSuchControl,
  parseKeys,
  SeveralControls,
  type WindowSeen,
} from "../src/core/hands.ts";

// The one program the client runs by itself: busctl, to put the desktop's accessibility
// switch back when the helper could not. Stood in for, so the real switch is never touched.
const ran = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: ran.execFile,
}));

const SWITCH_OFF = [
  "busctl",
  [
    "--user",
    "set-property",
    "org.a11y.Bus",
    "/org/a11y/bus",
    "org.a11y.Status",
    "IsEnabled",
    "b",
    "false",
  ],
];

/** A stand-in for the helper: records what it is sent and says what the test tells it to. */
class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Record<string, unknown>[] = [];
  readonly kill = vi.fn();
  inputEnded = false;
  /** When set, every request is answered at once by this. */
  auto: ((request: Record<string, unknown>) => Record<string, unknown> | null) | null = null;
  /** Leave after its input is closed, the way the real helper does. */
  leavesWhenClosed = true;

  constructor() {
    super();
    let pending = "";
    this.stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end = pending.indexOf("\n");
      while (end !== -1) {
        const request = JSON.parse(pending.slice(0, end)) as Record<string, unknown>;
        pending = pending.slice(end + 1);
        this.requests.push(request);
        const answer = this.auto?.(request);
        if (answer) this.say({ id: request["id"], ...answer });
        end = pending.indexOf("\n");
      }
    });
    this.stdin.on("end", () => {
      this.inputEnded = true;
      if (this.leavesWhenClosed) this.emit("exit", 0);
    });
  }

  say(message: unknown): void {
    this.stdout.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  last(): Record<string, unknown> {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error("the helper was sent nothing");
    return request;
  }
}

function setup(restAfterMs?: number): {
  hands: Hands;
  helpers: FakeHelper[];
  started: { python: string; script: string }[];
  current(): FakeHelper;
} {
  const helpers: FakeHelper[] = [];
  const started: { python: string; script: string }[] = [];
  const hands = new Hands({
    script: "/opt/ai-chan/hands/hands.py",
    restAfterMs,
    start: (python, script) => {
      started.push({ python, script });
      const helper = new FakeHelper();
      helpers.push(helper);
      return helper as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const current = (): FakeHelper => {
    const helper = helpers[helpers.length - 1];
    if (!helper) throw new Error("no helper was started");
    return helper;
  };
  return { hands, helpers, started, current };
}

/** Lets the streams carry what was written, under real or fake timers alike. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const TARGET = { pid: 4242, title: "notes.txt — Kate" };

describe("her hands' helper", () => {
  const before = process.env["AI_CHAN_REHEARSE_DESKTOP"];
  beforeEach(() => {
    delete process.env["AI_CHAN_REHEARSE_DESKTOP"];
    ran.execFile.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (before === undefined) delete process.env["AI_CHAN_REHEARSE_DESKTOP"];
    else process.env["AI_CHAN_REHEARSE_DESKTOP"] = before;
  });

  it("is only started when first needed, with the desktop's own Python", async () => {
    const { hands, started, current } = setup();
    expect(started).toHaveLength(0);
    const asked = hands.abilities();
    await flush();
    expect(started).toEqual([{ python: "python3", script: "/opt/ai-chan/hands/hands.py" }]);
    expect(current().last()).toMatchObject({ op: "hello", rehearse: false });
    expect(typeof current().last()["id"]).toBe("number");
    current().say({
      id: current().last()["id"],
      ok: true,
      controls: true,
      controlsProblem: "",
      input: false,
    });
    expect(await asked).toEqual({ controls: true, controlsProblem: "", input: false });
    await hands.dispose();
  });

  it("sends each step as one line carrying what it needs", async () => {
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: true });
    await hands.pointer(0.25, 0.5, { button: "left", clicks: 2 });
    expect(current().last()).toMatchObject({
      op: "pointer",
      x: 0.25,
      y: 0.5,
      button: "left",
      clicks: 2,
      rehearse: false,
    });
    await hands.pointer(0.1, 0.2);
    expect(current().last()).not.toHaveProperty("button");
    await hands.scroll(-3);
    expect(current().last()).toMatchObject({ op: "scroll", notches: -3 });
    await hands.keys(["ctrl", "s"], 2);
    expect(current().last()).toMatchObject({ op: "key", keys: ["ctrl", "s"], times: 2 });
    await hands.keys(["enter"]);
    expect(current().last()).toMatchObject({ op: "key", keys: ["enter"], times: 1 });
    // Every request has its own number.
    const ids = current().requests.map((request) => request["id"]);
    expect(new Set(ids).size).toBe(ids.length);
    await hands.dispose();
  });

  it("matches answers to questions by number, in whatever order they come back", async () => {
    const { hands, current } = setup();
    const first = hands.press(TARGET, { name: "Save" });
    const second = hands.press(TARGET, { name: "Open" });
    await flush();
    const [a, b] = current().requests;
    expect(a).toMatchObject({ op: "press", pid: 4242, title: "notes.txt — Kate", name: "Save" });
    expect(b).toMatchObject({ op: "press", name: "Open" });
    current().say({ id: b?.["id"], ok: true, pressed: { kind: "button", name: "Open" } });
    current().say({
      id: a?.["id"],
      ok: true,
      pressed: { kind: "checkbox", name: "Save" },
      on: true,
    });
    expect(await second).toEqual({ kind: "button", name: "Open" });
    expect(await first).toEqual({ kind: "checkbox", name: "Save", on: true });
    await hands.dispose();
  });

  it("reads a list of controls, dropping anything malformed", async () => {
    const { hands, current } = setup();
    const listing = hands.controls(TARGET, "save");
    await flush();
    expect(current().last()).toMatchObject({ op: "controls", pid: 4242, name: "save" });
    current().say({
      id: current().last()["id"],
      ok: true,
      window: "notes.txt — Kate",
      controls: [
        { n: 1, kind: "button", name: "Save", greyed: true },
        { n: "2", kind: "button", name: "bad number" },
        "nonsense",
        { n: 3, kind: "field", name: "Name", value: "x" },
      ],
      more: 4,
      text: ["Ready", 7, "Line 1"],
    });
    expect(await listing).toEqual({
      window: "notes.txt — Kate",
      controls: [
        { n: 1, kind: "button", name: "Save", greyed: true },
        { n: 3, kind: "field", name: "Name", value: "x" },
      ],
      more: 4,
      text: ["Ready", "Line 1"],
    });
    await hands.dispose();
  });

  it("reads back what a field holds after filling it", async () => {
    const { hands, current } = setup();
    const filling = hands.fill(TARGET, { name: "Name" }, "Bo");
    await flush();
    expect(current().last()).toMatchObject({ op: "fill", name: "Name", text: "Bo", pid: 4242 });
    current().say({ id: current().last()["id"], ok: true, filled: "Name", now: "Bo" });
    expect(await filling).toEqual({ field: "Name", now: "Bo" });
    await hands.dispose();
  });

  it("tells apart the ways a step can be turned down", async () => {
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    const refuse = (error: string) => (): Record<string, unknown> => ({ ok: false, error });

    current().auto = refuse("BARE");
    await expect(hands.controls(TARGET)).rejects.toBeInstanceOf(NoControls);

    current().auto = refuse("NOMATCH");
    await expect(hands.press(TARGET, { name: "x" })).rejects.toBeInstanceOf(NoSuchControl);

    current().auto = refuse(
      `SEVERAL ${JSON.stringify([
        { n: 1, kind: "button", name: "Open" },
        { n: 2, kind: "menu item", name: "Open", hidden: true },
        { bad: true },
      ])}`,
    );
    const several = await hands.press(TARGET, { name: "Open" }).catch((error: unknown) => error);
    expect(several).toBeInstanceOf(SeveralControls);
    expect((several as SeveralControls).choices).toEqual([
      { n: 1, kind: "button", name: "Open" },
      { n: 2, kind: "menu item", name: "Open", hidden: true },
    ]);

    current().auto = refuse("SEVERAL not json");
    const garbled = await hands.press(TARGET, { name: "Open" }).catch((error: unknown) => error);
    expect(garbled).toBeInstanceOf(HandsRefusal);
    expect(garbled).not.toBeInstanceOf(SeveralControls);

    current().auto = refuse('The button "Save" is greyed out right now.');
    const plain = await hands.press(TARGET, { name: "Save" }).catch((error: unknown) => error);
    expect(plain).toBeInstanceOf(HandsRefusal);
    expect(plain).not.toBeInstanceOf(NoControls);
    expect((plain as Error).message).toBe('The button "Save" is greyed out right now.');

    current().auto = () => ({ ok: false });
    await expect(hands.scroll(1)).rejects.toThrow("It did not work.");
    await hands.dispose();
  });

  it("passes on the window manager's reports, and drops ones it cannot read", async () => {
    const { hands, current } = setup();
    const seen: WindowSeen[] = [];
    const following = hands.followWindows((window) => seen.push(window));
    await flush();
    expect(current().last()).toMatchObject({ op: "watch" });
    current().say({
      id: current().last()["id"],
      ok: true,
      bus: ":1.77",
      path: "/Watch",
      interface: "moe.aichan.Watch",
    });
    expect(await following).toEqual({
      bus: ":1.77",
      path: "/Watch",
      interface: "moe.aichan.Watch",
    });

    current().say({
      event: "window",
      seen: {
        id: "{w1}",
        app: "org.kde.kate",
        title: "notes.txt — Kate",
        pid: 4242,
        fullScreen: false,
        dialog: true,
        width: 640,
        height: 480,
      },
    });
    current().say("this is not json");
    current().say({ event: "window", seen: { app: "no id" } });
    current().say({ event: "window", seen: "nonsense" });
    current().say({ event: "window", seen: { id: "{w2}", app: "x".repeat(500), title: 5 } });
    current().say({ id: 9999, ok: true }); // an answer to nothing
    current().say([1, 2, 3]);
    await flush();
    expect(seen).toEqual([
      {
        id: "{w1}",
        app: "org.kde.kate",
        title: "notes.txt — Kate",
        pid: 4242,
        fullScreen: false,
        dialog: true,
        width: 640,
        height: 480,
      },
      {
        id: "{w2}",
        app: "x".repeat(120),
        title: "",
        pid: -1,
        fullScreen: false,
        dialog: false,
        width: 0,
        height: 0,
      },
    ]);
    await hands.dispose();
  });

  it("fails to follow windows when the helper gives no address", async () => {
    const { hands, current } = setup();
    const following = hands.followWindows(() => undefined);
    await flush();
    current().say({ id: current().last()["id"], ok: true });
    await expect(following).rejects.toThrow("The helper gave no address.");
    await hands.dispose();
  });

  it("gives up on a step the program never answers, and ends the helper that was working on it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hands, helpers, current } = setup();
    const pressing = hands.press(TARGET, { name: "Save" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(19_000);
    await flush();
    expect(current().requests).toHaveLength(1);
    expect(current().kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(((await pressing) as Error).message).toBe("The program did not answer in time.");
    // She has been told the step failed, so the helper that may still be working on it
    // is ended: it must not press the button a minute from now.
    expect(current().kill).toHaveBeenCalledTimes(1);
    expect(current().kill).toHaveBeenCalledWith("SIGKILL");
    // A late answer to the abandoned step is ignored.
    const stuck = current();
    stuck.say({ id: stuck.last()["id"], ok: true, pressed: { kind: "button", name: "Save" } });
    await flush();
    stuck.emit("exit", null);
    vi.useRealTimers();
    // The next step gets a helper of its own.
    const again = hands.scroll(1);
    await flush();
    expect(helpers).toHaveLength(2);
    current().say({ id: current().last()["id"], ok: true });
    await expect(again).resolves.toBeUndefined();
    await hands.dispose();
  });

  it("tells the helper until when each step is wanted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
    const { hands, current } = setup();
    const noon = Date.parse("2026-11-21T12:00:00Z") / 1000;
    void hands.press(TARGET, { name: "Save" }).catch(() => undefined);
    await flush();
    // Twenty seconds for a step, in seconds since 1970: the helper refuses it after that.
    expect(current().last()["deadline"]).toBeCloseTo(noon + 20, 3);
    void hands.abilities().catch(() => undefined);
    await flush();
    expect(current().last()["deadline"]).toBeCloseTo(noon + 8, 3);
    vi.useRealTimers();
    await hands.dispose();
  });

  it("takes the helper's word that a step came too late as the step not answering", async () => {
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: false, error: "LATE" });
    const late = await hands.press(TARGET, { name: "Save" }).catch((error: unknown) => error);
    expect((late as Error).message).toBe("The program did not answer in time.");
    expect(late).not.toBeInstanceOf(HandsRefusal);
    await hands.dispose();
  });

  it("knows a near miss from a real match", async () => {
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({
      ok: false,
      error: `CLOSEST ${JSON.stringify([{ n: 1, kind: "button", name: "Send message" }])}`,
    });
    const near = await hands.press(TARGET, { name: "mess" }).catch((error: unknown) => error);
    expect(near).toBeInstanceOf(SeveralControls);
    expect((near as SeveralControls).exact).toBe(false);
    expect((near as SeveralControls).choices).toEqual([
      { n: 1, kind: "button", name: "Send message" },
    ]);
    current().auto = () => ({
      ok: false,
      error: `SEVERAL ${JSON.stringify([{ n: 1, kind: "button", name: "Open" }])}`,
    });
    const several = await hands.press(TARGET, { name: "Open" }).catch((error: unknown) => error);
    expect((several as SeveralControls).exact).toBe(true);
    current().auto = () => ({ ok: false, error: "CLOSEST not json" });
    const garbled = await hands.press(TARGET, { name: "x" }).catch((error: unknown) => error);
    expect(garbled).toBeInstanceOf(HandsRefusal);
    expect(garbled).not.toBeInstanceOf(SeveralControls);
    await hands.dispose();
  });

  it("puts the accessibility switch back when the helper dies with it on", async () => {
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: true, switchOn: true, controls: [], more: 0, text: [] });
    await hands.controls(TARGET);
    expect(ran.execFile).not.toHaveBeenCalled();
    current().emit("exit", 1);
    expect(ran.execFile).toHaveBeenCalledTimes(1);
    expect(ran.execFile.mock.calls[0]?.slice(0, 2)).toEqual(SWITCH_OFF);
    // Once is enough: the next helper to die had not switched it on.
    void hands.abilities().catch(() => undefined);
    await flush();
    current().emit("exit", 1);
    expect(ran.execFile).toHaveBeenCalledTimes(1);
    await hands.dispose();
  });

  it("leaves the switch alone when the helper had already put it back", async () => {
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: true, switchOn: true, controls: [], more: 0, text: [] });
    await hands.controls(TARGET);
    current().auto = () => ({ ok: true, switchOn: false });
    await hands.scroll(1);
    current().emit("exit", 1);
    expect(ran.execFile).not.toHaveBeenCalled();
    await hands.dispose();
  });

  it("puts the switch back for a helper that had to be ended after a step ran out of time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: true, switchOn: true, controls: [], more: 0, text: [] });
    await hands.controls(TARGET);
    current().auto = null;
    const pressing = hands.press(TARGET, { name: "Save" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_500);
    await pressing;
    expect(current().kill).toHaveBeenCalledWith("SIGKILL");
    current().emit("exit", null); // what being killed looks like
    expect(ran.execFile).toHaveBeenCalledTimes(1);
    expect(ran.execFile.mock.calls[0]?.slice(0, 2)).toEqual(SWITCH_OFF);
    vi.useRealTimers();
    await hands.dispose();
  });

  it("puts the switch back for a helper that would not leave when put away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: true, switchOn: true, controls: [], more: 0, text: [] });
    await hands.controls(TARGET);
    current().auto = null;
    current().leavesWhenClosed = false;
    const resting = hands.rest();
    await flush();
    await vi.advanceTimersByTimeAsync(2600);
    await resting;
    expect(current().kill).toHaveBeenCalledWith("SIGKILL");
    expect(ran.execFile).toHaveBeenCalledTimes(1);
    expect(ran.execFile.mock.calls[0]?.slice(0, 2)).toEqual(SWITCH_OFF);
    vi.useRealTimers();
  });

  it("trusts a helper that left by itself to have put the switch back", async () => {
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: true, switchOn: true, controls: [], more: 0, text: [] });
    await hands.controls(TARGET);
    await hands.rest(); // closes its input; the helper tidies up and goes
    expect(ran.execFile).not.toHaveBeenCalled();
  });

  it("fails everything it was waiting for when the helper dies, then starts a fresh one", async () => {
    const { hands, helpers, current } = setup();
    const first = hands.press(TARGET, { name: "Save" }).catch((error: unknown) => error);
    const second = hands.scroll(2).catch((error: unknown) => error);
    await flush();
    current().emit("exit", 1);
    expect(((await first) as Error).message).toBe("Her hands stopped unexpectedly.");
    expect(((await second) as Error).message).toBe("Her hands stopped unexpectedly.");
    const again = hands.scroll(1);
    await flush();
    expect(helpers).toHaveLength(2);
    current().say({ id: current().last()["id"], ok: true });
    await expect(again).resolves.toBeUndefined();
    await hands.dispose();
  });

  it("says plainly when Python is not installed", async () => {
    const { hands, current } = setup();
    const asking = hands.abilities().catch((error: unknown) => error);
    await flush();
    current().emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }));
    expect(((await asking) as Error).message).toBe('This needs "python3", which is not installed.');
    const other = hands.abilities().catch((error: unknown) => error);
    await flush();
    current().emit("error", new Error("EACCES"));
    expect(((await other) as Error).message).toBe("Her hands could not be started: EACCES");
  });

  it("rehearses instead of acting when the desktop is being rehearsed", async () => {
    process.env["AI_CHAN_REHEARSE_DESKTOP"] = "1";
    const { hands, current } = setup();
    void hands.pointer(0.5, 0.5, { button: "left", clicks: 1 }).catch(() => undefined);
    await flush();
    expect(current().last()).toMatchObject({ op: "pointer", rehearse: true });
    current().say({ id: current().last()["id"], ok: true, rehearsed: true });
    await flush();
    await hands.dispose();
  });

  it("is put away by closing its input, and comes back when next needed", async () => {
    const { hands, helpers, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    const first = current();
    first.auto = () => ({ ok: true });
    await hands.rest();
    expect(first.inputEnded).toBe(true);
    expect(first.kill).not.toHaveBeenCalled();
    expect(first.requests.map((request) => request["op"])).toEqual(["hello"]);

    const again = hands.scroll(1);
    await flush();
    expect(helpers).toHaveLength(2);
    current().say({ id: current().last()["id"], ok: true });
    await again;
    await hands.dispose();
    // Putting away what is already put away does nothing.
    await hands.rest();
    expect(helpers).toHaveLength(2);
  });

  it("kills a helper that will not leave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hands, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    current().leavesWhenClosed = false;
    const resting = hands.rest();
    await flush();
    expect(current().kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2600);
    await resting;
    expect(current().kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("puts itself away after a quiet while", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hands, current } = setup(60_000);
    void hands.abilities().catch(() => undefined);
    await flush();
    current().auto = () => ({ ok: true });
    await vi.advanceTimersByTimeAsync(59_000);
    await hands.scroll(1); // any use starts the quiet time over
    await vi.advanceTimersByTimeAsync(59_000);
    await flush();
    expect(current().inputEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(current().inputEnded).toBe(true);
  });

  it("while something follows the windows, lets go of the desktop but stays running", async () => {
    const { hands, helpers, current } = setup();
    const following = hands.followWindows(() => undefined);
    await flush();
    current().say({
      id: current().last()["id"],
      ok: true,
      bus: ":1.5",
      path: "/Watch",
      interface: "i",
    });
    await following;
    current().auto = () => ({ ok: true });

    await hands.rest();
    expect(current().last()).toMatchObject({ op: "rest" });
    expect(current().inputEnded).toBe(false);
    await hands.scroll(1);
    expect(helpers).toHaveLength(1);

    await hands.unfollowWindows();
    expect(current().last()).toMatchObject({ op: "unwatch" });
    await hands.rest();
    expect(current().inputEnded).toBe(true);
    await hands.dispose();
  });

  it("stops passing on window reports once nobody follows", async () => {
    const { hands, current } = setup();
    const seen: WindowSeen[] = [];
    const following = hands.followWindows((window) => seen.push(window));
    await flush();
    current().auto = () => ({ ok: true });
    current().say({
      id: current().last()["id"],
      ok: true,
      bus: ":1.5",
      path: "/Watch",
      interface: "i",
    });
    await following;
    await hands.unfollowWindows();
    current().say({ event: "window", seen: { id: "{w}", app: "kate" } });
    await flush();
    expect(seen).toEqual([]);
    await hands.dispose();
  });

  it("does nothing more once disposed", async () => {
    const { hands, helpers, current } = setup();
    void hands.abilities().catch(() => undefined);
    await flush();
    const helper = current();
    await hands.dispose();
    expect(helper.inputEnded).toBe(true);
    await expect(hands.scroll(1)).rejects.toThrow("Her hands have been put away.");
    await expect(hands.controls(TARGET)).rejects.toThrow("Her hands have been put away.");
    expect(helpers).toHaveLength(1);
  });

  it("unfollowing with no helper running starts none", async () => {
    const { hands, helpers } = setup();
    await hands.unfollowWindows();
    await hands.rest();
    expect(helpers).toHaveLength(0);
  });
});

describe("keys as she writes them", () => {
  it.each([
    ["ctrl+s", ["ctrl", "s"]],
    ["Ctrl + Shift + S", ["ctrl", "shift", "s"]],
    ["enter", ["enter"]],
    ["  ALT+F4 ", ["alt", "f4"]],
    ["ctrl shift tab", ["ctrl", "shift", "tab"]],
    ["+", ["="]],
    ["", []],
    ["   ", []],
    ["ctrl++", ["ctrl"]],
  ])("%j", (written, keys) => {
    expect(parseKeys(written)).toEqual(keys);
  });
});
