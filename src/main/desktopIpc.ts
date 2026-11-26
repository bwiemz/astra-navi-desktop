import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { clipboard, dialog, ipcMain, shell } from "electron";
import {
  AI_REPORT_CATEGORIES,
  buildAiOutputReport,
  buildGithubReportIssueUrl,
  saveAiOutputReport,
  type AiReportCategory,
} from "../core/aiReport.ts";
import { type Agenda, MAX_CALENDARS, readCalendar, whyNotThisCalendar } from "../core/agenda.ts";
import type { ConversationArchive } from "../core/archive.ts";
import type { Brain } from "../core/brain.ts";
import type { ConfigStore } from "../core/config.ts";
import { classifyDroppedPath, deriveCalendarNameFromPath } from "../core/dropRouter.ts";
import { canonical, isPrivatePath } from "../core/riskRules.ts";
import type {
  AiReportResult,
  AppState,
  DropFilesResult,
  PastExchange,
  PermissionDecision,
  PickedMotionClip,
  WindowLayout,
} from "../shared/ipc.ts";
import { detectMotionClipFormat } from "../shared/avatarMotion.ts";
import { clampModelFraming } from "../shared/spatialStage.ts";
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
  agenda?(): Agenda | null;
  workspaceDir?: string;
  privateDirs?: readonly string[];
  voice: VoiceController;
  interruptBrain(): void;
  resizeWindow(layout: WindowLayout): void;
  setClickThrough?(on: boolean): void;
  setHandsOff?(off: boolean): Promise<void>;
  openSettings(): void;
  importModel(): Promise<void>;
  importModelFile?(
    filePath: string,
  ): Promise<{ ok: true; files: number; name: string } | { ok: false; error: string }>;
  aiReportContext?(): {
    appVersion: string;
    reportsDir: string;
    brainLabel: string;
    inferenceScope: string;
    extraSecrets?: readonly string[];
    mcpEnvSecrets?: readonly string[];
  };
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
  ipcMain.on("stage:save-framing", (event, modelHash: unknown, rawFraming: unknown) => {
    if (!fromMainWindow(event)) return;
    if (typeof modelHash !== "string" || !/^[a-f0-9]{8,64}$/.test(modelHash)) return;
    const framing = clampModelFraming(
      typeof rawFraming === "object" && rawFraming !== null
        ? (rawFraming as Record<string, unknown>)
        : {},
    );
    const next = { ...config.value.avatarFraming, [modelHash]: framing };
    const entries = Object.entries(next);
    const trimmed = entries.length > 64 ? Object.fromEntries(entries.slice(-64)) : next;
    void config.update({ avatarFraming: trimmed }).catch((error: unknown) => console.warn("[config]", error));
  });
  ipcMain.handle("stage:pick-motion", async (event): Promise<PickedMotionClip> => {
    if (!fromMainWindow(event)) throw new Error("Not allowed from here.");
    const picked = await dialog.showOpenDialog({
      title: "Play Avatar Motion Clip (.vrma or .vmd)",
      properties: ["openFile"],
      filters: [{ name: "Avatar Animations (.vrma, .vmd)", extensions: ["vrma", "vmd"] }],
    });
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return { ok: false, canceled: true };
    try {
      const info = await stat(filePath);
      if (info.size > 24 * 1024 * 1024) {
        return { ok: false, canceled: false, error: "Animation file exceeds the 24 MB safety limit." };
      }
      const raw = await readFile(filePath);
      const name = basename(filePath);
      const format = detectMotionClipFormat(raw, name);
      if (format === "unknown") {
        return {
          ok: false,
          canceled: false,
          error: "File is not a valid VRMA (.vrma) or MMD (.vmd) motion clip.",
        };
      }
      return {
        ok: true,
        canceled: false,
        name,
        format,
        bytesBase64: raw.toString("base64"),
      };
    } catch (error) {
      return {
        ok: false,
        canceled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.on("window:click-through", (event, on: unknown) => {
    if (!fromMainWindow(event) || typeof on !== "boolean") return;
    deps.setClickThrough?.(on);
  });
  ipcMain.on("hands:off", (event, off: unknown) => {
    if (!fromMainWindow(event) || typeof off !== "boolean") return;
    void deps.setHandsOff?.(off).catch((error: unknown) => console.error(error));
  });
  ipcMain.handle(
    "chat:forget-last",
    async (
      event,
    ): Promise<{ removed: boolean; userText: string | null; forgottenMemories: number }> => {
      if (!fromMainWindow(event)) throw new Error("Not allowed from here.");
      return (
        (await deps.brain()?.forgetLastTurn()) ?? {
          removed: false,
          userText: null,
          forgottenMemories: 0,
        }
      );
    },
  );
  ipcMain.handle("ai:report-output", async (event, raw: unknown): Promise<AiReportResult> => {
    if (!fromMainWindow(event)) throw new Error("Not allowed from here.");
    const ctx = deps.aiReportContext?.();
    if (!ctx) return { ok: false, error: "AI report context is not configured." };
    const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const rawCat = typeof rec["category"] === "string" ? rec["category"] : "other";
    const category: AiReportCategory = (AI_REPORT_CATEGORIES as readonly string[]).includes(rawCat)
      ? (rawCat as AiReportCategory)
      : "other";
    const note = typeof rec["note"] === "string" ? rec["note"] : "";
    const includeExcerpt = rec["includeExcerpt"] === true;
    const replyExcerpt = typeof rec["replyExcerpt"] === "string" ? rec["replyExcerpt"] : undefined;
    const userPromptExcerpt =
      typeof rec["userPromptExcerpt"] === "string" ? rec["userPromptExcerpt"] : undefined;
    try {
      const report = buildAiOutputReport({
        category,
        note,
        includeExcerpt,
        replyExcerpt,
        userPromptExcerpt,
        appVersion: ctx.appVersion,
        brainLabel: ctx.brainLabel,
        inferenceScope: ctx.inferenceScope,
        extraSecrets: ctx.extraSecrets,
        mcpEnvSecrets: ctx.mcpEnvSecrets,
      });
      const filePath = await saveAiOutputReport(ctx.reportsDir, report);
      const issueUrl = buildGithubReportIssueUrl(report);
      try {
        shell.showItemInFolder(filePath);
      } catch {
        // Headless or sandboxed environments may lack a file manager portal.
      }
      return { ok: true, filePath, issueUrl };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle("files:drop", async (event, rawPaths: unknown): Promise<DropFilesResult> => {
    if (!fromMainWindow(event)) throw new Error("Not allowed from here.");
    const result: DropFilesResult = {
      avatarsLoaded: [],
      attachments: [],
      calendarAdded: [],
      notes: [],
    };
    if (!Array.isArray(rawPaths)) return result;
    const paths = rawPaths.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 8);
    const policyCtx = {
      workspace: deps.workspaceDir ?? process.cwd(),
      home: homedir(),
      privateDirs: deps.privateDirs,
    };

    for (const rawPath of paths) {
      let resolved: string;
      try {
        resolved = await canonical(rawPath);
      } catch {
        result.notes.push(`Skipped unreadable path: ${basename(rawPath)}`);
        continue;
      }
      const fileInfo = await stat(resolved).catch(() => null);
      if (!fileInfo?.isFile()) {
        result.notes.push(`Skipped "${basename(resolved)}" (not a regular file).`);
        continue;
      }
      if (isPrivatePath(resolved, policyCtx)) {
        result.notes.push(`Blocked private file "${basename(resolved)}".`);
        continue;
      }

      const kind = classifyDroppedPath(resolved);
      if (kind === "avatar") {
        if (deps.importModelFile) {
          const imported = await deps.importModelFile(resolved);
          if (imported.ok) result.avatarsLoaded.push(imported.name);
          else result.notes.push(`Could not load "${basename(resolved)}": ${imported.error}`);
        } else {
          result.notes.push("Avatar import handler unavailable.");
        }
      } else if (kind === "document" || kind === "image") {
        result.attachments.push({ kind, path: resolved, name: basename(resolved) });
      } else if (kind === "calendar") {
        const invalid = whyNotThisCalendar(resolved);
        if (invalid) {
          result.notes.push(invalid);
          continue;
        }
        const calendars = config.value.agenda.calendars;
        if (calendars.some((c) => c.source === resolved)) {
          result.notes.push(`"${basename(resolved)}" is already in Astra's agenda.`);
          continue;
        }
        if (calendars.length >= MAX_CALENDARS) {
          result.notes.push("Calendar limit reached (max 12). Remove one in Settings first.");
          continue;
        }
        let summaryDetail = `File: ${resolved}`;
        try {
          const rawIcs = await readFile(resolved, "utf8");
          const parsed = readCalendar(rawIcs);
          summaryDetail = `${parsed.events.length} event(s) found.\nFile: ${resolved}`;
        } catch {
          // Still allow confirm dialog if readable by agenda later, or warn cleanly
        }
        const baseName = deriveCalendarNameFromPath(resolved);
        let candidateName = baseName;
        let suffix = 2;
        while (calendars.some((c) => c.name.toLowerCase() === candidateName.toLowerCase())) {
          candidateName = `${baseName.slice(0, 35)} ${suffix}`;
          suffix += 1;
        }
        const { response } = await dialog.showMessageBox({
          type: "question",
          buttons: ["Add to Agenda", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          title: "Add calendar to Astra's agenda?",
          message: `Add "${candidateName}" to Astra Navi's read-only agenda?`,
          detail: summaryDetail,
          noLink: true,
        });
        if (response === 0) {
          await config.update({
            agenda: {
              ...config.value.agenda,
              calendars: [...calendars, { name: candidateName, source: resolved }],
            },
          });
          deps.agenda?.()?.forgetWhatWasRead();
          result.calendarAdded.push(candidateName);
        }
      } else {
        result.notes.push(
          `Attached path for "${basename(resolved)}" (unknown type — mention what to do with it).`,
        );
        result.attachments.push({ kind: "document", path: resolved, name: basename(resolved) });
      }
    }
    return result;
  });
}
