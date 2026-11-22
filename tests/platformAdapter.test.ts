import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolHost } from "../src/core/agentTools.ts";
import { createDesktopTools } from "../src/core/desktopTools.ts";
import { GameWatch } from "../src/core/gameWatch.ts";
import { Hands } from "../src/core/hands.ts";
import { createHandsTools } from "../src/core/handsTools.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { NoticeWatch } from "../src/core/notices.ts";
import { createPlatformAdapter } from "../src/core/platform/adapter.ts";
import { parsePipeWireStreams } from "../src/core/platform/linux.ts";
import {
  assertSafeDesktopDispatch,
  isTerminalApp,
  matchControlExact,
} from "../src/core/platform/safety.ts";
import {
  generateSecondaryDesktopScript,
  generateWindowsSandboxConfig,
} from "../src/core/platform/winSandbox.ts";
import {
  normalizeDpiCoords,
  parseQunsState,
  parseUiaControlsJson,
  parseWin32GpuVramJson,
  parseWin32WindowsJson,
  toVirtualDeskCoords,
  verifyTopWindowBeforeInput,
  WindowsPlatformAdapter,
} from "../src/core/platform/windows.ts";
import { TOOLS, type PolicyContext } from "../src/core/permissions.ts";
import { ShipEars, type EarsProcess } from "../src/core/shipEars.ts";
import { Sight } from "../src/core/sight.ts";

function fakeHost(workspace: string, policyOverrides: Partial<PolicyContext> = {}): ToolHost {
  let steps = 0;
  return {
    policy: () => ({ workspace, home: workspace, ...policyOverrides }),
    memory: new MemoryStore(join(workspace, "memories.json")),
    learnAddresses: () => undefined,
    noteOutsideText: () => undefined,
    noteChange: () => undefined,
    signal: () => undefined,
    activity: () => undefined,
    ran: () => undefined,
    ask: async () => true,
    step: () => ++steps,
  };
}

function invokeTool(
  tools: ReturnType<typeof createHandsTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const fn = tools[name];
  if (!fn) throw new Error(`Missing tool ${name}`);
  return (fn as { handler: (input: Record<string, unknown>) => Promise<string> }).handler(args);
}

