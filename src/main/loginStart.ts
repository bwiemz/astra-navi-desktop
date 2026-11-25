import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

/**
 * Starting her when the user logs in: one desktop entry in the session's autostart
 * folder, written when that is switched on and removed when it is switched off.
 * Nothing else on the computer is changed for it.
 */

const AUTOSTART_FILE = join(
  process.env["XDG_CONFIG_HOME"] ?? join(app.getPath("home"), ".config"),
  "autostart",
  "astra-navi-desktop.desktop",
);

export async function startsAtLogin(): Promise<boolean> {
  if (process.platform === "win32" || process.platform === "darwin") {
    return app.getLoginItemSettings().openAtLogin;
  }
  try {
    await readFile(AUTOSTART_FILE);
    return true;
  } catch {
    return false;
  }
}

/** Adds or removes the entry that starts her when the user logs in. */
/** A path written the way a desktop entry's Exec line needs it: quoted, with its special characters escaped. */
function desktopExecPath(path: string): string {
  return `"${path.replace(/[\\"`$]/g, "\\$&").replaceAll("%", "%%")}"`;
}

export async function setStartAtLogin(on: boolean): Promise<void> {
  if (process.platform === "win32" || process.platform === "darwin") {
    app.setLoginItemSettings({ openAtLogin: on });
    return;
  }
  if (!on) {
    await rm(AUTOSTART_FILE, { force: true });
    return;
  }
  const launcher = join(app.getAppPath(), "scripts", "launch.sh");
  await mkdir(join(AUTOSTART_FILE, ".."), { recursive: true });
  await writeFile(
    AUTOSTART_FILE,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Astra Navi Desktop",
      "Comment=Local-first AI desktop navigator with 3D MMD companion.",
      `Exec=${desktopExecPath(launcher)}`,
      "Icon=astra-navi-desktop",
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
    "utf8",
  );
}
