import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";
import type { Brain } from "../core/brain.ts";
import type { ConfigStore } from "../core/config.ts";
import type { Initiative } from "../core/initiative.ts";
import { LANGUAGES, type LanguageCode } from "../core/languages.ts";
import { BRAIN_MODELS } from "../core/models.ts";
import type { Reach } from "../core/reach.ts";
import type { VoiceBackend } from "../core/voice/backend.ts";
import { FullVoice } from "../core/voice/fullVoice.ts";
import { LightVoice } from "../core/voice/lightVoice.ts";
import { setStartAtLogin } from "./loginStart.ts";

/**
 * Her place in the tray: the small badge, and the menu behind it from which everything
 * about her can be switched without opening a window. The menu is built again whenever
 * something it shows has changed, so what it says is always how things stand.
 *
 * What each entry does is done elsewhere and handed in here; this file only lays the
 * menu out.
 */

function trayIcon(): Electron.NativeImage {
  // A small drawn badge, so the project ships no artwork of its own.
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 15.5, y - 15.5);
      const offset = (y * size + x) * 4;
      if (distance > 15) continue;
      const rim = distance > 12.5;
      const eye = Math.hypot(x - 11, y - 14) < 2.2 || Math.hypot(x - 21, y - 14) < 2.2;
      const [r, g, b] = rim || eye ? [27, 31, 59] : [255, 111, 163];
      // Bitmap byte order is BGRA.
      pixels[offset] = b;
      pixels[offset + 1] = g;
      pixels[offset + 2] = r;
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

export interface TrayDeps {
  config: ConfigStore;
  windowTitle: string;
  mainWindow(): BrowserWindow | null;
  brain(): Brain | null;
  reach(): Reach | null;
  initiative(): Initiative | null;
  voiceBackend(): VoiceBackend | null;
  /** Names of the designed voices found, and whether the full voice is set up. */
  designedVoices(): string[];
  fullVoiceReady(): boolean;
  /** Whether she starts at login, as last found out, and a way to note a change. */
  startAtLogin(): boolean;
  noteStartAtLogin(on: boolean): void;
  nameRequired(): boolean;
  showWindow(focusInput: boolean): void;
  openSettings(): void;
  sendToWindow(channel: string, payload?: unknown): void;
  chooseBrain(choice: string): void;
  chooseLanguage(language: LanguageCode): void;
  chooseVoice(engine: "full" | "light", design: string): void;
  setWatching(on: boolean): Promise<void>;
  setHearingPc(on: boolean): Promise<void>;
  setStationOpen(on: boolean): Promise<void>;
  setHandsOff(off: boolean): Promise<void>;
  showSelfCheck(): Promise<void>;
  showActions(): Promise<void>;
  showLearned(): Promise<void>;
  forgetConversations(): Promise<void>;
  /** Stops the reply she is writing and says so. */
  toldStopped(): void;
  importModel(): Promise<void>;
  removeModel(): Promise<void>;
  clickThrough?: () => boolean;
  setClickThrough?: (on: boolean) => void;
  resetWindowToPrimary?: () => void;
  forceReleaseVram?: () => Promise<void>;
  restartInSafeMode?: () => Promise<void>;
  exportSupportBundle?: () => Promise<void>;
}

export interface TrayMenu {
  rebuildTrayMenu(): void;
  createTray(): void;
}

