import { contextBridge, ipcRenderer } from "electron";
import type { MemoryKind } from "../core/memory.ts";
import type {
  MissionControlAction,
  MissionControlActionResult,
  MissionControlBridge,
  MissionControlSnapshot,
  PolicyConflictGraph,
  ReplayInspectResult,
} from "../shared/missionControl.ts";

const bridge: MissionControlBridge = {
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

contextBridge.exposeInMainWorld("missionControl", bridge);
