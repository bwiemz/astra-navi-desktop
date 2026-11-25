import { execFile } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { dataDir, modelsDir, resolveBundledRoot, voiceEnvPython } from "./paths.ts";

const execFileAsync = promisify(execFile);

export type BootstrapTask = "voice" | "voice-onnx" | "ocr" | "launcher" | "browser-bridge" | "all";

export interface BootstrapProgress {
  task: BootstrapTask;
  step: string;
  percent: number;
  detail: string;
  ok: boolean;
}

export interface BootstrapComponentStatus {
  ready: boolean;
  detail: string;
}

export interface BootstrapStatus {
  voice: BootstrapComponentStatus;
  voiceOnnx: BootstrapComponentStatus;
  nativeHands: BootstrapComponentStatus;
  ocr: BootstrapComponentStatus;
  launcher: BootstrapComponentStatus;
  browserBridge: BootstrapComponentStatus;
}

export interface BootstrapDeps {
  platform?: NodeJS.Platform;
  home?: string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
  appData?: string;
  localAppData?: string;
  dataRoot?: string;
  modelsRoot?: string;
  voicePython?: string;
  appRoot?: string;
  dryRun?: boolean;
  runCommand?(
    command: string,
    args: readonly string[],
    timeoutMs?: number,
    extraEnv?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }>;
  fetchBytes?(url: string): Promise<Buffer>;
  onProgress?(progress: BootstrapProgress): void;
}

export const DEFAULT_OCR_FILES = [
  {
    name: "det.onnx",
    url:
      process.env["ASTRA_NAVI_OCR_DET_URL"] ??
      process.env["AI_CHAN_OCR_DET_URL"] ??
      "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/detection/v5/det.onnx",
  },
  {
    name: "rec.onnx",
    url:
      process.env["ASTRA_NAVI_OCR_REC_URL"] ??
      process.env["AI_CHAN_OCR_REC_URL"] ??
      "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/rec.onnx",
  },
  {
    name: "dict.txt",
    url:
      process.env["ASTRA_NAVI_OCR_DICT_URL"] ??
      process.env["AI_CHAN_OCR_DICT_URL"] ??
      "https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/dict.txt",
  },
] as const;

async function defaultRun(
  command: string,
  args: readonly string[],
  timeoutMs = 300_000,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    timeout: timeoutMs,
    encoding: "utf8",
    windowsHide: true,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  return { stdout, stderr };
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`Empty response fetching ${url}`);
  return bytes;
}

function desktopExecEscape(path: string): string {
  return `"${path.replace(/[\\"`$]/g, "\\$&").replaceAll("%", "%%")}"`;
}

function resolveEnv(deps: BootstrapDeps) {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const xdgConfigHome = deps.xdgConfigHome ?? process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  const xdgDataHome = deps.xdgDataHome ?? process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
  const appData = deps.appData ?? process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
  const localAppData = deps.localAppData ?? process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
  const dataRoot = deps.dataRoot ?? dataDir();
  const modelsRoot = deps.modelsRoot ?? modelsDir();
  const voicePython =
    deps.voicePython ??
    (deps.dataRoot
      ? join(
          deps.dataRoot,
          "voice-env",
          platform === "win32" ? "Scripts" : "bin",
          platform === "win32" ? "python.exe" : "python",
        )
      : voiceEnvPython(platform));
  const appRoot = deps.appRoot ?? resolveBundledRoot(resolve(import.meta.dirname, "..", ".."));
  return {
    platform,
    home,
    xdgConfigHome,
    xdgDataHome,
    appData,
    localAppData,
    dataRoot,
    modelsRoot,
    voicePython,
    appRoot,
    dryRun: deps.dryRun === true,
    runCommand: deps.runCommand ?? defaultRun,
    fetchBytes: deps.fetchBytes ?? defaultFetchBytes,
    onProgress: deps.onProgress ?? (() => undefined),
  };
}

