import { spawn } from "node:child_process";
import type { DesktopLayout, MediaAction, NowPlaying, WindowAction, WindowDetail } from "../desktop.ts";
import type { Control } from "../hands.ts";
import type { MonitorChild } from "../notices.ts";
import type { PlatformAdapter, PlatformAudioStream, PlatformGpuVramStatus } from "./adapter.ts";

/** Validates Win32 window enumeration JSON produced by `win_hands.ps1 layout`. */
export function parseWin32WindowsJson(raw: string): DesktopLayout {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const width = typeof parsed["width"] === "number" && parsed["width"] > 0 ? parsed["width"] : 1920;
  const height =
    typeof parsed["height"] === "number" && parsed["height"] > 0 ? parsed["height"] : 1080;
  const list = Array.isArray(parsed["windows"]) ? parsed["windows"] : [];
  const windows: WindowDetail[] = [];

  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const w = item as Record<string, unknown>;
    if (
      typeof w["id"] !== "string" ||
      typeof w["title"] !== "string" ||
      typeof w["app"] !== "string" ||
      typeof w["pid"] !== "number"
    ) {
      continue;
    }
    const x = typeof w["x"] === "number" ? w["x"] : 0;
    const y = typeof w["y"] === "number" ? w["y"] : 0;
    const winW = typeof w["width"] === "number" ? w["width"] : 0;
    const winH = typeof w["height"] === "number" ? w["height"] : 0;
    if (winW <= 0 || winH <= 0) continue;
    windows.push({
      id: w["id"],
      title: w["title"].slice(0, 160),
      app: w["app"],
      active: w["active"] === true,
      minimized: w["minimized"] === true,
      pid: w["pid"],
      fullScreen: w["fullScreen"] === true,
      dialog: w["dialog"] === true,
      ...(typeof w["order"] === "number" ? { order: w["order"] } : {}),
      ...(typeof w["dpiScale"] === "number" && Number.isFinite(w["dpiScale"])
        ? { dpiScale: w["dpiScale"] }
        : {}),
      x,
      y,
      width: winW,
      height: winH,
    });
  }

  return { windows, width, height };
}

/** Validates UI Automation (UIA) control JSON produced by `win_hands.ps1 controls`. */
export function parseUiaControlsJson(raw: string): Control[] {
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["controls"])
      ? ((parsed as Record<string, unknown>)["controls"] as unknown[])
      : [];

  const controls: Control[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c["kind"] !== "string" || typeof c["name"] !== "string") continue;
    const n = typeof c["n"] === "number" ? c["n"] : i + 1;
    const rectRaw = c["rect"] as Record<string, unknown> | undefined;
    const hasRect =
      rectRaw &&
      typeof rectRaw["x"] === "number" &&
      typeof rectRaw["y"] === "number" &&
      typeof rectRaw["width"] === "number" &&
      typeof rectRaw["height"] === "number" &&
      rectRaw["width"] > 0 &&
      rectRaw["height"] > 0;

    controls.push({
      n,
      kind: c["kind"],
      name: c["name"],
      ...(typeof c["value"] === "string" ? { value: c["value"] } : {}),
      ...(typeof c["on"] === "boolean" ? { on: c["on"] } : {}),
      ...(typeof c["selected"] === "boolean" ? { selected: c["selected"] } : {}),
      ...(typeof c["greyed"] === "boolean" ? { greyed: c["greyed"] } : {}),
      ...(typeof c["focused"] === "boolean" ? { focused: c["focused"] } : {}),
      ...(typeof c["hidden"] === "boolean" ? { hidden: c["hidden"] } : {}),
      ...(hasRect
        ? {
            rect: {
              x: Math.round(rectRaw["x"] as number),
              y: Math.round(rectRaw["y"] as number),
              width: Math.round(rectRaw["width"] as number),
              height: Math.round(rectRaw["height"] as number),
            },
          }
        : {}),
    });
  }
  return controls;
}

/** Parses GPU VRAM JSON produced by `win_hands.ps1 gpu-vram` / `game-state`. */
export function parseWin32GpuVramJson(raw: string): PlatformGpuVramStatus | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const totalBytes = Number(obj["totalBytes"] ?? obj["vramTotalBytes"]);
  const freeBytes = Number(obj["freeBytes"] ?? obj["vramFreeBytes"]);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const sourceRaw = obj["source"] ?? obj["vramSource"];
  const source: PlatformGpuVramStatus["source"] =
    sourceRaw === "nvml" || sourceRaw === "dxgi" ? sourceRaw : "unknown";
  const util = Number(obj["utilizationPercent"]);
  return {
    totalBytes: Math.round(totalBytes),
    freeBytes: Number.isFinite(freeBytes) && freeBytes >= 0 ? Math.round(freeBytes) : 0,
    ...(Number.isFinite(util) ? { utilizationPercent: util } : {}),
    source,
  };
}

