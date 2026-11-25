import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { BRAIN_MODELS } from "./models.ts";
import { resolveBundledRoot } from "./paths.ts";
import { resolveNativeWinHandsBinary } from "./platform/windows.ts";
import type { ReachStatus } from "./reach.ts";

/**
 * Her knowledge of herself: which of her own systems are working, how much room she
 * takes up, and what could be cleared out. A ship's AI that cannot report on its own
 * state is not much of one.
 */

export interface StorageItem {
  label: string;
  path: string;
  bytes: number;
  /** For a brain model: whether it is the one she is using. */
  inUse?: boolean;
  /** Not needed for anything she does day to day, and fetched again if ever wanted. */
  spare?: boolean;
}

/** The model that invents new voices from a description. Speaking does not use it. */
const VOICE_DESIGNER = join("voice-hf", "hub", "models--Qwen--Qwen3-TTS-12Hz-1.7B-VoiceDesign");

export function gigabytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} kB`;
}

/** Total size of a file or of everything in a folder. Missing things count as nothing. */
async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // a link's target is counted where it really lives
      total += await sizeOf(join(path, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * What she keeps on disk and how big each part is.
 * @param brainInUse File name of the brain model she is using, or null when unknown.
 */
export async function storageReport(
  dataDir: string,
  modelsDir: string,
  brainInUse: string | null,
): Promise<StorageItem[]> {
  const items: StorageItem[] = [];
  for (const model of Object.values(BRAIN_MODELS)) {
    const path = join(modelsDir, model.fileName);
    const bytes = await sizeOf(path);
    if (bytes > 0) {
      items.push({
        label: `Brain: ${model.label}`,
        path,
        bytes,
        inUse: model.fileName === brainInUse,
      });
    }
  }
  const designer = await sizeOf(join(modelsDir, VOICE_DESIGNER));
  if (designer > 0) {
    items.push({
      label: "Voice designer (only used to invent new voices)",
      path: join(modelsDir, VOICE_DESIGNER),
      bytes: designer,
      spare: true,
    });
  }
  const voices = (await sizeOf(join(modelsDir, "voice-hf"))) - designer;
  if (voices > 0) {
    items.push({
      label: "Designed-voice models",
      path: join(modelsDir, "voice-hf"),
      bytes: voices,
    });
  }
  const primaryModelPath = join(dataDir, "model.astranavi");
  const legacyModelPath = join(dataDir, "model.aichan");
  const packedModelPath =
    (await sizeOf(primaryModelPath)) > 0
      ? primaryModelPath
      : (await sizeOf(legacyModelPath)) > 0
        ? legacyModelPath
        : primaryModelPath;
  const parts: [string, string][] = [
    ["Hearing, sight and note-finding models", join(modelsDir, "speech")],
    ["Designed-voice software", join(dataDir, "voice-env")],
    ["The packed character model", packedModelPath],
    ["Her records database", join(dataDir, "her.db")],
    ["Past conversations", join(dataDir, "conversations.jsonl")],
    ["Her notes", join(dataDir, "memory.json")],
    ["The record of what she did", join(dataDir, "actions.jsonl")],
  ];
  for (const [label, path] of parts) {
    const bytes = await sizeOf(path);
    if (bytes > 0) items.push({ label, path, bytes });
  }
  return items;
}

/**
 * What could be cleared out with nothing lost: brain models that are downloaded but not
 * the one in use, and the voice designer. All of it downloads again if ever wanted.
 */
export function spareStorage(items: readonly StorageItem[]): StorageItem[] {
  // Without knowing which brain is in use, none is safe to call unused.
  const brainKnown = items.some((item) => item.inUse === true);
  return items.filter((item) => item.spare === true || (brainKnown && item.inUse === false));
}

/** Deletes what `spareStorage` lists and returns what was removed. */
export async function removeSpareStorage(items: readonly StorageItem[]): Promise<StorageItem[]> {
  const removed: StorageItem[] = [];
  for (const item of spareStorage(items)) {
    await rm(item.path, { recursive: true, force: true });
    removed.push(item);
  }
  return removed;
}

function has(program: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const probe = platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(probe, [program], { timeout: 3000, windowsHide: true }, (error) => resolve(!error));
  });
}

function hasOnnxOcrModels(modelsRoot: string): boolean {
  return [join(modelsRoot, "ocr"), join(modelsRoot, "speech", "ocr")].some(
    (dir) =>
      existsSync(join(dir, "det.onnx")) &&
      existsSync(join(dir, "rec.onnx")) &&
      existsSync(join(dir, "dict.txt")),
  );
}

/** One line of the report: a system, whether it is all right, and a few words about it. */
export interface CheckLine {
  system: string;
  ok: boolean;
  detail: string;
}

/** How full her working memory is, or why there is none to speak of right now. */
export interface WorkingMemory {
  /**
   * How many tokens the conversation holds and how many it can hold. Null while her
   * brain is put away, when nothing is held in graphics memory at all.
   */
  meter: { held: number; size: number } | null;
  /** The game the graphics card was given back to, when that is why she is put away. */
  gaveCardTo?: string | null;
}

/** From this share on, older parts of a conversation are shortened to make room. */
const GETTING_FULL = 0.7;

/** The "Working memory" line of her self-check, in plain words. */
export function describeWorkingMemory(memory: WorkingMemory): string {
  const { meter } = memory;
  if (meter === null || meter.size <= 0) {
    return memory.gaveCardTo
      ? `Put away: the graphics card was given back to ${memory.gaveCardTo} while it runs. Nothing is held in graphics memory; she wakes when spoken to.`
      : "Put away, so nothing is held in graphics memory right now.";
  }
  const share = meter.held / meter.size;
  const count = (tokens: number): string => Math.round(tokens).toLocaleString("en-US");
  return (
    `Holding ${count(meter.held)} of ${count(meter.size)} tokens (${Math.round(share * 100)}%).` +
    (share >= GETTING_FULL
      ? " Getting full: older parts of the conversation are shortened to make room."
      : "")
  );
}

/** What she does while a game has the graphics card. */
export interface GameMode {
  /** She holds back what she would bring up herself until the game is over. */
  quiet: boolean;
  /** The game running right now, if any. */
  playing: string | null;
  /** How many things are being held back at the moment. */
  held?: number;
}

/** The "Game mode" line of her self-check, in plain words. */
export function describeGameMode(mode: GameMode): string {
  const held = mode.held ?? 0;
  const waiting =
    held > 0 ? ` ${held === 1 ? "One thing is" : `${held} things are`} waiting to be told.` : "";
  if (mode.playing === null) {
    return mode.quiet
      ? `On: she will keep quiet while a game runs. No game is running now.${waiting}`
      : "Off: she speaks up during a game as at any other time. No game is running now.";
  }
  return mode.quiet
    ? `Keeping quiet while ${mode.playing} runs: what she would bring up herself waits until it is over, and reminders are shown as plain notices.${waiting}`
    : `Off: ${mode.playing} is running, and she speaks up as at any other time.`;
}

export interface SelfCheckInputs {
  dataDir: string;
  modelsDir: string;
  brain: { label: string; fileName: string | null; onDisk: boolean; loaded: boolean };
  /** Left out where it cannot be told (her terminal chat has no meter to read). */
  workingMemory?: WorkingMemory;
  /** Left out where no watch for games is kept (her terminal chat). */
  gameMode?: GameMode;
  voice: { label: string; ready: boolean };
  listening: boolean;
  handsOff: boolean;
  notes: { total: number; topics: number; skills: number };
  pastExchanges: number;
  waitingToWriteUp: number;
  actionsRecorded: number;
  searchEngine: string | null;
  /** Memory the app is using right now, in bytes, when it can be measured. */
  memoryInUse: number | null;
  /** Answers true when the open lookup sources can be reached. */
  canReachTheWeb(): Promise<boolean>;
  /** Her reach beyond her own window, when that part of her is running. */
  reach?: ReachStatus | null;
  /** Her reading of the desktop's notifications. Left out where there is none (her terminal chat). */
  notices?: NoticeReading;
  /** Her agenda. Left out where she has none. */
  agenda?: AgendaReading;
  /** Operating system platform (defaults to `process.platform`; overridable in tests). */
  platform?: NodeJS.Platform;
  /** Whether the native `win-hands.exe` helper is available on Windows. */
  hasNativeWinHands?: boolean;
}

/** Where her agenda stands. Only counts and names: never where a calendar is. */
export interface AgendaReading {
  /** How many of the user's calendars she reads. */
  calendars: number;
  /** The calendars that could not be read at the last look, by name; null before any look. */
  unread: readonly string[] | null;
  /** Minutes of warning before something starts; 0 when the heads-up is off. */
  headsUpMinutes: number;
}

/** The self-check line about her agenda, in plain words. */
export function describeAgendaReading(reading: AgendaReading): { ok: boolean; detail: string } {
  const headsUp =
    reading.headsUpMinutes > 0
      ? `She says so ${reading.headsUpMinutes} minutes before something starts.`
      : "The heads-up before something starts is off.";
  if (reading.calendars === 0) {
    return {
      ok: true,
      detail: `Reading none of Captain's calendars (one can be added in Settings); keeping her own list. ${headsUp}`,
    };
  }
  const count = `${reading.calendars} calendar${reading.calendars === 1 ? "" : "s"}`;
  if (reading.unread === null) {
    return {
      ok: true,
      detail: `Reading ${count}; not looked at yet since she started. ${headsUp}`,
    };
  }
  if (reading.unread.length > 0) {
    return {
      ok: false,
      detail: `Reading ${count}, of which ${reading.unread.length} could not be read at the last look: ${reading.unread.join("; ")}. ${headsUp}`,
    };
  }
  return { ok: true, detail: `Reading ${count}, all readable at the last look. ${headsUp}` };
}

