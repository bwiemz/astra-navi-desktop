import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installNativeHost } from "../browser-bridge/install-host.mjs";
import {
  checkBootstrapStatus,
  DEFAULT_OCR_FILES,
  isVoiceEnvReady,
  runBootstrapTask,
} from "../src/core/bootstrap.ts";
import { FullVoice } from "../src/core/voice/fullVoice.ts";
import { gameAmongHolders, gameOnCard } from "../src/core/cardWatch.ts";
import { ConfigStore } from "../src/core/config.ts";
import { findFiles } from "../src/core/documents.ts";
import {
  loadModelAndContextWithFallback,
  type LoadableModel,
} from "../src/core/engine.ts";
import { FastOcr } from "../src/core/ocr.ts";
import { voiceEnvPython } from "../src/core/paths.ts";
import type { PlatformAdapter } from "../src/core/platform/adapter.ts";
import {
  isIgnoredWindowsGameProcess,
  parseQunsState,
  WindowsPlatformAdapter,
} from "../src/core/platform/windows.ts";
import { Reach } from "../src/core/reach.ts";
import { selfCheck, type SelfCheckInputs } from "../src/core/selfCheck.ts";
import { Sight } from "../src/core/sight.ts";

class InsufficientMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientMemoryError";
  }
}

function makeMockPlatformAdapter(activeTitle = "Code"): {
  adapter: PlatformAdapter;
  layoutCalls: () => number;
} {
  let calls = 0;
  const adapter: PlatformAdapter = {
    platform: "win32",
    abilities: async () => ({
      controls: false,
      controlsProblem: "Using Windows screen reading, pointer, and keyboard controls.",
      input: true,
    }),
    windowManager: {
      layout: async () => {
        calls += 1;
        return {
          width: 1920,
          height: 1080,
          windows: [
            {
              id: "101",
              title: activeTitle,
              app: "Code",
              active: true,
              minimized: false,
              pid: 4242,
              fullScreen: false,
              dialog: false,
              x: 0,
              y: 0,
              width: 1200,
              height: 800,
            },
          ],
        };
      },
      windowAt: async () => null,
      act: async () => true,
      lockScreen: async () => undefined,
    },
    accessibilityTree: {
      controls: async () => ({ window: "", controls: [], more: 0, text: [] }),
      press: async () => ({ kind: "button", name: "OK" }),
      fill: async () => ({ field: "input", now: "ok" }),
    },
    inputInjector: {
      pointer: async () => undefined,
      keys: async () => undefined,
      type: async () => undefined,
      scroll: async () => undefined,
    },
    screenCapture: {
      captureWindow: async () => undefined,
      captureScreen: async () => undefined,
    },
    audioLoopback: {
      isAvailable: async () => false,
      listStreams: async () => [],
    },
    systemNotices: {
      isAvailable: async () => false,
    },
    gameDetector: {
      activeFullscreenGame: async () => null,
    },
  };
  return { adapter, layoutCalls: () => calls };
}

