import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves the root directory holding unpacked bundled resources (`assets/`, `hands/`,
 * `voice-server/`, `browser-bridge/`). In packaged Electron builds (`asar: true`),
 * `app.getAppPath()` points inside `app.asar`, while `extraResources` live under
 * `process.resourcesPath`.
 */
export function resolveBundledRoot(
  fallbackRoot: string,
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
): string {
  if (
    resourcesPath &&
    (existsSync(join(resourcesPath, "hands")) || existsSync(join(resourcesPath, "assets")))
  ) {
    return resourcesPath;
  }
  return fallbackRoot;
}

/**
 * Where the app keeps everything it writes. Kept outside the project folder so the
 * repository never contains user data or the character model.
 * Uses `astra-navi` for new installs while falling back to an existing `ai-chan`
 * folder so prior models, config, and databases keep working seamlessly.
 */
export function dataDir(): string {
  const override = process.env["ASTRA_NAVI_DATA_DIR"] ?? process.env["AI_CHAN_DATA_DIR"];
  if (override) return override;
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  const primary = join(base, "astra-navi");
  const legacy = join(base, "ai-chan");
  if (!existsSync(primary) && existsSync(legacy)) return legacy;
  return primary;
}

export function memoryFile(): string {
  return join(dataDir(), "memory.json");
}

export function configFile(): string {
  return join(dataDir(), "config.json");
}

/** The conversation so far, so it can be picked up again after a restart. */
export function historyFile(): string {
  return join(dataDir(), "conversation.json");
}

/** Turns of conversation she has not yet written up into long-term notes. */
export function journalFile(): string {
  return join(dataDir(), "journal.json");
}

/** Every exchange the two of them have had, one per line. */
export function archiveFile(): string {
  return join(dataDir(), "conversations.jsonl");
}

/** The record of every tool call she makes. */
export function actionsFile(): string {
  return join(dataDir(), "actions.jsonl");
}

/** Her records in one local SQLite database. */
export function storeFile(): string {
  return join(dataDir(), "her.db");
}

/** The record of each reply, one to a line, when the user has asked for it to be kept. */
export function tracesFile(): string {
  return join(dataDir(), "traces.jsonl");
}

/** Auto-exported preference pairs from claims/eval corrections, for training the small brain. */
export function trainingPairsFile(): string {
  return join(dataDir(), "training-pairs.jsonl");
}

/** Distilled SFT examples in ChatML+spans format compatible with `train/lora.py`. */
export function distilledSftFile(): string {
  return join(dataDir(), "training-sft.jsonl");
}

/** A readable copy of that record, written when the user asks to see it. */
export function actionsPageFile(): string {
  return join(dataDir(), "what-she-has-done.md");
}

/** When each kind of task was asked for, from which habits are noticed. */
export function routinesFile(): string {
  return join(dataDir(), "routines.json");
}

/** A readable list of everything she has learned, written when the user asks to see it. */
export function learnedFile(): string {
  return join(dataDir(), "what-she-has-learned.md");
}

/** A private folder for things that exist only for a moment: a screen picture being read, a window-manager script. */
export function scratchDir(): string {
  return join(dataDir(), "scratch");
}

/** Her station for other devices: its certificate and the list of paired devices. */
export function stationDir(): string {
  return join(dataDir(), "station");
}

/** Her keys for the user's other machines, and what she knows of each one's identity. */
export function fleetDir(): string {
  return join(dataDir(), "fleet");
}

/** How many searches she has sent this month to the user's own search engine. */
export function searchCountFile(): string {
  return join(dataDir(), "search-count.json");
}

export function remindersFile(): string {
  return join(dataDir(), "reminders.json");
}

/** Her own agenda entries: what the user asked her to put down. */
export function agendaFile(): string {
  return join(dataDir(), "agenda.json");
}

/** Her standing orders: the checks she runs again and again until something happens. */
export function ordersFile(): string {
  return join(dataDir(), "standing-orders.json");
}

/** Which games were played and when, as far as she saw. */
export function playLogFile(): string {
  return join(dataDir(), "play-log.json");
}

/** The Deck Log lives in her own folder, where the user can read it. */
/** Missions of several steps that outlast a conversation and a restart. */
export function missionsFile(): string {
  return join(dataDir(), "missions.json");
}

export function deckLogFile(): string {
  return join(workspaceDir(), "deck-log.md");
}

/** Downloaded AI models (language, speech). Large; safe to delete, they download again. */
export function modelsDir(): string {
  return (
    process.env["ASTRA_NAVI_MODELS_DIR"] ??
    process.env["AI_CHAN_MODELS_DIR"] ??
    join(dataDir(), "models")
  );
}

/** The Python environment of the full voice, made by `npm run setup -- voice`. */
export function voiceEnvPython(): string {
  return (
    process.env["ASTRA_NAVI_VOICE_PYTHON"] ??
    process.env["AI_CHAN_VOICE_PYTHON"] ??
    join(dataDir(), "voice-env", "bin", "python")
  );
}

/** This install's random secret for the character-model bundle. */
export function modelKeyFile(): string {
  return join(dataDir(), "model.key");
}

export function modelBundleFile(): string {
  const primary = join(dataDir(), "model.astranavi");
  const legacy = join(dataDir(), "model.aichan");
  if (!existsSync(primary) && existsSync(legacy)) return legacy;
  return primary;
}

/** Default folder for documents and other files the assistant creates. */
export function workspaceDir(): string {
  const override = process.env["ASTRA_NAVI_WORKSPACE"] ?? process.env["AI_CHAN_WORKSPACE"];
  if (override) return override;
  const primary = join(homedir(), "Documents", "Astra-Navi");
  const legacy = join(homedir(), "Documents", "AI-chan");
  if (!existsSync(primary) && existsSync(legacy)) return legacy;
  return primary;
}
