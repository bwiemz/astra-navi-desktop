import { readFile, writeFile } from "node:fs/promises";
import { app, type BrowserWindow } from "electron";
import type { Brain } from "../core/brain.ts";
import type { ConfigStore } from "../core/config.ts";
import type { BrainEvent } from "../shared/ipc.ts";
import type { BrowserDeck } from "./browser.ts";

/**
 * Developer aids: ways to put her window into a known state and photograph it, or to
 * send her a message, from the command line. Each is switched on by an environment
 * variable, and none of them is active in a packaged build.
 */

export interface DebugDeps {
  config: ConfigStore;
  mainWindow(): BrowserWindow | null;
  settingsWindow(): BrowserWindow | null;
  brain(): Brain | null;
  browserDeck(): BrowserDeck | null;
  /** Whether the microphone conversation is on, and how many blocks of sound have come from it. */
  listening(): boolean;
  audioBlocks(): number;
  sendToWindow(channel: string, payload?: unknown): void;
  openSettings(): void;
}

/**
 * AI_CHAN_DEBUG_CAPTURE=/path/shot.png saves a picture of the window and quits.
 * AI_CHAN_DEBUG_DEMO=1 first plays a canned reply and an approval question, so the
 * balloon can be checked without running the model. AI_CHAN_DEBUG_SAY="hello" sends a
 * real message as if it had been typed; prefix it with "voice:" to send it as speech.
 * AI_CHAN_DEBUG_LISTEN=1 switches the microphone on and reports what arrives from it.
 * AI_CHAN_DEBUG_SETTINGS=/path/shot.png opens the settings panel, changes two settings through it, and saves a picture of it.
 * AI_CHAN_DEBUG_HIDE=<milliseconds> hides the window after that long, as closing it would.
 * AI_CHAN_DEBUG_BROWSE=<address> reads a page through her browser and reports what came back.
 */
