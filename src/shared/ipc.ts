import type { VisemeFrame } from "./visemes.ts";

/** Types shared by the main process and the window. No runtime code lives here. */

export const MOODS = [
  "neutral",
  "happy",
  "excited",
  "thinking",
  "surprised",
  "worried",
  "smug",
  "sad",
] as const;
export type Mood = (typeof MOODS)[number];

export type PermissionDecision = "allow" | "allow-session" | "deny";

export interface PermissionRequest {
  id: string;
  /** Plain question shown to the user, e.g. "Run this command?" */
  title: string;
  /** The exact thing that would happen: a command, a file path, a URL. */
  detail: string;
  /** Extra context from the assistant about why, when it gave one. */
  note: string | null;
  /** True when the request touches passwords, keys or similar private data. */
  sensitive: boolean;
  /** Whether "allow for this session" can be offered. */
  canRemember: boolean;
}

export type BrainEvent =
  | { type: "status"; state: "idle" }
  /** `spoken` is true when the message being answered was said aloud. */
  /** `initiated` is true when she is speaking first, about something that happened. */
  /** `away` is true when the message came from one of the user's other devices. */
  /** `correction` is true when she is putting right a reply of her own, not telling of an event. */
  | {
      type: "status";
      state: "thinking";
      spoken: boolean;
      initiated: boolean;
      away?: boolean;
      correction?: boolean;
    }
  /** Getting her language model ready: fetching it the first time, then loading it. */
  | {
      type: "setup";
      stage: "downloading" | "loading" | "ready";
      label: string;
      progress: number | null;
    }
  | { type: "reply-start" }
  | { type: "text"; delta: string }
  | { type: "reply-end" }
  | { type: "mood"; mood: Mood }
  | { type: "activity"; label: string }
  | { type: "permission"; request: PermissionRequest }
  /** `allowed` is how the question really ended, whatever was pressed in the window. */
  | { type: "permission-resolved"; id: string; allowed: boolean }
  /** Something she said does not match what actually happened; shown beneath her reply. */
  | { type: "caution"; message: string }
  | { type: "error"; message: string };

export type VoiceState = "off" | "starting" | "listening" | "hearing" | "transcribing";

export type VoiceEvent =
  | { type: "state"; state: VoiceState }
  /** What the user was understood to have said. */
  /** `from` names the device, for a message sent from one of the user's other devices. */
  /** `noReply` is true for something heard that she will not answer (her name alone). */
  | { type: "heard"; text: string; from?: string; noReply?: boolean }
  /** A sentence of her speech, ready to play, with optional time-aligned visemes. */
  | {
      type: "audio";
      samples: Float32Array;
      sampleRate: number;
      visemes?: VisemeFrame[];
      text?: string;
    }
  /** Stop talking now and drop anything queued. */
  | { type: "stop" }
  | { type: "error"; message: string };

export interface AppState {
  /** URL of the imported model on the private in-app protocol, or null when none is imported. */
  modelUrl: string | null;
  /** The imported model's own name and usage notes, shown under About. */
  modelCredit: { name: string; terms: string } | null;
  /** Shown once on first launch and from the tray's About item. */
  notice: string;
  showNotice: boolean;
  /** Switch the microphone on straight away (the "listen for her name" setting). */
  autoListen: boolean;
  /**
   * The window cannot change its size on this desktop, so it is always the middle size
   * and the conversation log opens over the balloon's place, not beside her.
   */
  fixedSize: boolean;
  /** Desktop window mode (`floating` overlay or `solid-docked` window). */
  windowMode: "floating" | "solid-docked";
  /** Battery-conscious 3D stage mode (reduced FPS and scaled pixel density). */
  lowPowerStage: boolean;
  /** Whether mouse clicks currently pass through the overlay window. */
  clickThrough: boolean;
}

/** What she is taking in or held back from right now. Each is shown as a small badge when true. */
export interface Senses {
  /** She keeps an eye on which window is in front. */
  watching: boolean;
  /** She keeps the last stretch of what the PC played. */
  hearingPc: boolean;
  /** The station for other devices is open, and how many devices are paired with it. */
  station: { open: boolean; paired: number };
  handsOff: boolean;
  doNotDisturb: boolean;
  /** The microphone is on all the time, waiting for her name. */
  waitingForName: boolean;
  /** The names of the user's other machines, for a suggestion in the message box. */
  machines: string[];
}

/** What the page needs to know to draw her as little as possible and in the right state. */
export interface Presence {
  visible: boolean;
  asleep: boolean;
  /** The game her brain was put away for, when that is why she is asleep. */
  asleepFor?: string;
  senses: Senses;
}

/**
 * How much room the window takes: just her; her with a balloon or the message box; or
 * her with the conversation log open beside her.
 */
export type WindowLayout = "compact" | "balloon" | "log";

/** One past exchange as the conversation log shows it. */
export interface PastExchange {
  at: string;
  said: string;
  reply: string;
}

/**
 * The window is as small as it can be around the character, and grows up and to the
 * left (its bottom-right corner stays put) while the balloon or the message box is open.
 */
