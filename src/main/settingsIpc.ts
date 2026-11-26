import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { describeSource } from "../core/agenda.ts";
import {
  checkBootstrapStatus,
  runBootstrapTask,
  type BootstrapTask,
} from "../core/bootstrap.ts";
import { gameOnCard as cardGameOnCard } from "../core/cardWatch.ts";
import { daysAboard } from "../core/clock.ts";
import type { ConfigStore } from "../core/config.ts";
import type { LocalEngine } from "../core/engine.ts";
import { benchmarkFirstLaunchHardware } from "../core/hardwareTuner.ts";
import type { Initiative } from "../core/initiative.ts";
import { LANGUAGE_CODES, LANGUAGES, type LanguageCode } from "../core/languages.ts";
import { BRAIN_MODELS, findCatalogEntry, MOE_WORKSTATION_MODELS } from "../core/models.ts";
import type { MemoryStore } from "../core/memory.ts";
import type { McpHub } from "../core/mcpClient.ts";
import type { MissionBoard } from "../core/missionPlan.ts";
import type { NoticeWatch } from "../core/notices.ts";
import { dataDir, ordersFile, resolveBundledRoot, stationDir } from "../core/paths.ts";
import {
  exportProfileBackup,
  importProfileBackup,
  inspectProfileBackup,
} from "../core/profileBackup.ts";
import { buildPairingUri, encodeQrMatrix, type QrMatrix } from "../core/qrCode.ts";
import type { Reach } from "../core/reach.ts";
import { auditSecurityRules } from "../core/ruleAudit.ts";
import type { SearchBudget } from "../core/searchBudget.ts";
import type { SelfCheckResult } from "../core/selfCheck.ts";
import { excerpt, type StandingOrder } from "../core/standingOrders.ts";
import { StationAccount, whyNotThese } from "../core/stationAccount.ts";
import { buildRedactedSupportBundle, formatSupportBundleJson } from "../core/supportBundle.ts";
import { forShow, type ShownTrace, type TraceKeeper } from "../core/trace.ts";
import { checkGithubReleaseUpdate, type UpdateCheckResult } from "../core/updateCheck.ts";
import type { ConversationArchive } from "../core/archive.ts";
import {
  detectDistributionChannel,
  resolveEdition,
  shouldCheckGithubUpdates,
} from "../shared/edition.ts";
import type {
  BootstrapStatusView,
  DiskSpaceCheckView,
  HardwareRecommendationView,
  ModelDownloadStatusView,
  PolicyAuditSummaryView,
  ProfileBackupActionResult,
  ProfileRestoreActionResult,
  SettingsPatch,
  SettingsView,
  SupportBundleResultView,
} from "../shared/settings.ts";
import { setStartAtLogin } from "./loginStart.ts";
import { buildMcpServerViews } from "./mcpIpc.ts";
import { SettingsPatchSchema, StationAccountSchema } from "./settingsSchema.ts";

/**
 * The settings window, its view of how things stand, applying patches from it, and all
 * `settings:*` IPC handlers. Kept isolated from her own window so nothing written by a
 * language model can reach settings or station accounts.
 */

const runFile = promisify(execFile);

export interface SettingsIpcDeps {
  appOrigin: string;
  config: ConfigStore;
  engine(): LocalEngine | null;
  memoryStore(): MemoryStore | null;
  archive(): ConversationArchive | null;
  traces: TraceKeeper;
  noticeWatch(): NoticeWatch | null;
  initiative(): Initiative | null;
  reach(): Reach | null;
  mcpHub?(): McpHub | null;
  board?(): MissionBoard | null;
  searchBudget(): SearchBudget | null;
  designedVoices(): string[];
  fullVoiceReady(): boolean;
  createVoice(): Promise<void>;
  chooseBrain(choice: string): void;
  chooseLean(lean: boolean): void;
  chooseLanguage(language: LanguageCode): void;
  chooseVoice(engine: "full" | "light", design: string): void;
  setHandsOff(off: boolean): Promise<void>;
  forgetConversations(): Promise<void>;
  showLearned(): Promise<void>;
  showActions(): Promise<void>;
  showSelfCheck(): Promise<void>;
  runSelfCheck?(): Promise<SelfCheckResult>;
  desktopSessionNotice?(): string | null;
  recentErrors?(): readonly string[];
  safeModeStatus?(): { active: boolean; consecutiveCrashes: number; reason: string | null };
  clearSafeMode?(): Promise<void>;
  applyHotkeys?(): { failed: string[] };
  applyStageOptions?(): void;
  beforeProfileRestore?(): Promise<void>;
  relaunchAfterRestore?(): void;
  showAvatarWindow?(): void;
  importModel?(): Promise<void>;
  detectGameOnCard?(): Promise<string | null>;
  sendToWindow(channel: string, payload?: unknown): void;
  rebuildTrayMenu(): void;
}