/** Parses Windows `SHQueryUserNotificationState` result into full-screen game status + optional VRAM telemetry. */
export function parseQunsState(raw: string): {
  fullscreenGame: boolean;
  state: string;
  processName?: string;
  vram?: PlatformGpuVramStatus;
} {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const state = String(obj["state"] ?? "");
      const code = Number(obj["code"]);
      const fullscreenGame =
        state === "QUNS_RUNNING_D3D_FULL_SCREEN" || state === "QUNS_BUSY" || code === 3 || code === 2;
      const vram = parseWin32GpuVramJson(trimmed);
      return {
        fullscreenGame,
        state: state || String(code),
        ...(typeof obj["process"] === "string" && obj["process"] ? { processName: obj["process"] } : {}),
        ...(vram ? { vram } : {}),
      };
    } catch {
      return { fullscreenGame: false, state: "UNKNOWN" };
    }
  }
  const fullscreenGame =
    trimmed === "QUNS_RUNNING_D3D_FULL_SCREEN" || trimmed === "QUNS_BUSY" || trimmed === "3" || trimmed === "2";
  return { fullscreenGame, state: trimmed || "UNKNOWN" };
}

/** Converts normalized `[0..1]` coordinates into DPI-aware virtual screen pixel coordinates. */
export function normalizeDpiCoords(
  nx: number,
  ny: number,
  layout: Pick<DesktopLayout, "width" | "height">,
  dpiScale = 1,
): { x: number; y: number } {
  const safeScale = Number.isFinite(dpiScale) && dpiScale > 0 ? dpiScale : 1;
  const cx = Math.max(0, Math.min(1, nx));
  const cy = Math.max(0, Math.min(1, ny));
  return {
    x: Math.round(cx * layout.width * safeScale),
    y: Math.round(cy * layout.height * safeScale),
  };
}

/** Maps physical virtual-desktop pixel coordinates (supporting negative multi-monitor origins) into Win32 SendInput `[0..65535]`. */
export function toVirtualDeskCoords(
  xPx: number,
  yPx: number,
  virtualBounds: { left: number; top: number; width: number; height: number },
): { dx: number; dy: number } {
  const vw = Math.max(1, virtualBounds.width);
  const vh = Math.max(1, virtualBounds.height);
  const rawX = Math.round(((xPx - virtualBounds.left) * 65535) / vw);
  const rawY = Math.round(((yPx - virtualBounds.top) * 65535) / vh);
  return {
    dx: Math.max(0, Math.min(65535, rawX)),
    dy: Math.max(0, Math.min(65535, rawY)),
  };
}

/** Enforces foreground/top-window check before Win32 `SendInput` dispatch. */
export function verifyTopWindowBeforeInput(
  expectedWindowId: string,
  topWindow: { id: string } | null,
): boolean {
  return topWindow !== null && topWindow.id === expectedWindowId;
}

export class WindowsPlatformAdapter implements PlatformAdapter {
  readonly platform = "win32" as const;
  private readonly scriptPath: string;
  private readonly runScript: (verb: string, payload: unknown) => Promise<string>;

  constructor(options: {
    scriptPath: string;
    runScript?: (verb: string, payload: unknown) => Promise<string>;
  }) {
    this.scriptPath = options.scriptPath;
    this.runScript = options.runScript ?? ((verb, payload) => this.invokePowershell(verb, payload));
  }

