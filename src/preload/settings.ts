import { contextBridge, ipcRenderer } from "electron";
import type { ShownTrace } from "../core/trace.ts";
import type {
  MachineFound,
  RemoteBackupView,
  SettingsBridge,
  SettingsPatch,
  SettingsView,
} from "../shared/settings.ts";

const bridge: SettingsBridge = {
  load: () => ipcRenderer.invoke("settings:load") as Promise<SettingsView>,
  save: (patch: SettingsPatch) =>
    ipcRenderer.invoke("settings:save", patch) as Promise<SettingsView>,
  open: (page) => ipcRenderer.send("settings:open", page),
  forgetConversations: () =>
    ipcRenderer.invoke("settings:forget-conversations") as Promise<SettingsView>,
  traces: () => ipcRenderer.invoke("settings:traces") as Promise<ShownTrace[]>,
  pairDevice: () =>
    ipcRenderer.invoke("settings:pair-device") as Promise<{ code: string; expiresAt: number }>,
  pinMission: (id: string | null) =>
    ipcRenderer.invoke("settings:pin-mission", id) as Promise<SettingsView>,
  forgetDevice: (id: string) =>
    ipcRenderer.invoke("settings:forget-device", id) as Promise<SettingsView>,
  setStationAccount: (username: string, password: string) =>
    ipcRenderer.invoke("settings:set-station-account", { username, password }) as Promise<
      { ok: true; view: SettingsView } | { ok: false; why: string }
    >,
  dismissReset: () => ipcRenderer.invoke("settings:dismiss-reset") as Promise<SettingsView>,
  addCalendar: (calendar) =>
    ipcRenderer.invoke("agenda:add-calendar", calendar) as Promise<
      { ok: true; view: SettingsView } | { ok: false; why: string }
    >,
  removeCalendar: (name: string) =>
    ipcRenderer.invoke("agenda:remove-calendar", name) as Promise<SettingsView>,
  findMachine: (machine) => ipcRenderer.invoke("fleet:find", machine) as Promise<MachineFound>,
  addMachine: (ticket: string) => ipcRenderer.invoke("fleet:add", ticket) as Promise<SettingsView>,
  letInMachine: (id: string) =>
    ipcRenderer.invoke("fleet:let-in", id) as Promise<{ ok: boolean; why: string }>,
  copyMachineKey: (id: string) => ipcRenderer.invoke("fleet:copy-key", id) as Promise<void>,
  testMachine: (id: string) =>
    ipcRenderer.invoke("fleet:test", id) as Promise<{ ok: boolean; why: string }>,
  setMachineLook: (id: string, on: boolean) =>
    ipcRenderer.invoke("fleet:set-look", id, on) as Promise<SettingsView>,
  listMachineBackups: (id: string) =>
    ipcRenderer.invoke("fleet:backups", id) as Promise<RemoteBackupView[]>,
  restoreMachineBackup: (machineId: string, backupId: string) =>
    ipcRenderer.invoke("fleet:restore", machineId, backupId) as Promise<{
      restored: boolean;
      keptNew: string | null;
    }>,
  removeMachine: (id: string) => ipcRenderer.invoke("fleet:remove", id) as Promise<SettingsView>,
};

contextBridge.exposeInMainWorld("aichanSettings", bridge);
