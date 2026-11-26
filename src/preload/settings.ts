import { contextBridge, ipcRenderer } from "electron";
import type { MemoryKind } from "../core/memory.ts";
import type { OpenAiProbeResult } from "../core/openaiBackend.ts";
import type { QrMatrix } from "../core/qrCode.ts";
import type { ShownTrace } from "../core/trace.ts";
import type {
  BootstrapStatusView,
  DiskSpaceCheckView,
  HardwareRecommendationView,
  MachineFound,
  McpServerAddRequest,
  MemoryManagerSnapshot,
  ModelDownloadStatusView,
  PolicyAuditSummaryView,
  ProfileBackupActionResult,
  ProfileRestoreActionResult,
  RemoteBackupView,
  SettingsBridge,
  SettingsPatch,
  SettingsView,
  SupportBundleResultView,
} from "../shared/settings.ts";
import type { UpdateCheckResult } from "../shared/edition.ts";

const bridge: SettingsBridge = {
  load: () => ipcRenderer.invoke("settings:load") as Promise<SettingsView>,
  save: (patch: SettingsPatch) =>
    ipcRenderer.invoke("settings:save", patch) as Promise<SettingsView>,
  open: (page) => ipcRenderer.send("settings:open", page),
  forgetConversations: () =>
    ipcRenderer.invoke("settings:forget-conversations") as Promise<SettingsView>,
  traces: () => ipcRenderer.invoke("settings:traces") as Promise<ShownTrace[]>,
  pairDevice: () =>
    ipcRenderer.invoke("settings:pair-device") as Promise<{
      code: string;
      expiresAt: number;
      pairingUri: string;
      qrMatrix: QrMatrix;
    }>,
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
  addMcpServer: (server: McpServerAddRequest) =>
    ipcRenderer.invoke("mcp:add-server", server) as Promise<
      { ok: true; view: SettingsView; warning?: string } | { ok: false; why: string }
    >,
  removeMcpServer: (id: string) =>
    ipcRenderer.invoke("mcp:remove-server", id) as Promise<SettingsView>,
  toggleMcpServer: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("mcp:toggle-server", id, enabled) as Promise<{
      ok: boolean;
      view: SettingsView;
      error?: string;
    }>,
  setMcpReadOnlyAuto: (id: string, on: boolean) =>
    ipcRenderer.invoke("mcp:set-read-only-auto", id, on) as Promise<SettingsView>,
  reconnectMcpServer: (id: string) =>
    ipcRenderer.invoke("mcp:reconnect-server", id) as Promise<{
      ok: boolean;
      view: SettingsView;
      error?: string;
    }>,
  importPersonaCard: () =>
    ipcRenderer.invoke("settings:import-persona-card") as Promise<
      { ok: true; canceled: false; view: SettingsView; name: string } | { ok: false; canceled: boolean; error?: string }
    >,
  loadCharacterBundle: () =>
    ipcRenderer.invoke("settings:load-character-bundle") as Promise<
      { ok: true; canceled: false; view: SettingsView; name: string } | { ok: false; canceled: boolean; error?: string }
    >,
  resetCharacter: () => ipcRenderer.invoke("settings:reset-character") as Promise<SettingsView>,
  downloadVisionMmproj: () =>
    ipcRenderer.invoke("settings:download-mmproj") as Promise<
      { ok: true; view: SettingsView; path: string } | { ok: false; view: SettingsView; error: string }
    >,
  listMemories: () => ipcRenderer.invoke("settings:memory-list") as Promise<MemoryManagerSnapshot>,
  addMemory: (input: { kind: MemoryKind; text: string; pinned?: boolean }) =>
    ipcRenderer.invoke("settings:memory-add", input) as Promise<
      { ok: true; snapshot: MemoryManagerSnapshot; view: SettingsView } | { ok: false; error: string }
    >,
  updateMemory: (input: { id: string; text: string; kind?: MemoryKind; points?: string[] }) =>
    ipcRenderer.invoke("settings:memory-update", input) as Promise<
      { ok: true; snapshot: MemoryManagerSnapshot; view: SettingsView } | { ok: false; error: string }
    >,
  pinMemory: (id: string, pinned: boolean) =>
    ipcRenderer.invoke("settings:memory-pin", { id, pinned }) as Promise<
      { ok: true; snapshot: MemoryManagerSnapshot; view: SettingsView } | { ok: false; error: string }
    >,
  forgetMemory: (id: string) =>
    ipcRenderer.invoke("settings:memory-forget", id) as Promise<
      { ok: true; snapshot: MemoryManagerSnapshot; view: SettingsView } | { ok: false; error: string }
    >,
  testInferenceBackend: (input: { baseUrl: string; apiKey?: string }) =>
    ipcRenderer.invoke("settings:test-inference", input) as Promise<OpenAiProbeResult>,
  hardwareProfile: (force?: boolean) =>
    ipcRenderer.invoke("settings:hardware-profile", Boolean(force)) as Promise<HardwareRecommendationView>,
  previewVoice: (name: string) =>
    ipcRenderer.invoke("settings:preview-voice", name) as Promise<string | null>,
  downloadBrain: (tier: string) =>
    ipcRenderer.invoke("settings:download-brain", tier) as Promise<SettingsView>,
  runBootstrap: (task) =>
    ipcRenderer.invoke("settings:run-bootstrap", task) as Promise<{
      ok: boolean;
      summary: string[];
      status: BootstrapStatusView;
    }>,
  runPolicyAudit: () =>
    ipcRenderer.invoke("settings:run-policy-audit") as Promise<PolicyAuditSummaryView>,
  exportSupportBundle: () =>
    ipcRenderer.invoke("settings:export-support-bundle") as Promise<SupportBundleResultView>,
  checkUpdates: () => ipcRenderer.invoke("settings:check-updates") as Promise<UpdateCheckResult>,
  clearSafeMode: () => ipcRenderer.invoke("settings:clear-safe-mode") as Promise<SettingsView>,
  exportProfileBackup: () =>
    ipcRenderer.invoke("settings:export-profile") as Promise<ProfileBackupActionResult>,
  importProfileBackup: () =>
    ipcRenderer.invoke("settings:import-profile") as Promise<ProfileRestoreActionResult>,
  checkDiskSpace: (tier: string) =>
    ipcRenderer.invoke("settings:disk-space", tier) as Promise<DiskSpaceCheckView>,
  downloadStatus: () =>
    ipcRenderer.invoke("settings:download-status") as Promise<ModelDownloadStatusView>,
  pauseBrainDownload: () =>
    ipcRenderer.invoke("settings:download-pause") as Promise<ModelDownloadStatusView>,
  resumeBrainDownload: () =>
    ipcRenderer.invoke("settings:download-resume") as Promise<ModelDownloadStatusView>,
  previewAvatarWindow: () => ipcRenderer.send("settings:preview-avatar"),
  importAvatarModel: () => ipcRenderer.send("settings:import-model"),
  onDownloadProgress: (listener) => {
    ipcRenderer.on("settings:download-progress", (_event, status: ModelDownloadStatusView) =>
      listener(status),
    );
  },
};

contextBridge.exposeInMainWorld("aichanSettings", bridge);