  private invokePowershell(verb: string, payload: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath, verb],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`Windows helper timed out on ${verb}.`));
      }, 15_000);

      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(Buffer.concat(err).toString("utf8").trim() || `PowerShell exit ${code}`));
          return;
        }
        resolve(Buffer.concat(out).toString("utf8"));
      });
      child.stdin.end(JSON.stringify(payload ?? {}));
    });
  }

  readonly windowManager: PlatformAdapter["windowManager"] = {
    layout: async () => parseWin32WindowsJson(await this.runScript("layout", {})),
    windowAt: async (x: number, y: number) => {
      const raw = await this.runScript("window-at", { x: Math.round(x), y: Math.round(y) });
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      return parsed && typeof parsed["id"] === "string"
        ? { id: parsed["id"], app: String(parsed["app"] ?? ""), title: String(parsed["title"] ?? "") }
        : null;
    },
    act: async (windowId: string, action: WindowAction) => {
      const raw = await this.runScript("act", { id: windowId, action });
      return raw.trim() === "true";
    },
    lockScreen: async () => {
      await this.runScript("lock", {});
    },
  };

  readonly accessibilityTree: PlatformAdapter["accessibilityTree"] = {
    controls: async (target, words = "") => {
      const raw = await this.runScript("controls", { ...target, words });
      const controls = parseUiaControlsJson(raw);
      return { window: target.title, controls, more: 0, text: [] };
    },
    press: async (target, control) => {
      const raw = await this.runScript("press", { ...target, ...control });
      const ans = JSON.parse(raw) as Record<string, unknown>;
      return {
        kind: typeof ans["kind"] === "string" ? ans["kind"] : "control",
        name: typeof ans["name"] === "string" ? ans["name"] : "",
        ...(typeof ans["on"] === "boolean" ? { on: ans["on"] } : {}),
      };
    },
    fill: async (target, control, text) => {
      const raw = await this.runScript("fill", { ...target, ...control, text });
      const ans = JSON.parse(raw) as Record<string, unknown>;
      return {
        field: typeof ans["field"] === "string" ? ans["field"] : "",
        now: typeof ans["now"] === "string" ? ans["now"] : "",
      };
    },
  };

  readonly inputInjector: PlatformAdapter["inputInjector"] = {
    pointer: async (x, y, click) => {
      await this.runScript("pointer", { x, y, ...(click ?? {}) });
    },
    keys: async (combo, times = 1) => {
      await this.runScript("keys", { keys: combo, times });
    },
    type: async (text) => {
      await this.runScript("type", { text });
    },
    scroll: async (notches) => {
      await this.runScript("scroll", { notches });
    },
  };

  readonly screenCapture: PlatformAdapter["screenCapture"] = {
    captureScreen: async (outPath) => {
      await this.runScript("capture", { outPath });
    },
    captureWindow: async (window, outPath) => {
      await this.runScript("capture", { windowId: window.id, outPath });
    },
  };

  readonly clipboard: NonNullable<PlatformAdapter["clipboard"]> = {
    read: () => this.runScript("clipboard-read", {}),
    write: async (text: string) => {
      await this.runScript("clipboard-write", { text });
    },
  };

  readonly media: NonNullable<PlatformAdapter["media"]> = {
    nowPlaying: async () => [],
    control: async (action: MediaAction): Promise<NowPlaying | null> => {
      await this.runScript("media-control", { action });
      return null;
    },
    getVolume: async () => {
      const parsed = JSON.parse(await this.runScript("volume-get", {})) as {
        percent?: number;
        muted?: boolean;
      };
      return {
        percent: typeof parsed.percent === "number" ? parsed.percent : 50,
        muted: parsed.muted === true,
      };
    },
    setVolume: async (percent: number) => {
      const parsed = JSON.parse(
        await this.runScript("volume-set", {
          percent: Math.min(100, Math.max(0, Math.round(percent))),
        }),
      ) as { percent?: number; muted?: boolean };
      return {
        percent: typeof parsed.percent === "number" ? parsed.percent : Math.round(percent),
        muted: parsed.muted === true,
      };
    },
    setMuted: async (muted: boolean) => {
      const parsed = JSON.parse(await this.runScript("volume-mute", { muted })) as {
        percent?: number;
        muted?: boolean;
      };
      return {
        percent: typeof parsed.percent === "number" ? parsed.percent : 50,
        muted: parsed.muted === true,
      };
    },
  };

  readonly audioLoopback: PlatformAdapter["audioLoopback"] = {
    isAvailable: async () => (await this.runScript("wasapi-check", {})).trim() === "true",
    listStreams: async (): Promise<PlatformAudioStream[]> => {
      const raw = await this.runScript("wasapi-streams", {});
      const list = JSON.parse(raw) as unknown;
      if (!Array.isArray(list)) return [];
      return list
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          id: String(item["id"] ?? ""),
          app: String(item["app"] ?? "unknown"),
          mediaName: String(item["mediaName"] ?? ""),
        }));
    },
    spawnCapture: (source = "default") =>
      spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath, "wasapi-capture"],
        { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, AI_CHAN_WASAPI_SOURCE: source } },
      ),
  };

  readonly systemNotices: PlatformAdapter["systemNotices"] = {
    isAvailable: async () => true,
    spawnMonitor: (): MonitorChild => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath, "notices-monitor"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const MAX_LINE_CHARS = 16_384;
      let heard: ((line: string) => void) | null = null;
      let pending = "";
      let skipping = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        let rest = chunk;
        for (let at = rest.indexOf("\n"); at !== -1; at = rest.indexOf("\n")) {
          const line = pending + rest.slice(0, at);
          rest = rest.slice(at + 1);
          pending = "";
          if (skipping) skipping = false;
          else if (line.length <= MAX_LINE_CHARS) heard?.(line);
        }
        if (skipping) return;
        pending += rest;
        if (pending.length > MAX_LINE_CHARS) {
          pending = "";
          skipping = true;
        }
      });
      let ended = false;
      let listener: ((how: { missing: boolean }) => void) | null = null;
      let how: { missing: boolean } | null = null;
      const end = (missing: boolean): void => {
        if (ended) return;
        ended = true;
        heard = null;
        how = { missing };
        listener?.(how);
      };
      child.on("error", (error: NodeJS.ErrnoException) => end(error.code === "ENOENT"));
      child.on("exit", () => end(false));
      return {
        onLine: (listen) => {
          heard = listen;
        },
        onExit: (ended_) => {
          listener = ended_;
          if (how) ended_(how);
        },
        kill: () => {
          if (!ended) child.kill("SIGTERM");
        },
      };
    },
  };

  readonly gameDetector: PlatformAdapter["gameDetector"] = {
    activeFullscreenGame: async () => {
      const state = parseQunsState(await this.runScript("game-state", {}));
      return state.fullscreenGame ? (state.processName ?? state.state) : null;
    },
    gpuVramStatus: async () => {
      return parseWin32GpuVramJson(await this.runScript("gpu-vram", {}));
    },
  };
}
