import type { LanguageCode } from "../core/languages.ts";
import type { ShownTrace } from "../core/trace.ts";

export const TIER10_KEYS = [
  "workerMesh",
  "modelCascade",
  "loraSubAgents",
  "predictivePrewarm",
  "semanticBridges",
  "pushEvents",
  "hardwareTelemetry",
  "sessionContinuity",
  "causalDryRun",
  "skillCompiler",
  "microSandbox",
  "episodicCalibration",
  "attentionArbiter",
  "nightlyHygiene",
  "fullDuplexVoice",
  "phonemeVisemes",
  "selfDistillation",
  "signedPlugins",
  "nativeMultimodal",
  "householdIsolation",
  "stationFederation",
] as const;
export type Tier10Key = (typeof TIER10_KEYS)[number];
export type Tier10Settings = Record<Tier10Key, boolean>;

/** Everything the settings panel shows. Secrets are never sent to the page, only whether one is set. */
export interface SettingsView {
  brain: string;
  brains: { id: string; label: string }[];
  language: LanguageCode;
  languages: { code: LanguageCode; label: string }[];
  voiceEngine: "full" | "light";
  voiceDesign: string;
  voices: string[];
  /** The designed voices have been set up on this computer. */
  designedVoicesReady: boolean;
  speed: number;
  speak: "when-spoken-to" | "always" | "never";
  alwaysListening: boolean;
  needsName: boolean;
  otherNames: string[];
  lookWithoutAsking: boolean;
  handsOff: boolean;
  keepConversations: boolean;
  pastExchanges: number;
  notes: number;
  doNotDisturb: boolean;
  morningBriefing: boolean;
  startAtLogin: boolean;
  idleUnloadMinutes: number;
  thinkingTokens: number;
  /** She hands the graphics card back soon after a reply while a game is running. */
  yieldToGames: boolean;
  /** She holds what she would bring up herself until a game is over. */
  quietInGames: boolean;
  /** She holds the conversation in less graphics memory (built-in brains only). */
  leanMemory: boolean;
  /** She is offered only the tools a message looks to need, to hold less in mind. */
  fittingTools: boolean;
  /** The record of each reply is also written to a file in her data folder. */
  keepTraces: boolean;
  searxngUrl: string;
  hasBraveKey: boolean;
  /** Searches sent to Brave this month, and the most she may send (0: no limit). */
  braveUsed: number;
  braveMonthlyLimit: number;
  daysTogether: number;
  /** She keeps an eye on the screen all the time. */
  watch: boolean;
  /** Programs she never reads while watching. */
  watchSkip: string[];
  /** She keeps the last minute and a half of what the PC played. */
  hearPc: boolean;
  /** She may read the desktop's notifications (kept in memory only). */
  readNotices: boolean;
  /** Programs whose notifications she never reads, on top of the built-in list. */
  noticesSkip: string[];
  /** The calendars she reads. Where a feed is, is not sent to the page: only that it is one. */
  calendars: CalendarView[];
  /** Minutes of warning before something on the agenda starts; 0 is off. */
  headsUpMinutes: number;
  /** She may work inside other programs (each one is still asked about first). */
  workInPrograms: boolean;
  /** What she can do inside other programs on this computer. */
  hands: { controls: boolean; input: boolean } | null;
  station: StationView;
  stationAccount: StationAccountView;
  /** KDE Connect is installed, so she can reach a paired phone. */
  phoneLink: boolean;
  pingPhone: boolean;
  machines: MachineView[];
  /** The desktop has a password window she can have SSH ask with. */
  canAskPassword: boolean;
  /** Whether the first-run setup wizard has been completed. */
  onboardingComplete: boolean;
  /** Whether Advanced power-user controls are shown in Settings. */
  advancedSettings: boolean;
  /** Optional local service availability reported by the cross-platform bootstrapper. */
  bootstrapStatus?: BootstrapStatusView;
  /** Default-off Tier 10 experimental capability switches. */
  tier10: Tier10Settings;
}

