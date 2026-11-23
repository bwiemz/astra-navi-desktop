import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopLayout, MediaAction, NowPlaying, WindowAction, WindowDetail } from "../desktop.ts";
import type { Control, ControlList } from "../hands.ts";
import type { MonitorChild } from "../notices.ts";
import type { PlatformAdapter, PlatformAudioStream, PlatformGpuVramStatus } from "./adapter.ts";

const execFileAsync = promisify(execFile);

export type MacOsCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface MacOsAdapterOptions {
  runCommand?: MacOsCommandRunner;
  spawnCommand?: (command: string, args: readonly string[]) => ChildProcess;
}

const KNOWN_MAC_GAME_APPS = [
  "minecraft",
  "steam_osx",
  "cyberpunk",
  "baldur",
  "elden",
  "factorio",
  "hollow knight",
  "roblox",
  "genshin",
  "blender",
  "unity",
  "unreal",
];

/** Validates JXA window enumeration JSON produced on macOS. */
export function parseMacOsWindowsJson(raw: string): DesktopLayout {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { windows: [], width: 1728, height: 1117 };
  }
  const width = typeof parsed["width"] === "number" && parsed["width"] > 0 ? parsed["width"] : 1728;
  const height = typeof parsed["height"] === "number" && parsed["height"] > 0 ? parsed["height"] : 1117;
  const rawList = Array.isArray(parsed["windows"]) ? parsed["windows"] : [];
  const windows: WindowDetail[] = [];

  for (const item of rawList) {
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
    const winW = typeof w["width"] === "number" ? w["width"] : 0;
    const winH = typeof w["height"] === "number" ? w["height"] : 0;
    if (winW <= 0 || winH <= 0) continue;
    windows.push({
      id: w["id"],
      title: w["title"].slice(0, 160),
      app: w["app"],
      pid: w["pid"],
      active: w["active"] === true,
      minimized: w["minimized"] === true,
      fullScreen: w["fullScreen"] === true,
      dialog: w["dialog"] === true,
      ...(typeof w["order"] === "number" ? { order: w["order"] } : {}),
      x: typeof w["x"] === "number" ? w["x"] : 0,
      y: typeof w["y"] === "number" ? w["y"] : 0,
      width: winW,
      height: winH,
    });
  }
  return { windows, width, height };
}

/** Validates macOS AXUIElement accessibility tree JSON. */
export function parseMacOsAxControlsJson(raw: string): Control[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const controls: Control[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const kind = typeof c["kind"] === "string" ? c["kind"] : "button";
    const name = typeof c["name"] === "string" ? c["name"].trim() : "";
    if (!name) continue;
    controls.push({
      n: typeof c["n"] === "number" ? c["n"] : controls.length + 1,
      kind,
      name: name.slice(0, 120),
      on: c["on"] === true,
      value: typeof c["value"] === "string" ? c["value"] : "",
      focused: c["focused"] === true,
    });
  }
  return controls;
}

/** Parses macOS `system_profiler SPAudioDataType -json` output into audio stream metadata. */
export function parseCoreAudioDevices(rawJson: string): PlatformAudioStream[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const sections = Array.isArray(parsed["SPAudioDataType"]) ? parsed["SPAudioDataType"] : [];
  const streams: PlatformAudioStream[] = [];
  for (const sec of sections) {
    if (typeof sec !== "object" || sec === null) continue;
    const items = Array.isArray((sec as Record<string, unknown>)["_items"])
      ? ((sec as Record<string, unknown>)["_items"] as unknown[])
      : [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const dev = item as Record<string, unknown>;
      const name = typeof dev["_name"] === "string" ? dev["_name"].trim() : "";
      if (!name) continue;
      streams.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        app: typeof dev["coreaudio_device_manufacturer"] === "string" ? dev["coreaudio_device_manufacturer"] : "CoreAudio",
        mediaName: name,
      });
    }
  }
  return streams;
}

