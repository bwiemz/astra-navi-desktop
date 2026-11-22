import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DesktopApp {
  /** Desktop-entry id, e.g. "org.kde.dolphin". This is what gets launched. */
  id: string;
  name: string;
  description: string;
  keywords: string[];
}

function applicationDirs(): string[] {
  const home = homedir();
  const dataHome = process.env["XDG_DATA_HOME"] || join(home, ".local", "share");
  const dataDirs = (process.env["XDG_DATA_DIRS"] || "/usr/local/share:/usr/share").split(":");
  const roots = [
    dataHome,
    ...dataDirs,
    join(dataHome, "flatpak", "exports", "share"),
    "/var/lib/flatpak/exports/share",
  ];
  return [...new Set(roots.filter(Boolean).map((root) => join(root, "applications")))];
}

function parseDesktopEntry(id: string, content: string): DesktopApp | null {
  const fields = new Map<string, string>();
  let inMainSection = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inMainSection = line === "[Desktop Entry]";
      continue;
    }
    if (!inMainSection || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  if (fields.get("Type") !== "Application") return null;
  if (fields.get("NoDisplay") === "true" || fields.get("Hidden") === "true") return null;
  const name = fields.get("Name");
  if (!name || !fields.get("Exec")) return null;
  return {
    id,
    name,
    description: fields.get("Comment") ?? fields.get("GenericName") ?? "",
    keywords: [
      ...(fields.get("Keywords") ?? "").split(";"),
      ...(fields.get("Categories") ?? "").split(";"),
      fields.get("GenericName") ?? "",
    ]
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** Every application that shows up in the desktop's launcher. Earlier folders win on duplicates. */
export async function listApps(): Promise<DesktopApp[]> {
  const apps = new Map<string, DesktopApp>();
  for (const dir of applicationDirs()) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (!fileName.endsWith(".desktop")) continue;
      const id = fileName.slice(0, -".desktop".length);
      if (apps.has(id)) continue;
      try {
        const app = parseDesktopEntry(id, await readFile(join(dir, fileName), "utf8"));
        if (app) apps.set(id, app);
      } catch {
        // Unreadable or broken entry: the launcher would skip it too.
      }
    }
  }
  return [...apps.values()];
}

export function rankApps(apps: readonly DesktopApp[], query: string, limit = 8): DesktopApp[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return apps
    .map((app) => {
      const name = app.name.toLowerCase();
      const id = app.id.toLowerCase();
      const description = app.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 10;
        else if (name.startsWith(term)) score += 6;
        else if (name.includes(term)) score += 4;
        if (id.includes(term)) score += 2;
        if (app.keywords.some((keyword) => keyword.includes(term))) score += 2;
        if (description.includes(term)) score += 1;
      }
      return { app, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name))
    .slice(0, limit)
    .map((entry) => entry.app);
}

const LAUNCH_WAIT_MS = 3000;

/**
 * Runs a launcher (`gtk-launch`, `xdg-open`) and reports whether it worked. Launchers hand
 * off and exit quickly; one still running after a few seconds is taken as a success.
 */
function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString("utf8")).slice(-400);
    });
    const letGo = (): void => {
      child.stderr.destroy();
      child.unref();
    };
    const timer = setTimeout(() => {
      letGo();
      resolvePromise();
    }, LAUNCH_WAIT_MS);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT"
          ? new Error(`"${command}" is not installed on this system.`)
          : error,
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      letGo();
      if (code === 0 || code === null) resolvePromise();
      else reject(new Error(errors.trim() || `${command} failed with exit code ${code}.`));
    });
  });
}

/** Launches an installed application by its desktop-entry id. Only ids from `listApps` are accepted. */
export async function openApp(id: string): Promise<DesktopApp> {
  const app = (await listApps()).find((candidate) => candidate.id === id);
  if (!app)
    throw new Error(`No installed application has the id "${id}". Use find_apps to look it up.`);
  await launchDetached("gtk-launch", [app.id]);
  return app;
}

/** Opens a file, folder or web address with whatever the desktop uses for it. */
export async function openTarget(target: string): Promise<void> {
  if (target.startsWith("-"))
    throw new Error("That does not look like a file path or a web address.");
  await launchDetached("xdg-open", [target]);
}