export interface SettingsController {
  settingsWindow(): BrowserWindow | null;
  fromSettingsWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
  settingsView(): SettingsView;
  openSettings(): void;
  registerSettingsIpc(): void;
  exportSupportBundle(): Promise<SupportBundleResultView>;
  sendDownloadProgress(status: ModelDownloadStatusView): void;
  setWatching(on: boolean): Promise<void>;
  setHearingPc(on: boolean): Promise<void>;
  setStationOpen(on: boolean): Promise<void>;
  rereadStationAccount(): Promise<void>;
  noteResetAsked(device: { name: string; pairedAt: string }): string;
  describeBraveUse(): string;
  detectFirewall(): Promise<void>;
  startAtLogin(): boolean;
  noteStartAtLogin(on: boolean): void;
  setHandsAbilities(abilities: SettingsView["hands"]): void;
  setPhoneLink(on: boolean): void;
  setCanAskPassword(can: boolean): void;
}

export function createSettingsController(deps: SettingsIpcDeps): SettingsController {
  const { config } = deps;
  const gameOnCard = (): Promise<string | null> =>
    deps.detectGameOnCard ? deps.detectGameOnCard() : cardGameOnCard();
  let settingsWindow: BrowserWindow | null = null;
  let startAtLogin = false;
  let handsAbilities: SettingsView["hands"] = null;
  let phoneLink = false;
  let canAskPassword = false;
  /** A firewall found running on this PC when the app started, by its service name. */
  let firewall: string | null = null;
  /**
   * The name and password for the station, read from its folder: what is shown and set
   * while the station is switched off and there is no station to ask.
   */
  let stationAccountAtRest: StationAccount | null = null;
  /** A paired device asked for the sign-in password to be reset, and the user has not answered yet. */
  let resetAsked: { device: string; at: string } | null = null;
  let lastBootstrapStatus: BootstrapStatusView | undefined;

  /** The account as it stands now: the open station's own, or the one read from its folder. */
  function stationAccount(): StationAccount | null {
    return deps.reach()?.station?.account ?? stationAccountAtRest;
  }

  /** Reads the account from disk again, after something may have changed it. */
  async function rereadStationAccount(): Promise<void> {
    stationAccountAtRest ??= new StationAccount({ dir: stationDir() });
    await stationAccountAtRest.load().catch(() => undefined);
  }

  function noteResetAsked(device: { name: string; pairedAt: string }): string {
    // A device names itself: one line, no quote marks of its own, and not long.
    const name =
      excerpt(device.name)
        .replace(/\s+/g, " ")
        .replace(/["\u201c\u201d]/g, "'")
        .slice(0, 40) || "A paired device";
    // Two devices may carry the same name: when it was paired tells them apart in
    // the list in Settings, where the one to remove is chosen.
    const paired = new Date(device.pairedAt);
    const since = Number.isNaN(paired.getTime())
      ? ""
      : `, paired ${paired.toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
    resetAsked = { device: `${name}${since}`, at: new Date().toISOString() };
    return `"${name}"${since ? ` (${since.slice(2)})` : ""} asked for the sign-in password for your devices to be reset. Nothing has been changed. If that was you, set a new one in Settings under Your other devices. If it was not, remove that device there.`;
  }

  function describeBraveUse(): string {
    const { used, limit } = deps.searchBudget()?.status() ?? { used: 0, limit: 0 };
    if (limit === 0) return `Brave Search, ${used} searches this month`;
    return used >= limit
      ? `Brave Search, but this month's ${limit} searches are used up, so she is on open sources until next month`
      : `Brave Search, ${used} of ${limit} searches used this month`;
  }

  /** Finds out whether a firewall service is running. Asks the service manager; changes nothing. */
  async function detectFirewall(): Promise<void> {
    if (process.platform === "win32") {
      try {
        const { stdout } = await runFile(
          "netsh",
          ["advfirewall", "show", "privateprofile", "state"],
          { timeout: 4000 },
        );
        firewall = /\bON\b/i.test(stdout) ? "windows-defender" : null;
      } catch {
        firewall = "windows-defender";
      }
      return;
    }
    for (const name of ["ufw", "firewalld"]) {
      try {
        const { stdout } = await runFile("systemctl", ["is-active", name], { timeout: 4000 });
        if (stdout.trim() === "active") {
          firewall = name;
          return;
        }
      } catch {
        // "inactive" and "not installed" both end up here
      }
    }
    firewall = null;
  }

  function settingsView(): SettingsView {
    const { voice } = config.value;
    const reach = deps.reach();
    const designedVoices = deps.designedVoices();
    const fullVoiceReady = deps.fullVoiceReady();
    return {
      brain: config.value.brain,
      brains: [
        BRAIN_MODELS.small,
        BRAIN_MODELS.standard,
        BRAIN_MODELS.large,
        { ...MOE_WORKSTATION_MODELS.largeMoe, id: "qwen3.5-35b-a3b-moe" },
        BRAIN_MODELS.xl,
      ].map((model) => ({
        id: model.id,
        label: `${model.label}, about ${model.vramGb} GB of graphics memory`,
      })),
      language: config.value.language,
      languages: LANGUAGE_CODES.map((code) => ({ code, label: LANGUAGES[code].label })),
      voiceEngine: voice.engine === "light" || !fullVoiceReady ? "light" : "full",
      voiceDesign: voice.design,
      voices: designedVoices,
      designedVoicesReady: fullVoiceReady,
      speed: voice.speed,
      speak: voice.speak,
      alwaysListening: voice.alwaysListening,
      needsName: voice.needsName,
      otherNames: voice.otherNames,
      lookWithoutAsking: config.value.sight.withoutAsking,
      handsOff: config.value.handsOff,
      keepConversations: config.value.keepConversations,
      pastExchanges: deps.archive()?.count ?? 0,
      notes: deps.memoryStore()?.all().length ?? 0,
      doNotDisturb: config.value.doNotDisturb,
      morningBriefing: config.value.morningBriefing,
      startAtLogin,
      idleUnloadMinutes: config.value.idleUnloadMinutes,
      thinkingTokens: config.value.thinkingTokens,
      yieldToGames: config.value.yieldToGames,
      quietInGames: config.value.quietInGames,
      leanMemory: config.value.leanMemory,
      fittingTools: config.value.fittingTools,
      keepTraces: config.value.keepTraces,
      searxngUrl: config.value.search.searxngUrl ?? "",
      // The key itself is never sent to a page.
      hasBraveKey: Boolean(config.value.search.braveApiKey),
      braveUsed: deps.searchBudget()?.status().used ?? 0,
      braveMonthlyLimit: config.value.search.braveMonthlyLimit,
      daysTogether: daysAboard(config.value.firstMetAt, new Date()),
      watch: config.value.sight.watch,
      watchSkip: config.value.sight.watchSkip,
      hearPc: config.value.hearing.pcAudio,
      readNotices: config.value.notices.read,
      noticesSkip: config.value.notices.skip,
      // Where a feed is, is never sent to a page: its address is what keeps it private.
      calendars: config.value.agenda.calendars.map(({ name, source }) => ({
        name,
        where: describeSource(source),
      })),
      headsUpMinutes: config.value.agenda.headsUpMinutes,
      workInPrograms: config.value.hands.inPrograms,
      hands: handsAbilities,
      station: (() => {
        const board = deps.board?.() ?? null;
        const pinned = board?.pinned() ?? null;
        const openMissions = (board?.list() ?? [])
          .filter((mission) => mission.state !== "cancelled")
          .map((mission) => ({
            id: mission.id,
            title: mission.title,
            state: mission.state,
            pinned: mission.pinnedToDevices === true,
          }));
        return {
          on: config.value.devices.station,
          port: config.value.devices.stationPort,
          addresses: reach?.station?.addresses() ?? [],
          fingerprint: reach?.station?.fingerprint() ?? null,
          firewall,
          platform: process.platform,
          devices: (reach?.station?.devices() ?? []).map(({ id, name, pairedAt, lastSeenAt }) => ({
            id,
            name,
            pairedAt,
            lastSeenAt,
          })),
          pinnedMission: pinned
            ? {
                id: pinned.id,
                title: pinned.title,
                state: pinned.state,
                done: pinned.steps.filter((s) => s.state === "done").length,
                total: pinned.steps.length,
              }
            : null,
          openMissions,
        };
      })(),
      // Whether a name and password are set, and the name. Nothing made from the password.
      stationAccount: {
        set: stationAccount()?.exists ?? false,
        username: stationAccount()?.username ?? null,
        changedAt: stationAccount()?.changedAt ?? null,
        resetAsked,
      },
      phoneLink,
      pingPhone: config.value.devices.pingPhone,
      machines: config.value.fleet.machines.map((machine) => ({ ...machine })),
      mcpServers: buildMcpServerViews(config.value.mcp.servers, deps.mcpHub?.() ?? null),
      canAskPassword,
      onboardingComplete: config.value.onboardingComplete,
      advancedSettings: config.value.advancedSettings,
      windowMode: config.value.windowMode,
      lowPowerStage: config.value.lowPowerStage,
      hotkeys: { ...config.value.hotkeys },
      safeModeNotice: deps.safeModeStatus?.() ?? {
        active: false,
        consecutiveCrashes: 0,
        reason: null,
      },
      updatePolicy: {
        standaloneChecksEnabled: shouldCheckGithubUpdates(),
        channel: detectDistributionChannel(),
      },
      desktopSessionNotice: deps.desktopSessionNotice?.() ?? null,
      ...(lastBootstrapStatus ? { bootstrapStatus: lastBootstrapStatus } : {}),
      tier10: { ...config.value.tier10 },
    };
  }

  async function probeHardwareView(force: boolean): Promise<HardwareRecommendationView> {
    const GIB = 1024 ** 3;
    const { profile, recommendation } = await benchmarkFirstLaunchHardware(
      join(dataDir(), "hardware-profile.json"),
      { force },
    );
    return {
      gpuName: profile.gpuName,
      totalVramGb: Number((profile.totalVramBytes / GIB).toFixed(1)),
      freeVramGb: Number((profile.freeVramBytes / GIB).toFixed(1)),
      systemRamGb: Number((profile.systemRamBytes / GIB).toFixed(1)),
      cpuThreads: profile.cpuThreads,
      memoryBandwidthGbps: profile.memoryBandwidthGbps ?? null,
      recommendedTier: recommendation.tier,
      quantization: recommendation.quantization,
      contextSize: recommendation.contextSize,
      leanMemory: recommendation.leanMemory,
      reason: recommendation.reason,
    };
  }

  /** Switches her standing watch on the screen on or off, and remembers the choice. */
  async function setWatching(on: boolean): Promise<void> {
    try {
      await deps.reach()?.setWatching(on);
      await config.update({ sight: { ...config.value.sight, watch: on } });
    } catch (error) {
      await config.update({ sight: { ...config.value.sight, watch: false } });
      throw error;
    } finally {
      deps.rebuildTrayMenu();
    }
  }

  async function setHearingPc(on: boolean): Promise<void> {
    deps.reach()?.setHearing(on);
    await config.update({ hearing: { pcAudio: on } });
    deps.rebuildTrayMenu();
  }

  /**
   * Starts or stops her reading of the desktop's notifications, and remembers the choice.
   * Switching it off lets go of every notification she was holding.
   */
  async function setReadingNotices(on: boolean): Promise<void> {
    const noticeWatch = deps.noticeWatch();
    if (on) noticeWatch?.start();
    else noticeWatch?.stop();
    await config.update({ notices: { ...config.value.notices, read: on } });
  }

  /** Opens or closes the station for other devices, and remembers the choice. */
  async function setStationOpen(on: boolean): Promise<void> {
    try {
      await deps.reach()?.setStation(on);
      // Switched off, the account is read from its file: read now what the station left there.
      await rereadStationAccount();
      await config.update({ devices: { ...config.value.devices, station: on } });
    } catch (error) {
      await config.update({ devices: { ...config.value.devices, station: false } });
      throw error;
    } finally {
      deps.rebuildTrayMenu();
    }
  }

  /** Applies a change from the settings panel the same way the tray menu would. */
  async function applySettings(patch: SettingsPatch): Promise<void> {
    if (patch.searxngUrl !== undefined && patch.searxngUrl !== "") {
      let address: URL;
      try {
        address = new URL(patch.searxngUrl);
      } catch {
        throw new Error("That is not a web address. It should look like http://localhost:8888");
      }
      if (!/^https?:$/.test(address.protocol) || address.username || address.password) {
        throw new Error("The address must start with http:// or https:// and hold no password.");
      }
    }

    const leanWas = config.value.leanMemory;
    // Plain values first, in one write.
    const voice = { ...config.value.voice };
    if (patch.speed !== undefined) voice.speed = patch.speed;
    if (patch.speak !== undefined) voice.speak = patch.speak;
    if (patch.alwaysListening !== undefined) voice.alwaysListening = patch.alwaysListening;
    if (patch.needsName !== undefined) voice.needsName = patch.needsName;
    if (patch.otherNames !== undefined) {
      voice.otherNames = patch.otherNames
        .map((name) => name.trim())
        .filter((name) => name.length >= 2);
    }
    await config.update({
      voice,
      ...(patch.lookWithoutAsking !== undefined || patch.watchSkip !== undefined
        ? {
            sight: {
              ...config.value.sight,
              ...(patch.lookWithoutAsking !== undefined
                ? { withoutAsking: patch.lookWithoutAsking }
                : {}),
              ...(patch.watchSkip !== undefined
                ? {
                    watchSkip: patch.watchSkip
                      .map((name) => name.trim())
                      .filter((name) => name.length >= 2),
                  }
                : {}),
            },
          }
        : {}),
      ...(patch.pingPhone !== undefined
        ? { devices: { ...config.value.devices, pingPhone: patch.pingPhone } }
        : {}),
      ...(patch.headsUpMinutes !== undefined
        ? { agenda: { ...config.value.agenda, headsUpMinutes: patch.headsUpMinutes } }
        : {}),
      ...(patch.noticesSkip !== undefined
        ? {
            notices: {
              ...config.value.notices,
              skip: patch.noticesSkip.map((name) => name.trim()).filter((name) => name.length >= 2),
            },
          }
        : {}),
      ...(patch.workInPrograms !== undefined
        ? { hands: { inPrograms: patch.workInPrograms } }
        : {}),
      ...(patch.keepConversations !== undefined
        ? { keepConversations: patch.keepConversations }
        : {}),
      ...(patch.doNotDisturb !== undefined ? { doNotDisturb: patch.doNotDisturb } : {}),
      ...(patch.morningBriefing !== undefined ? { morningBriefing: patch.morningBriefing } : {}),
      ...(patch.thinkingTokens !== undefined ? { thinkingTokens: patch.thinkingTokens } : {}),
      ...(patch.idleUnloadMinutes !== undefined
        ? { idleUnloadMinutes: patch.idleUnloadMinutes }
        : {}),
      ...(patch.yieldToGames !== undefined ? { yieldToGames: patch.yieldToGames } : {}),
      ...(patch.quietInGames !== undefined ? { quietInGames: patch.quietInGames } : {}),
      ...(patch.leanMemory !== undefined ? { leanMemory: patch.leanMemory } : {}),
      ...(patch.fittingTools !== undefined ? { fittingTools: patch.fittingTools } : {}),
      ...(patch.keepTraces !== undefined ? { keepTraces: patch.keepTraces } : {}),
      ...(patch.onboardingComplete !== undefined
        ? { onboardingComplete: patch.onboardingComplete }
        : {}),
      ...(patch.advancedSettings !== undefined
        ? { advancedSettings: patch.advancedSettings }
        : {}),
      ...(patch.windowMode !== undefined ? { windowMode: patch.windowMode } : {}),
      ...(patch.lowPowerStage !== undefined ? { lowPowerStage: patch.lowPowerStage } : {}),
      ...(patch.hotkeys !== undefined
        ? {
            hotkeys: {
              pushToTalk: (patch.hotkeys.pushToTalk ?? config.value.hotkeys.pushToTalk).trim().slice(0, 40),
              summonHide: (patch.hotkeys.summonHide ?? config.value.hotkeys.summonHide).trim().slice(0, 40),
              clickThrough: (patch.hotkeys.clickThrough ?? config.value.hotkeys.clickThrough).trim().slice(0, 40),
            },
          }
        : {}),
      ...(patch.tier10 !== undefined
        ? { tier10: { ...config.value.tier10, ...patch.tier10 } }
        : {}),
      ...(patch.searxngUrl !== undefined ||
      patch.braveApiKey !== undefined ||
      patch.braveMonthlyLimit !== undefined
        ? {
            search: {
              ...config.value.search,
              ...(patch.braveMonthlyLimit !== undefined
                ? { braveMonthlyLimit: patch.braveMonthlyLimit }
                : {}),
              searxngUrl:
                patch.searxngUrl !== undefined
                  ? patch.searxngUrl || null
                  : config.value.search.searxngUrl,
              braveApiKey:
                patch.braveApiKey !== undefined
                  ? patch.braveApiKey || null
                  : config.value.search.braveApiKey,
            },
          }
        : {}),
    });

    const engine = deps.engine();
    const initiative = deps.initiative();
    // Then the ones that have something to do besides being written down.
    if (patch.doNotDisturb === false) initiative?.release();
    // Told to stop keeping quiet in the middle of a game: what was held comes out now.
    if (patch.quietInGames === false) {
      initiative?.release("While you were keeping quiet for the game");
    }
    if (patch.idleUnloadMinutes !== undefined)
      engine?.setIdleUnload(patch.idleUnloadMinutes * 60_000);
    if (patch.yieldToGames !== undefined) {
      engine?.setGameWatch(patch.yieldToGames ? gameOnCard : undefined);
    }
    if (patch.leanMemory !== undefined && patch.leanMemory !== leanWas) {
      deps.chooseLean(patch.leanMemory);
    }
    if (patch.alwaysListening !== undefined) deps.sendToWindow("ui:listen", patch.alwaysListening);
    if (patch.speed !== undefined) await deps.createVoice();
    if (patch.handsOff !== undefined) await deps.setHandsOff(patch.handsOff);
    // Each of these can fail by itself (no helper, a port in use). One failing must not
    // keep the others, or the settings further down, from being applied; the first
    // failure is reported once everything else is done.
    let failure: unknown = null;
    const attempt = async (change: () => Promise<void>): Promise<void> => {
      try {
        await change();
      } catch (error) {
        failure ??= error;
      }
    };
    if (patch.watch !== undefined) await attempt(() => setWatching(patch.watch === true));
    if (patch.hearPc !== undefined) await attempt(() => setHearingPc(patch.hearPc === true));
    if (patch.readNotices !== undefined) {
      await attempt(() => setReadingNotices(patch.readNotices === true));
    }
    if (patch.station !== undefined) await attempt(() => setStationOpen(patch.station === true));
    if (patch.startAtLogin !== undefined) {
      await setStartAtLogin(patch.startAtLogin);
      startAtLogin = patch.startAtLogin;
    }
    if (patch.brain !== undefined && patch.brain !== config.value.brain) {
      deps.chooseBrain(patch.brain);
    }
    if (patch.windowMode !== undefined || patch.lowPowerStage !== undefined) {
      deps.applyStageOptions?.();
    }
    if (patch.hotkeys !== undefined) {
      const hotkeyResult = deps.applyHotkeys?.();
      if (hotkeyResult && hotkeyResult.failed.length > 0) {
        failure ??= new Error(
          `Could not register shortcut: ${hotkeyResult.failed.join(", ")}. Another app may already be using it.`,
        );
      }
    }
    if (patch.language !== undefined && patch.language !== config.value.language) {
      deps.chooseLanguage(patch.language);
    }
    if (patch.voice !== undefined) {
      const designedVoices = deps.designedVoices();
      const design =
        patch.voice.engine === "full" && designedVoices.includes(patch.voice.design)
          ? patch.voice.design
          : config.value.voice.design;
      deps.chooseVoice(patch.voice.engine, design);
    }
    deps.rebuildTrayMenu();
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  }

  function openSettings(): void {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 760,
      height: 800,
      minWidth: 380,
      minHeight: 420,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#59c8f5",
      title: "Astra Navi Desktop settings",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/settings.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: !app.isPackaged,
      },
    });
    settingsWindow = window;
    window.removeMenu();
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (settingsWindow === window) settingsWindow = null;
    });
    // The page is the app's own and goes nowhere else.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    void window.loadURL(`${deps.appOrigin}/settings.html`);
  }

  /**
   * Settings may only be read or changed by the settings window. Her own window shows
   * text a model wrote; it must never be able to reach these.
   */
  function fromSettingsWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    return (
      settingsWindow !== null &&
      !settingsWindow.isDestroyed() &&
      event.sender === settingsWindow.webContents
    );
  }

  function sendDownloadProgress(status: ModelDownloadStatusView): void {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("settings:download-progress", status);
    }
  }

  async function exportSupportBundleNow(): Promise<SupportBundleResultView> {
    const [selfRes, hwRes, bootRes] = await Promise.allSettled([
      deps.runSelfCheck ? deps.runSelfCheck() : Promise.resolve(null),
      probeHardwareView(false),
      checkBootstrapStatus(),
    ]);

    const extraSecrets: string[] = [
      config.value.search.braveApiKey,
      config.value.search.searxngUrl,
      stationAccount()?.username,
      ...config.value.fleet.machines.flatMap((m) => [m.name, m.host, m.user]),
      ...config.value.mcp.servers.flatMap((s) => [
        ...Object.values(s.headers ?? {}),
        ...Object.values(s.env ?? {}),
      ]),
    ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);

    const enabledTier10Flags = Object.entries(config.value.tier10)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);

    const bundle = buildRedactedSupportBundle({
      appVersion: app.getVersion(),
      edition: resolveEdition(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      desktopSessionNotice: deps.desktopSessionNotice?.() ?? null,
      selfCheck: selfRes.status === "fulfilled" ? selfRes.value : null,
      hardware: hwRes.status === "fulfilled" ? hwRes.value : null,
      bootstrapStatus: bootRes.status === "fulfilled" ? bootRes.value : null,
      recentErrors: deps.recentErrors?.() ?? [],
      settingsSummary: {
        brain: config.value.brain,
        language: config.value.language,
        voiceEngine: config.value.voice.engine,
        speak: config.value.voice.speak,
        handsOff: config.value.handsOff,
        lookWithoutAsking: config.value.sight.withoutAsking,
        yieldToGames: config.value.yieldToGames,
        quietInGames: config.value.quietInGames,
        fittingTools: config.value.fittingTools,
        keepTraces: config.value.keepTraces,
        advancedSettings: config.value.advancedSettings,
        stationOpen: config.value.devices.station,
        enabledTier10Flags,
      },
      extraSecretLiterals: extraSecrets,
    });

    const json = formatSupportBundleJson(bundle);
    const dir = join(dataDir(), "support-bundles");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(dir, `astra-navi-support-${stamp}.json`);
    await writeFile(filePath, json, { encoding: "utf8", mode: 0o600 });
    try {
      shell.showItemInFolder(filePath);
    } catch {
      // Headless / sandboxed environments may lack a file manager portal.
    }
    return {
      path: filePath,
      bytes: Buffer.byteLength(json, "utf8"),
      redactions: bundle.redactionsApplied,
    };
  }

  function registerSettingsIpc(): void {
    ipcMain.handle("settings:load", async (event): Promise<SettingsView> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      lastBootstrapStatus = await checkBootstrapStatus().catch(() => lastBootstrapStatus);
      return settingsView();
    });
    ipcMain.handle("settings:save", async (event, patch: unknown): Promise<SettingsView> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      const parsed = SettingsPatchSchema.safeParse(patch);
      if (!parsed.success) throw new Error("That setting could not be understood.");
      await applySettings(parsed.data);
      return settingsView();
    });
    ipcMain.handle("settings:forget-conversations", async (event): Promise<SettingsView> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      await deps.forgetConversations();
      return settingsView();
    });
    ipcMain.handle("settings:traces", (event): ShownTrace[] => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      return forShow(deps.traces.list());
    });
    ipcMain.handle(
      "settings:pair-device",
      (
        event,
      ): { code: string; expiresAt: number; pairingUri: string; qrMatrix: QrMatrix } => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        const station = deps.reach()?.station;
        if (!station?.running) throw new Error("Switch the station on first.");
        const pairing = station.beginPairing();
        const address =
          station.addresses()[0] ?? `https://127.0.0.1:${config.value.devices.stationPort}`;
        const fingerprint = station.fingerprint() ?? "";
        const pairingUri = buildPairingUri({
          address,
          fingerprint,
          code: pairing.code,
        });
        return {
          ...pairing,
          pairingUri,
          qrMatrix: encodeQrMatrix(pairingUri),
        };
      },
    );
    ipcMain.handle(
      "settings:pin-mission",
      async (event, id: unknown): Promise<SettingsView> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        const board = deps.board?.();
        if (!board) return settingsView();
        if (id === null) {
          await board.unpinFromDevices();
        } else if (typeof id === "string" && /^m-[a-f0-9]{6}$/.test(id.trim())) {
          await board.pinToDevices(id.trim());
        } else {
          throw new Error("Give a valid mission id to pin.");
        }
        return settingsView();
      },
    );
    ipcMain.handle("settings:forget-device", async (event, id: unknown): Promise<SettingsView> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      if (typeof id === "string") await deps.reach()?.station?.forget(id.slice(0, 80));
      return settingsView();
    });
    ipcMain.handle(
      "settings:set-station-account",
      async (
        event,
        given: unknown,
      ): Promise<{ ok: true; view: SettingsView } | { ok: false; why: string }> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        const parsed = StationAccountSchema.safeParse(given);
        if (!parsed.success) return { ok: false, why: "That name or password is too long." };
        const username = parsed.data.username.trim();
        const { password } = parsed.data;
        const problem = whyNotThese(username, password);
        if (problem) return { ok: false, why: problem };
        try {
          // Through the open station when there is one, so that everyone is signed out
          // there and then; otherwise straight into its folder, which it reads on opening.
          const station = deps.reach()?.station;
          if (station) await station.setAccount(username, password);
          else {
            await rereadStationAccount();
            await stationAccountAtRest?.set(username, password);
          }
          await rereadStationAccount();
        } catch (error) {
          // Never the password: only what the account itself said was wrong, or that it failed.
          const why = error instanceof Error ? error.message : "";
          return {
            ok: false,
            why: why && !why.includes(password) ? why : "The name and password could not be saved.",
          };
        }
        resetAsked = null;
        return { ok: true, view: settingsView() };
      },
    );
    ipcMain.handle("settings:dismiss-reset", (event): SettingsView => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      resetAsked = null;
      return settingsView();
    });
    ipcMain.on("settings:open", (event, page: unknown) => {
      if (!fromSettingsWindow(event)) return;
      const show =
        page === "learned"
          ? deps.showLearned
          : page === "actions"
            ? deps.showActions
            : page === "self-check"
              ? deps.showSelfCheck
              : null;
      void show?.().catch((error: unknown) => console.error(error));
    });
    ipcMain.handle(
      "settings:hardware-profile",
      async (event, force?: unknown): Promise<HardwareRecommendationView> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        return probeHardwareView(force === true);
      },
    );
    ipcMain.handle(
      "settings:preview-voice",
      async (event, name: unknown): Promise<string | null> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        if (typeof name !== "string" || !/^[a-z0-9_-]{1,40}$/.test(name)) return null;
        try {
          const wav = await readFile(
            join(resolveBundledRoot(app.getAppPath()), "assets", "voice", `${name}.wav`),
          );
          return `data:audio/wav;base64,${wav.toString("base64")}`;
        } catch {
          return null;
        }
      },
    );
    ipcMain.handle(
      "settings:download-brain",
      async (event, tier: unknown): Promise<SettingsView> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        if (
          typeof tier !== "string" ||
          (tier !== "auto" && !Object.hasOwn(BRAIN_MODELS, tier) && findCatalogEntry(tier) === null)
        ) {
          throw new Error("Choose a valid brain tier.");
        }
        deps.chooseBrain(tier);
        await config.update({ brain: tier });
        void deps
          .engine()
          ?.startBackgroundDownload(tier)
          .then(sendDownloadProgress)
          .catch(() => undefined);
        return settingsView();
      },
    );
    ipcMain.handle(
      "settings:disk-space",
      async (event, tier: unknown): Promise<DiskSpaceCheckView> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        const chosenTier = typeof tier === "string" ? tier : config.value.brain;
        const engine = deps.engine();
        if (!engine) {
          return {
            availableBytes: 0,
            requiredBytes: 0,
            enough: true,
            label: chosenTier,
            alreadyDownloaded: false,
          };
        }
        return engine.checkDiskSpaceFor(chosenTier);
      },
    );
    ipcMain.handle("settings:download-status", (event): ModelDownloadStatusView => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      return (
        deps.engine()?.downloadState() ?? {
          state: "idle",
          tier: config.value.brain,
          label: config.value.brain,
          received: 0,
          total: 0,
          bytesPerSec: 0,
          etaSeconds: null,
          freeDiskBytes: null,
          requiredBytes: 0,
          error: null,
        }
      );
    });
    ipcMain.handle("settings:download-pause", (event): ModelDownloadStatusView => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      const st = deps.engine()?.pauseDownload() ?? {
        state: "idle",
        tier: config.value.brain,
        label: config.value.brain,
        received: 0,
        total: 0,
        bytesPerSec: 0,
        etaSeconds: null,
        freeDiskBytes: null,
        requiredBytes: 0,
        error: null,
      };
      sendDownloadProgress(st);
      return st;
    });
    ipcMain.handle("settings:download-resume", async (event): Promise<ModelDownloadStatusView> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      const engine = deps.engine();
      if (!engine) {
        return {
          state: "idle",
          tier: config.value.brain,
          label: config.value.brain,
          received: 0,
          total: 0,
          bytesPerSec: 0,
          etaSeconds: null,
          freeDiskBytes: null,
          requiredBytes: 0,
          error: null,
        };
      }
      const st = await engine.resumeDownload();
      sendDownloadProgress(st);
      return st;
    });
    ipcMain.on("settings:preview-avatar", (event) => {
      if (!fromSettingsWindow(event)) return;
      deps.showAvatarWindow?.();
    });
    ipcMain.on("settings:import-model", (event) => {
      if (!fromSettingsWindow(event)) return;
      void deps.importModel?.();
    });
    ipcMain.handle(
      "settings:run-bootstrap",
      async (
        event,
        task: unknown,
      ): Promise<{ ok: boolean; summary: string[]; status: BootstrapStatusView }> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        const allowed: readonly BootstrapTask[] = ["voice", "ocr", "launcher", "browser-bridge", "all"];
        if (typeof task !== "string" || !allowed.includes(task as BootstrapTask)) {
          throw new Error("Unsupported setup task.");
        }
        const res = await runBootstrapTask(task as BootstrapTask);
        lastBootstrapStatus = await checkBootstrapStatus();
        return { ok: res.ok, summary: res.summary, status: lastBootstrapStatus };
      },
    );
    ipcMain.handle("settings:run-policy-audit", async (event): Promise<PolicyAuditSummaryView> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      let standingOrders: StandingOrder[] = [];
      try {
        const raw = JSON.parse(await readFile(ordersFile(), "utf8")) as {
          orders?: StandingOrder[];
        };
        if (Array.isArray(raw.orders)) standingOrders = raw.orders;
      } catch {
        // empty orders file is valid during initial setup
      }
      const report = auditSecurityRules({ config: config.value, standingOrders });
      return {
        ok: report.ok,
        counts: report.counts,
        findings: report.findings.map((f) => ({
          code: f.code,
          severity: f.severity,
          subject: f.subject,
          message: f.message,
          remediation: f.remediation,
        })),
      };
    });
    ipcMain.handle(
      "settings:export-support-bundle",
      async (event): Promise<SupportBundleResultView> => {
        if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
        return exportSupportBundleNow();
      },
    );
    ipcMain.handle("settings:check-updates", async (event): Promise<UpdateCheckResult> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      return checkGithubReleaseUpdate({ currentVersion: app.getVersion() });
    });
    ipcMain.handle("settings:clear-safe-mode", async (event): Promise<SettingsView> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      await deps.clearSafeMode?.();
      return settingsView();
    });
    ipcMain.handle("settings:export-profile", async (event): Promise<ProfileBackupActionResult> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
      const stamp = new Date().toISOString().slice(0, 10);
      const saveOptions: Electron.SaveDialogOptions = {
        title: "Export Astra Navi Profile Backup",
        defaultPath: `astra-navi-profile-${stamp}.anprof`,
        filters: [{ name: "Astra Navi Profile Backup", extensions: ["anprof"] }],
      };
      const picked = owner
        ? await dialog.showSaveDialog(owner, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (picked.canceled || !picked.filePath) {
        return { ok: false, canceled: true };
      }
      try {
        const summary = await exportProfileBackup(dataDir(), picked.filePath);
        return { ok: true, canceled: false, path: picked.filePath, summary };
      } catch (error) {
        return {
          ok: false,
          canceled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    ipcMain.handle("settings:import-profile", async (event): Promise<ProfileRestoreActionResult> => {
      if (!fromSettingsWindow(event)) throw new Error("Not allowed from here.");
      const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
      const openOptions: Electron.OpenDialogOptions = {
        title: "Restore Astra Navi Profile Backup",
        properties: ["openFile"],
        filters: [{ name: "Astra Navi Profile Backup", extensions: ["anprof"] }],
      };
      const picked = owner
        ? await dialog.showOpenDialog(owner, openOptions)
        : await dialog.showOpenDialog(openOptions);
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const filePath = picked.filePaths[0];
      if (!filePath) return { ok: false, canceled: true };
      try {
        const inspected = await inspectProfileBackup(filePath);
        const confirmOptions: Electron.MessageBoxOptions = {
          type: "question",
          buttons: ["Restore & Restart", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          title: "Restore profile backup?",
          message: `Restore ${inspected.files.length} files from backup dated ${inspected.exportedAt}?`,
          detail:
            "Your current state will first be backed up into pre-restore-backups/, then replaced and Astra Navi Desktop will restart to reload your profile cleanly.",
          noLink: true,
        };
        const { response } = owner
          ? await dialog.showMessageBox(owner, confirmOptions)
          : await dialog.showMessageBox(confirmOptions);
        if (response !== 0) return { ok: false, canceled: true };
        await deps.beforeProfileRestore?.();
        const result = await importProfileBackup(filePath, dataDir());
        setTimeout(() => deps.relaunchAfterRestore?.(), 250);
        return { ok: true, canceled: false, path: filePath, result };
      } catch (error) {
        return {
          ok: false,
          canceled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  return {
    settingsWindow: () => settingsWindow,
    fromSettingsWindow,
    settingsView,
    openSettings,
    registerSettingsIpc,
    exportSupportBundle: exportSupportBundleNow,
    sendDownloadProgress,
    setWatching,
    setHearingPc,
    setStationOpen,
    rereadStationAccount,
    noteResetAsked,
    describeBraveUse,
    detectFirewall,
    startAtLogin: () => startAtLogin,
    noteStartAtLogin: (on) => {
      startAtLogin = on;
    },
    setHandsAbilities: (abilities) => {
      handsAbilities = abilities;
    },
    setPhoneLink: (on) => {
      phoneLink = on;
    },
    setCanAskPassword: (can) => {
      canAskPassword = can;
    },
  };
}
