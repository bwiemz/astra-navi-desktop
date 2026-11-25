import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrainEvent } from "../shared/ipc.ts";
import type { ConfigStore } from "./config.ts";
import { reportFrontWindow } from "./desktop.ts";
import type { DesktopServices } from "./desktopTools.ts";
import { Hands, type HandsAbilities, type WindowSeen } from "./hands.ts";
import type { HandsServices } from "./handsTools.ts";
import type { PinnedMissionView } from "./missionPlan.ts";
import { listPhones, pingPhone } from "./phone.ts";
import type { PlatformAdapter } from "./platform/adapter.ts";
import { ShipEars } from "./shipEars.ts";
import type { Sight } from "./sight.ts";
import {
  Station,
  type PairedDevice,
  type StationAlert,
  type StationDeps,
  type StationEvent,
} from "./station.ts";
import { ClipTranscriber } from "./transcriber.ts";
import { programName, ScreenWatch, type WatchNotice } from "./watch.ts";

/**
 * Her reach beyond her own window: her hands in other programs, her standing watch on
 * the screen, her memory of what the PC played, and the station through which the
 * user's other devices talk to her. Each is off until the user switches it on, and this
 * is the one place that starts and stops them.
 */

export interface ReachDeps {
  config: ConfigStore;
  sight: Sight;
  /** A private folder for the small scripts handed to the window manager. */
  scriptDir: string;
  /** Where downloaded models are kept (the speech recogniser is one). */
  modelsCacheDir: string;
  /** Full path of hands.py. */
  handsScript: string;
  /** Optional cross-platform adapter replacing Linux Python/KWin helpers. */
  adapter?: PlatformAdapter;
  /** The app's own windows, by program name. */
  ownApps: readonly string[];
  stationDir: string;
  /** Where the built phone app is, if it has been built: phone-app/build/astra-navi.apk. */
  phoneAppFile?: string;
  /** Something she saw while watching is worth telling. */
  onNotice(text: string): void;
  /** A message typed on another device. False when it could not be taken. */
  onAwayMessage(text: string, device: PairedDevice): boolean;
  onAwayStop(): void;
  /** A problem the user should hear about, in plain words. */
  onProblem(message: string): void;
  /** The station opened or closed, or a device was paired or unpaired. */
  onStationChanged?(): void;
  /** Whoever holds a paired device asked for the sign-in password to be reset. Nothing was changed. */
  onResetAsked?(device: PairedDevice): void;
  /** Questions about mission steps that a signed-in device may answer; see the station. */
  approvals?: StationDeps["approvals"];
  /** Single mission explicitly pinned at the PC for signed-in devices to follow and steer. */
  pinnedMission?: StationDeps["pinnedMission"];
  /** Away-only turn traces shown in the station's collapsible inspector drawer. */
  traces?: StationDeps["traces"];
}

export interface ReachStatus {
  hands: HandsAbilities | null;
  watching: boolean;
  /** The program the user is in, when she is watching. */
  front: string | null;
  hearing: boolean;
  station: { running: boolean; addresses: string[]; devices: number };
}

interface Exchange {
  said: string;
  reply: string;
  at: string;
}

const KEPT_EXCHANGES = 10;
const KEPT_ALERTS = 50;

export class Reach {
  private readonly deps: ReachDeps;
  readonly hands: Hands;
  private readonly transcriber: ClipTranscriber;
  private watch: ScreenWatch | null = null;
  private ears: ShipEars | null = null;
  private stationServer: Station | null = null;
  private watchRestarts = 0;
  private lastWatchRestartAt = 0;
  /** Switching things on and off happens one change at a time, in the order asked. */
  private changes: Promise<unknown> = Promise.resolve();
  /** The reply being written is one a device may see: it answers a device, or she spoke first. */
  private forwarding = false;
  /** Messages from devices that are waiting for her answer, oldest first. */
  private readonly awaySaid: string[] = [];
  /** The last few exchanges, for a device that has just connected. Memory only. */
  private readonly exchanges: Exchange[] = [];
  /** Standing-order alerts kept for background polling by paired mobile clients. */
  private readonly alertsList: StationAlert[] = [];
  private said = "";
  private reply = "";

  constructor(deps: ReachDeps) {
    this.deps = deps;
    this.hands = new Hands({ script: deps.handsScript, adapter: deps.adapter });
    this.transcriber = new ClipTranscriber(deps.modelsCacheDir);
  }

