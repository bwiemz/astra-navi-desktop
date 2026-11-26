import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  protocol,
  screen,
  session,
} from "electron";
import { takeAwayMessage } from "../core/awayMessage.ts";
import { Brain } from "../core/brain.ts";
import { ConfigStore } from "../core/config.ts";
import { gameOnCard as cardGameOnCard, gpuUtilization } from "../core/cardWatch.ts";
import { LocalEngine, type EngineStatus } from "../core/engine.ts";
import { describeInferenceLocality } from "../core/openaiBackend.ts";
import { createPlatformAdapter, type PlatformAdapter } from "../core/platform/adapter.ts";
import { resolveNativeWinHandsBinary } from "../core/platform/windows.ts";
import { detectEnvironment } from "../core/environment.ts";
import { Agenda } from "../core/agenda.ts";
import { briefingLines } from "../core/agendaTools.ts";
import { AgendaWatch } from "../core/agendaWatch.ts";
import { GameWatch } from "../core/gameWatch.ts";
import { Initiative } from "../core/initiative.ts";
import { ApprovalDesk, type ApprovalCard } from "../core/missionApproval.ts";
import {
  describeFrom,
  describeMission,
  failedStep,
  MissionBoard,
  pinnedMissionView,
  printedBy,
} from "../core/missionPlan.ts";
import { judgeStep, runStep, stepFingerprint } from "../core/missionRules.ts";
import { MissionControl } from "../core/missions.ts";
import { homedir } from "node:os";
import { NoticeWatch } from "../core/notices.ts";
import { orderGuard, orderReader } from "../core/orderChecks.ts";
import { ReminderStore } from "../core/reminders.ts";
import { excerpt, StandingOrders } from "../core/standingOrders.ts";
import { forShow, TraceKeeper, type TurnTrace } from "../core/trace.ts";
import { TraceFile } from "../core/traceFile.ts";
import { TrainingSink } from "../core/trainingExport.ts";
import { describeShipStatus, findAlerts, readShipStatus } from "../core/status.ts";
import { readWebPage } from "../core/web.ts";
import { MemoryStore } from "../core/memory.ts";
import { ConversationArchive } from "../core/archive.ts";
import { ActionLog } from "../core/actionLog.ts";
import { searchEverywhere } from "../core/knowledge.ts";
import { ResearchDesk, researchReport } from "../core/research.ts";
import { Sight } from "../core/sight.ts";
import { LlamaVisionSidecar } from "../core/visionSidecar.ts";
import { characterFromBundleManifest, resolveBundleVoiceBinding } from "../core/characterLayer.ts";
import { Reach } from "../core/reach.ts";
import { Fleet } from "../core/fleet.ts";
import { SearchBudget } from "../core/searchBudget.ts";
import { LocalEmbedder } from "../core/embedder.ts";
import { Learner, quietTimeFor, withoutSecrets, type Learned } from "../core/learner.ts";
import { tidyDeviceName } from "../core/station.ts";
import { describeRoutine, RoutineWatch } from "../core/routines.ts";
import { Recall } from "../core/recall.ts";
import { EpisodicGraph } from "../core/episodic.ts";
import { CompiledSkillStore } from "../core/skillCompiler.ts";
import { HerStore } from "../core/store.ts";
import {
  actionsFile,
  agendaFile,
  archiveFile,
  configFile,
  dataDir,
  distilledSftFile,
  stationDir,
  searchCountFile,
  fleetDir,
  deckLogFile,
  missionsFile,
  historyFile,
  journalFile,
  memoryFile,
  modelBundleFile,
  routinesFile,
  scratchDir,
  modelsDir,
  ordersFile,
  playLogFile,
  remindersFile,
  resolveBundledRoot,
  storeFile,
  tracesFile,
  trainingPairsFile,
  workspaceDir,
} from "../core/paths.ts";
import { type LanguageCode } from "../core/languages.ts";
import {
  UNOFFICIAL_NOTICE,
  type AppState,
  type BrainEvent,
  type Presence,
  type WindowLayout,
  WINDOW_COMPACT,
  WINDOW_EXPANDED,
  WINDOW_LOG,
  fitWindow,
  type HeldCorner,
  resizeAboutCorner,
} from "../shared/ipc.ts";
import {
  computeMultiMonitorDock,
  isBoundsOnAnyDisplay,
  snapBoundsToMonitorEdge,
  type DisplayWorkArea,
  type DockEdge,
} from "../shared/spatialStage.ts";
import { registerAgendaIpc } from "./agendaIpc.ts";
import { BrowserDeck } from "./browser.ts";
import { scheduleDebugAids } from "./debugAids.ts";
import { registerDesktopIpc } from "./desktopIpc.ts";
import { registerFleetIpc } from "./fleetIpc.ts";
import { McpHub } from "../core/mcpClient.ts";
import { registerMcpIpc } from "./mcpIpc.ts";
import {
  detectLinuxDesktopEnvironment,
  installKwinHelper,
  type LinuxDesktopEnvironment,
} from "./kwin.ts";
import { startsAtLogin } from "./loginStart.ts";
import { createModelFiles } from "./modelFiles.ts";
import { globalShortcut } from "electron";
import { createReports } from "./reports.ts";
import { createSettingsController } from "./settingsIpc.ts";
import { StartupGuard, type BootStartStatus } from "../core/safeMode.ts";
import { programShown } from "./shown.ts";
import { createTrayMenu } from "./tray.ts";
import { createVoiceController } from "./voiceControl.ts";
import { createWorkbenchController } from "./workbenchIpc.ts";

const SCHEME = "astranavi";
const LEGACY_SCHEME = "aichan";
const APP_ORIGIN = `${SCHEME}://app`;
/** Gap kept between the window and the screen's bottom-right corner. */
const CORNER_MARGIN = { right: 24, bottom: 8 };
const WINDOW_TITLE = "Astra Navi Desktop";
const RENDERER_DIR = join(import.meta.dirname, "../renderer");
const MAX_RECENT_ERRORS = 30;
const recentErrors: string[] = [];
const linuxDesktopEnv: LinuxDesktopEnvironment | null =
  process.platform === "linux" ? detectLinuxDesktopEnvironment() : null;

function recordRecentError(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const entry = `[${new Date().toISOString()}] [${source}] ${message.split("\n")[0] ?? message}`;
  recentErrors.push(entry.slice(0, 400));
  if (recentErrors.length > MAX_RECENT_ERRORS) {
    recentErrors.splice(0, recentErrors.length - MAX_RECENT_ERRORS);
  }
}

process.on("unhandledRejection", (reason) => {
  recordRecentError("unhandledRejection", reason);
});

