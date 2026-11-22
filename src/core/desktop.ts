import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformAdapter } from "./platform/adapter.ts";

/**
 * Working the desktop directly: its windows, what is playing, the volume, the
 * clipboard, the lock screen. Each goes through the desktop's own published interface
 * (KWin, MPRIS, PipeWire, Klipper, logind), started with fixed arguments and no shell.
 */

function run(program: string, args: readonly string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: timeoutMs, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new Error(
            missing
              ? `This needs "${program}", which is not installed.`
              : (error.message.split("\n")[0] ?? "failed"),
          ),
        );
      },
    );
  });
}

/**
 * With AI_CHAN_REHEARSE_DESKTOP set, nothing here changes the desktop: each action
 * reports what it would have done. For trying her out while someone is using the PC.
 */
export function rehearsing(): boolean {
  return Boolean(process.env["AI_CHAN_REHEARSE_DESKTOP"]);
}

// ---------- windows ----------

export interface DesktopWindow {
  id: string;
  title: string;
  /** The program it belongs to, as the desktop names it ("firefox", "org.kde.dolphin"). */
  app: string;
  active: boolean;
  minimized: boolean;
}

export type WindowAction = "focus" | "minimize" | "maximize" | "close";

/**
 * KWin runs small scripts on request but has no way to hand a value back, so the script
 * prints its answer to the system log behind a marker made up for this one call, and
 * the answer is read from there. A window's title cannot fake the marker: it is random.
 */
async function askKwin(scriptDir: string, body: string): Promise<unknown> {
  const mark = `AICHAN${randomBytes(8).toString("hex")}`;
  const name = `ai-chan-task-${mark.toLowerCase()}`;
  const file = join(scriptDir, `${name}.js`);
  await mkdir(scriptDir, { recursive: true, mode: 0o700 });
  await writeFile(file, `(function () {\n${body}\n})();\n`.replaceAll("__MARK__", mark), {
    mode: 0o600,
  });
  const scripting = (method: string, ...args: string[]): Promise<string> =>
    run("dbus-send", [
      "--session",
      "--print-reply",
      "--dest=org.kde.KWin",
      "/Scripting",
      `org.kde.kwin.Scripting.${method}`,
      ...args.map((arg) => `string:${arg}`),
    ]);
  try {
    const reply = await scripting("loadScript", file, name);
    if (!/int32\s+\d+/.test(reply))
      throw new Error("The window manager would not take the request.");
    await scripting("start");
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      // A window manager started by hand writes its log to a file instead of the journal.
      // Only honoured together with the test desktop's own switch, so that outside a
      // test no setting of the environment can point her window answers at a file.
      const logFile = process.env["AI_CHAN_NO_VIRTUAL_INPUT"]
        ? process.env["AI_CHAN_KWIN_LOG"]
        : undefined;
      const log = await (
        logFile
          ? run("grep", ["-a", "--", mark, logFile])
          : run("journalctl", [
              "--user",
              "--output=cat",
              "--since=-15s",
              "--no-pager",
              `--grep=${mark}`,
            ])
      ).catch(() => "");
      const line = log.split("\n").find((entry) => entry.includes(`${mark} `));
      if (line)
        return JSON.parse(line.slice(line.indexOf(`${mark} `) + mark.length + 1)) as unknown;
    }
    throw new Error("The window manager did not answer.");
  } finally {
    await scripting("unloadScript", name).catch(() => undefined);
    await rm(file, { force: true });
  }
}

const LIST_WINDOWS = `
  var out = [];
  var all = workspace.windowList();
  for (var i = 0; i < all.length; i++) {
    var w = all[i];
    if (!w.normalWindow || w.skipTaskbar) continue;
    out.push({
      id: String(w.internalId),
      title: String(w.caption).slice(0, 160),
      app: String(w.resourceClass),
      active: w === workspace.activeWindow,
      minimized: !!w.minimized
    });
  }
  print("__MARK__ " + JSON.stringify(out));
`;

function isWindow(value: unknown): value is DesktopWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window["id"] === "string" &&
    typeof window["title"] === "string" &&
    typeof window["app"] === "string" &&
    typeof window["active"] === "boolean" &&
    typeof window["minimized"] === "boolean"
  );
}

/** The windows open on the desktop. Her own companion window is not among them. */
export async function listWindows(scriptDir: string): Promise<DesktopWindow[]> {
  const answer = await askKwin(scriptDir, LIST_WINDOWS);
  return Array.isArray(answer) ? answer.filter(isWindow) : [];
}

/**
 * The windows meant by a few words (a title or a program's name): every window that
 * matches as well as the best one does. More than one means the words were not enough to tell.
 */