  /** What the tools need to work inside other programs. */
  get handsServices(): HandsServices {
    return {
      hands: this.hands,
      ...(this.deps.adapter ? { adapter: this.deps.adapter } : {}),
      sight: this.deps.sight,
      scriptDir: this.deps.scriptDir,
      ownApps: this.deps.ownApps,
    };
  }

  /** The parts of her desktop tools that depend on what is switched on right now. */
  get desktopExtras(): Pick<DesktopServices, "watch" | "ears"> {
    return {
      watch: () => this.watch,
      ears: () =>
        this.ears
          ? { heard: this.ears, transcribe: (samples) => this.transcriber.transcribe(samples) }
          : null,
    };
  }

  /** Tells her which program the user is in, beside their next message. */
  get screen(): { next(): string; reset(): void } {
    return {
      next: () => this.watch?.next() ?? "",
      reset: () => this.watch?.reset(),
    };
  }

  get station(): Station | null {
    return this.stationServer;
  }

  /** Starts whatever the settings say should be running. Failures are reported, not thrown. */
  async start(): Promise<void> {
    const { sight, hearing, devices } = this.deps.config.value;
    if (sight.watch) await this.setWatching(true).catch(() => undefined);
    if (hearing.pcAudio) this.setHearing(true);
    if (devices.station) await this.setStation(true).catch(() => undefined);
  }

  /** Switches her standing watch on the screen on or off. Throws, in plain words, when it cannot start. */
  setWatching(on: boolean): Promise<void> {
    return this.inTurn(() => this.changeWatching(on));
  }

  /** Runs one change after the ones before it have finished, whether or not they worked. */
  private inTurn<T>(change: () => Promise<T>): Promise<T> {
    const next = this.changes.catch(() => undefined).then(change);
    this.changes = next;
    return next;
  }

  private async changeWatching(on: boolean): Promise<void> {
    if (!on) {
      const watch = this.watch;
      this.watch = null;
      await watch?.stop();
      if (!this.deps.adapter) await this.hands.unfollowWindows();
      return;
    }
    if (this.watch) return;
    const { deps, hands } = this;
    const adapter = deps.adapter;
    const watch = new ScreenWatch({
      follow: adapter
        ? async (listener) => {
            let stopped = false;
            let lastKey = "";
            let failures = 0;
            let polling = false;
            const emitActive = (
              layout: Awaited<ReturnType<typeof adapter.windowManager.layout>>,
            ): void => {
              const chosen =
                layout.windows.find((win) => win.active && !win.minimized) ??
                layout.windows.find((win) => !win.minimized);
              if (!chosen) return;
              const key = `${chosen.id}|${chosen.app}|${chosen.title}|${chosen.fullScreen}`;
              if (key === lastKey) return;
              lastKey = key;
              const seen: WindowSeen = {
                id: chosen.id,
                app: chosen.app,
                title: chosen.title,
                pid: chosen.pid,
                fullScreen: chosen.fullScreen,
                dialog: chosen.dialog,
                width: chosen.width,
                height: chosen.height,
              };
              listener(seen);
            };
            const initial = await adapter.windowManager.layout();
            emitActive(initial);
            const timer = setInterval(() => {
              if (stopped || polling) return;
              polling = true;
              void adapter.windowManager
                .layout()
                .then((layout) => {
                  failures = 0;
                  if (!stopped) emitActive(layout);
                })
                .catch(() => {
                  failures += 1;
                  if (!stopped && failures >= 5) {
                    stopped = true;
                    clearInterval(timer);
                    this.watchLost(watch);
                  }
                })
                .finally(() => {
                  polling = false;
                });
            }, 1200);
            timer.unref();
            return async () => {
              stopped = true;
              clearInterval(timer);
            };
          }
        : async (listener) => {
            const address = await hands.followWindows(listener, () => this.watchLost(watch));
            return reportFrontWindow(deps.scriptDir, address);
          },
      read: (signal) => deps.sight.readFrontWindow(signal),
      ownApps: deps.ownApps,
      skip: () => deps.config.value.sight.watchSkip,
      onNotice: (notice) => deps.onNotice(describeNotice(notice)),
    });
    this.watch = watch;
    try {
      await watch.start();
    } catch (error) {
      this.watch = null;
      if (!adapter) await hands.unfollowWindows();
      const message = `She cannot keep watch on the screen: ${error instanceof Error ? error.message : String(error)}`;
      deps.onProblem(message);
      throw new Error(message, { cause: error });
    }
  }

