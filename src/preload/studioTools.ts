import { contextBridge, ipcRenderer } from "electron";
import type { Config } from "../core/config.ts";
import type {
  AvatarStudioConfigPatch,
  AvatarStudioSnapshot,
  PolicyComposerSnapshot,
  StandingOrderDraft,
  StandingOrderPreviewResult,
  StudioToolsBridge,
  TurnXraySnapshot,
} from "../shared/studioTools.ts";

const bridge: StudioToolsBridge = {
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

contextBridge.exposeInMainWorld("studioTools", bridge);