// Draw through the session's own display system. (Going through XWayland instead was
// tried for its self-positioning windows; with NVIDIA drivers the window never appears.)
if (process.platform === "linux") {
  const display = process.env["XDG_SESSION_TYPE"] === "wayland" ? "wayland" : "x11";
  app.commandLine.appendSwitch(
    "ozone-platform",
    process.env["ASTRA_NAVI_OZONE"] ?? process.env["AI_CHAN_OZONE"] ?? display,
  );
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: LEGACY_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;
let engine: LocalEngine | null = null;
let memoryStore: MemoryStore | null = null;
let store: HerStore | null = null;
let episodicGraph: EpisodicGraph | null = null;
let compiledSkills: CompiledSkillStore | null = null;
let recallRef: Recall | null = null;
let workspaceRoot = workspaceDir();
let sight: Sight | null = null;
let visionSidecar: LlamaVisionSidecar | null = null;
let research: ResearchDesk | null = null;
let reach: Reach | null = null;
let platformAdapter: PlatformAdapter | null = null;
let fleet: Fleet | null = null;
let mcpHub: McpHub | null = null;

function gameOnCard(): Promise<string | null> {
  return platformAdapter ? platformAdapter.gameDetector.activeFullscreenGame() : cardGameOnCard();
}
/** True while her language model is unloaded after a quiet spell. */
let brainAsleep = false;
/** The game her brain was put away for, while that is why she is asleep. */
let brainAsleepFor: string | null = null;
let archive: ConversationArchive | null = null;
let actions: ActionLog | null = null;
/** The record of her last replies, for the page in Settings that shows them. Never on disk. */
const traces = new TraceKeeper(40);
/** Away-only turn traces shown on signed-in paired devices. Never holds PC chat or withheld turns. */
const awayTraces = new TraceKeeper(20);
/** The same records written down, when the user has asked for that. */
const traceFile = new TraceFile(tracesFile());
const trainingSink = new TrainingSink({
  pairsFile: trainingPairsFile(),
  sftFile: distilledSftFile(),
  systemPrompt: () => brain?.instructions() ?? "",
});
let ttsThisTurn = 0;
let traceForTurn: TurnTrace | null = null;
let learnerRef: Learner | null = null;
let removeKwinHelper: (() => Promise<void>) | null = null;
let quitting = false;
let recreatingWindow = false;
let windowSolidDocked = false;
let clickThrough = false;
let startupGuard: StartupGuard | null = null;
let safeModeBoot: BootStartStatus = { safeMode: false, consecutiveCrashes: 0, reason: null };
let healthyTimer: NodeJS.Timeout | null = null;
let initiative: Initiative | null = null;
let reminders: ReminderStore | null = null;
let missions: MissionControl | null = null;
/** Missions of several steps that outlast a conversation and a restart. */
let board: MissionBoard | null = null;
/** The questions about mission steps that are open now, at the PC and on signed-in devices. */
let approvalDesk: ApprovalDesk | null = null;
let orders: StandingOrders | null = null;
/** Her ear for the desktop's notifications. It listens only while the user has that switched on. */
let noticeWatch: NoticeWatch | null = null;
let gameWatch: GameWatch | null = null;
/** What is on: the user's calendars, which she only reads, and her own list. */
let agenda: Agenda | null = null;
let agendaWatch: AgendaWatch | null = null;
let browserDeck: BrowserDeck | null = null;
let watchTimer: NodeJS.Timeout | null = null;
/** Her count of this month's searches sent to Brave. */
let searchBudget: SearchBudget | null = null;
const WATCH_EVERY_MS = 2 * 60 * 1000;
/** A graphics card this busy means a game or a render is running; she does not start a briefing then. */
const BUSY_GPU_PERCENT = 60;
const runFile = promisify(execFile);
/**
 * Whether the window may change size while keeping its bottom-right corner still. On
 * X11 the app moves itself; on KDE Wayland the KWin helper does. Anywhere else the
 * window stays at its full size, because shrinking would make the character jump.
 */
let canResize = process.env["XDG_SESSION_TYPE"] !== "wayland";
const config = new ConfigStore(configFile());

function appState(showNotice: boolean): AppState {
  const modelBundle = modelFiles.bundle();
  const modelRevision = modelFiles.revision();
  const modelUrl = modelBundle
    ? // The revision keeps a re-imported model from being served out of the page's cache.
      `${SCHEME}://model/${modelRevision}/${modelBundle.entry.split("/").map(encodeURIComponent).join("/")}`
    : null;
  const modelHash = modelBundle?.hash ?? null;
  const modelFraming = modelHash ? (config.value.avatarFraming[modelHash] ?? null) : null;
  const info = modelBundle?.info;
  const modelCredit = info ? { name: info.name, terms: info.comment.slice(0, 1500) } : null;
  return {
    modelUrl,
    modelHash,
    modelFraming,
    modelCredit,
    notice: UNOFFICIAL_NOTICE,
    showNotice,
    autoListen: config.value.voice.alwaysListening,
    fixedSize: !canResize && config.value.windowMode !== "solid-docked",
    windowMode: config.value.windowMode,
    lowPowerStage: config.value.lowPowerStage,
    clickThrough,
    inferenceBackend: describeInferenceLocality(config.value.inference),
  };
}

function sendToWindow(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- the character model ----------

// Packing her model, opening it and serving its parts to her own page is in
// modelFiles.ts, together with the rule that the raw files never leave it.
const modelFiles = createModelFiles({
  scheme: SCHEME,
  appOrigin: APP_ORIGIN,
  rendererDir: RENDERER_DIR,
  bundledRoot: resolveBundledRoot(app.getAppPath()),
  sendToWindow,
  appState,
  defaultModelPath: join(resolveBundledRoot(app.getAppPath()), "assets", "models", "ai-navigator", "ai-navigator.pmx"),
});
const { loadModelBundle, packIntoBundle, registerProtocol, importModel, importModelFile, removeModel } =
  modelFiles;

// ---------- the window ----------

/** Bottom-right corner. Honoured on X11; on Wayland the compositor decides (see kwin.ts). */
function defaultPosition(size: { width: number; height: number }): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - size.width - CORNER_MARGIN.right,
    y: area.y + area.height - size.height - CORNER_MARGIN.bottom,
  };
}

const WINDOW_SIZES: Record<WindowLayout, { width: number; height: number }> = {
  compact: WINDOW_COMPACT,
  balloon: WINDOW_EXPANDED,
  log: WINDOW_LOG,
};

/** Set while the window sits moved in from a screen edge so that all of it shows. */
let heldCorner: HeldCorner | null = null;

/** Returns connected display workAreas in `spatialStage.ts` format for multi-monitor edge docking. */
function connectedDisplays(): DisplayWorkArea[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    x: d.workArea.x,
    y: d.workArea.y,
    width: d.workArea.width,
    height: d.workArea.height,
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId,
  }));
}

/** Moves the companion window cleanly to an edge/corner on any display monitor. */
export function dockWindowToEdge(targetDisplayId: string | null, edge: DockEdge): void {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const placement = computeMultiMonitorDock(
    connectedDisplays(),
    targetDisplayId,
    edge,
    { width: bounds.width, height: bounds.height },
  );
  heldCorner = null;
  mainWindow.setBounds({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  });
}

/** Snaps the companion window to a nearby monitor edge after a user drag across displays. */
export function snapWindowToNearestEdge(thresholdPx = 36): DockEdge | null {
  if (!mainWindow) return null;
  const snapped = snapBoundsToMonitorEdge(mainWindow.getBounds(), connectedDisplays(), thresholdPx);
  if (!snapped) return null;
  heldCorner = null;
  mainWindow.setBounds({
    x: snapped.x,
    y: snapped.y,
    width: snapped.width,
    height: snapped.height,
  });
  return snapped.edge;
}

function resizeWindow(layout: WindowLayout): void {
  if (!mainWindow || !canResize) return;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  // A short screen gets a shorter window; the page lays itself out in whatever it is given.
  const size = fitWindow(WINDOW_SIZES[layout], display.workAreaSize);
  if (bounds.width === size.width && bounds.height === size.height) return;
  if (removeKwinHelper) {
    // KWin keeps the corner in place, and the whole window on the screen (see kwin.ts).
    mainWindow.setSize(size.width, size.height);
  } else {
    // Grown from a corner near the left or top edge, the window would open past it.
    const next = resizeAboutCorner(bounds, size, display.workArea, heldCorner);
    heldCorner = next.held;
    mainWindow.setBounds(next.bounds);
  }
}

function createWindow(): BrowserWindow {
  const solidDocked = config.value.windowMode === "solid-docked";
  windowSolidDocked = solidDocked;
  const size =
    canResize && !solidDocked
      ? WINDOW_COMPACT
      : fitWindow(WINDOW_EXPANDED, screen.getPrimaryDisplay().workAreaSize);
  const window = new BrowserWindow({
    ...size,
    ...defaultPosition(size),
    frame: solidDocked,
    transparent: !solidDocked,
    backgroundColor: solidDocked ? "#141824" : "#00000000",
    hasShadow: solidDocked,
    resizable: solidDocked,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !solidDocked,
    alwaysOnTop: !solidDocked,
    show: false,
    title: WINDOW_TITLE,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The window only ever shows the app's own page; nothing else may load in it.
      webSecurity: true,
      devTools: !app.isPackaged,
      // She has to keep hearing her name while her window is hidden.
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  if (!solidDocked) {
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true);
  }
  if (clickThrough) {
    window.setIgnoreMouseEvents(true, { forward: true });
  }
  window.once("ready-to-show", () => window.show());
  // Closing only hides her: a reply or an approval question may be in progress, and the
  // tray's Quit is the way to end the app.
  window.on("close", (event) => {
    if (quitting || recreatingWindow) return;
    event.preventDefault();
    window.hide();
  });
  // A hidden window draws nothing at all.
  window.on("hide", sendPresence);
  window.on("show", sendPresence);
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (process.env["AI_CHAN_DEBUG"]) {
    window.webContents.on("console-message", (details) => {
      console.log(`[window:${details.level}] ${details.message}`);
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  void window.loadURL(`${APP_ORIGIN}/index.html`);
  return window;
}

/** The microphone is the only device permission the window is ever given. */
function restrictPermissions(): void {
  const isOurWindow = (contents: Electron.WebContents | null): boolean =>
    contents !== null && contents === mainWindow?.webContents;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isOurWindow(contents) && permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return isOurWindow(contents) && permission === "media";
  });
}

function showWindow(focusInput: boolean): void {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  if (focusInput) {
    mainWindow?.focus();
    sendToWindow("ui:focus-input");
  }
}

function setClickThrough(on: boolean): void {
  clickThrough = on;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(on, { forward: true });
  }
  sendToWindow("app:state", appState(false));
  rebuildTrayMenu();
}

/** Moves the companion window back onto the primary display workArea and clears click-through. */
function resetWindowToPrimary(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = mainWindow.getBounds();
  const size = {
    width: Math.max(WINDOW_COMPACT.width, Math.min(bounds.width || WINDOW_COMPACT.width, area.width - 24)),
    height: Math.max(WINDOW_COMPACT.height, Math.min(bounds.height || WINDOW_COMPACT.height, area.height - 24)),
  };
  heldCorner = null;
  if (clickThrough) {
    clickThrough = false;
    mainWindow.setIgnoreMouseEvents(false);
  }
  mainWindow.setBounds({ ...defaultPosition(size), ...size });
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendToWindow("app:state", appState(false));
  rebuildTrayMenu();
  sendPresence();
}

function rescueOffscreenWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const displays = connectedDisplays();
  if (!isBoundsOnAnyDisplay(mainWindow.getBounds(), displays)) {
    resetWindowToPrimary();
  }
}