  /**
   * The helper behind the watch died. The watch is set up again, a few times at most: a
   * helper that keeps dying is reported instead of being restarted for ever.
   */
  private watchLost(watch: ScreenWatch): void {
    if (this.watch !== watch) return;
    this.watch = null;
    // Counted over a short stretch: three failures in ten minutes, not three in a year.
    if (Date.now() - this.lastWatchRestartAt > 10 * 60_000) this.watchRestarts = 0;
    this.lastWatchRestartAt = Date.now();
    this.watchRestarts += 1;
    const again = this.watchRestarts <= 3 && this.deps.config.value.sight.watch;
    void watch
      .stop()
      .then(() => new Promise((resolve) => setTimeout(resolve, 3000)))
      .then(() => {
        if (again) return this.setWatching(true);
        this.deps.onProblem(
          "She has stopped keeping watch on the screen: her helper keeps stopping.",
        );
        return undefined;
      })
      .catch(() => undefined);
  }

  /** Switches her memory of what the PC plays on or off. */
  setHearing(on: boolean): void {
    if (!on) {
      this.ears?.stop();
      this.ears = null;
      void this.transcriber.rest();
      return;
    }
    if (this.ears) return;
    this.ears = new ShipEars({
      adapter: this.deps.adapter,
      onProblem: (message) => this.deps.onProblem(`She cannot hear the PC: ${message}`),
    });
    this.ears.start();
  }

  /** Opens or closes the station for the user's other devices. Throws, in plain words, when it cannot open. */
  setStation(on: boolean): Promise<void> {
    return this.inTurn(() => this.changeStation(on));
  }

  private async changeStation(on: boolean): Promise<void> {
    if (!on) {
      const station = this.stationServer;
      this.stationServer = null;
      await station?.stop();
      if (station) this.deps.onStationChanged?.();
      return;
    }
    if (this.stationServer) return;
    const station = new Station({
      dir: this.deps.stationDir,
      port: this.deps.config.value.devices.stationPort,
      onSay: (text, device) => {
        const taken = this.deps.onAwayMessage(text, device);
        if (taken) this.awaySaid.push(text);
        return taken;
      },
      onStop: () => this.deps.onAwayStop(),
      phoneApp: () => builtPhoneApp(this.deps.phoneAppFile),
      recent: () => [...this.exchanges],
      alerts: (sinceId) => this.alertsSince(sinceId),
      onVoice: (samples) => this.transcriber.transcribe(samples),
      onDevicesChanged: () => this.deps.onStationChanged?.(),
      onResetAsked: (device) => this.deps.onResetAsked?.(device),
      ...(this.deps.approvals ? { approvals: this.deps.approvals } : {}),
      ...(this.deps.pinnedMission ? { pinnedMission: this.deps.pinnedMission } : {}),
      ...(this.deps.traces ? { traces: this.deps.traces } : {}),
    });
    try {
      await station.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.onProblem(`The station for other devices could not open: ${message}`);
      throw error;
    }
    this.stationServer = station;
    this.deps.onStationChanged?.();
  }

  /** Broadcasts the updated pinned mission view (or null) to connected devices, if open. */
  updatePinnedMission(mission: PinnedMissionView | null): void {
    this.stationServer?.updatePinnedMission?.(mission);
  }

  /** Records a standing-order alert and broadcasts it to connected devices when open. */
  recordAlert(alert: { title: string; body: string; kind?: "order"; at?: string }): StationAlert {
    const entry: StationAlert = {
      id: randomUUID(),
      kind: alert.kind ?? "order",
      title: alert.title.slice(0, 120),
      body: alert.body.slice(0, 500),
      at: alert.at ?? new Date().toISOString(),
    };
    this.alertsList.push(entry);
    while (this.alertsList.length > KEPT_ALERTS) this.alertsList.shift();
    this.stationServer?.pushAlert(entry);
    return entry;
  }

  /** Returns standing-order alerts newer than `sinceId` (or recent ones when unknown). */
  alertsSince(sinceId?: string): StationAlert[] {
    if (!sinceId) return [...this.alertsList];
    const index = this.alertsList.findIndex((entry) => entry.id === sinceId);
    if (index === -1) return this.alertsList.slice(-10);
    return this.alertsList.slice(index + 1);
  }

