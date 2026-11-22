import type { DesktopLayout, MediaAction, NowPlaying, WindowAction, WindowDetail } from "../desktop.ts";
import type { ControlList, Hands } from "../hands.ts";
import type { MonitorChild } from "../notices.ts";
import type { EarsProcess } from "../shipEars.ts";
import { LinuxPlatformAdapter } from "./linux.ts";
import { WindowsPlatformAdapter } from "./windows.ts";

export interface PlatformAudioStream {
  id: string;
  app: string;
  mediaName: string;
  volumePercent?: number;
  muted?: boolean;
}

export interface PlatformCompanionOverlay {
  install(options: {
    appId: string;
    title: string;
    scriptPath: string;
    margin: { right: number; bottom: number };
  }): Promise<(() => Promise<void>) | null>;
}

export interface PlatformGpuVramStatus {
  totalBytes: number;
  freeBytes: number;
  utilizationPercent?: number;
  source: "nvml" | "dxgi" | "unknown";
}

/**
 * Strict cross-platform boundary isolating OS-specific plumbing (KWin/AT-SPI/PipeWire on
 * Linux; Win32/UIA/WGC/WASAPI/DXGI on Windows) so `core/` safety invariants—full-name
 * control matching, foreground-window re-verification before clicks, terminal typing blocks,
 * and hands-off enforcement—remain identical across operating systems.
 */
export interface PlatformAdapter {
  readonly platform: "linux" | "win32";
  readonly windowManager: {
    layout(): Promise<DesktopLayout>;
    windowAt(x: number, y: number): Promise<{ id: string; app: string; title: string } | null>;
    act(windowId: string, action: WindowAction): Promise<boolean>;
    lockScreen(): Promise<void>;
    companionOverlay?: PlatformCompanionOverlay;
  };
  readonly accessibilityTree: {
    controls(target: { pid: number; title: string }, words?: string): Promise<ControlList>;
    press(
      target: { pid: number; title: string },
      control: { name?: string; which?: number },
    ): Promise<{ kind: string; name: string; on?: boolean }>;
    fill(
      target: { pid: number; title: string },
      control: { name?: string; which?: number },
      text: string,
    ): Promise<{ field: string; now: string }>;
  };
  readonly inputInjector: {
    pointer(
      x: number,
      y: number,
      click?: { button: "left" | "right" | "middle"; clicks: number },
    ): Promise<void>;
    keys(combo: readonly string[], times?: number): Promise<void>;
    type(text: string): Promise<void>;
    scroll(notches: number): Promise<void>;
  };
  readonly clipboard?: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };
  readonly media?: {
    nowPlaying(): Promise<NowPlaying[]>;
    control(action: MediaAction): Promise<NowPlaying | null>;
    getVolume(): Promise<{ percent: number; muted: boolean }>;
    setVolume(percent: number): Promise<{ percent: number; muted: boolean }>;
    setMuted(muted: boolean): Promise<{ percent: number; muted: boolean }>;
  };
  readonly screenCapture: {
    captureWindow(window: WindowDetail, outPath: string): Promise<void>;
    captureScreen(outPath: string): Promise<void>;
  };
  readonly audioLoopback: {
    isAvailable(): Promise<boolean>;
    listStreams(): Promise<PlatformAudioStream[]>;
    spawnCapture?(source?: string): EarsProcess;
  };
  readonly systemNotices: {
    isAvailable(): Promise<boolean>;
    spawnMonitor?(): MonitorChild;
  };
  readonly gameDetector: {
    activeFullscreenGame(): Promise<string | null>;
    gpuVramStatus?(): Promise<PlatformGpuVramStatus | null>;
  };
}

export interface PlatformAdapterOptions {
  platform?: NodeJS.Platform;
  scriptDir: string;
  hands?: Hands;
  winScriptPath?: string;
}

export function createPlatformAdapter(options: PlatformAdapterOptions): PlatformAdapter {
  const target = options.platform ?? process.platform;
  if (target === "win32") {
    return new WindowsPlatformAdapter({
      scriptPath: options.winScriptPath ?? "hands/win_hands.ps1",
    });
  }
  return new LinuxPlatformAdapter({
    scriptDir: options.scriptDir,
    hands: options.hands,
  });
}