async function forceReleaseVram(): Promise<void> {
  interruptBrain();
  await brain?.whenIdle();
  await visionSidecar?.dispose().catch(() => undefined);
  await engine?.unload();
  await voice.releaseIdleMemory().catch(() => undefined);
  sendPresence();
}

async function restartInSafeMode(): Promise<void> {
  await startupGuard?.requestSafeModeNextBoot(
    "Restarted in Safe Mode from the system tray. Optional background hooks are paused until you clear Safe Mode.",
  );
  quitting = true;
  app.relaunch();
  app.exit(0);
}

async function exportSupportBundleFromTray(): Promise<void> {
  const result = await settings.exportSupportBundle();
  showNotice(
    `Support bundle exported (${result.redactions} secrets scrubbed): ${result.path}`,
  );
}

function applyStageOptions(): void {
  const wantSolidDocked = config.value.windowMode === "solid-docked";
  if (mainWindow && !mainWindow.isDestroyed() && windowSolidDocked !== wantSolidDocked) {
    const wasVisible = mainWindow.isVisible();
    recreatingWindow = true;
    try {
      mainWindow.destroy();
    } finally {
      recreatingWindow = false;
    }
    mainWindow = null;
    const created = createWindow();
    if (wasVisible) created.showInactive();
    sendPresence();
    return;
  }
  sendToWindow("app:state", appState(false));
}

function applyHotkeys(): { failed: string[] } {
  globalShortcut.unregisterAll();
  const failed: string[] = [];
  const bindings: [string, () => void][] = [
    [
      config.value.hotkeys.pushToTalk.trim(),
      () => {
        const next = !voice.listening();
        if (mainWindow && !mainWindow.isVisible()) mainWindow.showInactive();
        sendToWindow("ui:listen", next);
      },
    ],
    [
      config.value.hotkeys.summonHide.trim(),
      () => {
        if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          showWindow(true);
        }
      },
    ],
    [
      config.value.hotkeys.clickThrough.trim(),
      () => {
        setClickThrough(!clickThrough);
      },
    ],
  ];
  for (const [accel, handler] of bindings) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, handler);
      if (!ok) failed.push(accel);
    } catch {
      failed.push(accel);
    }
  }
  return { failed };
}

// ---------- the tray, reports, voice & settings controllers ----------

function chooseBrain(choice: string): void {
  void (async () => {
    await config.update({ brain: choice });
    interruptBrain();
    await brain?.whenIdle();
    await visionSidecar?.dispose().catch(() => undefined);
    await engine?.setChoice(choice);
    rebuildTrayMenu();
  })().catch((error: unknown) => console.error(error));
}

/**
 * Switches the smaller working memory on or off. The model has to be loaded afresh for
 * it, so this goes the way a change of brain does: her reply is stopped first.
 */
function chooseLean(lean: boolean): void {
  void (async () => {
    interruptBrain();
    await brain?.whenIdle();
    await engine?.setLean(lean);
  })().catch((error: unknown) => console.error(error));
}

function chooseLanguage(language: LanguageCode): void {
  void (async () => {
    await config.update({ language });
    const refreshed = brain?.refreshInstructions();
    toldStopped(); // it stops her reply first
    await refreshed;
    await voice.createVoice();
    rebuildTrayMenu();
  })().catch((error: unknown) => console.error(error));
}

/** Opens an avatar `.bundle` and binds its declared name, personality, and voice together. */
async function loadAndBindCharacterBundle(bundlePath: string): Promise<{ name: string }> {
  const manifest = await modelFiles.switchCharacterBundle(bundlePath);
  const nextCharacter = characterFromBundleManifest(manifest, config.value.character.userAddress);
  const boundVoice = resolveBundleVoiceBinding(
    manifest.voice,
    voice.designedVoices(),
    voice.fullVoiceReady(),
  );
  await config.update({
    characterBundle: bundlePath,
    character: nextCharacter,
    ...(boundVoice?.speed !== undefined
      ? { voice: { ...config.value.voice, speed: boundVoice.speed } }
      : {}),
  });
  if (boundVoice) {
    voice.chooseVoice(boundVoice.engine, boundVoice.design);
  }
  void brain?.refreshInstructions().catch(() => undefined);
  rebuildTrayMenu();
  return { name: manifest.persona?.displayName ?? manifest.name };
}

const voice = createVoiceController({
  config,
  mainWindow: () => mainWindow,
  brain: () => brain,
  sendToWindow,
  interruptBrain,
  rebuildTrayMenu: () => rebuildTrayMenu(),
  onTtsMs: (ms) => {
    ttsThisTurn += Math.round(ms);
    if (traceForTurn) traceForTurn.ms.tts = ttsThisTurn;
  },
});

// The pages she writes out to be read (her self-check, what she has done, what she has
// learned) are in reports.ts.
const { runSelfCheck, showSelfCheck, showActions, showLearned } = createReports({
  config,
  engine: () => engine,
  memoryStore: () => memoryStore,
  archive: () => archive,
  actions: () => actions,
  learner: () => learnerRef,
  noticeWatch: () => noticeWatch,
  agenda: () => agenda,
  gameWatch: () => gameWatch,
  initiative: () => initiative,
  reach: () => reach,
  voiceBackend: () => voice.voiceBackend(),
  speaker: () => voice.speaker(),
  listening: () => voice.listening(),
  brainAsleepFor: () => brainAsleepFor,
  describeBraveUse: () => settings.describeBraveUse(),
  hasNativeWinHands: () =>
    platformAdapter?.platform === "win32" &&
    Boolean(resolveNativeWinHandsBinary(join(resolveBundledRoot(app.getAppPath()), "hands", "win_hands.ps1"))),
});

const settings = createSettingsController({
  appOrigin: APP_ORIGIN,
  config,
  engine: () => engine,
  memoryStore: () => memoryStore,
  archive: () => archive,
  traces,
  noticeWatch: () => noticeWatch,
  initiative: () => initiative,
  reach: () => reach,
  mcpHub: () => mcpHub,
  visionSidecar: () => visionSidecar,
  board: () => board,
  searchBudget: () => searchBudget,
  designedVoices: () => voice.designedVoices(),
  fullVoiceReady: () => voice.fullVoiceReady(),
  createVoice: () => voice.createVoice(),
  chooseBrain,
  chooseLean,
  chooseLanguage,
  chooseVoice: (voiceEngine, design) => voice.chooseVoice(voiceEngine, design),
  setHandsOff,
  forgetConversations,
  showLearned,
  showActions,
  showSelfCheck,
  runSelfCheck,
  desktopSessionNotice: () => linuxDesktopEnv?.notice ?? null,
  recentErrors: () => [...recentErrors],
  safeModeStatus: () => ({
    active: safeModeBoot.safeMode,
    consecutiveCrashes: safeModeBoot.consecutiveCrashes,
    reason: safeModeBoot.reason,
  }),
  clearSafeMode: async () => {
    await startupGuard?.exitSafeMode();
    safeModeBoot = { safeMode: false, consecutiveCrashes: 0, reason: null };
    if (config.value.notices.read) noticeWatch?.start();
    await reach?.start();
    const abilities = await reach?.hands.abilities().catch(() => null);
    if (abilities) settings.setHandsAbilities(abilities);
    rebuildTrayMenu();
  },
  applyHotkeys,
  applyStageOptions,
  beforeProfileRestore: async () => {
    await actions?.flush().catch(() => undefined);
    episodicGraph = null;
    store?.close();
    store = null;
  },
  relaunchAfterRestore: () => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  },
  showAvatarWindow: () => showWindow(false),
  importModel,
  loadCharacterBundle: loadAndBindCharacterBundle,
  onCharacterChanged: () => {
    brain?.markInstructionsDirty();
    rebuildTrayMenu();
  },
  onMemoryChanged: () => {
    brain?.markInstructionsDirty();
  },
  onCharacterReset: async () => {
    await loadModelBundle();
    sendToWindow("app:state", appState(false));
  },
  onInferenceChanged: async () => {
    interruptBrain();
    await brain?.whenIdle();
    await engine?.setInferenceBackend(config.value.inference);
    sendToWindow("app:state", appState(false));
    rebuildTrayMenu();
  },
  detectGameOnCard: gameOnCard,
  sendToWindow,
  rebuildTrayMenu: () => rebuildTrayMenu(),
});

