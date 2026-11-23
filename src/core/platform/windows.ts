import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

export interface WinWorkerRpcResponse {
  id?: unknown;
  ok?: unknown;
  data?: unknown;
  error?: unknown;
}

export interface PersistentWinWorkerOptions {
  command: string;
  args: readonly string[];
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { stdio: ["pipe", "pipe", "pipe"] },
  ) => ChildProcess;
}

/**
 * Keeps a single stdio worker process alive (`win-hands.exe --serve` or `win_hands.ps1 -Serve`)
 * and multiplexes newline-delimited JSON-RPC calls to avoid process spawn overhead on every action.
 */
export class PersistentWinWorker {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly spawnProcess: NonNullable<PersistentWinWorkerOptions["spawnProcess"]>;
  private child: ChildProcess | null = null;
  private disposed = false;
  private seq = 0;
  private lineBuffer = "";
  private readonly pending = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(options: PersistentWinWorkerOptions) {
    this.command = options.command;
    this.args = options.args;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxLineBytes = options.maxLineBytes ?? 4 * 1024 * 1024;
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, opts) => spawn(command, [...args], opts));
  }

  private ensureStarted(): ChildProcess {
    if (this.disposed) throw new Error("Persistent Windows worker has been disposed.");
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;

    const proc = this.spawnProcess(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = proc;
    this.lineBuffer = "";

    const failAll = (reason: string): void => {
      if (this.child === proc) this.child = null;
      for (const [id, entry] of this.pending.entries()) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
    };

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      this.lineBuffer += chunk;
      if (this.lineBuffer.length > this.maxLineBytes) {
        this.lineBuffer = "";
        proc.kill();
        failAll("Windows persistent worker exceeded maximum response size.");
        return;
      }
      for (let nl = this.lineBuffer.indexOf("\n"); nl !== -1; nl = this.lineBuffer.indexOf("\n")) {
        const rawLine = this.lineBuffer.slice(0, nl).trim();
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        if (!rawLine) continue;
        let parsed: WinWorkerRpcResponse;
        try {
          parsed = JSON.parse(rawLine) as WinWorkerRpcResponse;
        } catch {
          continue;
        }
        const id = typeof parsed.id === "string" ? parsed.id : String(parsed.id ?? "");
        const waiter = this.pending.get(id);
        if (!waiter) continue;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        if (parsed.ok === true) {
          waiter.resolve(typeof parsed.data === "string" ? parsed.data : JSON.stringify(parsed.data ?? ""));
        } else {
          waiter.reject(new Error(typeof parsed.error === "string" ? parsed.error : "Windows worker error."));
        }
      }
    });

    const stderrTail: string[] = [];
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      if (stderrTail.length < 10) stderrTail.push(chunk.slice(0, 500));
    });

    proc.on("error", (err) => {
      failAll(err.message || "Windows worker failed to start.");
    });
    proc.on("exit", (code, signal) => {
      const detail = stderrTail.join("").trim();
      failAll(
        detail ||
          `Windows persistent worker exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`}).`,
      );
    });

    return proc;
  }

  call(verb: string, payload: unknown): Promise<string> {
    const proc = this.ensureStarted();
    const id = `w-${++this.seq}`;
    const line = `${JSON.stringify({ id, verb, payload: payload ?? {} })}\n`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        proc.kill();
        if (this.child === proc) this.child = null;
        reject(new Error(`Windows helper timed out on ${verb}.`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin?.write(line, "utf8", (err) => {
          if (!err) return;
          const waiter = this.pending.get(id);
          if (!waiter) return;
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(err);
        });
      } catch (err) {
        const waiter = this.pending.get(id);
        if (waiter) {
          this.pending.delete(id);
          clearTimeout(waiter.timer);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  dispose(): void {
    this.disposed = true;
    const proc = this.child;
    this.child = null;
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error("Windows worker disposed."));
    }
    if (proc && !proc.killed) {
      proc.stdin?.end();
      proc.kill();
    }
  }
}

export function resolveNativeWinHandsBinary(
  scriptPath: string,
  explicitPath?: string,
  checkExists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = [
    explicitPath,
    process.env["ASTRA_NAVI_WIN_HANDS_BIN"],
    join(dirname(scriptPath), "win-hands-native", "win-hands.exe"),
    join(dirname(scriptPath), "win-hands-native", "bin", "win-hands.exe"),
    join(dirname(scriptPath), "win-hands-native", "bin", "Release", "net9.0", "win-x64", "publish", "win-hands.exe"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((candidate) => checkExists(candidate)) ?? null;
}

export class WindowsPlatformAdapter implements PlatformAdapter {
  readonly platform = "win32" as const;
  private readonly scriptPath: string;
  private readonly runScript: (verb: string, payload: unknown) => Promise<string>;
  private readonly primaryWorker: PersistentWinWorker | null;
  private readonly fallbackWorker: PersistentWinWorker | null;
  private readonly workerKind: "native" | "powershell" | "custom";

  constructor(options: {
    scriptPath: string;
    nativeBinaryPath?: string;
    requestTimeoutMs?: number;
    spawnProcess?: PersistentWinWorkerOptions["spawnProcess"];
    runScript?: (verb: string, payload: unknown) => Promise<string>;
  }) {
    this.scriptPath = options.scriptPath;
    if (options.runScript) {
      this.primaryWorker = null;
      this.fallbackWorker = null;
      this.workerKind = "custom";
      this.runScript = options.runScript;
      return;
    }

    const nativeBin = resolveNativeWinHandsBinary(options.scriptPath, options.nativeBinaryPath);
    const hasFallbackScript = Boolean(options.spawnProcess) || existsSync(this.scriptPath);
    const psArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
      "-Serve",
    ];
    if (nativeBin) {
      this.workerKind = "native";
      const nativeWorker = new PersistentWinWorker({
        command: nativeBin,
        args: ["--serve"],
        requestTimeoutMs: options.requestTimeoutMs,
        spawnProcess: options.spawnProcess,
      });
      const psWorker = hasFallbackScript
        ? new PersistentWinWorker({
            command: "powershell.exe",
            args: psArgs,
            requestTimeoutMs: options.requestTimeoutMs,
            spawnProcess: options.spawnProcess,
          })
        : null;
      this.primaryWorker = nativeWorker;
      this.fallbackWorker = psWorker;
      this.runScript = async (verb, payload) => {
        if (verb === "controls" || verb === "press" || verb === "fill") {
          if (!psWorker) {
            throw new Error(
              `Action "${verb}" requires hands/win_hands.ps1 which is excluded from packaged Windows builds.`,
            );
          }
          return psWorker.call(verb, payload);
        }
        try {
          return await nativeWorker.call(verb, payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("UIA_FALLBACK") && psWorker) {
            return psWorker.call(verb, payload);
          }
          throw err;
        }
      };
    } else {
      this.workerKind = "powershell";
      const psWorker = hasFallbackScript
        ? new PersistentWinWorker({
            command: "powershell.exe",
            args: psArgs,
            requestTimeoutMs: options.requestTimeoutMs,
            spawnProcess: options.spawnProcess,
          })
        : null;
      this.primaryWorker = psWorker;
      this.fallbackWorker = null;
      this.runScript = (verb, payload) => {
        if (!psWorker) {
          return Promise.reject(
            new Error(
              "Windows desktop automation requires win-hands.exe (hands/win_hands.ps1 is excluded from packaged builds).",
            ),
          );
        }
        return psWorker.call(verb, payload);
      };
    }
  }

  activeWorkerKind(): "native" | "powershell" | "custom" {
    return this.workerKind;
  }

  dispose(): void {
    this.primaryWorker?.dispose();
    this.fallbackWorker?.dispose();
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