describe("Windows 1.0.0-rc Fixes", () => {
  it("1. Reach.setWatching uses PlatformAdapter polling without spawning python3 and stops cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "astranavi-win-reach-"));
    try {
      const config = new ConfigStore(join(dir, "config.json"));
      const { adapter, layoutCalls } = makeMockPlatformAdapter("README.md - Visual Studio Code");
      const sight = new Sight(join(dir, "cache"), join(dir, "scratch"), { adapter });
      const reach = new Reach({
        config,
        sight,
        scriptDir: join(dir, "scratch"),
        modelsCacheDir: join(dir, "cache"),
        handsScript: join(dir, "nonexistent", "hands.py"),
        adapter,
        ownApps: ["Astra Navi Desktop"],
        stationDir: join(dir, "station"),
        onNotice: () => undefined,
        onAwayMessage: () => true,
        onAwayStop: () => undefined,
        onProblem: () => undefined,
      });

      await reach.setWatching(true);
      const status = await reach.status();
      expect(status.watching).toBe(true);
      expect(reach.screen.next()).toContain("Captain is in Code");
      expect(layoutCalls()).toBeGreaterThanOrEqual(1);
      expect(status.hands).toEqual({
        controls: false,
        controlsProblem: "Using Windows screen reading, pointer, and keyboard controls.",
        input: true,
      });

      await reach.setWatching(false);
      const after = await reach.status();
      expect(after.watching).toBe(false);
      await reach.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. Windows selfCheck avoids Linux-only tool errors and findFiles native fallback finds name & content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "astranavi-win-check-"));
    const prevPath = process.env["PATH"];
    try {
      const work = join(dir, "docs");
      await mkdir(work, { recursive: true });
      await writeFile(join(work, "mission-notes.txt"), "hello windows native search", "utf8");

      const inputs: SelfCheckInputs = {
        dataDir: dir,
        modelsDir: join(dir, "models"),
        brain: { label: "Standard (Qwen3.5 9B)", fileName: null, onDisk: false, loaded: false },
        voice: { label: "embedded ONNX voice", ready: true },
        listening: false,
        handsOff: false,
        notes: { total: 0, topics: 0, skills: 0 },
        pastExchanges: 0,
        waitingToWriteUp: 0,
        actionsRecorded: 0,
        searchEngine: null,
        memoryInUse: null,
        canReachTheWeb: async () => true,
        platform: "win32",
        hasNativeWinHands: true,
        reach: {
          hands: {
            controls: false,
            controlsProblem: "Using Windows screen reading, pointer, and keyboard controls.",
            input: true,
          },
          watching: true,
          front: "Code",
          hearing: false,
          station: { running: false, addresses: [], devices: 0 },
        },
      };

      const res = await selfCheck(inputs);
      const bySystem = new Map(res.lines.map((l) => [l.system, l]));
      expect(bySystem.get("Eyes")?.ok).toBe(true);
      expect(bySystem.get("Hands")?.ok).toBe(true);
      expect(bySystem.get("Files")?.ok).toBe(true);
      expect(bySystem.get("Hands in other programs")?.ok).toBe(true);

      const joined = res.lines.map((l) => `${l.system}:${l.detail}`).join("\n");
      expect(joined).not.toContain("spectacle");
      expect(joined).not.toContain("wpctl");
      expect(joined).not.toContain("busctl");
      expect(joined).not.toContain("python3");
      expect(joined).not.toContain("python-gobject");
      expect(joined).not.toContain("/dev/uinput");

      // Exercise native Node fallback by temporarily hiding rg/fd on PATH
      process.env["PATH"] = dir;
      const byName = await findFiles({ name: "mission-*", folder: work });
      expect(byName).toHaveLength(1);
      expect(byName[0]?.path).toContain("mission-notes.txt");

      const byContent = await findFiles({ content: "windows native search", folder: work });
      expect(byContent).toHaveLength(1);
      expect(byContent[0]?.path).toContain("mission-notes.txt");

      // Packaged Windows audioLoopback / systemNotices fail clearly without PowerShell helper
      const winAdapter = new WindowsPlatformAdapter({
        scriptPath: join(dir, "missing_win_hands.ps1"),
        spawnProcess: () => new EventEmitter() as never,
      });
      expect(() => winAdapter.audioLoopback.spawnCapture?.("default")).toThrow(
        "packaged Windows builds",
      );
      expect(() => winAdapter.systemNotices.spawnMonitor?.()).toThrow("packaged Windows builds");
      winAdapter.dispose();
    } finally {
      process.env["PATH"] = prevPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("3. loadModelAndContextWithFallback recovers from VRAM context overflow via Q8_0 KV and gpuLayers=0 CPU offload", async () => {
    const calls: { gpuLayers: unknown; contextSize: unknown; flash: unknown }[] = [];
    const disposedCount = { count: 0 };

    const loader = {
      loadModel: vi.fn(async (opts: { gpuLayers?: unknown }) => {
        const model: LoadableModel<string> = {
          flashAttentionSupported: true,
          createContext: vi.fn(async (ctxOpts?: { contextSize?: unknown; flashAttention?: unknown }) => {
            calls.push({
              gpuLayers: opts.gpuLayers,
              contextSize: ctxOpts?.contextSize,
              flash: ctxOpts?.flashAttention,
            });
            if (opts.gpuLayers !== 0) {
              throw new InsufficientMemoryError(
                "A context size of 4096 is too large for the available VRAM",
              );
            }
            return "cpu-context-ok";
          }),
          dispose: vi.fn(async () => {
            disposedCount.count += 1;
          }),
        };
        return model;
      }),
    };

    const res = await loadModelAndContextWithFallback(loader, {
      modelPath: "/tmp/model.gguf",
      effectiveContextSize: 16_384,
      effectiveLean: false,
      allowLeanKv: true,
      freeVramBytes: 1.9 * 1024 ** 3,
      adapter: null,
    });

    expect(res.cpuFallback).toBe(true);
    expect(res.context).toBe("cpu-context-ok");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.flash).toBe(true); // proactively tried lean Q8_0 due to < 2.5 GB free VRAM
    expect(calls[1]?.contextSize).toEqual({ min: 2048, max: 8192 });
    expect(calls[2]?.gpuLayers).toBe(0);
    expect(disposedCount.count).toBe(2);

    // Non-VRAM errors fail fast without falling back to CPU
    const nonVramLoader = {
      loadModel: vi.fn(async () => ({
        flashAttentionSupported: true,
        createContext: vi.fn(async () => {
          throw new Error("Corrupted GGUF header");
        }),
        dispose: vi.fn(async () => undefined),
      })),
    };
    await expect(
      loadModelAndContextWithFallback(nonVramLoader, {
        modelPath: "/tmp/bad.gguf",
        effectiveContextSize: 16_384,
        effectiveLean: false,
        allowLeanKv: true,
        freeVramBytes: 8 * 1024 ** 3,
        adapter: null,
      }),
    ).rejects.toThrow("Corrupted GGUF header");
    expect(nonVramLoader.loadModel).toHaveBeenCalledTimes(1);
  });

  it("4. ignores ShellHost.exe and non-game Windows hosts in cardWatch and parseQunsState", async () => {
    expect(isIgnoredWindowsGameProcess("ShellHost.exe")).toBe(true);
    expect(isIgnoredWindowsGameProcess("ShellExperienceHost.exe")).toBe(true);
    expect(isIgnoredWindowsGameProcess("Starfield.exe")).toBe(false);

    expect(
      parseQunsState(JSON.stringify({ state: "QUNS_BUSY", code: 2, process: "ShellHost.exe" })),
    ).toMatchObject({ fullscreenGame: false, processName: "ShellHost.exe" });

    expect(
      parseQunsState(JSON.stringify({ state: "QUNS_BUSY", code: 2, process: "chrome" })),
    ).toMatchObject({ fullscreenGame: false, processName: "chrome" });

    expect(
      parseQunsState(
        JSON.stringify({ state: "QUNS_RUNNING_D3D_FULL_SCREEN", code: 3, process: "Starfield.exe" }),
      ),
    ).toMatchObject({ fullscreenGame: true, processName: "Starfield.exe" });

    expect(
      gameAmongHolders(["C:\\Windows\\SystemApps\\ShellHost.exe", "explorer.exe"], "win32"),
    ).toBeNull();
    expect(
      gameAmongHolders(
        ["C:\\Windows\\SystemApps\\ShellHost.exe", "D:\\SteamLibrary\\steamapps\\common\\Hades\\Hades.exe"],
        "win32",
      ),
    ).toBe("Hades.exe");

    expect(
      await gameOnCard(
        async () => [{ pid: null, name: "C:\\Windows\\SystemApps\\ShellHost.exe" }],
        undefined,
        "win32",
      ),
    ).toBeNull();
  });

  it("5. Settings layout uses responsive --page-max centering and safe section centering", async () => {
    const css = await readFile(join(import.meta.dirname, "..", "src/renderer/src/settings.css"), "utf8");
    expect(css).toContain("--page-max: 1120px;");
    expect(css).toContain("max-width: var(--page-max);");
    expect(css).toContain("margin-inline: auto;");
    expect(css).toContain("justify-content: safe center;");
    expect(css).toContain("@media (min-width: 860px)");
    expect(css).toContain(".row:not(.switch)");
  });

  it("6. fixes Windows voice-env path, live OCR v5 URL, FastOcr path resolution, PowerShell env, and ELECTRON_RUN_AS_NODE", async () => {
    expect(voiceEnvPython("win32").replace(/\\/g, "/")).toMatch(/voice-env\/Scripts\/python\.exe$/);
    expect(voiceEnvPython("linux").replace(/\\/g, "/")).toMatch(/voice-env\/bin\/python$/);

    const detUrl = DEFAULT_OCR_FILES.find((f) => f.name === "det.onnx")?.url ?? "";
    expect(detUrl).toContain("/detection/v5/det.onnx");
    expect(detUrl).not.toContain("/detection/v4/");

    const dir = await mkdtemp(join(tmpdir(), "astranavi-win-boot-"));
    try {
      // FastOcr constructed with models/speech finds models downloaded into models/ocr
      const modelsRoot = join(dir, "models");
      const speechDir = join(modelsRoot, "speech");
      const ocrDir = join(modelsRoot, "ocr");
      await mkdir(speechDir, { recursive: true });
      await mkdir(ocrDir, { recursive: true });
      await writeFile(join(ocrDir, "det.onnx"), "det");
      await writeFile(join(ocrDir, "rec.onnx"), "rec");
      await writeFile(join(ocrDir, "dict.txt"), "a\n");

      const fastOcr = new FastOcr({ cacheDir: speechDir });
      expect(fastOcr.resolveOcrDir()).toBe(ocrDir);

      // Windows launcher passes ASTRA_LNK_* via extraEnv
      let capturedEnv: Record<string, string> | undefined;
      await runBootstrapTask("launcher", {
        platform: "win32",
        home: dir,
        appData: join(dir, "AppData", "Roaming"),
        appRoot: dir,
        runCommand: vi.fn(async (_cmd, _args, _timeout, extraEnv) => {
          capturedEnv = extraEnv;
          return { stdout: "", stderr: "" };
        }),
      });
      expect(capturedEnv?.["ASTRA_LNK_OUT"]).toContain("Astra Navi Desktop.lnk");
      expect(capturedEnv?.["ASTRA_LNK_EXE"]).toBe(process.execPath);
      expect(capturedEnv?.["ASTRA_LNK_CWD"]).toBeTruthy();

      // Browser bridge host launcher emits ELECTRON_RUN_AS_NODE=1 when packaged inside Electron
      const installed = await installNativeHost({
        platform: "win32",
        home: dir,
        localAppData: join(dir, "AppData", "Local"),
        dataRoot: join(dir, "data", "browser-bridge"),
        hostScript: join(dir, "native-host.mjs"),
        nodePath: "C:\\Program Files\\Astra Navi Desktop\\Astra Navi Desktop.exe",
        electronRunAsNode: true,
        dryRun: true,
      });
      expect(installed.launcherPath).toContain("astra-navi-dom-bridge.cmd");

      const realWrite = await installNativeHost({
        platform: "linux",
        home: dir,
        configHome: join(dir, ".config"),
        dataRoot: join(dir, "data", "browser-bridge"),
        hostScript: join(dir, "native-host.mjs"),
        nodePath: "/opt/Astra/astra-navi",
        electronRunAsNode: true,
        dryRun: false,
      });
      const launcherScript = await readFile(realWrite.launcherPath, "utf8");
      expect(launcherScript).toContain("ELECTRON_RUN_AS_NODE=1 exec");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("7. detects incomplete voice-env, passes --clear to venv, pins compatible qwen-tts deps, and aligns wizard buttons", async () => {
    const dir = await mkdtemp(join(tmpdir(), "astranavi-win-venv-"));
    try {
      const dataRoot = join(dir, "data");
      const envDir = join(dataRoot, "voice-env");
      const scriptsDir = join(envDir, "Scripts");
      const voicePy = join(scriptsDir, "python.exe");
      const refWav = join(dir, "ref.wav");
      const refTxt = join(dir, "ref.txt");
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(voicePy, "stub");
      await writeFile(refWav, "wav");
      await writeFile(refTxt, "txt");

      // Partial/empty voice-env without qwen_tts or marker must NOT report ready
      expect(isVoiceEnvReady(voicePy)).toBe(false);
      expect(
        await FullVoice.isSetUp({ python: voicePy, referenceAudio: refWav, referenceText: refTxt }),
      ).toBe(false);
      const beforeStatus = await checkBootstrapStatus({
        platform: "win32",
        home: dir,
        dataRoot,
        modelsRoot: join(dir, "models"),
        voicePython: voicePy,
        appRoot: join(import.meta.dirname, ".."),
      });
      expect(beforeStatus.voice.ready).toBe(false);

      // Re-running voice setup clears prior partial venv via --clear and writes ready marker
      const uvCalls: string[][] = [];
      await runBootstrapTask("voice", {
        platform: "win32",
        home: dir,
        dataRoot,
        modelsRoot: join(dir, "models"),
        voicePython: voicePy,
        appRoot: join(import.meta.dirname, ".."),
        runCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
          uvCalls.push([cmd, ...args]);
          if (cmd === "uv" && args[0] === "venv") {
            await mkdir(scriptsDir, { recursive: true });
            await writeFile(voicePy, "fresh-python");
          }
          return { stdout: "uv 0.6.0", stderr: "" };
        }),
      });

      const venvCall = uvCalls.find((c) => c[0] === "uv" && c[1] === "venv");
      expect(venvCall).toContain("--clear");
      expect(existsSync(join(envDir, ".astranavi-voice-ready"))).toBe(true);
      expect(isVoiceEnvReady(voicePy)).toBe(true);

      const afterStatus = await checkBootstrapStatus({
        platform: "win32",
        home: dir,
        dataRoot,
        modelsRoot: join(dir, "models"),
        voicePython: voicePy,
        appRoot: join(import.meta.dirname, ".."),
      });
      expect(afterStatus.voice.ready).toBe(true);

      // Removing marker while Lib/site-packages/qwen_tts is present still detects readiness
      await rm(join(envDir, ".astranavi-voice-ready"), { force: true });
      expect(isVoiceEnvReady(voicePy)).toBe(false);
      await mkdir(join(envDir, "Lib", "site-packages", "qwen_tts"), { recursive: true });
      expect(isVoiceEnvReady(voicePy)).toBe(true);

      // Verify compatible qwen-tts==0.0.5 pins & uniform Step 3 button styling
      const [reqs, css] = await Promise.all([
        readFile(join(import.meta.dirname, "..", "voice-server/requirements.txt"), "utf8"),
        readFile(join(import.meta.dirname, "..", "src/renderer/src/settings.css"), "utf8"),
      ]);
      expect(reqs).toContain("qwen-tts==0.0.5");
      expect(reqs).toContain("transformers==4.57.3");
      expect(reqs).toContain("accelerate==1.12.0");
      expect(css).toMatch(/\.wiz-service-row\s+button\s*\{[^}]*flex:\s*none;[^}]*width:\s*auto;/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