const workbench = createWorkbenchController({
  appOrigin: APP_ORIGIN,
  config,
  dataDir,
  workspaceDir: workspaceRoot,
  pluginsDir: join(resolveBundledRoot(app.getAppPath()), "plugins"),
  board: () => board,
  approvalDesk: () => approvalDesk,
  memoryStore: () => memoryStore,
  episodic: () => episodicGraph,
  orders: () => orders,
  skills: () => compiledSkills,
  traces,
  recall: () => recallRef,
  brain: () => brain,
});

// The badge and its menu are laid out in tray.ts; what each entry does is done here.
const { rebuildTrayMenu, createTray } = createTrayMenu({
  config,
  windowTitle: WINDOW_TITLE,
  mainWindow: () => mainWindow,
  brain: () => brain,
  reach: () => reach,
  initiative: () => initiative,
  voiceBackend: () => voice.voiceBackend(),
  designedVoices: () => voice.designedVoices(),
  fullVoiceReady: () => voice.fullVoiceReady(),
  startAtLogin: () => settings.startAtLogin(),
  noteStartAtLogin: (on) => settings.noteStartAtLogin(on),
  nameRequired: () => voice.nameRequired(),
  showWindow,
  openSettings: () => settings.openSettings(),
  openWorkbench: (tab) => workbench.open(tab),
  sendToWindow,
  chooseBrain,
  chooseLanguage,
  chooseVoice: (voiceEngine, design) => voice.chooseVoice(voiceEngine, design),
  setWatching: (on) => settings.setWatching(on),
  setHearingPc: (on) => settings.setHearingPc(on),
  setStationOpen: (on) => settings.setStationOpen(on),
  setHandsOff,
  showSelfCheck,
  showActions,
  showLearned,
  forgetConversations,
  toldStopped,
  importModel,
  removeModel,
  clickThrough: () => clickThrough,
  setClickThrough,
  resetWindowToPrimary,
  forceReleaseVram,
  restartInSafeMode,
  exportSupportBundle: exportSupportBundleFromTray,
});

// ---------- thinking and presence ----------

/** Tells the page whether to draw her at all, and whether she is asleep. */
function sendPresence(): void {
  const activeJobs =
    (missions?.running ?? 0) +
    (research?.busy ? 1 : 0) +
    (board?.list().filter((m) => m.state === "running").length ?? 0);
  sendToWindow("stage:presence", {
    visible: mainWindow?.isVisible() ?? false,
    asleep: brainAsleep,
    ...(brainAsleep && brainAsleepFor !== null ? { asleepFor: brainAsleepFor } : {}),
    activeJobs,
    // What she is taking in and held back from, for the small badges beside her.
    senses: {
      watching: config.value.sight.watch,
      hearingPc: config.value.hearing.pcAudio,
      station: {
        open: reach?.station?.running ?? false,
        paired: reach?.station?.devices().length ?? 0,
      },
      handsOff: config.value.handsOff,
      doNotDisturb: config.value.doNotDisturb,
      waitingForName: config.value.voice.alwaysListening,
      machines: config.value.fleet.machines.map((machine) => machine.name).slice(0, 6),
    },
  } satisfies Presence);
}

/** True for a message from her own window, which is the only page that may ask for these. */
function fromMainWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return mainWindow !== null && event.sender === mainWindow.webContents;
}

/** How many typed messages her window has sent since it was loaded. */
let typedTaken = 0;

/**
 * Tells her window that her reply was stopped. Whatever was waiting behind that reply
 * was dropped with it, so the window must stop expecting answers to those things. A
 * message typed after this is told apart by the count, and is still answered.
 */
function toldStopped(): void {
  sendToWindow("chat:dropped", typedTaken);
}

/** Stops the reply she is writing, and says so to her window. */
function interruptBrain(): void {
  brain?.interrupt();
  toldStopped();
}

function onEngineStatus(status: EngineStatus): void {
  // Her brain being put away or brought back is shown in her body, not in the balloon.
  const asleep = status.stage === "resting";
  const asleepFor = status.stage === "resting" ? programShown(status.game) : null;
  if (asleep !== brainAsleep || asleepFor !== brainAsleepFor) {
    brainAsleep = asleep;
    brainAsleepFor = asleepFor;
    sendPresence();
  }
  if (status.stage === "resting") {
    // Her voice holds GPU/ORT memory too; restIfQuiet avoids cutting her off mid-sentence.
    void Promise.resolve(voice.speaker()?.restIfQuiet())
      .then(() => voice.releaseIdleMemory())
      .catch((error: unknown) => console.warn("[voice] could not be put away:", error));
    return;
  }
  sendToWindow("brain:event", {
    type: "setup",
    stage: status.stage,
    label: status.label,
    progress:
      status.stage === "downloading" && status.total > 0 ? status.received / status.total : null,
  } satisfies BrainEvent);
}

function onBrainEvent(event: BrainEvent): void {
  if (event.type === "status" && event.state === "thinking") {
    ttsThisTurn = 0;
    traceForTurn = null;
  }
  sendToWindow("brain:event", event);
  reach?.onBrainEvent(event);
  voice.onBrainEvent(event);
}

// ---------- the ship: watch, reminders, missions, briefing ----------