export interface BootstrapComponentView {
  ready: boolean;
  detail: string;
}

export interface BootstrapStatusView {
  voice: BootstrapComponentView;
  ocr: BootstrapComponentView;
  launcher: BootstrapComponentView;
  browserBridge: BootstrapComponentView;
}

export interface HardwareRecommendationView {
  gpuName: string | null;
  totalVramGb: number;
  freeVramGb: number;
  systemRamGb: number;
  cpuThreads: number;
  memoryBandwidthGbps: number | null;
  recommendedTier: "small" | "standard" | "large" | "xl";
  quantization: string;
  contextSize: number;
  leanMemory: boolean;
  reason: string;
}

export interface PolicyAuditSummaryView {
  ok: boolean;
  counts: { critical: number; warning: number; info: number };
  findings: { code: string; severity: string; subject: string; message: string; remediation: string }[];
}

/** One of the user's calendars, as the panel shows it. */
export interface CalendarView {
  name: string;
  /** A file's path, or for a feed only which site it is on. */
  where: string;
}

/** One of the user's other machines, as the panel shows it. */
export interface MachineView {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  lookWithoutAsking: boolean;
}

/** One kept backup on a remote machine, as the Settings rollback drawer shows it. */
export interface RemoteBackupView {
  id: string;
  path: string;
  at: string;
  bytes: number;
}

/** A machine that answered, waiting for the user to say its fingerprint is the right one. */
export interface MachineFound {
  /** Handed back to add the machine; the page never holds the keys themselves. */
  ticket: string;
  fingerprints: string[];
}

/**
 * The name and password the user's other devices sign in with, as far as a page may
 * know of them: whether they are set, the name, and when they were last changed. Never
 * the password or anything made from it.
 */
export interface StationAccountView {
  set: boolean;
  username: string | null;
  changedAt: string | null;
  /** A paired device asked for the password to be reset, and the user has not yet answered. */
  resetAsked: { device: string; at: string } | null;
}

/** The station for the user's other devices, as the panel shows it. */
export interface StationView {
  on: boolean;
  port: number;
  /** Where another device finds her, for example https://192.168.1.20:47821 */
  addresses: string[];
  /** The certificate's fingerprint, to compare with what the other device shows. */
  fingerprint: string | null;
  devices: { id: string; name: string; pairedAt: string; lastSeenAt: string | null }[];
  /**
   * A firewall running on this PC ("ufw", "firewalld"), or null. With one on, other
   * devices cannot reach her until her port is allowed through it.
   */
  firewall: string | null;
  /** The single mission currently pinned for paired devices, if any. */
  pinnedMission?: { id: string; title: string; state: string; done: number; total: number } | null;
  /** Open missions that may be pinned to paired devices from the PC. */
  openMissions?: { id: string; title: string; state: string; pinned: boolean }[];
}

/** A change from the panel: any subset of what can be changed. */
export interface SettingsPatch {
  brain?: string;
  language?: LanguageCode;
  voice?: { engine: "full" | "light"; design: string };
  speed?: number;
  speak?: "when-spoken-to" | "always" | "never";
  alwaysListening?: boolean;
  needsName?: boolean;
  otherNames?: string[];
  lookWithoutAsking?: boolean;
  handsOff?: boolean;
  keepConversations?: boolean;
  doNotDisturb?: boolean;
  morningBriefing?: boolean;
  startAtLogin?: boolean;
  idleUnloadMinutes?: number;
  thinkingTokens?: number;
  yieldToGames?: boolean;
  quietInGames?: boolean;
  leanMemory?: boolean;
  fittingTools?: boolean;
  keepTraces?: boolean;
  searxngUrl?: string;
  /** A new key, or an empty string to remove the one that is set. */
  braveApiKey?: string;
  braveMonthlyLimit?: number;
  workInPrograms?: boolean;
  watch?: boolean;
  watchSkip?: string[];
  hearPc?: boolean;
  readNotices?: boolean;
  noticesSkip?: string[];
  headsUpMinutes?: number;
  station?: boolean;
  pingPhone?: boolean;
  onboardingComplete?: boolean;
  advancedSettings?: boolean;
  tier10?: Partial<Tier10Settings>;
}