describe("PlatformAdapter & Windows/Linux backends", () => {
  it("creates linux or win32 adapters via createPlatformAdapter", () => {
    const linux = createPlatformAdapter({ platform: "linux", scriptDir: "/tmp/s" });
    expect(linux.platform).toBe("linux");

    const win = createPlatformAdapter({ platform: "win32", scriptDir: "/tmp/s" });
    expect(win.platform).toBe("win32");
  });

  it("parses Win32 window layouts, UIA controls, QUNS game state, VRAM, and multi-monitor DPI coordinates", () => {
    const layout = parseWin32WindowsJson(
      JSON.stringify({
        width: 2560,
        height: 1440,
        windows: [
          {
            id: "12345",
            title: "settings.yaml - Visual Studio Code",
            app: "Code",
            active: true,
            minimized: false,
            pid: 9001,
            dpiScale: 1.5,
            x: 100,
            y: 80,
            width: 1200,
            height: 800,
          },
          { id: "bad", width: 0, height: 0 },
        ],
      }),
    );
    expect(layout.windows).toHaveLength(1);
    expect(layout.windows[0]?.pid).toBe(9001);
    expect(layout.windows[0]?.dpiScale).toBe(1.5);

    const controls = parseUiaControlsJson(
      JSON.stringify([
        {
          n: 1,
          kind: "button",
          name: "Save",
          greyed: false,
          rect: { x: 120, y: 110, width: 80, height: 28 },
        },
      ]),
    );
    expect(controls).toHaveLength(1);
    expect(controls[0]?.rect).toEqual({ x: 120, y: 110, width: 80, height: 28 });

    expect(
      parseQunsState(
        JSON.stringify({
          state: "QUNS_RUNNING_D3D_FULL_SCREEN",
          code: 3,
          process: "Starfield.exe",
          vramTotalBytes: 17179869184,
          vramFreeBytes: 4294967296,
          vramSource: "dxgi",
        }),
      ),
    ).toEqual({
      fullscreenGame: true,
      state: "QUNS_RUNNING_D3D_FULL_SCREEN",
      processName: "Starfield.exe",
      vram: { totalBytes: 17179869184, freeBytes: 4294967296, source: "dxgi" },
    });
    expect(parseQunsState("QUNS_ACCEPTS_NOTIFICATIONS").fullscreenGame).toBe(false);

    expect(parseWin32GpuVramJson(JSON.stringify({ totalBytes: 8589934592, freeBytes: 6442450944, source: "nvml", utilizationPercent: 42 }))).toEqual({
      totalBytes: 8589934592,
      freeBytes: 6442450944,
      utilizationPercent: 42,
      source: "nvml",
    });

    expect(normalizeDpiCoords(0.5, 0.25, layout, 1.5)).toEqual({ x: 1920, y: 540 });
    expect(normalizeDpiCoords(0.5, 0.5, layout, 1.25)).toEqual({ x: 1600, y: 900 });
    expect(normalizeDpiCoords(0.5, 0.5, layout, 2.0)).toEqual({ x: 2560, y: 1440 });
    // Negative origin secondary monitor on the left (-1920..+2560, total width 4480)
    expect(toVirtualDeskCoords(-1920, 0, { left: -1920, top: 0, width: 4480, height: 1440 })).toEqual({
      dx: 0,
      dy: 0,
    });
    expect(toVirtualDeskCoords(2560, 1440, { left: -1920, top: 0, width: 4480, height: 1440 })).toEqual({
      dx: 65535,
      dy: 65535,
    });
    expect(verifyTopWindowBeforeInput("12345", { id: "12345" })).toBe(true);
    expect(verifyTopWindowBeforeInput("12345", { id: "99999" })).toBe(false);
    expect(verifyTopWindowBeforeInput("12345", null)).toBe(false);
  });

  it("enforces cross-platform safety invariants (terminal blocking, exact control match, hands-off, foreground verification)", () => {
    // Both Linux and Windows terminals blocked for typing; editors editing scripts are allowed.
    expect(isTerminalApp("org.kde.konsole")).toBe(true);
    expect(isTerminalApp("wt.exe")).toBe(true);
    expect(isTerminalApp("powershell.exe")).toBe(true);
    expect(isTerminalApp("pwsh")).toBe(true);
    expect(isTerminalApp("cmd.exe", "Command Prompt")).toBe(true);
    expect(isTerminalApp("Code.exe", "powershell_notes.md - Visual Studio Code")).toBe(false);

    const sampleControls = [
      { n: 1, kind: "button", name: "Send" },
      { n: 2, kind: "button", name: "Send All" },
      { n: 3, kind: "button", name: "Save" },
      { n: 4, kind: "button", name: "Save" },
    ];
    expect(matchControlExact(sampleControls, { name: " send " })).toEqual({
      kind: "match",
      control: sampleControls[0],
    });
    // Substring "Sav" must NOT auto-click a partial match
    expect(matchControlExact(sampleControls, { name: "Sav" })).toMatchObject({
      kind: "ambiguous",
      exact: false,
    });
    // Exact duplicate needs disambiguation
    expect(matchControlExact(sampleControls, { name: "Save" })).toMatchObject({
      kind: "ambiguous",
      exact: true,
    });
    expect(matchControlExact(sampleControls, { which: 4 })).toEqual({
      kind: "match",
      control: sampleControls[3],
    });

    const target = { id: "101", app: "notepad.exe", title: "notes.txt - Notepad" };
    expect(
      assertSafeDesktopDispatch({ handsOff: true, action: "click", targetWindow: target, actualForeground: target })
        .allowed,
    ).toBe(false);
    expect(
      assertSafeDesktopDispatch({
        handsOff: false,
        action: "type",
        targetWindow: { id: "102", app: "powershell.exe", title: "Windows PowerShell" },
        actualForeground: { id: "102", app: "powershell.exe", title: "Windows PowerShell" },
      }).allowed,
    ).toBe(false);
    expect(
      assertSafeDesktopDispatch({
        handsOff: false,
        action: "click",
        targetWindow: { id: "103", app: "KeePassXC.exe", title: "Passwords" },
        actualForeground: { id: "103", app: "KeePassXC.exe", title: "Passwords" },
      }).allowed,
    ).toBe(false);
    expect(
      assertSafeDesktopDispatch({
        handsOff: false,
        action: "click",
        targetWindow: target,
        actualForeground: { id: "999", app: "other.exe", title: "Popup" },
      }).allowed,
    ).toBe(false);
    expect(
      assertSafeDesktopDispatch({
        handsOff: false,
        action: "type",
        targetWindow: target,
        actualForeground: target,
      }).allowed,
    ).toBe(true);
  });

  it("parses PipeWire stream nodes and executes core modules cleanly via mocked WindowsPlatformAdapter", async () => {
    const streams = parsePipeWireStreams(
      JSON.stringify([
        { id: 41, info: { props: { "media.class": "Stream/Output/Audio", "application.name": "Firefox", "media.name": "Music" } } },
        { id: 42, info: { props: { "media.class": "Audio/Sink", "node.name": "alsa" } } },
      ]),
    );
    expect(streams).toEqual([{ id: "41", app: "Firefox", mediaName: "Music" }]);

    const runScript = vi.fn(async (verb: string, payload: unknown) => {
      switch (verb) {
        case "game-state":
          return JSON.stringify({ state: "QUNS_RUNNING_D3D_FULL_SCREEN", code: 3, process: "EldenRing" });
        case "gpu-vram":
          return JSON.stringify({ totalBytes: 12_000_000_000, freeBytes: 2_000_000_000, source: "dxgi" });
        case "layout":
          return JSON.stringify({
            width: 1920,
            height: 1080,
            windows: [
              { id: "10", title: "draft.txt - Notepad", app: "notepad.exe", active: true, minimized: false, pid: 555, x: 0, y: 0, width: 900, height: 700 },
              { id: "20", title: "Windows PowerShell", app: "powershell.exe", active: false, minimized: false, pid: 666, x: 100, y: 100, width: 900, height: 600 },
            ],
          });
        case "controls":
          return JSON.stringify([
            { n: 1, kind: "button", name: "Send Report" },
            { n: 2, kind: "edit", name: "Message Body" },
          ]);
        case "press":
          return JSON.stringify({ kind: "button", name: "Send Report" });
        case "clipboard-read":
          return "copied-from-win32";
        case "volume-get":
          return JSON.stringify({ percent: 65, muted: false });
        case "volume-set":
          return JSON.stringify({ percent: (payload as { percent: number }).percent, muted: false });
        default:
          return "true";
      }
    });

    const win = new WindowsPlatformAdapter({ scriptPath: "hands/win_hands.ps1", runScript });
    expect(await win.gameDetector.activeFullscreenGame()).toBe("EldenRing");
    expect((await win.gameDetector.gpuVramStatus?.())?.totalBytes).toBe(12_000_000_000);
    expect(await win.windowManager.act("10", "focus")).toBe(true);
    expect(await win.clipboard?.read()).toBe("copied-from-win32");
    expect((await win.media?.setVolume(80))?.percent).toBe(80);

    const dir = await mkdtemp(join(tmpdir(), "aichan-win-adapter-"));
    try {
      const host = fakeHost(dir, {
        windows: async () => (await win.windowManager.layout()).windows,
      });
      const desktopTools = createDesktopTools(host, {
        scriptDir: dir,
        adapter: win,
        ownApps: ["ai-chan-desktop"],
      });
      const clipRes = await invokeTool(desktopTools, TOOLS.clipboard, { action: "read" });
      expect(clipRes).toContain("copied-from-win32");
      const volRes = await invokeTool(desktopTools, TOOLS.sound, { action: "set_volume", level: 42 });
      expect(volRes).toContain("42%");

      // Refactored HandsTools running over WindowsPlatformAdapter
      const dummyHands = new Hands({ script: "/unused/hands.py", adapter: win });
      let handsOffFlag = false;
      const handsTools = createHandsTools(host, {
        hands: dummyHands,
        adapter: win,
        isHandsOff: () => handsOffFlag,
        scriptDir: dir,
        ownApps: ["ai-chan-desktop"],
      });

      const listText = await invokeTool(handsTools, TOOLS.operate, { action: "controls", window: "notepad" });
      expect(listText).toContain("Send Report");

      const typedText = await invokeTool(handsTools, TOOLS.operate, {
        action: "type",
        window: "notepad",
        text: "hello win32",
      });
      expect(typedText).toContain("Typed 11 characters");
      expect(runScript).toHaveBeenCalledWith("type", { text: "hello win32" });

      // Windows terminal typing must be blocked identically across platforms.
      const termBlocked = await invokeTool(handsTools, TOOLS.operate, {
        action: "type",
        window: "powershell",
        text: "Remove-Item -Recurse C:\\",
      });
      expect(termBlocked).toMatch(/terminal/i);

      // Master hands-off switch must block even notepad.
      handsOffFlag = true;
      const handsOffBlocked = await invokeTool(handsTools, TOOLS.operate, {
        action: "press",
        window: "notepad",
        name: "Send Report",
      });
      expect(handsOffBlocked).toMatch(/Hands-off/i);

      // Refactored Sight, GameWatch, ShipEars, and NoticeWatch delegating to WindowsPlatformAdapter
      const customScreen = vi.fn().mockResolvedValue(undefined);
      const spyAdapter = {
        ...win,
        screenCapture: { captureScreen: customScreen, captureWindow: vi.fn().mockResolvedValue(undefined) },
        audioLoopback: {
          ...win.audioLoopback,
          spawnCapture: vi.fn(() => {
            const fakeProc = new EventEmitter() as unknown as EarsProcess;
            (fakeProc as unknown as { stdout: EventEmitter; kill: () => void }).stdout = new EventEmitter();
            (fakeProc as unknown as { kill: () => void }).kill = vi.fn();
            return fakeProc;
          }),
        },
        systemNotices: {
          isAvailable: async () => true,
          spawnMonitor: vi.fn(() => {
            let lineCb: ((line: string) => void) | null = null;
            return {
              onLine: (cb: (line: string) => void) => {
                lineCb = cb;
                queueMicrotask(() =>
                  lineCb?.(
                    JSON.stringify({
                      type: "method_call",
                      interface: "org.freedesktop.Notifications",
                      member: "Notify",
                      payload: { data: ["KeePassXC", 0, "", "Vault", "secret123", [], {}] },
                    }),
                  ),
                );
              },
              onExit: () => undefined,
              kill: vi.fn(),
            };
          }),
        },
      };

      const sight = new Sight(dir, dir, { adapter: spyAdapter });
      await expect(sight.lookAtScreen()).resolves.toBeDefined();
      expect(customScreen).toHaveBeenCalledTimes(1);

      const gameWatch = new GameWatch({ file: join(dir, "games.json"), adapter: spyAdapter });
      await gameWatch.look();
      await gameWatch.look();
      expect(gameWatch.current()?.game).toBe("EldenRing");
      await gameWatch.stop();

      const ears = new ShipEars({ adapter: spyAdapter });
      ears.start();
      expect(spyAdapter.audioLoopback.spawnCapture).toHaveBeenCalledTimes(1);
      ears.stop();

      const notices = new NoticeWatch({
        adapter: spyAdapter,
        skip: () => [],
        ownNames: ["AI-chan"],
      });
      notices.start();
      await new Promise((r) => setTimeout(r, 20));
      const kept = notices.recent();
      expect(kept).toHaveLength(1);
      expect(kept[0]?.notRead).toBe(true);
      expect(kept[0]?.body).toBe("");
      notices.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("generates locked-down Windows Sandbox .wsb XML and CreateDesktop secondary desktop scripts", () => {
    expect(() => generateWindowsSandboxConfig({ repoPath: "relative/path" })).toThrow(/absolute/);

    const wsb = generateWindowsSandboxConfig({ repoPath: "C:\\Projects\\AI & Chan" });
    expect(wsb).toContain("<Networking>Disable</Networking>");
    expect(wsb).toContain("<ClipboardRedirection>Disable</ClipboardRedirection>");
    expect(wsb).toContain("<AudioInput>Disable</AudioInput>");
    expect(wsb).toContain("<ReadOnly>true</ReadOnly>");
    expect(wsb).toContain("AI &amp; Chan");

    const script = generateSecondaryDesktopScript({
      desktopName: "AiChanTest",
      testCommand: 'Write-Host "ok"',
    });
    expect(script).toContain("CreateDesktop");
    expect(script).toContain("SetThreadDesktop");
    expect(script).toContain("CloseDesktop");
    expect(script).toContain("finally {");
  });
});
