import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import { gameOnCard } from "../cardWatch.ts";
import {
  actOnWindow,
  controlMedia,
  desktopLayout,
  getVolume,
  lockScreen,
  nowPlaying,
  readClipboard,
  rehearsing,
  setMuted,
  setVolume,
  windowAt,
  writeClipboard,
  type DesktopLayout,
  type WindowAction,
  type WindowDetail,
} from "../desktop.ts";
import type { ControlList, Hands } from "../hands.ts";
import { startMonitor } from "../notices.ts";
import { SHIP_EARS_RATE } from "../shipEars.ts";
import type { PlatformAdapter, PlatformAudioStream } from "./adapter.ts";

const execFileAsync = promisify(execFile);

/** Parses `pw-dump` JSON output for active application audio streams. */
export function parsePipeWireStreams(pwDumpJson: string): PlatformAudioStream[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pwDumpJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const streams: PlatformAudioStream[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const info = obj["info"] as Record<string, unknown> | undefined;
    const props = info?.["props"] as Record<string, unknown> | undefined;
    if (!props) continue;
    if (props["media.class"] !== "Stream/Output/Audio") continue;
    streams.push({
      id: String(obj["id"] ?? ""),
      app: String(props["application.name"] ?? props["node.name"] ?? "unknown"),
      mediaName: String(props["media.name"] ?? ""),
    });
  }
  return streams;
}

export class LinuxPlatformAdapter implements PlatformAdapter {
  readonly platform = "linux" as const;
  private readonly scriptDir: string;
  private readonly hands?: Hands;

  constructor(options: { scriptDir: string; hands?: Hands }) {
    this.scriptDir = options.scriptDir;
    this.hands = options.hands;
  }

  private requireHands(): Hands {
    if (!this.hands) throw new Error("Desktop hands helper is not available.");
    return this.hands;
  }

  readonly windowManager: PlatformAdapter["windowManager"] = {
    layout: (): Promise<DesktopLayout> => desktopLayout(this.scriptDir),
    windowAt: (x: number, y: number) => windowAt(this.scriptDir, x, y),
    act: (windowId: string, action: WindowAction) => actOnWindow(this.scriptDir, windowId, action),
    lockScreen: () => lockScreen(),
  };

  readonly accessibilityTree: PlatformAdapter["accessibilityTree"] = {
    controls: (target, words): Promise<ControlList> => this.requireHands().controls(target, words),
    press: (target, control) => this.requireHands().press(target, control),
    fill: (target, control, text) => this.requireHands().fill(target, control, text),
  };

  readonly inputInjector: PlatformAdapter["inputInjector"] = {
    pointer: (x, y, click) => this.requireHands().pointer(x, y, click),
    keys: (combo, times) => this.requireHands().keys(combo, times),
    scroll: (notches) => this.requireHands().scroll(notches),
    type: async (text: string) => {
      const hands = this.requireHands();
      const before = await readClipboard().catch(() => null);
      await writeClipboard(text);
      try {
        if (!rehearsing()) await hands.keys(["ctrl", "v"], 1);
      } finally {
        if (before !== null) await writeClipboard(before).catch(() => undefined);
      }
    },
  };

  readonly clipboard: NonNullable<PlatformAdapter["clipboard"]> = {
    read: () => readClipboard(),
    write: (text: string) => writeClipboard(text),
  };

  readonly media: NonNullable<PlatformAdapter["media"]> = {
    nowPlaying: () => nowPlaying(),
    control: (action) => controlMedia(action),
    getVolume: () => getVolume(),
    setVolume: (percent: number) => setVolume(percent),
    setMuted: (muted: boolean) => setMuted(muted),
  };

  readonly screenCapture: PlatformAdapter["screenCapture"] = {
    captureScreen: async (outPath: string) => {
      await execFileAsync("spectacle", ["-b", "-n", "-f", "-o", outPath], { timeout: 10_000 });
    },
    captureWindow: async (window: WindowDetail, outPath: string) => {
      const fullTmp = `${outPath}.full.png`;
      try {
        await execFileAsync("spectacle", ["-b", "-n", "-f", "-o", fullTmp], { timeout: 10_000 });
        const meta = await sharp(fullTmp).metadata();
        const imgW = meta.width ?? 0;
        const imgH = meta.height ?? 0;
        if (imgW <= 0 || imgH <= 0) throw new Error("Screen capture returned an empty image.");
        const left = Math.max(0, Math.min(imgW - 1, Math.round(window.x)));
        const top = Math.max(0, Math.min(imgH - 1, Math.round(window.y)));
        const width = Math.max(1, Math.min(imgW - left, Math.round(window.width)));
        const height = Math.max(1, Math.min(imgH - top, Math.round(window.height)));
        await sharp(fullTmp).extract({ left, top, width, height }).png().toFile(outPath);
      } finally {
        await rm(fullTmp, { force: true }).catch(() => undefined);
      }
    },
  };

  readonly audioLoopback: PlatformAdapter["audioLoopback"] = {
    isAvailable: async () => {
      try {
        await execFileAsync("wpctl", ["--version"], { timeout: 3_000 });
        return true;
      } catch {
        return false;
      }
    },
    listStreams: async () => {
      try {
        const { stdout } = await execFileAsync("pw-dump", [], {
          timeout: 5_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return parsePipeWireStreams(stdout);
      } catch {
        return [];
      }
    },
    spawnCapture: (source = "@DEFAULT_MONITOR@") =>
      spawn(
        "parec",
        [
          `--device=${source}`,
          "--format=float32le",
          `--rate=${SHIP_EARS_RATE}`,
          "--channels=1",
          "--latency-msec=250",
          "--client-name=AI-chan",
          "--stream-name=what the PC is playing",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      ),
  };

  readonly systemNotices: PlatformAdapter["systemNotices"] = {
    isAvailable: async () => {
      try {
        await execFileAsync("busctl", ["--user", "status"], { timeout: 3_000 });
        return true;
      } catch {
        return false;
      }
    },
    spawnMonitor: () => startMonitor(),
  };

  readonly gameDetector: PlatformAdapter["gameDetector"] = {
    activeFullscreenGame: () => gameOnCard(),
    gpuVramStatus: async () => {
      try {
        const { stdout } = await execFileAsync(
          "nvidia-smi",
          ["--query-gpu=memory.total,memory.free,utilization.gpu", "--format=csv,noheader,nounits"],
          { timeout: 3_000, encoding: "utf8" },
        );
        const line = stdout.trim().split(/\r?\n/)[0] ?? "";
        const [totalMb, freeMb, utilPct] = line.split(",").map((s) => Number(s.trim()));
        if (totalMb === undefined || !Number.isFinite(totalMb) || totalMb <= 0) return null;
        const MIB = 1024 * 1024;
        return {
          totalBytes: Math.round(totalMb * MIB),
          freeBytes: Math.round((Number.isFinite(freeMb) ? (freeMb ?? 0) : 0) * MIB),
          ...(utilPct !== undefined && Number.isFinite(utilPct) ? { utilizationPercent: utilPct } : {}),
          source: "nvml",
        };
      } catch {
        return null;
      }
    },
  };
}
