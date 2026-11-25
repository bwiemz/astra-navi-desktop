import { execFile } from "node:child_process";
import { readFile, readlink, stat } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Knowing when a game has the graphics card.
 *
 * Her language model sits in the same graphics memory a game wants. While she is being
 * talked to that is the price of having her; once she has answered, it is memory held
 * for nothing. So when a game is running she gives it back soon after each reply
 * instead of keeping it for the usual while. This file only answers "is a game on the
 * card?"; `LocalEngine` decides what to do about it.
 */

const run = promisify(execFile);

/** Marks of a game among the programs holding the card across platforms. */
const CROSS_PLATFORM_GAME_MARKS: readonly RegExp[] = [
  // Anything from a Steam library, on either kind of path.
  /steamapps[\\/]+common[\\/]/i,
  /(?:^|[\\/])gamescope(?:-wl)?$/i,
  // How Unreal and Unity name what they ship.
  /-(?:Win64|Linux)-Shipping(?:\.exe)?$/i,
  /\.x86_64$/i,
];

/** On Linux/macOS, an `.exe` holding the GPU means a Windows game running under Proton or Wine. */
const LINUX_EXE_GAME_MARK = /\.exe$/i;

/** Built-in Windows shell/compositor/app processes that hold the GPU and are never games. */
const WINDOWS_SYSTEM_NON_GAMES = new Set([
  "shellhost.exe",
  "shellexperiencehost.exe",
  "startmenuexperiencehost.exe",
  "searchhost.exe",
  "searchapp.exe",
  "textinputhost.exe",
  "lockapp.exe",
  "dwm.exe",
  "explorer.exe",
  "applicationframehost.exe",
  "systemsettings.exe",
  "widgets.exe",
  "widgetservice.exe",
  "screenclippinghost.exe",
  "sihost.exe",
  "csrss.exe",
  "winlogon.exe",
  "runtimebroker.exe",
  "ctfmon.exe",
  "taskhostw.exe",
  "dllhost.exe",
  "conhost.exe",
  "windowsterminal.exe",
  "openconsole.exe",
  "nvcontainer.exe",
  "nvdisplay.container.exe",
  "electron.exe",
  "astra navi desktop.exe",
]);

function lastPart(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** A program holding memory on the graphics card. */
export interface Holder {
  /** Its process id, when the card gave one. */
  pid: number | null;
  /** Its path or name, as the card reports it. */
  name: string;
}

/** The name of a game among the programs holding the card, or null when none looks like one. */
export function gameAmongHolders(
  holders: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const marks =
    platform === "win32"
      ? CROSS_PLATFORM_GAME_MARKS
      : [...CROSS_PLATFORM_GAME_MARKS, LINUX_EXE_GAME_MARK];
  for (const holder of holders) {
    const name = holder.trim();
    if (name === "") continue;
    const file = lastPart(name);
    if (WINDOWS_SYSTEM_NON_GAMES.has(file.toLowerCase())) continue;
    if (marks.some((mark) => mark.test(name))) return file;
  }
  return null;
}

/** The programs holding memory on the graphics card. Null when the card did not say. */
export async function cardHolders(command = "nvidia-smi"): Promise<Holder[] | null> {
  try {
    const { stdout } = await run(
      command,
      ["--query-compute-apps=pid,process_name", "--format=csv,noheader"],
      { timeout: 5000, windowsHide: true },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const comma = line.indexOf(",");
        const pid = Number(line.slice(0, comma).trim());
        return {
          pid: comma > 0 && Number.isInteger(pid) && pid > 0 ? pid : null,
          name: line.slice(comma + 1).trim(),
        };
      });
  } catch {
    return null;
  }
}

/**
 * What a game launcher sets for the games it starts and for nothing else. The card
 * names a native game only by what it was started as ("./Civ7_linux_Vulkan"), which
 * says nothing; these do. The launcher's own window holds the card too and has none.
 */