  /**
   * Passes on to the devices on the station what they may see: her answers to messages
   * sent from a device, and things she brings up herself (a reminder coming due). What
   * is said between her and whoever is at the PC stays at the PC.
   */
  onBrainEvent(event: BrainEvent): void {
    if (event.type === "status" && event.state === "thinking") {
      // Her putting right a reply belongs wherever that reply went: to the devices only
      // when the message it answered came from one.
      this.forwarding = event.away === true || (event.initiated && event.correction !== true);
      // Messages from devices are answered in the order they were taken.
      this.said = event.away === true && !event.initiated ? (this.awaySaid.shift() ?? "") : "";
    }
    if (!this.forwarding) return;
    switch (event.type) {
      case "reply-start":
        this.reply = "";
        break;
      case "text":
        this.reply += event.delta;
        break;
      case "reply-end":
        if (this.reply.trim()) {
          this.exchanges.push({
            said: this.said.slice(0, 2000),
            reply: this.reply.slice(0, 6000),
            at: new Date().toISOString(),
          });
          if (this.exchanges.length > KEPT_EXCHANGES) this.exchanges.shift();
        }
        this.said = "";
        break;
      default:
        break;
    }
    const forward = toStationEvent(event);
    if (forward) this.stationServer?.broadcast(forward);
  }

  /** A reminder came due: it is also sent to the phone, when the user asked for that. */
  async remindPhone(text: string): Promise<void> {
    if (!this.deps.config.value.devices.pingPhone) return;
    try {
      const phone = (await listPhones()).find((entry) => entry.reachable);
      if (phone) await pingPhone(phone.id, `Reminder: ${text}`);
    } catch (error) {
      console.warn("[reach] the reminder could not be sent to the phone:", error);
    }
  }

  async status(): Promise<ReachStatus> {
    const station = this.stationServer;
    const front = this.watch?.glance(Number.MAX_SAFE_INTEGER);
    return {
      hands: await this.hands.abilities().catch(() => null),
      watching: this.watch?.running ?? false,
      front: front ? programName(front.app) : null,
      hearing: this.ears?.running ?? false,
      station: {
        running: station?.running ?? false,
        addresses: station?.addresses() ?? [],
        devices: station?.devices().length ?? 0,
      },
    };
  }

  /** Forgets the conversation kept for connecting devices (a new conversation was started). */
  forgetExchanges(): void {
    this.exchanges.length = 0;
    this.awaySaid.length = 0;
  }

  async dispose(): Promise<void> {
    const watch = this.watch;
    this.watch = null;
    this.ears?.stop();
    this.ears = null;
    await Promise.allSettled([watch?.stop(), this.stationServer?.stop(), this.transcriber.rest()]);
    this.stationServer = null;
    await this.hands.dispose();
  }
}

/** The phone app as built on this computer, or null when it has not been built. */
export function builtPhoneApp(file: string | undefined): { file: string; version: string } | null {
  if (!file) return null;
  let resolved = file;
  if (!existsSync(resolved)) {
    const legacy = join(dirname(file), "ai-chan.apk");
    if (!existsSync(legacy)) return null;
    resolved = legacy;
  }
  let version = "";
  try {
    version = readFileSync(join(dirname(resolved), "version"), "utf8")
      .trim()
      .slice(0, 40);
  } catch {
    // an app built without its version note is still an app
  }
  return { file: resolved, version };
}

/** How something she noticed on screen is put to her, to tell in her own words. */
export function describeNotice(notice: WatchNotice): string {
  return `While keeping watch on the screen you noticed a small window in ${programName(notice.app)} that looks like trouble. It reads: "${notice.line}". Tell Captain you saw it and offer to help. You cannot check or fix anything in this reply, so do not say you are doing so, and do not assume what caused it.`;
}

/** What a device on the station is shown of an event in her brain. */
export function toStationEvent(event: BrainEvent): StationEvent | null {
  switch (event.type) {
    case "reply-start":
    case "reply-end":
      return { type: event.type };
    case "text":
      return { type: "text", delta: event.delta };
    case "mood":
      return { type: "mood", mood: event.mood };
    case "activity":
      return { type: "activity", label: event.label };
    case "status":
      return { type: "status", state: event.state };
    case "caution":
      return { type: "caution", message: event.message };
    case "error":
      return { type: "caution", message: event.message };
    // The question itself stays on the PC: only that one is waiting is passed on.
    case "permission":
      return { type: "needs-captain", title: event.request.title };
    default:
      return null;
  }
}