/**
 * Infers Apple Silicon unified memory budget (`source: "metal"`, ~75% Metal wired limit)
 * from `sysctl -n hw.memsize`, `vm_stat`, and `sysctl -n machdep.cpu.brand_string`.
 */
export function parseMacOsSysctlMemory(
  hwMemsizeOut: string,
  vmStatOut: string,
  brandOut: string,
): PlatformGpuVramStatus & {
  unifiedMemory: boolean;
  totalSystemBytes: number;
  chipName: string;
  estimatedBandwidthGbps: number;
} {
  const totalSystemBytes = Number(hwMemsizeOut.trim()) || 0;
  const chipName = brandOut.trim() || "Apple Silicon";
  const isAppleSilicon = /apple\s+m[1-9]/i.test(chipName) || /apple silicon/i.test(chipName);

  const pageSizeMatch = /page size of (\d+) bytes/i.exec(vmStatOut);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16_384;
  const pagesFree = Number(/Pages free:\s+(\d+)/i.exec(vmStatOut)?.[1] ?? "0");
  const pagesInactive = Number(/Pages inactive:\s+(\d+)/i.exec(vmStatOut)?.[1] ?? "0");
  const reclaimableBytes = (pagesFree + pagesInactive) * pageSize;

  // Apple Silicon Metal max recommended working set is ~75% of unified memory.
  const metalBudgetBytes = isAppleSilicon ? Math.round(totalSystemBytes * 0.75) : Math.round(totalSystemBytes * 0.45);
  const freeBytes = Math.min(metalBudgetBytes, Math.max(reclaimableBytes, Math.round(metalBudgetBytes * 0.65)));

  let estimatedBandwidthGbps = 120;
  if (/ultra/i.test(chipName)) estimatedBandwidthGbps = 800;
  else if (/max/i.test(chipName)) estimatedBandwidthGbps = 400;
  else if (/pro/i.test(chipName)) estimatedBandwidthGbps = 200;

  return {
    totalBytes: metalBudgetBytes,
    freeBytes,
    utilizationPercent:
      metalBudgetBytes > 0
        ? Math.max(0, Math.min(100, Math.round(((metalBudgetBytes - freeBytes) / metalBudgetBytes) * 100)))
        : 0,
    source: "metal",
    unifiedMemory: isAppleSilicon,
    totalSystemBytes,
    chipName,
    estimatedBandwidthGbps,
  };
}

async function defaultRun(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    timeout: 8_000,
    encoding: "utf8",
  });
  return { stdout, stderr };
}

/**
 * macOS (`darwin`) platform adapter backed by JXA/AXUIElement, Quartz CGEvents,
 * `screencapture` / ScreenCaptureKit permissions, CoreAudio, and Apple Silicon Metal telemetry.
 */
export class MacOsPlatformAdapter implements PlatformAdapter {
  readonly platform = "darwin" as const;
  private readonly runCommand: MacOsCommandRunner;
  private readonly spawnCommand: (command: string, args: readonly string[]) => ChildProcess;