export const WINDOW_COMPACT = { width: 280, height: 430 } as const;
export const WINDOW_EXPANDED = { width: 440, height: 820 } as const;
/** With the conversation log open: the same height, and a panel's width more to the left. */
export const WINDOW_LOG = { width: 760, height: 820 } as const;

/**
 * The size a layout gets on a screen with this much room: its own size where that fits,
 * and otherwise as much as the screen has, less a margin. Never smaller than she is.
 */
export function fitWindow(
  size: { width: number; height: number },
  room: { width: number; height: number },
  margin = 24,
): { width: number; height: number } {
  return {
    width: Math.max(WINDOW_COMPACT.width, Math.min(size.width, room.width - margin)),
    height: Math.max(WINDOW_COMPACT.height, Math.min(size.height, room.height - margin)),
  };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A window's bottom-right corner: the part of her window that stays put as it grows. */
export interface Corner {
  right: number;
  bottom: number;
}

/**
 * Where a window of this size goes when its bottom-right corner belongs at `corner`:
 * there, unless part of it would then be off the work area, in which case it is moved
 * in just far enough to be whole. (She may stand near the left or top edge; the panel
 * that opens beside her must still be on the screen.) Where the area is smaller than
 * the window, its left and top edges are the ones kept in view.
 */
export function placeByCorner(
  corner: Corner,
  size: { width: number; height: number },
  area: Box,
): Box {
  const x = Math.max(area.x, Math.min(corner.right - size.width, area.x + area.width - size.width));
  const y = Math.max(
    area.y,
    Math.min(corner.bottom - size.height, area.y + area.height - size.height),
  );
  return { x, y, width: size.width, height: size.height };
}

/** The corner a window was moved away from to fit, and where it was put instead. */
export interface HeldCorner {
  corner: Corner;
  placed: Box;
}

/**
 * Resizes a window about its bottom-right corner, keeping it on the work area. When it
 * had to be moved in from an edge, the corner it left is handed back as `held`: pass it
 * in again at the next resize and, as long as nobody moved the window meanwhile, it
 * shrinks back to where the user had put it and not to where it was pushed.
 */
export function resizeAboutCorner(
  bounds: Box,
  size: { width: number; height: number },
  area: Box,
  held: HeldCorner | null,
): { bounds: Box; held: HeldCorner | null } {
  const untouched =
    held !== null &&
    held.placed.x === bounds.x &&
    held.placed.y === bounds.y &&
    held.placed.width === bounds.width &&
    held.placed.height === bounds.height;
  const corner = untouched
    ? held.corner
    : { right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
  const placed = placeByCorner(corner, size, area);
  const moved =
    placed.x + placed.width !== corner.right || placed.y + placed.height !== corner.bottom;
  return { bounds: placed, held: moved ? { corner, placed } : null };
}

export const APP_NOTICE =
  "Astra Navi Desktop is an open-source, local-first AI desktop companion. " +
  "Everything stays on your own hardware: local LLM inference, local voice, local memory, and explicit user approvals.";

/** Alias retained for existing imports across main/station/tests. */
export const UNOFFICIAL_NOTICE = APP_NOTICE;

/** The API the preload script exposes to the window as `window.aichan`. */
export interface AichanBridge {
  ready(): Promise<AppState>;
  send(text: string): void;
  interrupt(): void;
  answerPermission(id: string, decision: PermissionDecision): void;
  setLayout(layout: WindowLayout): void;
  /** The most recent exchanges from earlier sessions, oldest first. Empty when none are kept. */
  history(): Promise<PastExchange[]>;
  /** Puts text on the clipboard: used by the log's copy control. */
  copyText(text: string): void;
  openSettings(): void;
  /** Starts importing a character model, as the tray menu's entry does. */
  importModel(): void;
  /** The full path of a file dropped onto the window, or "" when it has none. */
  pathForFile(file: File): string;
  openLink(url: string): void;
  reportModelError(message: string): void;
  /** Turns the microphone conversation on or off. */
  setListening(on: boolean): void;
  /** Microphone audio: mono, 16 kHz. */
  sendAudio(samples: Float32Array): void;
  /** Tells the app whether her voice is coming out of the speakers right now. */
  setSpeaking(speaking: boolean): void;
  onVoiceEvent(listener: (event: VoiceEvent) => void): void;
  onBrainEvent(listener: (event: BrainEvent) => void): void;
  onAppState(listener: (state: AppState) => void): void;
  onShowNotice(listener: () => void): void;
  onFocusInput(listener: () => void): void;
  /** The app asks for the microphone to be switched on or off (from the tray menu). */
  onListenRequest(listener: (on: boolean) => void): void;
  /** Whether her window can be seen, and whether her brain is put away (she sleeps). */
  onPresence(listener: (presence: Presence) => void): void;
  /** Past conversations were erased on purpose: the log must drop what it shows of them. */
  onForgotten(listener: () => void): void;
  /**
   * Her reply was stopped, and what was waiting behind it will get no answer.
   * `typedTaken` is how many typed messages the app had received from this window by then.
   */
  onDropped(listener: (typedTaken: number) => void): void;
}