export function scheduleDebugAids(deps: DebugDeps): void {
  if (app.isPackaged) return;
  if (process.env["AI_CHAN_DEBUG_DEMO"]) {
    setTimeout(() => {
      const demo: BrainEvent[] = [
        { type: "status", state: "thinking", spoken: false, initiated: false },
        { type: "reply-start" },
        { type: "mood", mood: "happy" },
        {
          type: "text",
          delta:
            "Kdenlive is in the official repos, Captain. **Astra** will install it with `pacman`, so you'll get a password prompt.\n\n- about 310 MB\n- no AUR needed",
        },
        // In the order her tools really work: the question comes first, and the step is
        // only named once it has been allowed.
        {
          type: "permission",
          request: {
            id: "demo",
            title: "Run this command?",
            detail: "pkexec pacman -S --needed --noconfirm kdenlive",
            note: "Install Kdenlive from the official repositories",
            sensitive: false,
            canRemember: true,
          },
        },
      ];
      for (const event of demo) deps.sendToWindow("brain:event", event);
    }, 6000);
  }
  const browse = process.env["AI_CHAN_DEBUG_BROWSE"];
  if (browse) {
    setTimeout(() => {
      void deps
        .browserDeck()
        ?.read(browse)
        .then((page) =>
          console.log(
            `[debug] browser read ${page.url}: ${page.text.length} characters, starts ${JSON.stringify(page.text.slice(0, 120))}`,
          ),
        )
        .catch((error: unknown) => console.log("[debug] browser read failed:", String(error)));
    }, 4000);
  }
  const say = process.env["AI_CHAN_DEBUG_SAY"];
  if (say) {
    setTimeout(() => {
      const spoken = say.startsWith("voice:");
      deps.brain()?.send(spoken ? say.slice("voice:".length) : say, { spoken });
    }, 6000);
  }
  if (process.env["AI_CHAN_DEBUG_LISTEN"]) {
    setTimeout(() => {
      void deps
        .mainWindow()
        ?.webContents.executeJavaScript("document.getElementById('mic').click()", true);
    }, 5000);
    setInterval(() => {
      console.log(
        `[debug] microphone: listening=${deps.listening()}, blocks received=${deps.audioBlocks()}`,
      );
    }, 3000).unref();
  }
  // AI_CHAN_DEBUG_EVENTS=/path/events.json plays a list of
  // { after: <ms>, channel: "brain:event" | "voice:event" | "stage:presence" | "chat:forgotten" | "chat:dropped", payload }
  // into her window,
  // and AI_CHAN_DEBUG_JS=<script> then runs in it (AI_CHAN_DEBUG_JS_AFTER ms after start,
  // 5000 by default), so any state of the window can be put up and photographed.
  const eventsFile = process.env["AI_CHAN_DEBUG_EVENTS"];
  if (eventsFile) {
    void readFile(eventsFile, "utf8")
      .then((raw) => {
        const events = JSON.parse(raw) as { after: number; channel: string; payload: unknown }[];
        for (const entry of events) {
          const playable = [
            "brain:event",
            "voice:event",
            "stage:presence",
            "chat:forgotten",
            "chat:dropped",
          ];
          if (!playable.includes(entry.channel)) continue;
          setTimeout(() => deps.sendToWindow(entry.channel, entry.payload), entry.after).unref();
        }
      })
      .catch((error: unknown) => console.log("[debug] events could not be played:", String(error)));
  }
  const debugScript = process.env["AI_CHAN_DEBUG_JS"];
  if (debugScript) {
    setTimeout(
      () =>
        void deps
          .mainWindow()
          ?.webContents.executeJavaScript(debugScript, true)
          .catch((error: unknown) => console.log("[debug] script failed:", String(error))),
      Number(process.env["AI_CHAN_DEBUG_JS_AFTER"] ?? 5000),
    ).unref();
  }
  const settingsShot = process.env["AI_CHAN_DEBUG_SETTINGS"];
  if (settingsShot) {
    setTimeout(() => {
      deps.openSettings();
      setTimeout(() => {
        void (async () => {
          const page = deps.settingsWindow()?.webContents;
          if (!page) return;
          // Flip two controls the way a person would, to prove a change reaches the settings file.
          await page.executeJavaScript(
            "document.getElementById('morningBriefing').click(); const n = document.getElementById('otherNames'); n.value = 'Computer, Hyperion'; n.dispatchEvent(new Event('change'));",
            true,
          );
          // AI_CHAN_DEBUG_SETTINGS_SCROLL=<element id> brings that part of the page into the
          // picture and asks for a pairing code, to check the section for other devices.
          const scrollTo = process.env["AI_CHAN_DEBUG_SETTINGS_SCROLL"];
          if (scrollTo) {
            await page.executeJavaScript(
              `document.getElementById(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: "start" }); document.getElementById("pair")?.click();`,
              true,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 900));
          console.log(
            `[debug] after the panel: morningBriefing=${deps.config.value.morningBriefing}, otherNames=${JSON.stringify(deps.config.value.voice.otherNames)}`,
          );
          await writeFile(settingsShot, (await page.capturePage()).toPNG());
          console.log("[debug] settings page captured");
        })().catch((error: unknown) =>
          console.log("[debug] settings check failed:", String(error)),
        );
      }, 2500);
    }, 4000);
  }
  const hideAfter = Number(process.env["AI_CHAN_DEBUG_HIDE"] ?? 0);
  if (hideAfter > 0) {
    setTimeout(() => {
      deps.mainWindow()?.hide();
      console.log("[debug] window hidden");
    }, hideAfter);
  }
  const target = process.env["AI_CHAN_DEBUG_CAPTURE"];
  if (!target) return;
  const delay = Number(process.env["AI_CHAN_DEBUG_CAPTURE_DELAY"] ?? 8000);
  setTimeout(() => {
    void (async () => {
      // The window as it is when the picture is due.
      const mainWindow = deps.mainWindow();
      if (mainWindow) {
        await writeFile(target, (await mainWindow.webContents.capturePage()).toPNG());
        console.log(
          "[debug] window:",
          JSON.stringify({
            visible: mainWindow.isVisible(),
            bounds: mainWindow.getBounds(),
            onTop: mainWindow.isAlwaysOnTop(),
          }),
        );
        const snapshot = (await mainWindow.webContents.executeJavaScript(
          "window.aichanDebug?.()",
        )) as {
          info: unknown;
          image: string;
        } | null;
        if (snapshot) {
          console.log("[debug] stage:", JSON.stringify(snapshot.info));
          await writeFile(
            `${target}.canvas.png`,
            Buffer.from(snapshot.image.split(",")[1] ?? "", "base64"),
          );
        }
      }
      app.quit();
    })();
  }, delay);
}