const LAUNCHED_AS_GAME = /^(?:SteamAppId|SteamGameId|LUTRIS_GAME_UUID|HEROIC_APP_NAME)=./;
const STEAM_GAME_FOLDER = /steamapps[\\/]+common[\\/]+([^\\/]+)/i;

/** How a running program is looked into. Replaced in tests. */
export interface ProcessLook {
  /** The full path of the program file, or null when it cannot be read. */
  exe(pid: number): Promise<string | null>;
  /** The names and values the program was started with, or null when they cannot be read. */
  environment(pid: number): Promise<string[] | null>;
  /**
   * Whether the program belongs to the account she runs as: false for another account's,
   * null when that cannot be told (it ended meanwhile). A program of the user's own whose
   * file cannot be read (one started with special rights, as some game launchers are)
   * is still theirs.
   */
  mine(pid: number): Promise<boolean | null>;
}

const PROC: ProcessLook = {
  mine: (pid) =>
    stat(`/proc/${pid}`).then(
      (info) => info.uid === process.getuid?.(),
      () => null,
    ),
  exe: (pid) => readlink(`/proc/${pid}/exe`).catch(() => null),
  environment: (pid) =>
    readFile(`/proc/${pid}/environ`, "utf8").then(
      (text) => text.split("\0"),
      () => null, // another user's program, or it ended meanwhile
    ),
};

/** Folders in a Steam library that games run in, and are not games. */
const NOT_THE_GAME = /^(?:Proton|SteamLinuxRuntime|Steamworks|Steam Linux Runtime)/i;

/** The game's own folder in a Steam library, from a path that lies inside one. */
function steamGame(path: string | null): string | null {
  const folder = path ? STEAM_GAME_FOLDER.exec(path)?.[1] : undefined;
  return folder && !NOT_THE_GAME.test(folder) ? folder : null;
}

/** The game this program on the card is, or null when it is not one. */
async function gameBehind(
  holder: Holder,
  look: ProcessLook,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (WINDOWS_SYSTEM_NON_GAMES.has(lastPart(holder.name.trim()).toLowerCase())) return null;
  const byName = gameAmongHolders([holder.name], platform);
  if (holder.pid === null) return byName;
  // Another account's program is not this user's game, and what it calls itself is
  // not to be trusted: anyone can name a program "x.exe".
  if ((await look.mine(holder.pid)) === false) return null;
  const exe = await look.exe(holder.pid);
  if (exe && WINDOWS_SYSTEM_NON_GAMES.has(lastPart(exe.trim()).toLowerCase())) return null;
  // A Windows game is named by the card with its own path; the program file behind it
  // is the layer it runs in ("Proton"), which is not its name.
  const folder = steamGame(holder.name) ?? steamGame(exe);
  if (folder) return folder;
  if (byName !== null) return byName;
  if (exe && gameAmongHolders([exe], platform) !== null) return lastPart(exe);
  const started = await look.environment(holder.pid);
  if (started?.some((entry) => LAUNCHED_AS_GAME.test(entry))) {
    return lastPart(exe ?? holder.name);
  }
  return null;
}

/**
 * The name of the game that has the card right now, or null. Null also when the card
 * cannot be asked (no NVIDIA card, no nvidia-smi): then she simply behaves as she always
 * did, which is the safe way for this to fail.
 */
export async function gameOnCard(
  holders: () => Promise<Holder[] | null> = cardHolders,
  look: ProcessLook = PROC,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  for (const holder of (await holders()) ?? []) {
    // Herself, started from a game launcher's shell, is not a game.
    if (holder.pid === process.pid || holder.pid === process.ppid) continue;
    const game = await gameBehind(holder, look, platform);
    if (game !== null) return game;
  }
  return null;
}

/**
 * Current graphics card compute utilisation (0-100), or null when the card will not say.
 * Used to wait for an idle GPU window before running heavy background steps.
 */
export async function gpuUtilization(command = "nvidia-smi"): Promise<number | null> {
  try {
    const { stdout } = await run(
      command,
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
    );
    const numbers = stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return numbers.length > 0 ? Math.max(...numbers) : null;
  } catch {
    return null;
  }
}