function startShipServices(workspace: string): void {
  initiative = new Initiative({
    deliver: (text, options) => {
      void (async () => {
        // Speaking first must never be what starts a download of several gigabytes. Until
        // her brain is on disk, what happened is shown as it is, in the app's own words.
        if (engine && (await engine.isDownloaded())) {
          brain?.announce(text, { outsideText: options.outsideText });
        } else {
          if (mainWindow && !mainWindow.isVisible()) mainWindow.showInactive();
          sendToWindow("brain:event", {
            type: "caution",
            // The wording meant for Captain's eyes, not the one written to her.
            message: excerpt(options.plain),
          } satisfies BrainEvent);
        }
      })();
    },
    whenFree: () => brain?.whenIdle() ?? Promise.resolve(),
    doNotDisturb: () => config.value.doNotDisturb,
    // Game mode: quiet while a game is on, unless that has been switched off.
    inGame: () => (config.value.quietInGames ? (gameWatch?.current()?.game ?? null) : null),
    brainAwake: () => engine?.isLoaded() ?? false,
    showPlainly: (text) => showNotice(text),
    raisedBefore: config.value.alertsRaised,
    onRaised: (key, at) => {
      void config
        .update({ alertsRaised: { ...config.value.alertsRaised, [key]: at } })
        .catch((error: unknown) => console.warn("[config]", error));
    },
  });

  reminders = new ReminderStore(remindersFile(), (reminder, lateByMs) => {
    const late =
      lateByMs > 5 * 60_000
        ? ` (it was due ${Math.round(lateByMs / 60_000)} minutes ago, while the app was closed)`
        : "";
    initiative?.raise({
      kind: "reminder",
      requested: true,
      text: `A reminder is due${late}: "${reminder.text}"`,
      plain: `Reminder${late}: ${reminder.text}`,
    });
    sendToWindow("stage:reaction", { event: "reminder-fired", detail: reminder.text });
    void reach?.remindPhone(reminder.text);
  });

  // Knows when a game is on. Started a little after the window is up; see main().
  gameWatch = new GameWatch({
    file: playLogFile(),
    store: store ?? undefined,
    adapter: platformAdapter ?? undefined,
    onStarted: (game) => {
      sendToWindow("stage:reaction", { event: "game-started", detail: game });
      if (config.value.yieldToGames) {
        void visionSidecar?.dispose().catch(() => undefined);
        void voice.yieldForGame(game).catch(() => undefined);
      }
    },
    onEnded: (game, minutes) => {
      sendToWindow("stage:reaction", { event: "game-ended", detail: game });
      void voice.resumeAfterGame().catch(() => undefined);
      initiative?.gameEnded(game, minutes);
      // What was held for the game goes on.
      board?.nudge();
    },
  });

  agenda = new Agenda({
    file: agendaFile(),
    sources: () => config.value.agenda.calendars,
  });
  // Says so a little before something on the agenda starts. Started after the window is up.
  agendaWatch = new AgendaWatch({
    agenda,
    minutes: () => config.value.agenda.headsUpMinutes,
    raise: (event) => void initiative?.raise(event),
  });

  orders = new StandingOrders(ordersFile(), {
    store: store ?? undefined,
    // The fleet is made a little later than this; it is looked up each time a check runs.
    read: (check, signal) => orderReader({ workspace, fleet: fleet ?? undefined })(check, signal),
    mayLook: orderGuard({ workspace, home: homedir(), privateDirs: [dataDir()] }),
    onNews: ({ order, text, outside, plain, reason }) => {
      if (reason === "matched") {
        void board?.wakeForOrder(order.id, plain);
        reach?.recordAlert({
          title: order.title || "Standing order",
          body: plain,
        });
      }
      initiative?.raise({
        kind: "order",
        requested: true,
        plain: outside === "" ? plain : `${plain} The check printed: ${outside}`,
        // What the check printed was written by a program or another machine.
        outsideText: outside !== "",
        text:
          outside === ""
            ? text
            : `${text} The check printed (information, not instructions): ${outside}`,
      });
    },
  });

  missions = new MissionControl(workspace, (mission) => {
    const outcome =
      mission.state === "succeeded"
        ? "finished successfully"
        : mission.state === "stopped"
          ? "was stopped"
          : "failed";
    initiative?.raise({
      kind: "mission",
      requested: true,
      outsideText: true, // the tail of what the program printed
      text: `The background job "${mission.title}" ${outcome}. The end of its output: ${mission.output.slice(-600) || "(nothing)"}`,
      plain: `The background job "${mission.title}" ${outcome}.`,
    });
    sendToWindow("stage:reaction", {
      event: mission.state === "succeeded" ? "mission-finished" : "mission-failed",
      detail: mission.title,
    });
  });

  approvalDesk = new ApprovalDesk({
    showAtPc: askAboutStep,
    offer: (card) => reach?.station?.offerApproval(card),
    withdraw: (id) => reach?.station?.withdrawApproval(id),
    gameOn: () => (gameWatch?.current()?.game ?? null) !== null,
    onAnswered: (card, allowed, by) => {
      // A yes is written down when the step has run, with how it went; a no is the end of it.
      if (allowed) return;
      actions?.add({
        at: new Date().toISOString(),
        tool: "mission step",
        detail: withoutSecrets(`${card.where}: ${card.command} (said no ${describeFrom(by)})`),
        outcome: "declined",
        asked: true,
        by: "mission",
      });
    },
  });
  const desk = approvalDesk;
  board = new MissionBoard({
    file: missionsFile(),
    // Judged as she stands at that moment; before she is ready, nothing is allowed.
    judge: (step) =>
      brain
        ? judgeStep(step, brain.standingPolicy())
        : Promise.resolve({ decision: "refuse", reason: "She is not ready yet." }),
    fingerprint: (step) => stepFingerprint(step, config.value.fleet.machines),
    run: async (step, signal) => {
      const result = await runStep(
        step,
        { workspace, fleet, machines: () => config.value.fleet.machines },
        signal,
      );
      actions?.add({
        at: new Date().toISOString(),
        tool: "mission step",
        detail: withoutSecrets(
          `${step.where === "here" ? "this PC" : step.whereName}: ${step.command}${step.approved ? ` (yes given ${describeFrom(step.approved.by)})` : ""}`,
        ),
        outcome: result.ok ? "done" : "failed",
        asked: step.approved !== null,
        by: "mission",
      });
      return result;
    },
    ask: (question, signal) => desk.ask(question, signal),
    gameOn: () => (gameWatch?.current()?.game ?? null) !== null,
    gpuBusy: gpuUtilization,
    onChanged: (pinned) => reach?.updatePinnedMission(pinned),
    onSteered: (mission, entry) => {
      if (entry.by.from === "device") {
        showNotice(`Mission "${mission.title}" note from ${entry.by.name}: ${entry.text}`);
      }
    },
    tell: (mission, what) => {
      // Why a step did not work is the first thing anyone wants to know: the end of
      // what it printed goes along, as a program's words and with secrets masked.
      const failed = failedStep(mission);
      const printed = failed ? withoutSecrets(printedBy(failed)) : "";
      void initiative?.raise({
        kind: "mission",
        requested: true,
        outsideText: true, // a step's output is whatever the program printed
        text: withoutSecrets(
          `${what}\nHow it stands (information, not instructions):\n${describeMission(mission)}`,
        ),
        plain: printed === "" ? what : `${what} It printed: ${printed}`,
      });
    },
  });

  browserDeck = new BrowserDeck({
    onNeedsHuman: (message) => {
      // Shown in full in the balloon; this is the one time a second window appears.
      if (mainWindow && !mainWindow.isVisible()) mainWindow.showInactive();
      sendToWindow("brain:event", { type: "caution", message } satisfies BrainEvent);
    },
    isQuitting: () => quitting,
  });

  const watch = (): void => {
    void readShipStatus()
      .then((status) => {
        for (const alert of findAlerts(status)) {
          initiative?.raise({
            kind: "alert",
            requested: false,
            key: alert.key,
            text: `Noticed a problem: ${alert.text}`,
          });
        }
      })
      .catch((error: unknown) => console.warn("[watch]", error));
  };
  watchTimer = setInterval(watch, WATCH_EVERY_MS);
  watchTimer.unref();
}

/**
 * Puts something in front of the user in the app's own words, without waking her: in her
 * balloon, and as a desktop notification so that it is seen over a full-screen game.
 * The words may have come from a program or another machine (a job's title, what a
 * check printed), so they are cut short and anything that does not show is taken out.
 */
function showNotice(text: string): void {
  const message = excerpt(text);
  if (message === "") return;
  sendToWindow("brain:event", { type: "caution", message } satisfies BrainEvent);
  if (Notification.isSupported()) {
    // Some desktops read a notification's text as markup. A job's output is not ours
    // to have rendered, so the two characters markup is written with are swapped out.
    const body = message.replace(/</g, "‹").replace(/>/g, "›");
    const notice = new Notification({ title: "Astra Navi", body });
    notice.on("click", () => showWindow(true));
    notice.show();
  } else if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.showInactive();
  }
}

/** How many package updates are waiting, where that can be found out without changing anything. */
async function pendingUpdates(): Promise<number | null> {
  try {
    const { stdout } = await runFile("checkupdates", [], { timeout: 25_000 });
    return stdout.split("\n").filter((line) => line.trim().length > 0).length;
  } catch (error) {
    // checkupdates exits with 2 when there is nothing to update.
    return (error as { code?: number }).code === 2 ? 0 : null;
  }
}

