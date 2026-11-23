import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { PlatformAdapter } from "./platform/adapter.ts";

/** Locates the compiled Rust `linux-hands` binary when built locally or bundled alongside `hands/`. */
export function resolveNativeLinuxHandsBinary(appRoot?: string): string | null {
  if (process.env["ASTRA_NAVI_FORCE_PYTHON_HANDS"] === "1") return null;
  const override = process.env["ASTRA_NAVI_LINUX_HANDS_BIN"];
  if (override && existsSync(override)) return override;
  const root = appRoot ? resolve(appRoot) : resolve(dirname(import.meta.dirname), "..");
  for (const candidate of [
    join(root, "hands", "linux-hands-native", "bin", "linux-hands"),
    join(root, "hands", "linux-hands-native", "target", "release", "linux-hands"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Her hands in other programs: the app's side of the small helper in `hands/hands.py`.
 *
 * The helper reads a window's controls through the desktop's accessibility service and
 * presses them, and it owns a virtual pointer and keyboard for programs that describe
 * nothing. It is started when first needed and put away after a few quiet minutes, so
 * the virtual devices and the accessibility switch exist only while she is working.
 * It makes no decisions: what she may touch is decided before anything is sent here.
 */

export interface ControlRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One control in a window, as she is shown it. */
export interface Control {
  /** Its number in the list it came from; "which: 3" presses the third. */
  n: number;
  kind: string;
  name: string;
  value?: string;
  on?: boolean;
  selected?: boolean;
  greyed?: boolean;
  focused?: boolean;
  hidden?: boolean;
  rect?: ControlRect;
}

export interface ControlList {
  window: string;
  controls: Control[];
  /** How many more matched than are listed. */
  more: number;
  /** Text the window shows that is not a control: labels, status lines. */
  text: string[];
}

/** What the window manager says about the window in front, each time it changes. */
export interface WindowSeen {
  id: string;
  app: string;
  title: string;
  pid: number;
  fullScreen: boolean;
  dialog: boolean;
  width: number;
  height: number;
}

export interface HandsAbilities {
  /** She can read and press programs' controls. */
  controls: boolean;
  controlsProblem: string;
  /** She can move a pointer and press keys. */
  input: boolean;
}

/** The helper answered that the thing cannot be done; the message is written for her. */
export class HandsRefusal extends Error {}
/** The program does not describe its controls at all. */
export class NoControls extends HandsRefusal {}
/** Nothing in the window goes by that name. */
export class NoSuchControl extends HandsRefusal {}
/** Several controls fit equally well; they are listed so she can say which. */
export class SeveralControls extends HandsRefusal {
  readonly choices: Control[];
  /**
   * False when none of them goes by the name she gave: they only resemble it. A control
   * is pressed on its whole name or not at all.
   */
  readonly exact: boolean;
  constructor(choices: Control[], exact = true) {
    super("Several controls match.");
    this.choices = choices;
    this.exact = exact;
  }
}

export interface HandsOptions {
  /** Full path of hands.py. */
  script: string;
  /** Optional cross-platform adapter delegating accessibility and input injection. */
  adapter?: PlatformAdapter;
  /** The Python to run it with. The desktop's own, since that is where the accessibility bindings live. */
  python?: string;
  /** Put the helper away after this long without a request. */
  restAfterMs?: number;
  /** For tests: how the helper is started. */
  start?(python: string, script: string): ChildProcessWithoutNullStreams;
}

interface Waiting {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const REST_AFTER_MS = 5 * 60_000;
const STEP_TIMEOUT_MS = 20_000;

function isControl(value: unknown): value is Control {
  if (typeof value !== "object" || value === null) return false;
  const control = value as Record<string, unknown>;
  return (
    typeof control["n"] === "number" &&
    typeof control["kind"] === "string" &&
    typeof control["name"] === "string"
  );
}

function readControlRect(value: unknown): ControlRect | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const x = r["x"];
  const y = r["y"];
  const width = r["width"];
  const height = r["height"];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function controlsIn(value: unknown): Control[] {
  if (!Array.isArray(value)) return [];
  const out: Control[] = [];
  for (const item of value) {
    if (!isControl(item)) continue;
    const raw = item as unknown as Record<string, unknown>;
    const rect = readControlRect(raw["rect"]);
    const copy: Control = { ...item };
    if (rect) copy.rect = rect;
    else delete copy.rect;
    out.push(copy);
  }
  return out;
}

function readSeen(value: unknown): WindowSeen | null {
  if (typeof value !== "object" || value === null) return null;
  const seen = value as Record<string, unknown>;
  if (typeof seen["id"] !== "string" || typeof seen["app"] !== "string") return null;
  return {
    id: seen["id"],
    app: seen["app"].slice(0, 120),
    title: typeof seen["title"] === "string" ? seen["title"].slice(0, 200) : "",
    pid: typeof seen["pid"] === "number" ? seen["pid"] : -1,
    fullScreen: seen["fullScreen"] === true,
    dialog: seen["dialog"] === true,
    width: typeof seen["width"] === "number" ? seen["width"] : 0,
    height: typeof seen["height"] === "number" ? seen["height"] : 0,
  };
}

export class Hands {
  private readonly options: HandsOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 1;
  private restTimer: NodeJS.Timeout | null = null;
  /** While something follows the window in front, the helper is kept running. */
  private windowListener: ((seen: WindowSeen) => void) | null = null;
  /** Called when the helper dies while something was following windows through it. */
  private onFollowLost: (() => void) | null = null;
  private disposed = false;
  /** The helper has switched the desktop's accessibility on and not yet off again. */
  private switchOn = false;

  constructor(options: HandsOptions) {
    this.options = options;
  }

  private rehearsing(): boolean {
    return Boolean(process.env["AI_CHAN_REHEARSE_DESKTOP"]);
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error("Her hands have been put away.");
    if (this.child) return this.child;
    const python = this.options.python ?? "python3";
    const nativeBin =
      !this.options.start && process.platform === "linux"
        ? resolveNativeLinuxHandsBinary()
        : null;
    const child =
      this.options.start?.(python, this.options.script) ??
      (nativeBin
        ? spawn(nativeBin, [], { stdio: ["pipe", "pipe", "pipe"] })
        : // -I: the helper must not pick up modules from the current folder or the user's site.
          spawn(python, ["-I", this.options.script], { stdio: ["pipe", "pipe", "pipe"] }));
    this.child = child;
    const fail = (reason: string): void => {
      if (this.child !== child) return;
      this.child = null;
      // A helper that died could not put the accessibility switch back; do it for it.
      if (this.switchOn) restoreAccessibilitySwitch();
      this.switchOn = false;
      // Whoever was following windows has stopped hearing about them and must be told.
      if (this.windowListener) {
        const lost = this.onFollowLost;
        this.windowListener = null;
        this.onFollowLost = null;
        lost?.();
      }
      for (const [id, entry] of this.waiting) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
        this.waiting.delete(id);
      }
    };
    child.on("error", (error: NodeJS.ErrnoException) =>
      fail(
        error.code === "ENOENT"
          ? `This needs "${python}", which is not installed.`
          : `Her hands could not be started: ${error.message}`,
      ),
    );
    child.on("exit", () => fail("Her hands stopped unexpectedly."));
    child.stdin.on("error", () => undefined); // a helper that died is reported by "exit"
    child.stderr.on("data", () => undefined); // toolkit chatter; nothing she needs
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    return child;
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const answer = message as Record<string, unknown>;
    if (answer["event"] === "window") {
      const seen = readSeen(answer["seen"]);
      if (seen) this.windowListener?.(seen);
      return;
    }
    const id = answer["id"];
    if (typeof id !== "number") return;
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    clearTimeout(entry.timer);
    if (typeof answer["switchOn"] === "boolean") this.switchOn = answer["switchOn"];
    if (answer["ok"] === true) return entry.resolve(answer);
    const error = typeof answer["error"] === "string" ? answer["error"] : "It did not work.";
    if (error === "BARE") return entry.reject(new NoControls("BARE"));
    if (error === "NOMATCH") return entry.reject(new NoSuchControl("NOMATCH"));
    if (error === "LATE") return entry.reject(new Error("The program did not answer in time."));
    for (const [mark, exact] of [
      ["SEVERAL ", true],
      ["CLOSEST ", false],
    ] as const) {
      if (!error.startsWith(mark)) continue;
      try {
        return entry.reject(
          new SeveralControls(controlsIn(JSON.parse(error.slice(mark.length))), exact),
        );
      } catch {
        return entry.reject(new HandsRefusal("Several controls match."));
      }
    }
    entry.reject(new HandsRefusal(error));
  }

  private ask(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = STEP_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensure();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.restLater();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("The program did not answer in time."));
        // She is about to be told this step failed, so it must not happen later. The
        // helper refuses anything past its deadline; ending it settles the case where
        // it is stuck inside a program that has hung. It starts afresh when next needed.
        if (this.child === child) child.kill("SIGKILL");
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      const deadline = (Date.now() + timeoutMs) / 1000;
      child.stdin.write(
        `${JSON.stringify({ id, op, rehearse: this.rehearsing(), deadline, ...args })}\n`,
      );
    });
  }

  private restLater(): void {
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = setTimeout(
      () => void this.rest().catch(() => undefined),
      this.options.restAfterMs ?? REST_AFTER_MS,
    );
    this.restTimer.unref();
  }

  async abilities(): Promise<HandsAbilities> {
    if (this.options.adapter) {
      return { controls: true, controlsProblem: "", input: true };
    }
    const answer = await this.ask("hello", {}, 8000);
    return {
      controls: answer["controls"] === true,
      controlsProblem:
        typeof answer["controlsProblem"] === "string" ? answer["controlsProblem"] : "",
      input: answer["input"] === true,
    };
  }

  /** The controls of one window. With `words`, only those whose name holds every word, hidden ones included. */
  async controls(target: { pid: number; title: string }, words = ""): Promise<ControlList> {
    if (this.options.adapter) {
      return this.options.adapter.accessibilityTree.controls(target, words);
    }
    const answer = await this.ask("controls", { ...target, name: words });
    return {
      window: typeof answer["window"] === "string" ? answer["window"] : "",
      controls: controlsIn(answer["controls"]),
      more: typeof answer["more"] === "number" ? answer["more"] : 0,
      text: Array.isArray(answer["text"])
        ? answer["text"].filter((line): line is string => typeof line === "string")
        : [],
    };
  }

  /** Presses a control by its name, or by its number in the last list. */
  async press(
    target: { pid: number; title: string },
    control: { name?: string; which?: number },
  ): Promise<{ kind: string; name: string; on?: boolean }> {
    if (this.options.adapter) {
      return this.options.adapter.accessibilityTree.press(target, control);
    }
    const answer = await this.ask("press", { ...target, ...control });
    const pressed = (answer["pressed"] ?? {}) as Record<string, unknown>;
    return {
      kind: typeof pressed["kind"] === "string" ? pressed["kind"] : "control",
      name: typeof pressed["name"] === "string" ? pressed["name"] : "",
      ...(typeof answer["on"] === "boolean" ? { on: answer["on"] } : {}),
    };
  }

  /** Puts text into a field, replacing what was there. Password fields are refused by the helper itself. */
  async fill(
    target: { pid: number; title: string },
    control: { name?: string; which?: number },
    text: string,
  ): Promise<{ field: string; now: string }> {
    if (this.options.adapter) {
      return this.options.adapter.accessibilityTree.fill(target, control, text);
    }
    const answer = await this.ask("fill", { ...target, ...control, text });
    return {
      field: typeof answer["filled"] === "string" ? answer["filled"] : "",
      now: typeof answer["now"] === "string" ? answer["now"] : "",
    };
  }

  /** Moves the pointer to a spot given as fractions of the whole desktop, and clicks if asked. */
  async pointer(
    x: number,
    y: number,
    click?: { button: "left" | "right" | "middle"; clicks: number },
  ): Promise<void> {
    if (this.options.adapter) {
      await this.options.adapter.inputInjector.pointer(x, y, click);
      return;
    }
    await this.ask("pointer", { x, y, ...(click ?? {}) });
  }

  /** Turns the wheel under the pointer; positive scrolls down. */
  async scroll(notches: number): Promise<void> {
    if (this.options.adapter) {
      await this.options.adapter.inputInjector.scroll(notches);
      return;
    }
    await this.ask("scroll", { notches });
  }

  /** Presses one key or combination ("ctrl", "s"), a number of times. */
  async keys(combo: readonly string[], times = 1): Promise<void> {
    if (this.options.adapter) {
      await this.options.adapter.inputInjector.keys(combo, times);
      return;
    }
    await this.ask("key", { keys: combo, times });
  }

  /**
   * Starts receiving the window manager's reports of the window in front. Returns where
   * the window manager must send them. While this is on, the helper is not put away.
   */
  async followWindows(
    listener: (seen: WindowSeen) => void,
    onLost?: () => void,
  ): Promise<{ bus: string; path: string; interface: string }> {
    const answer = await this.ask("watch", {}, 8000);
    if (typeof answer["bus"] !== "string") throw new Error("The helper gave no address.");
    this.windowListener = listener;
    this.onFollowLost = onLost ?? null;
    return {
      bus: answer["bus"],
      path: String(answer["path"]),
      interface: String(answer["interface"]),
    };
  }

  async unfollowWindows(): Promise<void> {
    this.windowListener = null;
    this.onFollowLost = null;
    if (this.child) await this.ask("unwatch", {}, 4000).catch(() => undefined);
  }

  /**
   * Lets go of the virtual devices and the accessibility switch. With nothing following
   * windows the helper itself is ended too; it starts again when next needed.
   */
  async rest(): Promise<void> {
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    const child = this.child;
    if (!child) return;
    if (this.windowListener) {
      await this.ask("rest", {}, 4000).catch(() => undefined);
      if (this.restTimer) clearTimeout(this.restTimer);
      this.restTimer = null;
      return;
    }
    this.child = null;
    // Closing its input is the helper's cue to tidy up and leave; the kill is for one that hangs.
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (this.switchOn) restoreAccessibilitySwitch();
        resolve();
      }, 2500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.switchOn = false;
  }

  async dispose(): Promise<void> {
    this.windowListener = null;
    this.onFollowLost = null;
    await this.rest();
    this.disposed = true;
  }
}

/** Puts the desktop's accessibility switch back to off, for a helper that could not. */
function restoreAccessibilitySwitch(): void {
  execFile(
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
    { timeout: 4000 },
    () => undefined,
  );
}

/** Splits "ctrl+shift+s" into its keys. A lone "+" is the plus key itself. */
export function parseKeys(written: string): string[] {
  const text = written.trim().toLowerCase();
  if (text === "+") return ["="];
  return text
    .split(/\s*\+\s*|\s+/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}
