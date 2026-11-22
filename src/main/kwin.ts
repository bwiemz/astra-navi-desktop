import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { PlatformCompanionOverlay } from "../core/platform/adapter.ts";

const run = promisify(execFile);
const PLUGIN_NAME = "ai-chan-desktop-helper";

/**
 * On Wayland a window cannot keep itself above others, hide from the taskbar or choose
 * where it sits; only the compositor can. On KDE Plasma we ask KWin to do those three
 * things for our window with a small script that lives only while the app runs. Nothing
 * is written to the user's KWin settings.
 *
 * Exported so the placing can be tested by running the script against a stand-in for KWin.
 */
export function helperScript(
  appId: string,
  title: string,
  margin: { right: number; bottom: number },
): string {
  return `
var APP_ID = ${JSON.stringify(appId)};
var TITLE = ${JSON.stringify(title)};
// Where the window's bottom-right corner belongs. The window grows and shrinks, and
// that corner is the part that must not move.
var corner = null;
var adopted = [];
// Counts moves made in a row without the window ending up where it was sent. If the
// compositor keeps refusing (the window cannot fit there), stop instead of fighting it.
var corrections = 0;

function place(w) {
  var g = w.frameGeometry;
  if (!g || g.width <= 0) return;
  var area = workspace.clientArea(KWin.PlacementArea, w);
  if (!corner) {
    corner = { right: area.x + area.width - ${margin.right}, bottom: area.y + area.height - ${margin.bottom} };
  }
  // The corner stays where it belongs, unless the window would then reach past an edge
  // of the screen (she stands near the left or top, and the panel beside her opens):
  // then it is moved in just far enough to be whole. The corner itself is not forgotten,
  // so she goes back to her place when the window shrinks again.
  var x = Math.max(area.x, Math.min(corner.right - g.width, area.x + area.width - g.width));
  var y = Math.max(area.y, Math.min(corner.bottom - g.height, area.y + area.height - g.height));
  if (Math.abs(g.x - x) < 1 && Math.abs(g.y - y) < 1) {
    corrections = 0;
    return;
  }
  if (corrections > 30) return;
  corrections += 1;
  w.frameGeometry = { x: x, y: y, width: g.width, height: g.height };
}

// The app's dialogs share its id; only the companion window itself is managed.
function isCompanion(w) {
  return !!w && String(w.resourceClass) === APP_ID && w.normalWindow && String(w.caption) === TITLE;
}

function adopt(w) {
  var id = String(w.internalId);
  if (adopted.indexOf(id) !== -1) {
    place(w); // shown again after being hidden
    return;
  }
  adopted.push(id);
  w.keepAbove = true;
  w.skipTaskbar = true;
  w.skipPager = true;
  w.skipSwitcher = true;
  w.onAllDesktops = true;
  place(w);
  var dragging = false;
  w.interactiveMoveResizeStarted.connect(function () {
    dragging = true;
  });
  // Remember where the user dragged her, so hiding and showing does not reset it.
  w.interactiveMoveResizeFinished.connect(function () {
    dragging = false;
    corrections = 0;
    var g = w.frameGeometry;
    corner = { right: g.x + g.width, bottom: g.y + g.height };
  });
  // The app resized itself: put the corner back where it was.
  w.frameGeometryChanged.connect(function () {
    if (!dragging) place(w);
  });
}

function consider(w) {
  if (!w || String(w.resourceClass) !== APP_ID) return;
  if (isCompanion(w)) {
    adopt(w);
  } else if (!String(w.caption)) {
    // The title can arrive a moment after the window does.
    w.captionChanged.connect(function () {
      if (isCompanion(w)) adopt(w);
    });
  }
}

function everyWindow() {
  return workspace.windowList ? workspace.windowList() : workspace.clientList();
}

var windows = everyWindow();
for (var i = 0; i < windows.length; i++) consider(windows[i]);
(workspace.windowAdded || workspace.clientAdded).connect(consider);

// A changed screen layout makes the remembered corner meaningless; go back to the default one.
if (workspace.virtualScreenGeometryChanged) {
  workspace.virtualScreenGeometryChanged.connect(function () {
    corner = null;
    corrections = 0;
    var all = everyWindow();
    for (var i = 0; i < all.length; i++) if (isCompanion(all[i])) place(all[i]);
  });
}
`;
}

async function kwin(method: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "dbus-send",
    [
      "--session",
      "--print-reply",
      "--dest=org.kde.KWin",
      "/Scripting",
      `org.kde.kwin.Scripting.${method}`,
      ...args.map((arg) => `string:${arg}`),
    ],
    { timeout: 5000 },
  );
  return stdout;
}

export function isKdeWayland(): boolean {
  return (
    process.env["XDG_SESSION_TYPE"] === "wayland" &&
    (process.env["XDG_CURRENT_DESKTOP"] ?? "").toUpperCase().includes("KDE")
  );
}

/**
 * Loads the helper into KWin. Returns a function that removes it again, or null when
 * the helper could not be loaded (the app still works, just as an ordinary window).
 */
export async function installKwinHelper(options: {
  appId: string;
  /** The companion window's title; the app's other windows are left alone. */
  title: string;
  scriptPath: string;
  margin: { right: number; bottom: number };
}): Promise<(() => Promise<void>) | null> {
  const remove = async (): Promise<void> => {
    try {
      await kwin("unloadScript", PLUGIN_NAME);
    } catch {
      // Not loaded, or KWin is gone; either way there is nothing left to remove.
    }
  };
  try {
    await mkdir(dirname(options.scriptPath), { recursive: true });
    await writeFile(
      options.scriptPath,
      helperScript(options.appId, options.title, options.margin),
      "utf8",
    );
    await remove(); // a copy left behind by a crash would otherwise run twice
    const reply = await kwin("loadScript", options.scriptPath, PLUGIN_NAME);
    // KWin answers with the script's id, or -1 when it would not load it.
    const id = Number(/int32\s+(-?\d+)/.exec(reply)?.[1] ?? Number.NaN);
    if (!Number.isInteger(id) || id < 0)
      throw new Error(`KWin refused the script (reply: ${reply.trim()})`);
    await kwin("start");
    return remove;
  } catch (error) {
    console.warn("[kwin] could not ask KWin to keep the window on top:", error);
    return null;
  }
}

/** Exposes KWin companion overlay installation through the `PlatformAdapter` contract. */
export function createLinuxCompanionOverlay(): PlatformCompanionOverlay {
  return {
    install: (options) => installKwinHelper(options),
  };
}