export function createTrayMenu(deps: TrayDeps): TrayMenu {
  let tray: Tray | null = null;

  function rebuildTrayMenu(): void {
    if (!tray) return;
    // What she is taking in right now is always readable from the tray, without opening anything.
    const senses = [
      deps.config.value.sight.watch ? "watching the screen" : "",
      deps.config.value.hearing.pcAudio ? "hearing the PC" : "",
      deps.config.value.devices.station ? "open to your other devices" : "",
    ].filter(Boolean);
    tray.setToolTip(
      senses.length > 0 ? `${deps.windowTitle}: ${senses.join(", ")}` : deps.windowTitle,
    );
    const current = deps.config.value.brain;
    const sizeGb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
    const speak = deps.config.value.voice.speak;
    const setSpeak = (value: typeof speak): void => {
      void deps.config
        .update({ voice: { ...deps.config.value.voice, speak: value } })
        .then(rebuildTrayMenu);
    };
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Talk to Astra Navi", click: () => deps.showWindow(true) },
        { label: "Settings…", click: deps.openSettings },
        {
          label: "Show or hide",
          click: () =>
            deps.mainWindow()?.isVisible() ? deps.mainWindow()?.hide() : deps.showWindow(false),
        },
        {
          label: "Reset window to primary monitor",
          click: () => deps.resetWindowToPrimary?.(),
        },
        {
          label: "Click-through lock",
          type: "checkbox",
          checked: deps.clickThrough?.() ?? false,
          click: (item) => {
            deps.setClickThrough?.(item.checked);
            rebuildTrayMenu();
          },
        },
        { type: "separator" },
        {
          label: "Her brain",
          submenu: [
            {
              label: "Choose for this computer",
              type: "radio",
              checked: current === "auto",
              click: () => deps.chooseBrain("auto"),
            },
            ...Object.values(BRAIN_MODELS).map((model) => ({
              label: `${model.label}, ${sizeGb(model.sizeBytes)} download, about ${model.vramGb} GB of graphics memory`,
              type: "radio" as const,
              checked: current === model.id,
              click: () => deps.chooseBrain(model.id),
            })),
          ],
        },
        {
          label: "Her language",
          submenu: (Object.keys(LANGUAGES) as LanguageCode[]).map((code) => ({
            label: LANGUAGES[code].label,
            type: "radio" as const,
            checked: deps.config.value.language === code,
            click: () => deps.chooseLanguage(code),
          })),
        },
        {
          label: "Her voice",
          submenu: [
            ...deps.designedVoices().map((name) => ({
              label: `${name[0]?.toUpperCase() ?? ""}${name.slice(1)} (all languages)`,
              type: "radio" as const,
              enabled: deps.fullVoiceReady(),
              checked:
                deps.voiceBackend() instanceof FullVoice && deps.config.value.voice.design === name,
              click: () => deps.chooseVoice("full", name),
            })),
            {
              label: "Light (English only, runs on any computer)",
              type: "radio" as const,
              checked: deps.voiceBackend() instanceof LightVoice,
              click: () => deps.chooseVoice("light", deps.config.value.voice.design),
            },
            ...(deps.fullVoiceReady()
              ? []
              : [
                  { type: "separator" as const },
                  {
                    label: "The designed voices need a one-time set-up: npm run setup-voice",
                    enabled: false,
                  },
                ]),
          ],
        },
        {
          label: "Do not disturb",
          type: "checkbox",
          checked: deps.config.value.doNotDisturb,
          click: (item) => {
            void deps.config.update({ doNotDisturb: item.checked }).then(() => {
              if (!item.checked) deps.initiative()?.release();
            });
          },
        },
        {
          label: "She may look at the screen without asking",
          type: "checkbox",
          checked: deps.config.value.sight.withoutAsking,
          click: (item) =>
            void deps.config.update({
              sight: { ...deps.config.value.sight, withoutAsking: item.checked },
            }),
        },
        {
          label: "She may work inside other programs",
          type: "checkbox",
          checked: deps.config.value.hands.inPrograms,
          click: (item) =>
            void deps.config.update({ hands: { inPrograms: item.checked } }).then(rebuildTrayMenu),
        },
        {
          label: "Keep an eye on the screen",
          type: "checkbox",
          checked: deps.config.value.sight.watch,
          click: (item) => void deps.setWatching(item.checked).catch(() => undefined),
        },
        {
          label: "Remember what the PC just played",
          type: "checkbox",
          checked: deps.config.value.hearing.pcAudio,
          click: (item) => void deps.setHearingPc(item.checked),
        },
        {
          label: "Let my other devices talk to her",
          type: "checkbox",
          checked: deps.config.value.devices.station,
          click: (item) =>
            void deps
              .setStationOpen(item.checked)
              .then(() => {
                if (item.checked) deps.openSettings();
              })
              .catch(() => undefined),
        },
        {
          label: "Morning briefing",
          type: "checkbox",
          checked: deps.config.value.morningBriefing,
          click: (item) => void deps.config.update({ morningBriefing: item.checked }),
        },
        {
          label: "Listen for her name (microphone always on)",
          type: "checkbox",
          checked: deps.config.value.voice.alwaysListening,
          click: (item) => {
            void deps.config
              .update({ voice: { ...deps.config.value.voice, alwaysListening: item.checked } })
              .then(() => {
                deps.sendToWindow("ui:listen", item.checked);
                rebuildTrayMenu();
              });
          },
        },
        {
          label: "Start when I log in",
          type: "checkbox",
          checked: deps.startAtLogin(),
          click: (item) => {
            void setStartAtLogin(item.checked)
              .then(() => {
                deps.noteStartAtLogin(item.checked);
              })
              .catch((error: unknown) => console.error(error))
              .finally(rebuildTrayMenu);
          },
        },
        {
          label: "Only answer to her name",
          type: "checkbox",
          enabled: !deps.config.value.voice.alwaysListening,
          checked: deps.nameRequired(),
          click: (item) =>
            void deps.config.update({
              voice: { ...deps.config.value.voice, needsName: item.checked },
            }),
        },
        {
          label: "She speaks aloud",
          submenu: [
            {
              label: "When you speak to her",
              type: "radio",
              checked: speak === "when-spoken-to",
              click: () => setSpeak("when-spoken-to"),
            },
            {
              label: "Always",
              type: "radio",
              checked: speak === "always",
              click: () => setSpeak("always"),
            },
            {
              label: "Never",
              type: "radio",
              checked: speak === "never",
              click: () => setSpeak("never"),
            },
          ],
        },
        {
          label: "Hands off the controls (she can only talk and look things up)",
          type: "checkbox",
          checked: deps.config.value.handsOff,
          click: (item) =>
            void deps.setHandsOff(item.checked).catch((error: unknown) => console.error(error)),
        },
        {
          label: "Force release GPU VRAM",
          click: () =>
            void deps.forceReleaseVram?.().catch((error: unknown) => console.error(error)),
        },
        { type: "separator" },
        {
          label: "Check her systems…",
          click: () => void deps.showSelfCheck().catch((error: unknown) => console.error(error)),
        },
        {
          label: "Restart in Safe Mode",
          click: () =>
            void deps.restartInSafeMode?.().catch((error: unknown) => console.error(error)),
        },
        {
          label: "Export Support Bundle…",
          click: () =>
            void deps.exportSupportBundle?.().catch((error: unknown) => console.error(error)),
        },
        {
          label: "What she has done…",
          click: () => void deps.showActions().catch((error: unknown) => console.error(error)),
        },
        {
          label: "Past conversations",
          submenu: [
            {
              label: "Keep them, so she can look back",
              type: "checkbox",
              checked: deps.config.value.keepConversations,
              click: (item) => void deps.config.update({ keepConversations: item.checked }),
            },
            {
              label: "Forget all past conversations…",
              click: () =>
                void deps.forgetConversations().catch((error: unknown) => console.error(error)),
            },
          ],
        },
        {
          label: "What she has learned…",
          click: () => void deps.showLearned().catch((error: unknown) => console.error(error)),
        },
        {
          label: "Start a new conversation",
          click: () => {
            deps.reach()?.forgetExchanges();
            void deps
              .brain()
              ?.newConversation()
              .catch((error: unknown) => console.error(error));
            deps.toldStopped(); // it stops her reply first
          },
        },
        { type: "separator" },
        { label: "Import character model…", click: () => void deps.importModel() },
        { label: "Remove character model", click: () => void deps.removeModel() },
        { type: "separator" },
        {
          label: "About this fan project",
          click: () => {
            deps.showWindow(false);
            deps.sendToWindow("ui:notice");
          },
        },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  }

  function createTray(): void {
    tray = new Tray(trayIcon());
    tray.setToolTip(deps.windowTitle);
    tray.on("click", () => deps.showWindow(true));
    rebuildTrayMenu();
  }

  return { rebuildTrayMenu, createTray };
}