/** Where her reading of notifications stands. */
export interface NoticeReading {
  /** The user has switched it on. */
  on: boolean;
  /** How many she holds in memory right now. */
  held: number;
  /** Why she cannot listen for them although it is switched on, or null. */
  trouble: string | null;
}

/** The self-check line about notifications, in plain words. */
export function describeNoticeReading(reading: NoticeReading): { ok: boolean; detail: string } {
  if (!reading.on) return { ok: true, detail: "Not reading desktop notifications." };
  if (reading.trouble) return { ok: false, detail: reading.trouble };
  return {
    ok: true,
    detail: `Reading desktop notifications: ${reading.held} held, in memory only; the list is never saved.`,
  };
}

export interface SelfCheckResult {
  lines: CheckLine[];
  storage: StorageItem[];
  /** Room left on the disk her data is on, when it can be read. */
  freeBytes: number | null;
}

/** Looks over each of her systems and returns the findings. */
export async function selfCheck(inputs: SelfCheckInputs): Promise<SelfCheckResult> {
  const plat = inputs.platform ?? process.platform;
  const isWin = plat === "win32";
  const [spectacle, tesseract, wpctl, busctl, fd, rg, pdftotext, online, storage] =
    await Promise.all([
      isWin ? Promise.resolve(false) : has("spectacle", plat),
      has("tesseract", plat),
      isWin ? Promise.resolve(false) : has("wpctl", plat),
      isWin ? Promise.resolve(false) : has("busctl", plat),
      has("fd", plat),
      has("rg", plat),
      has("pdftotext", plat),
      inputs.canReachTheWeb().catch(() => false),
      storageReport(inputs.dataDir, inputs.modelsDir, inputs.brain.fileName),
    ]);
  const onnxOcr = hasOnnxOcrModels(inputs.modelsDir);
  const winNative =
    isWin &&
    (inputs.hasNativeWinHands ??
      Boolean(resolveNativeWinHandsBinary(join(resolveBundledRoot(process.cwd()), "hands", "win_hands.ps1"))));
  const missingFilesTools = [
    !fd && "fd (find by name)",
    !rg && "rg (find by content)",
    !pdftotext && "pdftotext (read PDFs)",
  ].filter(Boolean);
  const freeBytes = await statfs(inputs.dataDir)
    .then((disk) => disk.bavail * disk.bsize)
    .catch(() => null);
  const lines: CheckLine[] = [
    {
      system: "Brain",
      ok: inputs.brain.onDisk,
      detail: !inputs.brain.onDisk
        ? `${inputs.brain.label} is not downloaded yet; it downloads on the first message.`
        : inputs.brain.loaded
          ? `${inputs.brain.label}, awake and in memory.`
          : `${inputs.brain.label}, asleep (wakes in a few seconds when spoken to).`,
    },
    ...(inputs.workingMemory && inputs.brain.onDisk
      ? [
          {
            system: "Working memory",
            ok: true,
            detail: describeWorkingMemory(inputs.workingMemory),
          },
        ]
      : []),
    ...(inputs.gameMode
      ? [{ system: "Game mode", ok: true, detail: describeGameMode(inputs.gameMode) }]
      : []),
    {
      system: "Voice",
      ok: inputs.voice.ready,
      detail: inputs.voice.ready
        ? inputs.voice.label
        : `${inputs.voice.label} (not set up, so she cannot speak aloud)`,
    },
    {
      system: "Hearing",
      ok: true,
      detail: inputs.listening ? "The microphone is on." : "The microphone is off.",
    },
    isWin
      ? {
          system: "Eyes",
          ok: winNative,
          detail: winNative
            ? `Can take a picture of the screen and describe it (${
                onnxOcr
                  ? "Fast ONNX OCR ready"
                  : tesseract
                    ? "Tesseract OCR ready"
                    : "built-in vision; install Fast ONNX OCR in the Setup Wizard for sharper text reading"
              }).`
            : "Cannot look at the screen: native Windows capture helper (win-hands.exe) is missing.",
        }
      : {
          system: "Eyes",
          ok: spectacle && (tesseract || onnxOcr),
          detail:
            spectacle && (tesseract || onnxOcr)
              ? "Can take a picture of the screen and read it."
              : `Cannot look at the screen: ${[!spectacle && "spectacle", !(tesseract || onnxOcr) && "tesseract"].filter(Boolean).join(" and ")} missing.`,
        },
    isWin
      ? {
          system: "Hands",
          ok: !inputs.handsOff && winNative,
          detail: inputs.handsOff
            ? "Off the controls: she can only talk and look things up."
            : winNative
              ? "Windows, sound, clipboard and lock are within reach."
              : "Windows desktop controls helper (win-hands.exe) is missing.",
        }
      : {
          system: "Hands",
          ok: !inputs.handsOff && wpctl && busctl,
          detail: inputs.handsOff
            ? "Off the controls: she can only talk and look things up."
            : wpctl && busctl
              ? "Windows, sound, clipboard and lock are within reach."
              : `Some desktop controls are missing: ${[!wpctl && "wpctl", !busctl && "busctl"].filter(Boolean).join(", ")}.`,
        },
    {
      system: "Lookups",
      ok: online,
      detail: online
        ? `Online sources answer${inputs.searchEngine ? `, and a search engine is set up (${inputs.searchEngine})` : "; no search engine of your own is set up, so results come from open sources"}.`
        : "The online sources did not answer. She is working from what she knows.",
    },
    isWin
      ? {
          system: "Files",
          ok: true,
          detail:
            fd && rg && pdftotext
              ? "Can find files and read documents."
              : `Can find files by name and content (built-in search; optional tools for faster search/PDFs not installed: ${missingFilesTools.join(", ")}).`,
        }
      : {
          system: "Files",
          ok: fd && rg && pdftotext,
          detail:
            fd && rg && pdftotext
              ? "Can find files and read documents."
              : `Missing: ${missingFilesTools.join(", ")}.`,
        },
    {
      system: "Memory",
      ok: true,
      detail: `${inputs.notes.total} notes (${inputs.notes.topics} topics, ${inputs.notes.skills} tasks), ${inputs.pastExchanges} past exchanges kept, ${inputs.waitingToWriteUp} waiting to be written up.`,
    },
    { system: "Record", ok: true, detail: `${inputs.actionsRecorded} actions on record.` },
  ];
  const { reach } = inputs;
  if (reach) {
    const hands = reach.hands;
    lines.push(
      {
        system: "Hands in other programs",
        ok: hands !== null && (hands.controls || hands.input),
        detail:
          hands === null
            ? isWin
              ? "The Windows desktop helper (win-hands.exe) did not start."
              : "The helper that works other programs did not start (it needs python3)."
            : [
                hands.controls
                  ? "Can read and press programs' controls."
                  : isWin
                    ? hands.controlsProblem || "Using screen reading, pointer, and keyboard controls on Windows."
                    : "Cannot read programs' controls (python-gobject and at-spi2-core are needed).",
                hands.input
                  ? "Can move a pointer and press keys."
                  : isWin
                    ? "Cannot move a pointer or press keys."
                    : "Cannot move a pointer or press keys (no access to /dev/uinput).",
              ].join(" "),
      },
      {
        system: "Watch",
        ok: true,
        detail: reach.watching
          ? `Keeping an eye on the screen${reach.front ? ` (Captain is in ${reach.front})` : ""}. Nothing seen is written to disk.`
          : "Not watching the screen. She looks only when asked.",
      },
      {
        system: "Hearing the PC",
        ok: true,
        detail: reach.hearing
          ? "Keeping the last minute and a half of what the PC played, in memory only."
          : "Not listening to what the PC plays.",
      },
      {
        system: "Other devices",
        ok: true,
        detail: reach.station.running
          ? `The station is open at ${reach.station.addresses.join(", ") || "no address"}, with ${reach.station.devices} paired device${reach.station.devices === 1 ? "" : "s"}.`
          : "The station for other devices is closed.",
      },
    );
  }
  if (inputs.notices) {
    lines.push({ system: "Notifications", ...describeNoticeReading(inputs.notices) });
  }
  if (inputs.agenda) {
    lines.push({ system: "Agenda", ...describeAgendaReading(inputs.agenda) });
  }
  if (inputs.memoryInUse !== null) {
    lines.push({
      system: "Footprint",
      ok: true,
      detail: `Using ${gigabytes(inputs.memoryInUse)} of memory right now.`,
    });
  }
  return { lines, storage, freeBytes };
}

/** The findings as text she can read out or the user can read. */
export function describeSelfCheck(result: SelfCheckResult): string {
  const total = result.storage.reduce((sum, item) => sum + item.bytes, 0);
  const spare = spareStorage(result.storage);
  const spareBytes = spare.reduce((sum, item) => sum + item.bytes, 0);
  return [
    ...result.lines.map((line) => `${line.ok ? "OK" : "PROBLEM"} ${line.system}: ${line.detail}`),
    `Storage: she takes up ${gigabytes(total)} on disk${result.freeBytes === null ? "" : `; ${gigabytes(result.freeBytes)} is free`}.`,
    ...result.storage.map(
      (item) =>
        `  - ${item.label}: ${gigabytes(item.bytes)}${item.inUse === true ? " (in use)" : item.inUse === false ? " (not in use)" : ""}`,
    ),
    spare.length > 0
      ? `Could be freed: ${gigabytes(spareBytes)} by removing what is not in use (${spare
          .map((item) =>
            item.label.replace("Brain: ", "").replace(" (only used to invent new voices)", ""),
          )
          .join(", ")}). All of it downloads again if ever wanted.`
      : "Nothing obvious to clear out.",
  ].join("\n");
}