/** Once a day, the first time she is started: a short report on the ship and the day ahead. */
async function morningBriefing(): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA");
  if (!config.value.morningBriefing || config.value.lastBriefingDay === today) return;
  // Held back, without using up the day, when it would be unwelcome or could not be given:
  // do-not-disturb is on, her brain is not downloaded yet, or the graphics card is already
  // hard at work (a game, a render), which loading her model would disturb.
  if (config.value.doNotDisturb || !(engine && (await engine.isDownloaded()))) return;
  // Nor while a game is on: it would only be held, and a restart before the game ended
  // would lose it with the day already marked as briefed.
  if (initiative?.holding) return;

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [status, updates, log, onToday] = await Promise.all([
    readShipStatus(),
    pendingUpdates(),
    readFile(deckLogFile(), "utf8").catch(() => ""),
    agenda
      ? agenda
          // To the last moment of today by the calendar: a day is not always 24 hours long.
          .between(
            dayStart,
            new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1),
          )
          .catch(() => ({ items: [], unread: [] }))
      : Promise.resolve({ items: [], unread: [] }),
  ]);
  const dueToday = (reminders?.list() ?? []).filter(
    (reminder) => new Date(reminder.dueAt).toLocaleDateString("en-CA") === today,
  );
  if ((status.gpu?.usedPercent ?? 0) >= BUSY_GPU_PERCENT) return;
  const lastEntries = log
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-3)
    .map((line) => line.slice(0, 400));
  const addressee = config.value.character.userAddress.trim() || "the user";
  const parts = [
    `This is the first start today, and the time is ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Greet ${addressee} to suit the time of day and give a short briefing: anything that needs attention first, then one line on the ship, then what is planned. Leave out anything unremarkable.`,
    `Ship status:\n${describeShipStatus(status)}`,
    findAlerts(status).length > 0
      ? `Problems: ${findAlerts(status)
          .map((alert) => alert.text)
          .join(" ")}`
      : "No problems found.",
  ];
  if (updates !== null) parts.push(`Software updates waiting: ${updates}`);
  parts.push(
    dueToday.length > 0
      ? `Reminders for today:\n${dueToday.map((r) => `- ${new Date(r.dueAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ${r.text}`).join("\n")}`
      : "No reminders are set for today.",
  );
  const agendaToday = briefingLines(onToday, now);
  if (agendaToday) parts.push(agendaToday);
  if (lastEntries.length > 0) parts.push(`Latest Deck Log entries:\n${lastEntries.join("\n")}`);
  // The log lines are text read back from a file, and a calendar's entries may have been
  // written by whoever sent an invitation, so the briefing counts as outside text.
  const raised = initiative?.raise({
    kind: "briefing",
    requested: false,
    outsideText: lastEntries.length > 0 || agendaToday !== "",
    text: parts.join("\n\n"),
  });
  if (raised) await config.update({ lastBriefingDay: today });
}

// ---------- start-up and shutdown ----------

/** `--import-model <file>` packs a model from the command line and exits. */
async function importFromCommandLine(): Promise<boolean> {
  const flag = process.argv.indexOf("--import-model");
  if (flag === -1) return false;
  const file = process.argv[flag + 1];
  try {
    if (!file) throw new Error('Usage: npm run import-model -- "/path/to/model.pmx"');
    const files = await packIntoBundle(file);
    console.log(`Packed ${files} files into ${modelBundleFile()}`);
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  }
  return true;
}

/**
 * Takes her hands off the controls, or gives them back. Taking them off also stops
 * whatever she is in the middle of: the reply being written and any research under way.
 */
async function setHandsOff(off: boolean): Promise<void> {
  await config.update({ handsOff: off });
  if (!off) return;
  // Everything she has in motion stops: the reply, her research, and her background jobs.
  // (She still takes notes on conversations; those change nothing on the PC.)
  interruptBrain();
  await research?.stopAll();
  await missions?.stopAll();
}

/**
 * Puts a mission's step to the person at the PC, in a window of its own, since it may
 * come hours after anyone last spoke to her. Null when the question was taken down
 * unanswered (it was answered on a device, or the mission was cancelled): closing the
 * window that way must never be read as a no.
 */
async function askAboutStep(
  card: ApprovalCard,
  sensitive: boolean,
  signal: AbortSignal,
): Promise<boolean | null> {
  const options: Electron.MessageBoxOptions = {
    type: sensitive ? "warning" : "question",
    buttons: ["Allow this step", "Do not allow"],
    defaultId: 1,
    cancelId: 1,
    title: "Astra Navi: a mission is waiting for you",
    message: `Mission "${card.mission}", step ${card.step} of ${card.steps}: ${card.title}`,
    // The card's command already has any character that would not show written out.
    detail: `On ${card.where}:\n${card.command}\n\n${card.reason}${sensitive ? "\n\nThis touches a place where passwords or keys are kept, so it can only be answered here." : ""}`,
    noLink: true,
    signal,
  };
  if (process.env["ASTRA_NAVI_DOGFOOD_WORKBENCH"] === "1") {
    return await new Promise<boolean | null>((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  }
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  // Closed from here because the question is no longer open: that is no answer.
  if (signal.aborted) return null;
  return response === 0;
}

/** Erases the word-for-word record of past conversations, after asking. Her notes are kept. */
async function forgetConversations(): Promise<void> {
  if (!archive) {
    // Nothing word for word is kept to ask about, but a file of records may be left
    // from when that was switched on: it goes without a question.
    traces.clear();
    awayTraces.clear();
    await Promise.all([traceFile.clear(), trainingSink.clear()]);
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Forget them", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Forget all ${archive.count} past exchanges?`,
    detail:
      "The word-for-word record of what you two have said is erased from this computer. What she has learned (her notes) is kept. This cannot be undone.",
  });
  if (response !== 0) return;
  await archive.clear();
  // The records of her replies hold the same words: they go too, kept or not.
  traces.clear();
  awayTraces.clear();
  await Promise.all([traceFile.clear(), trainingSink.clear()]);
  // Her window may be showing some of them in its log.
  sendToWindow("chat:forgotten");
}

/**
 * After a write-up: notes when each task was done, and when one turns out to be a habit,
 * has her offer (once) to take it on.
 */
async function noticeRoutines(routines: RoutineWatch, learned: Learned): Promise<void> {
  for (const skill of learned.skills) await routines.note(skill.id, skill.text, learned.when);
  const [routine] = routines.found();
  if (!routine) return;
  await routines.markOffered(routine.id);
  initiative?.raise({ kind: "routine", requested: false, text: describeRoutine(routine) });
}

async function shutDown(): Promise<void> {
  // Speech first: nothing may ask the voice for another sentence while it is being closed.
  voice.beginShutdown();
  if (healthyTimer) {
    clearTimeout(healthyTimer);
    healthyTimer = null;
  }
  globalShortcut.unregisterAll();
  await startupGuard?.markBootHealthy().catch(() => undefined);
  if (watchTimer) clearInterval(watchTimer);
  reminders?.stop();
  orders?.dispose();
  noticeWatch?.dispose();
  agendaWatch?.stop();
  browserDeck?.dispose();
  void sight?.rest();
  const closing = (async () => {
    // First, so the window manager's script, the virtual devices and the open port go
    // even if something further down hangs.
    await reach?.dispose();
    await visionSidecar?.dispose();
    visionSidecar = null;
    await mcpHub?.closeAll();
    mcpHub = null;
    platformAdapter?.dispose?.();
    platformAdapter = null;
    await searchBudget?.flush();
    // A game still going on is written down as played up to the last look.
    await gameWatch?.stop();
    await missions?.stopAll();
    // What a mission was in the middle of is found as interrupted when she next starts.
    await board?.dispose();
    await research?.stopAll();
    await actions?.flush();
    await Promise.allSettled([traceFile.whenWritten(), trainingSink.whenWritten()]);
    if (removeKwinHelper) {
      const remove = removeKwinHelper;
      removeKwinHelper = null;
      await remove();
    }
    const closingBrain = brain;
    brain = null;
    await closingBrain?.dispose();
    await voice.dispose();
    store?.close();
    store = null;
  })();
  // Never let a stuck clean-up keep the app from closing.
  await Promise.race([
    closing.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

async function main(): Promise<void> {
  if (process.argv.includes("--import-model")) {
    await app.whenReady();
    await importFromCommandLine();
    return;
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showWindow(true));
  // Closing the window keeps AI-chan in the tray; Quit in the tray menu ends the app.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => {
    quitting = true;
  });
  let cleanedUp = false;
  app.on("will-quit", (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    cleanedUp = true;
    void shutDown().finally(() => app.quit());
  });

  await app.whenReady();
  await config.load();
  startupGuard = new StartupGuard(dataDir(), 2);
  safeModeBoot = await startupGuard.recordBootStart();
  if (safeModeBoot.safeMode && safeModeBoot.reason) {
    console.warn(`[startup] ${safeModeBoot.reason}`);
    recordRecentError("safeMode", safeModeBoot.reason);
  }
  // Her badges follow the settings, whoever changed them: the tray, the panel, or she herself.
  config.onChange = () => queueMicrotask(sendPresence);
  if (!config.value.firstMetAt) await config.update({ firstMetAt: new Date().toISOString() });

  const memory = new MemoryStore(memoryFile());
  try {
    await memory.load();
  } catch (error) {
    dialog.showErrorBox(
      "Astra Navi's memory could not be read",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  memoryStore = memory;

  try {
    store = new HerStore(storeFile());
    episodicGraph = new EpisodicGraph(store);
  } catch (error) {
    dialog.showErrorBox(
      "Astra Navi's records could not be opened",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  compiledSkills = new CompiledSkillStore(join(dataDir(), "compiled-skills.json"));
  await compiledSkills.load();

  const environment = await detectEnvironment(workspaceDir());
  workspaceRoot = environment.workspace;
  if (process.platform === "win32" || process.platform === "darwin") {
    platformAdapter = createPlatformAdapter({
      scriptDir: scratchDir(),
      winScriptPath: join(resolveBundledRoot(app.getAppPath()), "hands", "win_hands.ps1"),
    });
  }
  startShipServices(environment.workspace);
  engine = new LocalEngine({
    modelsDir: modelsDir(),
    choice: process.env["ASTRA_NAVI_BRAIN"] ?? process.env["AI_CHAN_BRAIN"] ?? config.value.brain,
    contextSize: config.value.contextSize,
    idleUnloadMs: config.value.idleUnloadMinutes * 60_000,
    lean: config.value.leanMemory,
    gameOnCard: config.value.yieldToGames ? gameOnCard : undefined,
    inference: config.value.inference,
    onStatus: onEngineStatus,
    onDownloadUpdate: (dl) => settings.sendDownloadProgress(dl),
  });
  const thinker = engine;
  const routines = new RoutineWatch(routinesFile());
  await routines.load();
  const recall = new Recall(memory, new LocalEmbedder(join(modelsDir(), "speech")), store);
  recallRef = recall;
  const learner = new Learner({
    memory,
    recall,
    ask: (instructions, text, signal) => thinker.sideQuestion(instructions, text, signal),
    journalFile: journalFile(),
    quietMs: quietTimeFor(config.value.idleUnloadMinutes * 60_000),
    onLearned: (learned) => void noticeRoutines(routines, learned),
  });
  await learner.load();
  learnerRef = learner;
  archive = new ConversationArchive(archiveFile(), recall.embedder, undefined, store);
  await archive.load();
  actions = new ActionLog(actionsFile(), undefined, store);
  await actions.load();
  // A crash while she was looking at the screen could have left the picture behind.
  await rm(scratchDir(), { recursive: true, force: true }).catch(() => undefined);
  let cachedTotalVramBytes: number | null = null;
  try {
    const hwRaw = JSON.parse(await readFile(join(dataDir(), "hardware-profile.json"), "utf8")) as {
      profile?: { totalVramBytes?: unknown };
      totalVramBytes?: unknown;
    };
    const vram = hwRaw.profile?.totalVramBytes ?? hwRaw.totalVramBytes;
    if (typeof vram === "number" && Number.isFinite(vram) && vram > 0) {
      cachedTotalVramBytes = vram;
    }
  } catch {
    // Not profiled yet; engine will report exact total VRAM once initialized.
  }
  visionSidecar = new LlamaVisionSidecar({
    modelsDir: modelsDir(),
    brainChoice: () => config.value.brain,
    totalVramBytes: () => engine?.knownTotalVramBytes() ?? cachedTotalVramBytes,
    enabled: () => config.value.sight.nativeVision,
    binaryPath: () => config.value.sight.llamaServerPath,
    endpoint: () => config.value.sight.visionEndpoint,
    extraBinDirs: [join(dataDir(), "bin")],
    gpuBusy: () => (gameWatch?.current()?.game ?? null) !== null,
    localModelLoaded: () => engine?.isLocalModelLoaded() ?? false,
    freeVramBytes: () => engine?.freeVramBytes() ?? Promise.resolve(null),
    beforeSpawn: async () => {
      if (!brain?.isTurnActive()) {
        await engine?.unload();
      }
    },
  });
  sight = new Sight(join(modelsDir(), "speech"), scratchDir(), {
    adapter: platformAdapter ?? undefined,
    gpuBusy: () => (gameWatch?.current()?.game ?? null) !== null,
    visionSidecar,
  });
  noticeWatch = new NoticeWatch({
    adapter: platformAdapter ?? undefined,
    skip: () => config.value.notices.skip,
    // Her own notifications (a reminder shown while her window is hidden) are not news to her.
    ownNames: [app.getName(), "Astra Navi", "astra-navi", "ai-chan"],
  });
  if (!safeModeBoot.safeMode) {
    if (config.value.notices.read) noticeWatch.start();
  }
  // Before the station opens (it reads the same file), so Settings can show whether a
  // name and password are set even while the station is switched off.
  await settings.rereadStationAccount();
  reach = new Reach({
    config,
    sight,
    scriptDir: scratchDir(),
    modelsCacheDir: join(modelsDir(), "speech"),
    handsScript: join(resolveBundledRoot(app.getAppPath()), "hands", "hands.py"),
    adapter: platformAdapter ?? undefined,
    ownApps: [app.getName(), "astra-navi-desktop", "ai-chan-desktop"],
    stationDir: stationDir(),
    phoneAppFile: join(resolveBundledRoot(app.getAppPath()), "phone-app", "build", "astra-navi.apk"),
    onNotice: (text) =>
      initiative?.raise({ kind: "alert", requested: false, outsideText: true, text }),
    // Shown in her window too, and before her reply to it starts: see takeAwayMessage.
    onAwayMessage: (text, device) =>
      takeAwayMessage(brain, text, () => voice.sendVoice({ type: "heard", text, from: device.name })),
    onAwayStop: () => {
      interruptBrain();
      voice.stopSpeaking();
    },
    // The badge beside her counts the paired devices, and says whether the station is open.
    onStationChanged: () => sendPresence(),
    // Nothing has been changed by the request, and nothing can be from the device: the
    // person at the PC is told, plainly and without waking her, and decides in Settings.
    approvals: {
      cards: () => approvalDesk?.cards() ?? [],
      answer: (id, allowed, device) =>
        approvalDesk?.answerFromDevice(id, allowed, tidyDeviceName(device.name)) ?? false,
    },
    pinnedMission: {
      current: () => board?.pinnedView() ?? null,
      steer: async (missionId, note, device) => {
        const updated = await board?.steer(missionId, note, {
          from: "device",
          name: tidyDeviceName(device.name),
        });
        return updated ? pinnedMissionView(updated) : null;
      },
      stop: (missionId, device) =>
        board?.cancelPinned(missionId, {
          from: "device",
          name: tidyDeviceName(device.name),
        }) ?? Promise.resolve(false),
    },
    traces: () => forShow(awayTraces.list()),
    onResetAsked: (device) => {
      showNotice(settings.noteResetAsked(device));
    },
    onProblem: (message) => {
      console.warn(`[reach] ${message}`);
      recordRecentError("reach", message);
      sendToWindow("brain:event", { type: "caution", message } satisfies BrainEvent);
    },
  });
  searchBudget = new SearchBudget(searchCountFile(), () => config.value.search.braveMonthlyLimit);
  await searchBudget.load();
  const hasPhoneLink = environment.commands.has("kdeconnect-cli");
  settings.setPhoneLink(hasPhoneLink);
  fleet = new Fleet({ dir: fleetDir(), machines: () => config.value.fleet.machines });
  mcpHub = new McpHub();
  settings.setCanAskPassword(environment.commands.has("kdialog") || environment.commands.has("zenity"));
  void settings.detectFirewall();
  research = new ResearchDesk({
    openWorker: (instructions) => thinker.openWorker(instructions),
    // In the background she keeps to sources that welcome programs: no browser window
    // may pop up asking someone to prove they are human while nobody is looking.
    web: {
      search: (query, signal) =>
        searchEverywhere(
          query,
          {
            language: config.value.language,
            linux: environment.commands.has("pacman"),
            searxngUrl: config.value.search.searxngUrl,
            braveApiKey: config.value.search.braveApiKey,
            mayAskBrave: () => searchBudget?.take() ?? true,
          },
          signal,
        ),
      read: readWebPage,
    },
    language: () => config.value.language,
    reportsDir: join(environment.workspace, "reports"),
    memory,
    actions,
    workspace: environment.workspace,
    onFinished: (job) =>
      initiative?.raise({
        kind: "mission",
        requested: true,
        outsideText: true,
        text: researchReport(job),
        plain:
          job.state === "done"
            ? `The research "${job.title}" is finished. The report is saved at ${job.reportFile ?? "(nowhere)"}.`
            : `The research "${job.title}" ${job.state === "stopped" ? "was stopped" : "failed"}.`,
      }),
  });
  brain = new Brain({
    config,
    memory,
    recall,
    learner,
    archive,
    actions,
    privateDirs: [dataDir()],
    desktop: {
      sight,
      hands: reach.hands,
      adapter: platformAdapter ?? undefined,
      ownApps: [app.getName()],
      scriptDir: scratchDir(),
      ...reach.desktopExtras,
    },
    hands: reach.handsServices,
    phone: hasPhoneLink,
    fleet,
    mcp: mcpHub,
    screen: reach.screen,
    notices: () => (config.value.notices.read ? noticeWatch : null),
    environment,
    engine,
    historyFile: historyFile(),
    onTrace: (trace) => {
      const enriched: TurnTrace =
        ttsThisTurn > 0 && trace.ms.tts == null
          ? { ...trace, ms: { ...trace.ms, tts: ttsThisTurn } }
          : trace;
      traceForTurn = enriched;
      traces.add(enriched);
      if (enriched.away === true && !enriched.withheld) awayTraces.add(enriched);
      if (config.value.keepTraces) {
        traceFile.append(enriched);
        trainingSink.record(enriched);
      }
    },
    emit: onBrainEvent,
    ship:
      reminders && missions
        ? {
            reminders,
            missions,
            board: board ?? undefined,
            deckLogFile: deckLogFile(),
            research,
            selfCheck: runSelfCheck,
            orders: orders ?? undefined,
            games: gameWatch ?? undefined,
            agenda: agenda ?? undefined,
          }
        : undefined,
    web: {
      // Searching goes through her browser. Reading tries a plain request first, which is
      // lighter, and falls back to the browser for pages that only appear once scripts run.
      // Open sources that welcome programs first; her browser only when they find too little.
      search: (query, signal) =>
        searchEverywhere(
          query,
          {
            language: config.value.language,
            linux: environment.commands.has("pacman"),
            searxngUrl: config.value.search.searxngUrl,
            braveApiKey: config.value.search.braveApiKey,
            mayAskBrave: () => searchBudget?.take() ?? true,
            browser: browserDeck
              ? (words, stop) => browserDeck?.search(words, stop) ?? Promise.resolve([])
              : undefined,
          },
          signal,
        ),
      read: async (url, signal) => {
        try {
          const page = await readWebPage(url, signal);
          if (page.text.length >= 400 || !browserDeck) return page;
        } catch (error) {
          if (!browserDeck || signal?.aborted) throw error;
        }
        return browserDeck.read(url, signal);
      },
    },
  });
  await voice.createVoice();

  await loadModelBundle();
  if (config.value.characterBundle && existsSync(config.value.characterBundle)) {
    await modelFiles.switchCharacterBundle(config.value.characterBundle).catch((error: unknown) => {
      console.warn("[character-bundle] could not reopen saved bundle; using default avatar:", error);
    });
  }
  registerProtocol();
  restrictPermissions();
  registerDesktopIpc({
    config,
    fromMainWindow,
    appState,
    sendPresence,
    resetTyped: () => {
      typedTaken = 0;
    },
    noteTyped: () => {
      typedTaken += 1;
    },
    brain: () => brain,
    archive: () => archive,
    agenda: () => agenda,
    workspaceDir: environment.workspace,
    privateDirs: [dataDir()],
    voice,
    interruptBrain,
    resizeWindow,
    setClickThrough,
    setHandsOff,
    openSettings: () => settings.openSettings(),
    importModel,
    importModelFile,
    aiReportContext: () => {
      const loc = describeInferenceLocality(config.value.inference);
      return {
        appVersion: app.getVersion(),
        reportsDir: join(dataDir(), "ai-reports"),
        brainLabel:
          config.value.inference.provider === "openai-compatible"
            ? loc.label
            : config.value.brain,
        inferenceScope: loc.scope,
        extraSecrets: [
          config.value.search.braveApiKey ?? "",
          config.value.inference.apiKey,
        ].filter(Boolean),
      };
    },
  });
  settings.registerSettingsIpc();
  workbench.registerIpc();
  registerFleetIpc({
    config,
    fleet: () => fleet,
    fromSettingsWindow: settings.fromSettingsWindow,
    settingsView: settings.settingsView,
  });
  registerAgendaIpc({
    config,
    agenda: () => agenda,
    fromSettingsWindow: settings.fromSettingsWindow,
    settingsView: settings.settingsView,
  });
  registerMcpIpc({
    config,
    mcpHub: () => mcpHub,
    fromSettingsWindow: settings.fromSettingsWindow,
    settingsView: settings.settingsView,
  });
  if (linuxDesktopEnv?.isKdeWayland) {
    removeKwinHelper = await installKwinHelper({
      appId: app.getName(),
      title: WINDOW_TITLE,
      scriptPath: join(dataDir(), "kwin-helper.js"),
      margin: CORNER_MARGIN,
    });
    canResize = removeKwinHelper !== null;
  } else if (linuxDesktopEnv?.notice) {
    console.info(`[desktop] ${linuxDesktopEnv.notice}`);
  }
  settings.noteStartAtLogin(await startsAtLogin());
  createWindow();
  screen.on("display-removed", rescueOffscreenWindow);
  screen.on("display-metrics-changed", rescueOffscreenWindow);
  const hotkeyStatus = applyHotkeys();
  if (hotkeyStatus.failed.length > 0) {
    console.warn(`[hotkeys] Failed to register: ${hotkeyStatus.failed.join(", ")}`);
  }
  createTray();
  const dogfoodWorkbench = process.env["ASTRA_NAVI_DOGFOOD_WORKBENCH"] === "1";
  if (dogfoodWorkbench) {
    try {
      const seedTraceFile = join(dataDir(), "dogfood-traces.json");
      if (existsSync(seedTraceFile)) {
        const parsed = JSON.parse(await readFile(seedTraceFile, "utf8")) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (entry && typeof entry === "object") traces.add(entry as TurnTrace);
          }
        }
      }
    } catch (error) {
      console.warn("[dogfood] could not load seeded traces:", error);
    }
    await orders?.start().catch((error: unknown) => console.warn("[dogfood-orders]", error));
    await board?.load().catch((error: unknown) => console.warn("[dogfood-missions]", error));
    workbench.open("missions");
  }
  if (
    !dogfoodWorkbench &&
    (!config.value.onboardingComplete || safeModeBoot.safeMode) &&
    !process.env["AI_CHAN_DEBUG_CAPTURE"] &&
    !process.env["AI_CHAN_DEBUG_SETTINGS"]
  ) {
    settings.openSettings();
  }
  // Her watch, her memory of the PC's sound and the station, as the settings have them.
  if (!safeModeBoot.safeMode) {
    void reach.start().then(() => {
      rebuildTrayMenu();
      sendPresence();
    });
    void reach.hands
      .abilities()
      .then((abilities) => {
        settings.setHandsAbilities(abilities);
      })
      .catch(() => undefined);
    if (mcpHub && config.value.mcp.servers.some((s) => s.enabled !== false)) {
      void mcpHub.syncServers(config.value.mcp.servers).catch((error: unknown) => {
        recordRecentError("mcp", error);
        console.warn("[mcp] startup sync failed:", error);
      });
    }
  } else {
    rebuildTrayMenu();
    sendPresence();
  }
  healthyTimer = setTimeout(() => {
    void startupGuard?.markBootHealthy().catch(() => undefined);
  }, 15_000);
  healthyTimer.unref();
  scheduleDebugAids({
    config,
    mainWindow: () => mainWindow,
    settingsWindow: () => settings.settingsWindow(),
    brain: () => brain,
    browserDeck: () => browserDeck,
    listening: () => voice.listening(),
    audioBlocks: () => voice.audioBlocks(),
    sendToWindow,
    openSettings: () => settings.openSettings(),
  });
  // A little after start-up, so she is on screen before she speaks. Reminders that came
  // due while the app was closed are among the first things she has to say.
  setTimeout(
    () => void reminders?.start().catch((error: unknown) => console.warn("[reminders]", error)),
    5000,
  );
  if (!dogfoodWorkbench) {
    setTimeout(
      () => void orders?.start().catch((error: unknown) => console.warn("[orders]", error)),
      6000,
    );
  }
  setTimeout(
    () => void gameWatch?.start().catch((error: unknown) => console.warn("[games]", error)),
    7000,
  );
  agendaWatch?.startAfter(8000);
  // Gets her notes ready to be found by meaning, off to the side, before the first message.
  setTimeout(
    () => void recall.warm().catch((error: unknown) => console.warn("[recall]", error)),
    3000,
  );
  setTimeout(
    () => void morningBriefing().catch((error: unknown) => console.warn("[briefing]", error)),
    8000,
  );
  // Missions left from before she was closed are taken up where they stood.
  if (!dogfoodWorkbench) {
    setTimeout(
      () => void board?.load().catch((error: unknown) => console.warn("[missions]", error)),
      5000,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