export type SettingsPage = "learned" | "actions" | "self-check";

/** What the settings page may ask the app to do. */
export interface SettingsBridge {
  load(): Promise<SettingsView>;
  save(patch: SettingsPatch): Promise<SettingsView>;
  /** Opens one of her readable pages. */
  open(page: SettingsPage): void;
  /** Asks (with a confirmation) to erase past conversations; resolves with the fresh view. */
  forgetConversations(): Promise<SettingsView>;
  /** The records of her last replies, newest first, worded for showing. */
  traces(): Promise<ShownTrace[]>;
  /** Starts pairing a device: a six-digit code to type on it, good for five minutes. */
  pairDevice(): Promise<{ code: string; expiresAt: number }>;
  /** Pins one mission (or null to unpin) to paired devices from the PC. */
  pinMission(id: string | null): Promise<SettingsView>;
  /** Takes a paired device's access away. */
  forgetDevice(id: string): Promise<SettingsView>;
  /**
   * Sets the name and password the other devices sign in with. Every device is signed
   * out. Resolves with why not, in plain words, when the name or password will not do.
   */
  setStationAccount(
    username: string,
    password: string,
  ): Promise<{ ok: true; view: SettingsView } | { ok: false; why: string }>;
  /** Puts away the note that a device asked for a password reset. */
  dismissReset(): Promise<SettingsView>;
  /** Adds one of the user's calendars for her to read: a file's full path or a feed's address. */
  addCalendar(calendar: {
    name: string;
    source: string;
  }): Promise<{ ok: true; view: SettingsView } | { ok: false; why: string }>;
  /** Takes a calendar off her list. The calendar itself is not touched. */
  removeCalendar(name: string): Promise<SettingsView>;
  /** Looks for a machine and returns its fingerprints for the user to compare. */
  findMachine(machine: {
    name: string;
    host: string;
    port: number;
    user: string;
  }): Promise<MachineFound>;
  /** Adds the machine found, now that the user has confirmed its fingerprint. */
  addMachine(ticket: string): Promise<SettingsView>;
  /** Lets her key in using the machine's password, typed into the desktop's own window. */
  letInMachine(id: string): Promise<{ ok: boolean; why: string }>;
  /** Copies her public key for a machine, for pasting into it by hand. */
  copyMachineKey(id: string): Promise<void>;
  testMachine(id: string): Promise<{ ok: boolean; why: string }>;
  setMachineLook(id: string, on: boolean): Promise<SettingsView>;
  /** Lists kept backups on a machine, newest first. */
  listMachineBackups(id: string): Promise<RemoteBackupView[]>;
  /** Shows what restoring a backup changes, asks confirmation, and puts it back. */
  restoreMachineBackup(
    machineId: string,
    backupId: string,
  ): Promise<{ restored: boolean; keptNew: string | null }>;
  /** Asks (with a confirmation) to forget a machine; resolves with the fresh view. */
  removeMachine(id: string): Promise<SettingsView>;
  /** Probes local GPU/VRAM/RAM and recommends the optimal brain tier & quantization. */
  hardwareProfile(force?: boolean): Promise<HardwareRecommendationView>;
  /** Reads a bundled voice sample wav as a base64 data URI, or null if missing. */
  previewVoice(name: string): Promise<string | null>;
  /** Switches to (and triggers download/load of) a brain tier from the onboarding wizard. */
  downloadBrain(tier: string): Promise<SettingsView>;
  /** Runs a cross-platform optional setup task and returns updated service statuses. */
  runBootstrap(
    task: "voice" | "ocr" | "launcher" | "browser-bridge" | "all",
  ): Promise<{ ok: boolean; summary: string[]; status: BootstrapStatusView }>;
  /** Runs static security policy audit against current config & standing orders. */
  runPolicyAudit(): Promise<PolicyAuditSummaryView>;
}
