import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import type { Brain } from "../core/brain.ts";
import type { ConfigStore } from "../core/config.ts";
import type { EpisodicGraph } from "../core/episodic.ts";
import type { MemoryStore } from "../core/memory.ts";
import type { ApprovalDesk } from "../core/missionApproval.ts";
import type { MissionBoard } from "../core/missionPlan.ts";
import type { Recall } from "../core/recall.ts";
import type { CompiledSkillStore } from "../core/skillCompiler.ts";
import type { StandingOrders } from "../core/standingOrders.ts";
import type { TraceKeeper } from "../core/trace.ts";
import { WORKBENCH_TABS, type WorkbenchTab } from "../shared/workbench.ts";
import { createMissionControlIpc } from "./missionControlIpc.ts";
import { createStudioToolsIpc } from "./studioToolsIpc.ts";
import { createWave2Ipc } from "./wave2Ipc.ts";

/**
 * Single secondary Electron window (`workbench.html`) consolidating Mission Control,
 * Memory Graph, Policy Composer, Turn X-Ray, and Avatar Studio behind one Chromium
 * process and one hardened preload script.
 */

export interface WorkbenchDeps {
  appOrigin: string;
  config: ConfigStore;
  dataDir(): string;
  workspaceDir: string;
  pluginsDir?: string;
  board(): MissionBoard | null;
  approvalDesk(): ApprovalDesk | null;
  memoryStore(): MemoryStore | null;
  episodic(): EpisodicGraph | null;
  orders(): StandingOrders | null;
  skills(): CompiledSkillStore | null;
  traces: TraceKeeper;
  recall(): Recall | null;
  brain(): Brain | null;
}

export interface WorkbenchController {
  window(): BrowserWindow | null;
  open(tab?: WorkbenchTab): void;
  registerIpc(): void;
  fromWorkbenchWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
  activeTab(): WorkbenchTab;
}

const VALID_TABS = new Set<string>(WORKBENCH_TABS.map((t) => t.id));

function normalizeTab(tab: WorkbenchTab | undefined): WorkbenchTab {
  return tab && VALID_TABS.has(tab) ? tab : "missions";
}

export function createWorkbenchController(deps: WorkbenchDeps): WorkbenchController {
  let wbWindow: BrowserWindow | null = null;
  let currentTab: WorkbenchTab = "missions";
  let pageReady = false;
  let ipcRegistered = false;

  function fromWorkbenchWindow(
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ): boolean {
    return (
      wbWindow !== null &&
      !wbWindow.isDestroyed() &&
      event.sender === wbWindow.webContents
    );
  }

  const mcIpc = createMissionControlIpc({
    ...deps,
    isAuthorizedSender: fromWorkbenchWindow,
  });
  const studioIpc = createStudioToolsIpc({
    appOrigin: deps.appOrigin,
    config: deps.config,
    memoryStore: deps.memoryStore,
    orders: deps.orders,
    skills: deps.skills,
    traces: deps.traces,
    isAuthorizedSender: fromWorkbenchWindow,
  });
  const wave2Ipc = createWave2Ipc({
    config: deps.config,
    workspaceDir: deps.workspaceDir,
    pluginsDir: deps.pluginsDir,
    isAuthorizedSender: fromWorkbenchWindow,
  });

  function sendTab(win: BrowserWindow, tab: WorkbenchTab): void {
    win.webContents.send("workbench:select-tab", tab);
  }

  function open(tab?: WorkbenchTab): void {
    currentTab = normalizeTab(tab);
    if (wbWindow && !wbWindow.isDestroyed()) {
      wbWindow.show();
      wbWindow.focus();
      if (pageReady) sendTab(wbWindow, currentTab);
      return;
    }

    pageReady = false;
    const win = new BrowserWindow({
      width: 1220,
      height: 780,
      minWidth: 820,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#0f172a",
      title: "Astra Navi — Workbench",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/workbench.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: !app.isPackaged,
      },
    });
    wbWindow = win;
    win.removeMenu();
    win.once("ready-to-show", () => win.show());
    win.webContents.once("did-finish-load", () => {
      pageReady = true;
      if (!win.isDestroyed()) sendTab(win, currentTab);
    });
    win.on("closed", () => {
      if (wbWindow === win) {
        wbWindow = null;
        pageReady = false;
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    void win.loadURL(`${deps.appOrigin}/workbench.html`);
  }

  function registerIpc(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;
    mcIpc.registerIpc();
    studioIpc.registerIpc();
    wave2Ipc.registerIpc();
  }

  return {
    window: () => wbWindow,
    open,
    registerIpc,
    fromWorkbenchWindow,
    activeTab: () => currentTab,
  };
}