export function matchWindows(windows: readonly DesktopWindow[], wanted: string): DesktopWindow[] {
  const words = wanted.toLowerCase().trim();
  if (!words) return [];
  const score = (window: DesktopWindow): number => {
    const title = window.title.toLowerCase();
    const app = window.app.toLowerCase();
    if (window.id === wanted) return 100;
    if (app === words || app.endsWith(`.${words}`)) return 50;
    if (title === words) return 45;
    if (app.includes(words)) return 30;
    if (title.includes(words)) return 20;
    // Every word appears somewhere: "unreal editor" for "MyGame - Unreal Editor".
    const parts = words.split(/\s+/);
    return parts.every((part) => title.includes(part) || app.includes(part)) ? 10 : 0;
  };
  const ranked = windows
    .map((window) => ({ window, score: score(window) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.score ?? 0;
  return ranked.filter((entry) => entry.score === best).map((entry) => entry.window);
}

/** The single best match, or null. */
export function matchWindow(
  windows: readonly DesktopWindow[],
  wanted: string,
): DesktopWindow | null {
  return matchWindows(windows, wanted)[0] ?? null;
}

export async function actOnWindow(
  scriptDir: string,
  id: string,
  action: WindowAction,
): Promise<boolean> {
  if (rehearsing()) return true;
  const act = {
    focus: "w.minimized = false; workspace.activeWindow = w;",
    minimize: "w.minimized = true;",
    maximize: "w.minimized = false; w.setMaximize(true, true); workspace.activeWindow = w;",
    close: "w.closeWindow();",
  }[action];
  const answer = await askKwin(
    scriptDir,
    `
  var done = false;
  var all = workspace.windowList();
  for (var i = 0; i < all.length; i++) {
    var w = all[i];
    if (String(w.internalId) === ${JSON.stringify(id)}) { ${act} done = true; break; }
  }
  print("__MARK__ " + JSON.stringify(done));
`,
  );
  return answer === true;
}

// ---------- windows in detail, for working inside them ----------

/** A window with what is needed to work inside it: whose it is and where it sits. */
export interface WindowDetail extends DesktopWindow {
  /** The process that owns it. */
  pid: number;
  fullScreen: boolean;
  /** A dialog or another window that belongs to a bigger one. */
  dialog: boolean;
  /** Its place in the pile of windows; the highest is on top. */
  order?: number;
  /** Where it is, in the desktop's own units. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional DPI scaling factor reported by high-DPI / mixed-DPI compositors (e.g. Windows). */
  dpiScale?: number;
}

export interface DesktopLayout {
  windows: WindowDetail[];
  /** The size of the whole desktop, all screens together. */
  width: number;
  height: number;
}

const LIST_DETAIL = `
  var out = [];
  var all = workspace.windowList();
  var pile = workspace.stackingOrder;
  for (var i = 0; i < all.length; i++) {
    var w = all[i];
    if (!w.normalWindow && !w.dialog) continue;
    var g = w.frameGeometry;
    out.push({
      id: String(w.internalId),
      title: String(w.caption).slice(0, 160),
      app: String(w.resourceClass),
      active: w === workspace.activeWindow,
      minimized: !!w.minimized,
      pid: w.pid,
      fullScreen: !!w.fullScreen,
      dialog: !!w.dialog || !!w.transient,
      order: pile.indexOf(w),
      x: g.x, y: g.y, width: g.width, height: g.height
    });
  }
  var size = workspace.virtualScreenSize;
  print("__MARK__ " + JSON.stringify({ windows: out, width: size.width, height: size.height }));
`;

function isDetail(value: unknown): value is WindowDetail {
  if (!isWindow(value)) return false;
  const window = value as unknown as Record<string, unknown>;
  return (
    typeof window["pid"] === "number" &&
    ["x", "y", "width", "height"].every((key) => typeof window[key] === "number")
  );
}

/** Every window and dialog with its owner and place. Her own windows are among them. */
export async function desktopLayout(scriptDir: string): Promise<DesktopLayout> {
  const answer = (await askKwin(scriptDir, LIST_DETAIL)) as Record<string, unknown> | null;
  const windows = Array.isArray(answer?.["windows"]) ? answer["windows"].filter(isDetail) : [];
  const width = typeof answer?.["width"] === "number" ? answer["width"] : 0;
  const height = typeof answer?.["height"] === "number" ? answer["height"] : 0;
  if (width <= 0 || height <= 0)
    throw new Error("The window manager did not say how big the desktop is.");
  return { windows, width, height };
}

/**
 * The window that would take a click at this spot: the topmost one covering it, panels
 * and her own window included. Null when nothing is there.
 */
export async function windowAt(
  scriptDir: string,
  x: number,
  y: number,
): Promise<{ id: string; app: string; title: string } | null> {
  const answer = await askKwin(
    scriptDir,
    `
  var X = ${Math.round(x)}, Y = ${Math.round(y)};
  var order = workspace.stackingOrder;
  var hit = null;
  for (var i = order.length - 1; i >= 0; i--) {
    var w = order[i];
    if (w.minimized || w.deleted) continue;
    if (!w.onAllDesktops && w.desktops.length > 0 && w.desktops.indexOf(workspace.currentDesktop) === -1) continue;
    var g = w.frameGeometry;
    if (X >= g.x && X < g.x + g.width && Y >= g.y && Y < g.y + g.height) { hit = w; break; }
  }
  print("__MARK__ " + JSON.stringify(hit ? { id: String(hit.internalId), app: String(hit.resourceClass), title: String(hit.caption).slice(0, 160) } : null));
`,
  );
  if (typeof answer !== "object" || answer === null) return null;
  const hit = answer as Record<string, unknown>;
  return typeof hit["id"] === "string"
    ? { id: hit["id"], app: String(hit["app"]), title: String(hit["title"]) }
    : null;
}

/** Resolves desktop layout via `PlatformAdapter` when present, falling back to KWin. */
export function resolveDesktopLayout(
  scriptDir: string,
  adapter?: PlatformAdapter,
): Promise<DesktopLayout> {
  return adapter ? adapter.windowManager.layout() : desktopLayout(scriptDir);
}

/** Resolves window actions via `PlatformAdapter` when present, falling back to KWin. */
export function resolveActOnWindow(
  scriptDir: string,
  id: string,
  action: WindowAction,
  adapter?: PlatformAdapter,
): Promise<boolean> {
  if (rehearsing()) return Promise.resolve(true);
  return adapter ? adapter.windowManager.act(id, action) : actOnWindow(scriptDir, id, action);
}

/** Resolves hit-test under screen coordinates via `PlatformAdapter` when present. */
export function resolveWindowAt(
  scriptDir: string,
  x: number,
  y: number,
  adapter?: PlatformAdapter,
): Promise<{ id: string; app: string; title: string } | null> {
  return adapter ? adapter.windowManager.windowAt(x, y) : windowAt(scriptDir, x, y);
}

const WATCH_SCRIPT = "ai-chan-watch";

/**
 * Has the window manager report the window in front, and every change of it or of its
 * title, to the given address on the session bus. The reports go straight to her helper
 * and are written nowhere. Returns a function that ends the reporting.
 */
export async function reportFrontWindow(
  scriptDir: string,
  to: { bus: string; path: string; interface: string },
): Promise<() => Promise<void>> {
  const file = join(scriptDir, `${WATCH_SCRIPT}.js`);
  await mkdir(scriptDir, { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    `(function () {
  var hooked = [];
  function tell(w) {
    if (!w) return;
    var g = w.frameGeometry;
    callDBus(${JSON.stringify(to.bus)}, ${JSON.stringify(to.path)}, ${JSON.stringify(to.interface)}, "Seen", JSON.stringify({
      id: String(w.internalId), app: String(w.resourceClass), title: String(w.caption).slice(0, 200),
      pid: w.pid, fullScreen: !!w.fullScreen, dialog: !!w.dialog || !!w.transient,
      width: g.width, height: g.height
    }));
  }
  function hook(w) {
    if (!w) return;
    var id = String(w.internalId);
    if (hooked.indexOf(id) !== -1) return;
    hooked.push(id);
    if (hooked.length > 400) hooked.shift();
    w.captionChanged.connect(function () { if (w === workspace.activeWindow) tell(w); });
  }
  workspace.windowActivated.connect(function (w) { hook(w); tell(w); });
  hook(workspace.activeWindow);
  tell(workspace.activeWindow);
})();
`,
    { mode: 0o600 },
  );
  const scripting = (method: string, ...args: string[]): Promise<string> =>
    run("dbus-send", [
      "--session",
      "--print-reply",
      "--dest=org.kde.KWin",
      "/Scripting",
      `org.kde.kwin.Scripting.${method}`,
      ...args.map((arg) => `string:${arg}`),
    ]);
  // One left behind by a run that crashed would report to an address nobody holds.
  await scripting("unloadScript", WATCH_SCRIPT).catch(() => undefined);
  const reply = await scripting("loadScript", file, WATCH_SCRIPT);
  if (!/int32\s+\d+/.test(reply)) throw new Error("The window manager would not take the request.");
  await scripting("start");
  return async () => {
    await scripting("unloadScript", WATCH_SCRIPT).catch(() => undefined);
    await rm(file, { force: true });
  };
}

// ---------- what is playing, and how loud ----------

export type MediaAction = "play" | "pause" | "play_pause" | "next" | "previous";

export interface NowPlaying {
  player: string;
  status: string;
  title: string;
  artist: string;
}

const MPRIS = "org.mpris.MediaPlayer2";

async function players(): Promise<string[]> {
  const listed = await run("busctl", ["--user", "list", "--no-legend", "--no-pager"]);
  return listed
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name.startsWith(`${MPRIS}.`));
}

async function playerProperty(player: string, property: string): Promise<unknown> {
  const raw = await run("busctl", [
    "--user",
    "--json=short",
    "get-property",
    player,
    "/org/mpris/MediaPlayer2",
    `${MPRIS}.Player`,
    property,
  ]);
  return (JSON.parse(raw) as { data?: unknown }).data;
}

/** Reads the title and artist out of the player's description of its track. */
export function readTrack(metadata: unknown): { title: string; artist: string } {
  const entry = (key: string): unknown => {
    if (typeof metadata !== "object" || metadata === null) return undefined;
    const field = (metadata as Record<string, unknown>)[key];
    return typeof field === "object" && field !== null ? (field as { data?: unknown }).data : field;
  };
  const artist = entry("xesam:artist");
  return {
    title:
      typeof entry("xesam:title") === "string"
        ? (entry("xesam:title") as string).slice(0, 160)
        : "",
    artist: (Array.isArray(artist)
      ? artist.filter((name) => typeof name === "string").join(", ")
      : ""
    ).slice(0, 120),
  };
}

/** Every player with its state; the one that is playing comes first. */
export async function nowPlaying(): Promise<NowPlaying[]> {
  const found: NowPlaying[] = [];
  for (const player of await players()) {
    try {
      const status = String(await playerProperty(player, "PlaybackStatus"));
      const track = readTrack(await playerProperty(player, "Metadata"));
      found.push({ player, status, ...track });
    } catch {
      // a player that vanished or does not answer is simply left out
    }
  }
  // A browser shows up twice (itself, and through the desktop's browser bridge); one is enough.
  const seen = new Set<string>();
  return found
    .sort((a, b) => Number(b.status === "Playing") - Number(a.status === "Playing"))
    .filter((entry) => {
      const key = `${entry.status}|${entry.title}|${entry.artist}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function controlMedia(action: MediaAction): Promise<NowPlaying | null> {
  const [target] = await nowPlaying();
  if (!target) return null;
  if (rehearsing()) return target;
  const method = {
    play: "Play",
    pause: "Pause",
    play_pause: "PlayPause",
    next: "Next",
    previous: "Previous",
  }[action];
  await run("busctl", [
    "--user",
    "call",
    target.player,
    "/org/mpris/MediaPlayer2",
    `${MPRIS}.Player`,
    method,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return (await nowPlaying())[0] ?? target;
}

const SINK = "@DEFAULT_AUDIO_SINK@";

export async function getVolume(): Promise<{ percent: number; muted: boolean }> {
  const raw = await run("wpctl", ["get-volume", SINK]);
  const level = Number(/Volume:\s*([\d.]+)/.exec(raw)?.[1] ?? Number.NaN);
  if (!Number.isFinite(level)) throw new Error("The volume could not be read.");
  return { percent: Math.round(level * 100), muted: raw.includes("[MUTED]") };
}

/** Sets the volume, never above 100%: she must not be able to blast the speakers. */
export async function setVolume(percent: number): Promise<{ percent: number; muted: boolean }> {
  const level = Math.min(100, Math.max(0, Math.round(percent)));
  if (rehearsing()) return { ...(await getVolume()), percent: level };
  await run("wpctl", ["set-volume", SINK, `${level}%`]);
  return getVolume();
}

export async function setMuted(muted: boolean): Promise<{ percent: number; muted: boolean }> {
  if (rehearsing()) return { ...(await getVolume()), muted };
  await run("wpctl", ["set-mute", SINK, muted ? "1" : "0"]);
  return getVolume();
}

// ---------- clipboard and lock ----------

const KLIPPER = ["org.kde.klipper", "/klipper", "org.kde.klipper.klipper"] as const;

export async function readClipboard(): Promise<string> {
  const raw = await run("busctl", [
    "--user",
    "--json=short",
    "call",
    ...KLIPPER,
    "getClipboardContents",
  ]);
  const data = (JSON.parse(raw) as { data?: unknown }).data;
  return Array.isArray(data) && typeof data[0] === "string" ? data[0] : "";
}

export async function writeClipboard(text: string): Promise<void> {
  if (rehearsing()) return;
  // The "--" matters: without it, text starting with a dash is read as an option.
  await run("busctl", ["--user", "call", ...KLIPPER, "setClipboardContents", "--", "s", text]);
}

export async function lockScreen(): Promise<void> {
  if (rehearsing()) return;
  await run("loginctl", ["lock-session"]);
}