  constructor(options: MacOsAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? defaultRun;
    this.spawnCommand =
      options.spawnCommand ??
      ((command, args) =>
        spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  }

  private async jxa<T>(script: string): Promise<T | null> {
    try {
      const { stdout } = await this.runCommand("osascript", ["-l", "JavaScript", "-e", script]);
      return JSON.parse(stdout) as T;
    } catch {
      return null;
    }
  }

  readonly windowManager: PlatformAdapter["windowManager"] = {
    layout: async (): Promise<DesktopLayout> => {
      const script = `
        const se = Application("System Events");
        const finder = Application("Finder");
        const bounds = finder.desktop.window.bounds();
        const wins = [];
        for (const p of se.applicationProcesses.whose({ backgroundOnly: false })()) {
          const appName = p.name();
          const pid = p.unixId();
          const active = p.frontmost();
          for (const w of p.windows()) {
            const pos = w.position();
            const sz = w.size();
            wins.push({
              id: pid + ":" + w.name(),
              title: w.name(),
              app: appName,
              pid,
              active,
              minimized: false,
              fullScreen: Boolean(w.attributes.byName("AXFullScreen").value()),
              dialog: false,
              x: pos[0], y: pos[1], width: sz[0], height: sz[1]
            });
          }
        }
        JSON.stringify({ width: bounds[2] || 1728, height: bounds[3] || 1117, windows: wins });
      `;
      try {
        const { stdout } = await this.runCommand("osascript", ["-l", "JavaScript", "-e", script]);
        return parseMacOsWindowsJson(stdout);
      } catch {
        return { windows: [], width: 1728, height: 1117 };
      }
    },

    windowAt: async (x: number, y: number) => {
      const { windows } = await this.windowManager.layout();
      const hit = windows.find(
        (w) => !w.minimized && x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height,
      );
      return hit ? { id: hit.id, app: hit.app, title: hit.title } : null;
    },

    act: async (windowId: string, action: WindowAction): Promise<boolean> => {
      const pid = Number(windowId.split(":")[0]);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const script = `
        const se = Application("System Events");
        const proc = se.applicationProcesses.whose({ unixId: ${pid} })[0];
        if (!proc) { JSON.stringify(false); } else {
          if (${JSON.stringify(action)} === "activate" || ${JSON.stringify(action)} === "restore") {
            proc.frontmost = true;
          } else if (${JSON.stringify(action)} === "minimize" && proc.windows.length > 0) {
            proc.windows[0].attributes.byName("AXMinimized").value = true;
          } else if (${JSON.stringify(action)} === "close" && proc.windows.length > 0) {
            proc.windows[0].actions.byName("AXClose")?.perform?.();
          }
          JSON.stringify(true);
        }
      `;
      return (await this.jxa<boolean>(script)) === true;
    },

    lockScreen: async (): Promise<void> => {
      await this.runCommand("osascript", [
        "-e",
        'tell application "System Events" to keystroke "q" using {command down, control down}',
      ]);
    },
  };

  readonly accessibilityTree: PlatformAdapter["accessibilityTree"] = {
    controls: async (target, words): Promise<ControlList> => {
      const script = `
        const se = Application("System Events");
        const proc = se.applicationProcesses.whose({ unixId: ${target.pid} })[0];
        const out = [];
        if (proc && proc.windows.length > 0) {
          const w = proc.windows[0];
          for (const el of w.entireContents()) {
            const role = String(el.role() || "");
            const name = String(el.title() || el.description() || el.name() || "");
            if (!name) continue;
            if (role === "AXButton" || role === "AXTextField" || role === "AXCheckBox" || role === "AXPopUpButton") {
              out.push({ kind: role.replace(/^AX/, "").toLowerCase(), name, on: Boolean(el.value()), value: String(el.value() || ""), focused: Boolean(el.focused()), path: [out.length] });
              if (out.length >= 80) break;
            }
          }
        }
        JSON.stringify(out);
      `;
      try {
        const { stdout } = await this.runCommand("osascript", ["-l", "JavaScript", "-e", script]);
        let controls = parseMacOsAxControlsJson(stdout);
        if (words) {
          const needle = words.toLowerCase();
          controls = controls.filter((c) => c.name.toLowerCase().includes(needle));
        }
        return { window: target.title, controls, more: 0, text: [] };
      } catch {
        return { window: target.title, controls: [], more: 0, text: [] };
      }
    },

    press: async (target, control) => {
      const list = await this.accessibilityTree.controls(target, control.name);
      const picked =
        control.which !== undefined
          ? list.controls[control.which - 1]
          : list.controls.find((c) => !control.name || c.name === control.name);
      if (!picked) {
        throw new Error(`macOS AXUIElement control "${control.name ?? `#${control.which ?? 1}`}" not found.`);
      }
      const elementIdx = Math.max(0, picked.n - 1);
      await this.runCommand("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `const se = Application("System Events"); const p = se.applicationProcesses.whose({ unixId: ${target.pid} })[0]; if (p && p.windows.length > 0) { const els = p.windows[0].entireContents(); const hit = els[${elementIdx}]; if (hit) hit.click(); }`,
      ]);
      return { kind: picked.kind, name: picked.name, on: !picked.on };
    },

    fill: async (target, control, text) => {
      const list = await this.accessibilityTree.controls(target, control.name);
      const picked =
        control.which !== undefined
          ? list.controls[control.which - 1]
          : list.controls.find((c) => !control.name || c.name === control.name);
      if (!picked) {
        throw new Error(`macOS text field "${control.name ?? `#${control.which ?? 1}`}" not found.`);
      }
      const elementIdx = Math.max(0, picked.n - 1);
      await this.runCommand("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `const se = Application("System Events"); const p = se.applicationProcesses.whose({ unixId: ${target.pid} })[0]; if (p && p.windows.length > 0) { const els = p.windows[0].entireContents(); const hit = els[${elementIdx}]; if (hit) { hit.focused = true; hit.value = ${JSON.stringify(text)}; } }`,
      ]);
      return { field: picked.name, now: text };
    },
  };

  readonly inputInjector: PlatformAdapter["inputInjector"] = {
    pointer: async (x, y, click): Promise<void> => {
      const script = `
        ObjC.import("ApplicationServices");
        const pt = { x: ${Math.round(x)}, y: ${Math.round(y)} };
        const move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, move);
        ${
          click
            ? `const downType = ${click.button === "right" ? "$.kCGEventRightMouseDown" : "$.kCGEventLeftMouseDown"};
               const upType = ${click.button === "right" ? "$.kCGEventRightMouseUp" : "$.kCGEventLeftMouseUp"};
               const btn = ${click.button === "right" ? "$.kCGMouseButtonRight" : "$.kCGMouseButtonLeft"};
               for (let i = 0; i < ${Math.max(1, click.clicks)}; i++) {
                 $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, downType, pt, btn));
                 $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, upType, pt, btn));
               }`
            : ""
        }
      `;
      await this.runCommand("osascript", ["-l", "JavaScript", "-e", script]);
    },

    keys: async (combo, times = 1): Promise<void> => {
      const modifiers: string[] = [];
      let mainKey = combo[combo.length - 1] ?? "";
      for (const part of combo.slice(0, -1)) {
        const lower = part.toLowerCase();
        if (lower === "cmd" || lower === "command" || lower === "super") modifiers.push("command down");
        else if (lower === "ctrl" || lower === "control") modifiers.push("control down");
        else if (lower === "alt" || lower === "option") modifiers.push("option down");
        else if (lower === "shift") modifiers.push("shift down");
      }
      mainKey = mainKey.replace(/["\\]/g, "");
      const usingClause = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
      const repeat = Math.max(1, Math.min(20, times));
      await this.runCommand("osascript", [
        "-e",
        `repeat ${repeat} times\ntell application "System Events" to keystroke "${mainKey}"${usingClause}\nend repeat`,
      ]);
    },

    type: async (text): Promise<void> => {
      await this.runCommand("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `Application("System Events").keystroke(${JSON.stringify(text)})`,
      ]);
    },

    scroll: async (notches): Promise<void> => {
      await this.runCommand("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("ApplicationServices"); const ev = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, ${Math.trunc(notches)}); $.CGEventPost($.kCGHIDEventTap, ev);`,
      ]);
    },
  };

  readonly clipboard: NonNullable<PlatformAdapter["clipboard"]> = {
    read: async () => {
      const { stdout } = await this.runCommand("pbpaste", []);
      return stdout;
    },
    write: async (text) => {
      await this.runCommand("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `const app = Application.currentApplication(); app.includeStandardAdditions = true; app.setTheClipboardTo(${JSON.stringify(text)});`,
      ]);
    },
  };

  readonly media: NonNullable<PlatformAdapter["media"]> = {
    nowPlaying: async () => {
      const res = await this.jxa<NowPlaying[]>(
        `const out = []; for (const name of ["Music", "Spotify"]) { try { const a = Application(name); if (a.running() && a.playerState() !== "stopped") { const t = a.currentTrack(); out.push({ player: name, status: String(a.playerState() || "playing"), title: String(t.name() || ""), artist: String(t.artist() || "") }); } } catch {} } JSON.stringify(out);`,
      );
      return res ?? [];
    },
    control: async (action: MediaAction) => {
      const op =
        action === "play"
          ? "play()"
          : action === "pause"
            ? "pause()"
            : action === "play_pause"
              ? "playpause()"
              : action === "next"
                ? "nextTrack()"
                : "previousTrack()";
      await this.jxa(
        `for (const name of ["Music", "Spotify"]) { try { const a = Application(name); if (a.running()) { a.${op}; break; } } catch {} } JSON.stringify(true);`,
      );
      const list = await this.media.nowPlaying();
      return list[0] ?? null;
    },
    getVolume: async () => {
      const res = await this.jxa<{ percent: number; muted: boolean }>(
        `const a = Application.currentApplication(); a.includeStandardAdditions = true; const s = a.getVolumeSettings(); JSON.stringify({ percent: s.outputVolume, muted: s.outputMuted });`,
      );
      return res ?? { percent: 50, muted: false };
    },
    setVolume: async (percent) => {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      await this.runCommand("osascript", ["-e", `set volume output volume ${clamped}`]);
      return this.media.getVolume();
    },
    setMuted: async (muted) => {
      await this.runCommand("osascript", ["-e", `set volume output muted ${muted ? "true" : "false"}`]);
      return this.media.getVolume();
    },
  };

  readonly screenCapture: PlatformAdapter["screenCapture"] = {
    captureWindow: async (window, outPath): Promise<void> => {
      const rect = `${Math.round(window.x)},${Math.round(window.y)},${Math.max(1, Math.round(window.width))},${Math.max(1, Math.round(window.height))}`;
      await this.runCommand("screencapture", ["-x", "-t", "png", "-R", rect, outPath]);
    },
    captureScreen: async (outPath): Promise<void> => {
      await this.runCommand("screencapture", ["-x", "-t", "png", outPath]);
    },
  };

  readonly audioLoopback: PlatformAdapter["audioLoopback"] = {
    isAvailable: async () => {
      const streams = await this.audioLoopback.listStreams();
      return streams.length > 0;
    },
    listStreams: async () => {
      try {
        const { stdout } = await this.runCommand("system_profiler", ["SPAudioDataType", "-json"]);
        return parseCoreAudioDevices(stdout);
      } catch {
        return [];
      }
    },
  };

  readonly systemNotices: PlatformAdapter["systemNotices"] = {
    isAvailable: async () => true,
    spawnMonitor: () =>
      this.spawnCommand("log", [
        "stream",
        "--predicate",
        'subsystem == "com.apple.unc"',
        "--style",
        "ndjson",
      ]) as unknown as MonitorChild,
  };

  readonly gameDetector: PlatformAdapter["gameDetector"] = {
    activeFullscreenGame: async () => {
      const { windows } = await this.windowManager.layout();
      const fs = windows.find((w) => {
        if (!w.fullScreen || w.minimized) return false;
        const lower = w.app.toLowerCase();
        return KNOWN_MAC_GAME_APPS.some((g) => lower.includes(g));
      });
      return fs ? fs.app : null;
    },

    gpuVramStatus: async () => {
      try {
        const [{ stdout: memOut }, { stdout: vmOut }, { stdout: brandOut }] = await Promise.all([
          this.runCommand("sysctl", ["-n", "hw.memsize"]),
          this.runCommand("vm_stat", []),
          this.runCommand("sysctl", ["-n", "machdep.cpu.brand_string"]),
        ]);
        const info = parseMacOsSysctlMemory(memOut, vmOut, brandOut);
        return {
          totalBytes: info.totalBytes,
          freeBytes: info.freeBytes,
          utilizationPercent: info.utilizationPercent,
          source: info.source,
        };
      } catch {
        return null;
      }
    },
  };
}
