import { clipboard, ipcMain, shell } from "electron";
import type { ConversationArchive } from "../core/archive.ts";
import type { Brain } from "../core/brain.ts";
import type { ConfigStore } from "../core/config.ts";
import type { AppState, PastExchange, PermissionDecision, WindowLayout } from "../shared/ipc.ts";
import type { VoiceController } from "./voiceControl.ts";

/**
 * What her own desktop window may ask of the main process. Only messages coming from
 * `mainWindow.webContents` are accepted, channel by channel.
 */

export interface DesktopIpcDeps {
  config: ConfigStore;
  fromMainWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean;
  appState(showNotice: boolean): AppState;
  sendPresence(): void;
  resetTyped(): void;
  noteTyped(): void;
  brain(): Brain | null;
  archive(): ConversationArchive | null;
  voice: VoiceController;
  interruptBrain(): void;
  resizeWindow(layout: WindowLayout): void;
  openSettings(): void;
  importModel(): Promise<void>;
}

export function registerDesktopIpc(deps: DesktopIpcDeps): void {
  const { config, fromMainWindow } = deps;

  ipcMain.handle("app:ready", async (event): Promise<AppState> => {
    // The window has just loaded, and counts the messages it sends from nothing again.
    if (fromMainWindow(event)) deps.resetTyped();
    const showNotice = !config.value.noticeShown;
    if (showNotice) {
      // Failing to record this only means the notice shows again next time.
      await config
        .update({ noticeShown: true })
        .catch((error: unknown) => console.warn("[config]", error));
    }
    // The page is listening now: tell it what she is sensing, for its badges.
    setTimeout(deps.sendPresence, 0);
    return deps.appState(showNotice);
  });

  // Everything below is for her own window alone. No other page is given this bridge
  // today; the check keeps it so if another window is ever added.
  ipcMain.on("chat:send", (event, text: unknown) => {
    if (!fromMainWindow(event)) return;
    // Counted whatever it holds: the window counts every message it sends the same way.
    deps.noteTyped();
    if (typeof text === "string") deps.brain()?.send(text.slice(0, 20_000));
  });
  ipcMain.on("chat:interrupt", (event) => {
    if (!fromMainWindow(event)) return;
    deps.interruptBrain();
    deps.voice.stopSpeaking();
  });
  ipcMain.on("permission:answer", (event, id: unknown, decision: unknown) => {
    if (!fromMainWindow(event)) return;
    const valid: readonly unknown[] = ["allow", "allow-session", "deny"];
    if (typeof id === "string" && valid.includes(decision)) {
      deps.brain()?.answerPermission(id, decision as PermissionDecision);
    }
  });

  ipcMain.on("voice:listen", (event, on: unknown) => {
    if (fromMainWindow(event) && typeof on === "boolean") deps.voice.setListening(on);
  });
  ipcMain.on("voice:audio", (event, payload: unknown) => {
    if (!fromMainWindow(event)) return;
    deps.voice.feedAudio(payload);
  });
  ipcMain.on("voice:speaking", (event, speaking: unknown) => {
    if (!fromMainWindow(event) || typeof speaking !== "boolean") return;
    deps.voice.setSpeakerPlaying(speaking);
  });

  ipcMain.on("window:layout", (event, layout: unknown) => {
    if (!fromMainWindow(event)) return;
    if (layout === "compact" || layout === "balloon" || layout === "log") {
      deps.resizeWindow(layout);
    }
  });
  // The conversation log: the latest exchanges of earlier sessions, when those are kept.
  ipcMain.handle("chat:history", (event): PastExchange[] => {
    const archive = deps.archive();
    if (!fromMainWindow(event) || !config.value.keepConversations || !archive) return [];
    return archive.latest(40).map(({ at, said, reply }) => ({ at, said, reply }));
  });
  ipcMain.on("clipboard:copy", (event, text: unknown) => {
    if (fromMainWindow(event) && typeof text === "string") {
      clipboard.writeText(text.slice(0, 200_000));
    }
  });
  ipcMain.on("ui:open-settings", (event) => {
    if (fromMainWindow(event)) deps.openSettings();
  });
  ipcMain.on("model:import", (event) => {
    if (fromMainWindow(event)) void deps.importModel();
  });
  ipcMain.on("link:open", (event, url: unknown) => {
    if (!fromMainWindow(event)) return;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  ipcMain.on("model:error", (event, message: unknown) => {
    if (!fromMainWindow(event)) return;
    // Only the start is kept: a page must not be able to fill the log.
    console.error(
      "[model] the window could not show the model:",
      typeof message === "string" ? message.slice(0, 2000) : "(no message)",
    );
  });
}
