import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gameOnCard } from "../src/core/cardWatch.ts";

/**
 * Whether now is a bad moment to load a model onto the graphics card. A run of the
 * suite takes the card for many minutes; if the user is in a game, both would suffer,
 * and the user did not ask for either to.
 *
 * When the card cannot be asked, the answer is "not now": a run that starts blind is
 * the one that lands on top of a game.
 */

const run = promisify(execFile);

/** A card busier than this is somebody's game or render. */
export const BUSY_PERCENT = 40;

export interface CardState {
  /** How busy the card is, in percent, or null when that cannot be read. */
  utilisation: number | null;
  /** The programs holding memory on the card, by path or name. Null when the card did not say. */
  holders: readonly string[] | null;
  /** The command lines of everything running, for games the card does not list. */
  commands: readonly string[];
}

/** Marks of a game among the programs holding the card. */
const GAME_ON_CARD = [
  // Anything from a Steam library, on either kind of path.
  /steamapps[\\/]+common[\\/]/i,
  // A Windows program, which on this kind of machine means a game under Proton or Wine.
  /\.exe$/i,
  /(?:^|[\\/])gamescope(?:-wl)?$/i,
  // How Unreal and Unity name what they ship.
  /-(?:Win64|Linux)-Shipping(?:\.exe)?$/i,
  /\.x86_64$/i,
];

/**
 * A game among all running programs: anything started from a Steam library. Narrower than
 * the list above, since a program that is merely running (a Windows tool under Wine, say)
 * is not using the card.
 */
const STEAM_FOLDER = /steamapps[\\/]+common[\\/]+([^\\/"']+)/gi;
/** Folders in a Steam library that are what games run in, not games. They only run while one does. */
const NOT_THE_GAME = /^(?:SteamLinuxRuntime|Proton|Steamworks)/i;

function lastPart(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The name of a game found among these programs, or null when none looks like one. */
export function gameAmong(
  holders: readonly string[],
  commands: readonly string[] = [],
): string | null {
  for (const holder of holders) {
    const name = holder.trim();
    if (name !== "" && GAME_ON_CARD.some((mark) => mark.test(name))) return lastPart(name);
  }
  const folders = commands.flatMap((command) =>
    [...command.matchAll(STEAM_FOLDER)].map((found) => (found[1] ?? "").trim()),
  );
  if (folders.length === 0) return null;
  return folders.find((folder) => !NOT_THE_GAME.test(folder)) ?? "a Steam game";
}

/** Why a run should not start now, in plain words, or null when the card is free. */
export function whyNotNow(state: CardState): string | null {
  const game = gameAmong(state.holders ?? [], state.commands);
  if (game) {
    return `A game is running (${game}). Not starting, so it keeps the graphics card to itself. Run this again when the game is closed, or use --force to run anyway.`;
  }
  if (state.holders === null || state.utilisation === null) {
    return "The graphics card could not be asked what is running on it (nvidia-smi gave no answer), so there is no telling whether a game has it. Not starting. Use --force to run anyway.";
  }
  if (state.utilisation > BUSY_PERCENT) {
    return `The graphics card is ${Math.round(state.utilisation)}% busy with something else. Not starting, so neither is spoiled. Run this again when it is free, or use --force to run anyway.`;
  }
  return null;
}

/** The programs holding memory on the graphics card, by path or name. Null when the card did not say. */
export async function cardHolders(command = "nvidia-smi"): Promise<string[] | null> {
  try {
    const { stdout } = await run(
      command,
      ["--query-compute-apps=process_name", "--format=csv,noheader"],
      { timeout: 5000 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return null;
  }
}

/**
 * The command line of every running program this user may see. Empty where there is
 * no such folder to read (not Linux).
 */
export async function runningCommands(procDir = "/proc"): Promise<string[]> {
  try {
    const ids = (await readdir(procDir)).filter((name) => /^\d+$/.test(name));
    const lines = await Promise.all(
      ids.map((id) =>
        readFile(join(procDir, id, "cmdline"), "utf8").then(
          (line) => line.replaceAll("\0", " ").trim(),
          () => "", // it ended meanwhile, or is not ours to read
        ),
      ),
    );
    return lines.filter((line) => line !== "");
  } catch {
    return [];
  }
}

/**
 * What is on the card right now, for a look taken while cases run: the name of a game,
 * "unknown" when the card would not say, or null when it is free of games. How busy the
 * card is tells nothing by then, as she is the one keeping it busy.
 */
export async function gameNow(
  look: {
    holders?: () => Promise<string[] | null>;
    commands?: () => Promise<string[]>;
    native?: () => Promise<string | null>;
  } = {},
): Promise<{ game: string } | "unknown" | null> {
  const [holders, commands] = await Promise.all([
    (look.holders ?? cardHolders)(),
    (look.commands ?? runningCommands)(),
  ]);
  const game = gameAmong(holders ?? [], commands);
  if (game) return { game };
  if (holders === null) return "unknown";
  // A native game the card names only by how it was started ("./Civ7_linux_Vulkan") is
  // told by where its program file lives and what its launcher set; the app's own
  // watch knows how. Only for the real card: a look handed in is all there is to go on.
  if (look.holders === undefined) {
    const native = await (look.native ?? gameOnCard)();
    if (native !== null) return { game: native };
  }
  return null;
}
