import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AiReportResult,
  AiReportSubmission,
  AichanBridge,
  AppState,
  AvatarReactionEvent,
  BrainEvent,
  DropFilesResult,
  ModelFraming,
  PastExchange,
  PickedMotionClip,
  Presence,
  VoiceEvent,
} from "../shared/ipc.ts";

const bridge: AichanBridge = {
  ready: () => ipcRenderer.invoke("app:ready") as Promise<AppState>,
  send: (text) => ipcRenderer.send("chat:send", text),
  interrupt: () => ipcRenderer.send("chat:interrupt"),
  answerPermission: (id, decision) => ipcRenderer.send("permission:answer", id, decision),
  setLayout: (layout) => ipcRenderer.send("window:layout", layout),
  history: () => ipcRenderer.invoke("chat:history") as Promise<PastExchange[]>,
  copyText: (text) => ipcRenderer.send("clipboard:copy", text),
  openSettings: () => ipcRenderer.send("ui:open-settings"),
  importModel: () => ipcRenderer.send("model:import"),
  saveModelFraming: (modelHash: string, framing: ModelFraming) =>
    ipcRenderer.send("stage:save-framing", modelHash, framing),
  pickMotionClip: () => ipcRenderer.invoke("stage:pick-motion") as Promise<PickedMotionClip>,
  setClickThrough: (on: boolean) => ipcRenderer.send("window:click-through", on),
  setHandsOff: (off: boolean) => ipcRenderer.send("hands:off", off),
  handleDroppedFiles: (paths: string[]) =>
    ipcRenderer.invoke("files:drop", paths) as Promise<DropFilesResult>,
  forgetLastTurn: () =>
    ipcRenderer.invoke("chat:forget-last") as Promise<{
      removed: boolean;
      userText: string | null;
      forgottenMemories: number;
    }>,
  reportAiOutput: (input: AiReportSubmission) =>
    ipcRenderer.invoke("ai:report-output", input) as Promise<AiReportResult>,
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  openLink: (url) => ipcRenderer.send("link:open", url),
  reportModelError: (message) => ipcRenderer.send("model:error", message),
  setListening: (on) => ipcRenderer.send("voice:listen", on),
  sendAudio: (samples) => ipcRenderer.send("voice:audio", samples),
  setSpeaking: (speaking) => ipcRenderer.send("voice:speaking", speaking),
  onVoiceEvent: (listener) => {
    ipcRenderer.on("voice:event", (_event, payload: VoiceEvent) => listener(payload));
  },
  onBrainEvent: (listener) => {
    ipcRenderer.on("brain:event", (_event, payload: BrainEvent) => listener(payload));
  },
  onAppState: (listener) => {
    ipcRenderer.on("app:state", (_event, payload: AppState) => listener(payload));
  },
  onShowNotice: (listener) => {
    ipcRenderer.on("ui:notice", () => listener());
  },
  onPresence: (listener) => {
    ipcRenderer.on("stage:presence", (_event, presence: Presence) => listener(presence));
  },
  onForgotten: (listener) => {
    ipcRenderer.on("chat:forgotten", () => listener());
  },
  onDropped: (listener) => {
    ipcRenderer.on("chat:dropped", (_event, typedTaken: number) => listener(typedTaken));
  },
  onAvatarReaction: (listener) => {
    ipcRenderer.on("stage:reaction", (_event, payload: AvatarReactionEvent) => listener(payload));
  },
  onListenRequest: (listener) => {
    ipcRenderer.on("ui:listen", (_event, on: boolean) => listener(on));
  },
  onFocusInput: (listener) => {
    ipcRenderer.on("ui:focus-input", () => listener());
  },
};

contextBridge.exposeInMainWorld("aichan", bridge);
