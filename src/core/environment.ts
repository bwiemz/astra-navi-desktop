import { access, constants, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

/** Programs the assistant's instructions mention when they are present on this machine. */
const PROBED_COMMANDS = [
  "kdeconnect-cli",
  "kdialog",
  "zenity",
  "ssh",
  "pacman",
  "paru",
  "yay",
  "apt",
  "dnf",
  "zypper",
  "flatpak",
  "pkexec",
  "soffice",
  "pandoc",
  "ffmpeg",
  "ffprobe",
  "kdenlive",
  "melt",
  "shotcut",
  "blender",
  "gtk-launch",
  "xdg-open",
] as const;
export type ProbedCommand = (typeof PROBED_COMMANDS)[number];

export interface EnvironmentFacts {
  userName: string;
  home: string;
  workspace: string;
  osName: string;
  desktop: string;
  commands: ReadonlySet<ProbedCommand>;
}

async function isOnPath(command: string): Promise<boolean> {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

async function readOsName(): Promise<string> {
  try {
    const release = await readFile("/etc/os-release", "utf8");
    const match = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(release);
    if (match?.[1]) return match[1];
  } catch {
    // fall through
  }
  return process.platform;
}

export async function detectEnvironment(workspace: string): Promise<EnvironmentFacts> {
  const found = await Promise.all(
    PROBED_COMMANDS.map(async (command) => ((await isOnPath(command)) ? command : null)),
  );
  const session = process.env["XDG_SESSION_TYPE"];
  const desktop = process.env["XDG_CURRENT_DESKTOP"] ?? "unknown desktop";
  return {
    userName: userInfo().username,
    home: homedir(),
    workspace,
    osName: await readOsName(),
    desktop: session ? `${desktop} (${session})` : desktop,
    commands: new Set(found.filter((command): command is ProbedCommand => command !== null)),
  };
}
