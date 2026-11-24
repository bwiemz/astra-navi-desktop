import { contextBridge, ipcRenderer } from "electron";
import type { Config } from "../core/config.ts";
import type { MemoryKind } from "../core/memory.ts";
import type {
  MissionControlAction,
  MissionControlActionResult,
  MissionControlBridge,
  MissionControlSnapshot,
  PolicyConflictGraph,
  ReplayInspectResult,
} from "../shared/missionControl.ts";
import type {
  AvatarStudioConfigPatch,
  AvatarStudioSnapshot,
  PolicyComposerSnapshot,
  StandingOrderDraft,
  StandingOrderPreviewResult,
  StudioToolsBridge,
  TurnXraySnapshot,
} from "../shared/studioTools.ts";
import { WORKBENCH_TABS, type WorkbenchBridge, type WorkbenchTab } from "../shared/workbench.ts";

const VALID_TABS = new Set<string>(WORKBENCH_TABS.map((t) => t.id));

const missionControl: MissionControlBridge = {
  getSnapshot: () => ipcRenderer.invoke("mc:snapshot") as Promise<MissionControlSnapshot>,
  actMission: (id: string, action: MissionControlAction) =>
    ipcRenderer.invoke("mc:mission-action", id, action) as Promise<MissionControlActionResult>,
  upsertMemory: (input: { id?: string; kind: MemoryKind; text: string }) =>
    ipcRenderer.invoke("mc:memory-upsert", input) as Promise<{ ok: boolean; message: string }>,
  pinMemory: (id: string, pinned: boolean) =>
    ipcRenderer.invoke("mc:memory-pin", id, pinned) as Promise<{ ok: boolean; message: string }>,
  deleteMemory: (id: string) =>
    ipcRenderer.invoke("mc:memory-delete", id) as Promise<{ ok: boolean; message: string }>,
  deleteEpisode: (id: number) =>
    ipcRenderer.invoke("mc:episode-delete", id) as Promise<{ ok: boolean; message: string }>,
  cancelStandingOrder: (id: string) =>
    ipcRenderer.invoke("mc:order-cancel", id) as Promise<{ ok: boolean; message: string }>,
  setSkillStatus: (id: string, action: "ratify" | "revoke") =>
    ipcRenderer.invoke("mc:skill-action", id, action) as Promise<{ ok: boolean; message: string }>,
  verifyPolicies: () => ipcRenderer.invoke("mc:policy-verify") as Promise<PolicyConflictGraph>,
  inspectReplay: (bundlePath?: string) =>
    ipcRenderer.invoke("mc:replay-inspect", bundlePath) as Promise<ReplayInspectResult>,
};

const studioTools: StudioToolsBridge = {
  getAvatarStudioSnapshot: () =>
    ipcRenderer.invoke("studio:avatar-snapshot") as Promise<AvatarStudioSnapshot>,
  updateAvatarStudioConfig: (patch: AvatarStudioConfigPatch) =>
    ipcRenderer.invoke("studio:avatar-update", patch) as Promise<{ ok: boolean; message: string }>,
  getTurnXraySnapshot: (contextLimit?: number) =>
    ipcRenderer.invoke("studio:xray-snapshot", contextLimit) as Promise<TurnXraySnapshot>,
  resolveMemoryConflict: (keepId: string, dropIds: string[]) =>
    ipcRenderer.invoke("studio:xray-resolve-conflict", keepId, dropIds) as Promise<{
      ok: boolean;
      message: string;
    }>,
  getPolicyComposerSnapshot: () =>
    ipcRenderer.invoke("studio:policy-snapshot") as Promise<PolicyComposerSnapshot>,
  previewStandingOrder: (draft: StandingOrderDraft) =>
    ipcRenderer.invoke("studio:policy-preview-order", draft) as Promise<StandingOrderPreviewResult>,
  createStandingOrder: (draft: StandingOrderDraft) =>
    ipcRenderer.invoke("studio:policy-create-order", draft) as Promise<{
      ok: boolean;
      message: string;
    }>,
  cancelStandingOrder: (id: string) =>
    ipcRenderer.invoke("studio:policy-cancel-order", id) as Promise<{
      ok: boolean;
      message: string;
    }>,
  setExperimentalFlag: (flag: keyof Config["tier10"], enabled: boolean) =>
    ipcRenderer.invoke("studio:policy-set-flag", flag, enabled) as Promise<{
      ok: boolean;
      message: string;
    }>,
};

const workbench: WorkbenchBridge = {
  missionControl,
  studioTools,
  onSelectTab: (cb: (tab: WorkbenchTab) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tab: string): void => {
      if (VALID_TABS.has(tab)) cb(tab as WorkbenchTab);
    };
    ipcRenderer.on("workbench:select-tab", listener);
    return () => ipcRenderer.off("workbench:select-tab", listener);
  },
};

contextBridge.exposeInMainWorld("workbench", workbench);
contextBridge.exposeInMainWorld("missionControl", missionControl);
contextBridge.exposeInMainWorld("studioTools", studioTools);