export function launcherTargetPath(deps: BootstrapDeps = {}): string {
  const env = resolveEnv(deps);
  if (env.platform === "win32") {
    return join(env.appData, "Microsoft", "Windows", "Start Menu", "Programs", "Astra Navi Desktop.lnk");
  }
  if (env.platform === "darwin") {
    return join(env.home, "Applications", "Astra Navi Desktop.command");
  }
  return join(env.xdgDataHome, "applications", "astra-navi-desktop.desktop");
}

/** True when the optional Qwen-TTS Python environment exists and finished installing `qwen-tts`. */
export function isVoiceEnvReady(voicePythonPath: string): boolean {
  if (!existsSync(voicePythonPath)) return false;
  const envDir = dirname(dirname(voicePythonPath));
  if (existsSync(join(envDir, ".astranavi-voice-ready"))) return true;
  if (existsSync(join(envDir, "Lib", "site-packages", "qwen_tts"))) return true;
  const posixLib = join(envDir, "lib");
  if (existsSync(posixLib)) {
    try {
      for (const entry of readdirSync(posixLib)) {
        if (
          entry.startsWith("python3.") &&
          existsSync(join(posixLib, entry, "site-packages", "qwen_tts"))
        ) {
          return true;
        }
      }
    } catch {
      return false;
    }
  }
  return false;
}

export async function checkBootstrapStatus(deps: BootstrapDeps = {}): Promise<BootstrapStatus> {
  const env = resolveEnv(deps);
  const voiceReady = isVoiceEnvReady(env.voicePython);
  const ocrDir = join(env.modelsRoot, "ocr");
  const ocrReady =
    existsSync(join(ocrDir, "det.onnx")) &&
    existsSync(join(ocrDir, "rec.onnx")) &&
    existsSync(join(ocrDir, "dict.txt"));
  const launcherFile = launcherTargetPath(deps);
  const launcherReady =
    existsSync(launcherFile) ||
    (env.platform === "win32" && existsSync(launcherFile.replace(/\.lnk$/i, ".cmd")));

  const installer = (await import("../../browser-bridge/install-host.mjs")) as {
    nativeHostTargets(opts?: {
      platform?: NodeJS.Platform;
      home?: string;
      configHome?: string;
      localAppData?: string;
      dataRoot?: string;
    }): { launcherPath: string; manifests: { file: string }[] };
  };
  const targets = installer.nativeHostTargets({
    platform: env.platform,
    home: env.home,
    configHome: env.xdgConfigHome,
    localAppData: env.localAppData,
    dataRoot: join(env.dataRoot, "browser-bridge"),
  });
  const bridgeReady =
    existsSync(targets.launcherPath) && targets.manifests.some((m) => existsSync(m.file));

  const onnxSpeechDir = join(env.modelsRoot, "speech");
  const nativeLinuxBin = join(env.appRoot, "hands", "linux-hands-native", "target", "release", "linux-hands");
  const bundledLinuxBin = join(env.appRoot, "hands", "linux-hands-native", "bin", "linux-hands");
  const nativeWinBin = join(env.appRoot, "hands", "win-hands-native", "bin", "Release", "net9.0", "win-x64", "publish", "win-hands.exe");
  const handsNativeReady =
    env.platform === "win32"
      ? existsSync(nativeWinBin)
      : env.platform === "darwin"
        ? true
        : existsSync(bundledLinuxBin) || existsSync(nativeLinuxBin);

  return {
    voice: {
      ready: voiceReady,
      detail: voiceReady ? `Legacy Python voice environment ready (${env.voicePython})` : "Not set up (optional legacy Python voice; embedded ONNX voice is built-in)",
    },
    voiceOnnx: {
      ready: true,
      detail: `Built-in zero-Python Kokoro ONNX voice ready (${onnxSpeechDir})`,
    },
    nativeHands: {
      ready: handsNativeReady,
      detail: handsNativeReady
        ? "Native desktop control helper ready (zero Python runtime required)"
        : "Native hands binary not built yet (falling back cleanly)",
    },
    ocr: {
      ready: ocrReady,
      detail: ocrReady ? `PP-OCRv4 ONNX models ready (${ocrDir})` : "Not downloaded (optional fast ONNX OCR)",
    },
    launcher: {
      ready: launcherReady,
      detail: launcherReady ? `Desktop launcher installed (${launcherFile})` : "Desktop menu shortcut not installed",
    },
    browserBridge: {
      ready: bridgeReady,
      detail: bridgeReady ? "Browser native messaging host registered" : "Browser DOM bridge host not registered",
    },
  };
}

async function setupOnnxVoice(env: ReturnType<typeof resolveEnv>): Promise<string> {
  const speechDir = join(env.modelsRoot, "speech");
  env.onProgress({
    task: "voice-onnx",
    step: "prepare",
    percent: 40,
    detail: `Preparing zero-Python ONNX voice cache in ${speechDir}...`,
    ok: true,
  });
  if (!env.dryRun) {
    await mkdir(speechDir, { recursive: true, mode: 0o700 });
  }
  env.onProgress({
    task: "voice-onnx",
    step: "done",
    percent: 100,
    detail: `Embedded ONNX voice ready (${speechDir}; no Python runtime needed).`,
    ok: true,
  });
  return `Embedded ONNX voice cache ready in ${speechDir} (zero Python)`;
}

async function setupVoice(env: ReturnType<typeof resolveEnv>): Promise<string> {
  const emit = (step: string, percent: number, detail: string, ok = true) =>
    env.onProgress({ task: "voice", step, percent, detail, ok });

  const envDir = join(env.dataRoot, "voice-env");
  emit("probe", 15, "Checking Python / uv toolchain...");

  let hasUv = false;
  try {
    await env.runCommand("uv", ["--version"], 5000);
    hasUv = true;
  } catch {
    // uv not installed; fall back to python venv
  }

  let pyCmd: { cmd: string; preArgs: string[] } | null = null;
  for (const candidate of env.platform === "win32"
    ? [
        { cmd: "py", preArgs: ["-3"] },
        { cmd: "python", preArgs: [] },
      ]
    : [
        { cmd: "python3", preArgs: [] },
        { cmd: "python", preArgs: [] },
      ]) {
    try {
      const probeArgs =
        env.platform === "win32"
          ? [...candidate.preArgs, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"]
          : [...candidate.preArgs, "--version"];
      await env.runCommand(candidate.cmd, probeArgs, 5000);
      pyCmd = candidate;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!hasUv && !pyCmd) {
    throw new Error(
      "Optional full Qwen-TTS voice requires Python 3.10+ or uv (install Python from python.org or run 'winget install astral-sh.uv'). Built-in ONNX voice already works without Python.",
    );
  }

  const reqFile = join(env.appRoot, "voice-server", "requirements.txt");
  const hasReqs = existsSync(reqFile);
  if (env.dryRun) {
    const pkgDesc = hasReqs ? reqFile : "qwen-tts";
    emit("done", 100, `Dry run: would create ${envDir} and install ${pkgDesc}.`, true);
    return `Dry run: voice environment target ${envDir} (${hasReqs ? "voice-server/requirements.txt" : "qwen-tts"})`;
  }

  await mkdir(env.dataRoot, { recursive: true, mode: 0o700 });
  if (!isVoiceEnvReady(env.voicePython) && existsSync(envDir)) {
    await rm(envDir, { recursive: true, force: true });
  }
  emit("venv", 45, `Creating virtual environment in ${envDir}...`);
  const pipArgs = hasReqs ? ["-r", reqFile] : ["qwen-tts"];
  if (hasUv) {
    await env.runCommand("uv", ["venv", "--clear", envDir, "--python", "3.12"], 120_000);
    emit("install", 75, "Installing pinned voice packages via uv...");
    await env.runCommand("uv", ["pip", "install", "--python", env.voicePython, ...pipArgs], 600_000);
  } else if (pyCmd) {
    await env.runCommand(pyCmd.cmd, [...pyCmd.preArgs, "-m", "venv", "--clear", envDir], 120_000);
    emit("install", 75, "Installing pinned voice packages via pip...");
    await env.runCommand(
      env.voicePython,
      ["-m", "pip", "install", "--upgrade", ...pipArgs],
      600_000,
    );
  }

  await mkdir(envDir, { recursive: true, mode: 0o700 });
  await writeFile(join(envDir, ".astranavi-voice-ready"), "ok\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  emit("done", 100, `Voice environment ready at ${envDir}.`);
  return `Voice environment installed in ${envDir}`;
}

async function setupOcr(env: ReturnType<typeof resolveEnv>): Promise<string> {
  const ocrDir = join(env.modelsRoot, "ocr");
  env.onProgress({ task: "ocr", step: "prepare", percent: 10, detail: `Preparing ${ocrDir}...`, ok: true });
  if (env.dryRun) {
    env.onProgress({
      task: "ocr",
      step: "done",
      percent: 100,
      detail: `Dry run: would download ${DEFAULT_OCR_FILES.length} ONNX OCR assets into ${ocrDir}.`,
      ok: true,
    });
    return `Dry run: OCR directory ${ocrDir}`;
  }

  await mkdir(ocrDir, { recursive: true, mode: 0o700 });
  let idx = 0;
  for (const file of DEFAULT_OCR_FILES) {
    idx += 1;
    const pct = Math.round((idx / (DEFAULT_OCR_FILES.length + 1)) * 100);
    env.onProgress({ task: "ocr", step: "download", percent: pct, detail: `Fetching ${file.name}...`, ok: true });
    const bytes = await env.fetchBytes(file.url);
    const dest = join(ocrDir, file.name);
    const tmp = `${dest}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, dest);
  }
  env.onProgress({ task: "ocr", step: "done", percent: 100, detail: `OCR models installed in ${ocrDir}.`, ok: true });
  return `OCR models installed in ${ocrDir}`;
}

async function setupLauncher(env: ReturnType<typeof resolveEnv>): Promise<string> {
  const target = launcherTargetPath(env);
  env.onProgress({ task: "launcher", step: "write", percent: 40, detail: `Installing shortcut at ${target}...`, ok: true });
  if (env.dryRun) {
    env.onProgress({ task: "launcher", step: "done", percent: 100, detail: `Dry run: would install launcher at ${target}.`, ok: true });
    return `Dry run: launcher ${target}`;
  }

  if (env.platform === "win32") {
    await mkdir(dirname(target), { recursive: true });
    const exeTarget = process.execPath;
    const iconIco = join(env.appRoot, "assets", "icon.ico");
    const iconPng = join(env.appRoot, "assets", "icon.png");
    const iconPath = existsSync(iconIco) ? iconIco : iconPng;
    const ps = [
      "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:ASTRA_LNK_OUT);",
      "$s.TargetPath=$env:ASTRA_LNK_EXE;",
      "$s.WorkingDirectory=$env:ASTRA_LNK_CWD;",
      `$s.Description='Astra Navi Desktop';`,
      `if (Test-Path $env:ASTRA_LNK_ICON) { $s.IconLocation=$env:ASTRA_LNK_ICON };`,
      "$s.Save();",
    ].join(" ");
    await env
      .runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 15_000, {
        ASTRA_LNK_OUT: target,
        ASTRA_LNK_EXE: exeTarget,
        ASTRA_LNK_CWD: dirname(exeTarget),
        ASTRA_LNK_ICON: iconPath,
      })
      .catch(async () => {
        // Fallback: write a direct Start Menu .cmd launcher when COM shortcut creation is unavailable in CI/sandbox
        const fallbackCmd = target.replace(/\.lnk$/i, ".cmd");
        const isElectronBinary = /electron(?:\.exe)?$/i.test(basename(exeTarget));
        const launchArgs = isElectronBinary ? ` "${env.appRoot}"` : "";
        await writeFile(fallbackCmd, `@echo off\r\nstart "" "${exeTarget}"${launchArgs}\r\n`, "utf8");
      });
  } else if (env.platform === "darwin") {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `#!/usr/bin/env sh\ncd "${env.appRoot}" && exec "${process.execPath}" .\n`,
      "utf8",
    );
    chmodSync(target, 0o755);
  } else {
    const iconDest = join(env.xdgDataHome, "icons", "hicolor", "256x256", "apps", "astra-navi-desktop.png");
    const iconSrc = join(env.appRoot, "assets", "icon.png");
    await mkdir(dirname(target), { recursive: true });
    await mkdir(dirname(iconDest), { recursive: true });
    if (existsSync(iconSrc)) {
      await copyFile(iconSrc, iconDest);
    }
    const execScript = join(env.appRoot, "scripts", "launch.sh");
    const entry = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Astra Navi Desktop",
      "GenericName=Local AI Navigator",
      "Comment=Local-first AI desktop companion with 3D MMD avatar.",
      `Exec=${desktopExecEscape(execScript)}`,
      "Icon=astra-navi-desktop",
      "Terminal=false",
      "Categories=Utility;",
      "StartupWMClass=astra-navi-desktop",
      "StartupNotify=false",
      "",
    ].join("\n");
    await writeFile(target, entry, { encoding: "utf8", mode: 0o644 });
  }

  env.onProgress({ task: "launcher", step: "done", percent: 100, detail: `Launcher ready at ${target}.`, ok: true });
  return `Launcher installed at ${target}`;
}

async function setupBrowserBridge(env: ReturnType<typeof resolveEnv>): Promise<string> {
  env.onProgress({ task: "browser-bridge", step: "register", percent: 50, detail: "Registering browser native messaging host...", ok: true });
  const installer = (await import("../../browser-bridge/install-host.mjs")) as {
    installNativeHost(opts?: {
      platform?: NodeJS.Platform;
      home?: string;
      configHome?: string;
      localAppData?: string;
      dataRoot?: string;
      hostScript?: string;
      electronRunAsNode?: boolean;
      dryRun?: boolean;
    }): Promise<{ files: string[]; launcherPath: string }>;
  };
  const result = await installer.installNativeHost({
    platform: env.platform,
    home: env.home,
    configHome: env.xdgConfigHome,
    localAppData: env.localAppData,
    dataRoot: join(env.dataRoot, "browser-bridge"),
    hostScript: join(env.appRoot, "browser-bridge", "native-host.mjs"),
    electronRunAsNode: Boolean(process.versions["electron"]),
    dryRun: env.dryRun,
  });
  env.onProgress({
    task: "browser-bridge",
    step: "done",
    percent: 100,
    detail: `Registered ${result.files.length} browser host manifest(s).`,
    ok: true,
  });
  return `Registered browser native host (${result.files.length} target manifests)`;
}

export async function runBootstrapTask(
  task: BootstrapTask,
  deps: BootstrapDeps = {},
): Promise<{ ok: boolean; summary: string[] }> {
  const env = resolveEnv(deps);
  const summary: string[] = [];
  if (task === "voice") summary.push(await setupVoice(env));
  if (task === "voice-onnx" || task === "all") summary.push(await setupOnnxVoice(env));
  if (task === "ocr" || task === "all") summary.push(await setupOcr(env));
  if (task === "launcher" || task === "all") summary.push(await setupLauncher(env));
  if (task === "browser-bridge" || task === "all") summary.push(await setupBrowserBridge(env));
  return { ok: true, summary };
}
