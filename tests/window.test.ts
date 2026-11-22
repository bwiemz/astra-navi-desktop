import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import { helperScript } from "../src/main/kwin.ts";
import { oneAtATime } from "../src/main/once.ts";
import {
  type Box,
  WINDOW_COMPACT,
  WINDOW_EXPANDED,
  WINDOW_LOG,
  fitWindow,
  placeByCorner,
  resizeAboutCorner,
} from "../src/shared/ipc.ts";

describe("the size her window takes", () => {
  it("is the layout's own size where the screen has room for it", () => {
    expect(fitWindow(WINDOW_LOG, { width: 1920, height: 1036 })).toEqual(WINDOW_LOG);
  });

  it("is shortened to fit a short screen, less a margin", () => {
    expect(fitWindow(WINDOW_EXPANDED, { width: 1366, height: 728 })).toEqual({
      width: WINDOW_EXPANDED.width,
      height: 704,
    });
  });

  it("is narrowed to fit a narrow screen", () => {
    expect(fitWindow(WINDOW_LOG, { width: 720, height: 1280 }).width).toBe(696);
  });

  it("is never smaller than she is, however little room there is", () => {
    expect(fitWindow(WINDOW_EXPANDED, { width: 200, height: 200 })).toEqual(WINDOW_COMPACT);
  });
});

describe("telling the window when a setting changes", () => {
  it("calls the listener on every change, after the new value is in place", async () => {
    const folder = await mkdtemp(join(tmpdir(), "aichan-config-"));
    try {
      const config = new ConfigStore(join(folder, "config.json"));
      const seen: boolean[] = [];
      config.onChange = () => seen.push(config.value.doNotDisturb);
      await config.update({ doNotDisturb: true });
      await config.update({ doNotDisturb: false });
      expect(seen).toEqual([true, false]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

const SCREEN: Box = { x: 0, y: 0, width: 2560, height: 1396 };
const inside = (box: Box, area: Box): boolean =>
  box.x >= area.x &&
  box.y >= area.y &&
  box.x + box.width <= area.x + area.width &&
  box.y + box.height <= area.y + area.height;

describe("where her window goes when it grows", () => {
  it("keeps its bottom-right corner where there is room", () => {
    expect(placeByCorner({ right: 2540, bottom: 1380 }, WINDOW_LOG, SCREEN)).toEqual({
      x: 1780,
      y: 560,
      ...WINDOW_LOG,
    });
  });

  // She was dragged to the left edge: the log panel is 760 wide and would open off the screen.
  it("moves in from the left edge just far enough to be whole", () => {
    const placed = placeByCorner({ right: 300, bottom: 1380 }, WINDOW_LOG, SCREEN);
    expect(placed).toEqual({ x: 0, y: 560, ...WINDOW_LOG });
    expect(inside(placed, SCREEN)).toBe(true);
  });

  it("moves down from the top edge just far enough to be whole", () => {
    const placed = placeByCorner({ right: 2540, bottom: 450 }, WINDOW_EXPANDED, SCREEN);
    expect(placed).toEqual({ x: 2100, y: 0, ...WINDOW_EXPANDED });
    expect(inside(placed, SCREEN)).toBe(true);
  });

  it("respects a work area that does not start at the screen's corner", () => {
    // A second screen to the right, with a panel along its top.
    const area: Box = { x: 2560, y: 44, width: 1920, height: 1036 };
    const placed = placeByCorner({ right: 2860, bottom: 500 }, WINDOW_LOG, area);
    expect(placed).toEqual({ x: 2560, y: 44, ...WINDOW_LOG });
    expect(inside(placed, area)).toBe(true);
  });

  it("pulls a window that hangs off the right or bottom back in as well", () => {
    const placed = placeByCorner({ right: 2700, bottom: 1500 }, WINDOW_COMPACT, SCREEN);
    expect(inside(placed, SCREEN)).toBe(true);
  });

  it("is on screen for every layout wherever the corner is", () => {
    for (const size of [WINDOW_COMPACT, WINDOW_EXPANDED, WINDOW_LOG]) {
      for (const right of [0, 280, 300, 1200, 2560, 2900]) {
        for (const bottom of [0, 430, 600, 1396, 1700]) {
          expect(inside(placeByCorner({ right, bottom }, size, SCREEN), SCREEN)).toBe(true);
        }
      }
    }
  });

  it("keeps the left and top edges in view on a screen smaller than the window", () => {
    const small: Box = { x: 0, y: 0, width: 600, height: 500 };
    expect(placeByCorner({ right: 590, bottom: 490 }, WINDOW_LOG, small)).toMatchObject({
      x: 0,
      y: 0,
    });
  });
});

describe("growing and shrinking her window about its corner", () => {
  const compactAtLeft: Box = { x: 20, y: 950, ...WINDOW_COMPACT };

  it("goes back to where the user put her after being moved in to fit", () => {
    const grown = resizeAboutCorner(compactAtLeft, WINDOW_LOG, SCREEN, null);
    expect(grown.bounds).toEqual({ x: 0, y: 560, ...WINDOW_LOG });
    expect(grown.held).not.toBeNull();
    const shrunk = resizeAboutCorner(grown.bounds, WINDOW_COMPACT, SCREEN, grown.held);
    expect(shrunk.bounds).toEqual(compactAtLeft);
    expect(shrunk.held).toBeNull();
  });

  it("holds the corner through several sizes in a row", () => {
    const log = resizeAboutCorner(compactAtLeft, WINDOW_LOG, SCREEN, null);
    const balloon = resizeAboutCorner(log.bounds, WINDOW_EXPANDED, SCREEN, log.held);
    expect(balloon.bounds).toEqual({ x: 0, y: 560, ...WINDOW_EXPANDED });
    const compact = resizeAboutCorner(balloon.bounds, WINDOW_COMPACT, SCREEN, balloon.held);
    expect(compact.bounds).toEqual(compactAtLeft);
  });

  it("forgets the held corner once the user has moved the window", () => {
    const grown = resizeAboutCorner(compactAtLeft, WINDOW_LOG, SCREEN, null);
    const dragged: Box = { ...grown.bounds, x: 900, y: 300 };
    const shrunk = resizeAboutCorner(dragged, WINDOW_COMPACT, SCREEN, grown.held);
    expect(shrunk.bounds).toEqual({ x: 900 + 760 - 280, y: 300 + 820 - 430, ...WINDOW_COMPACT });
    expect(shrunk.held).toBeNull();
  });

  it("holds nothing when the window fitted where it was", () => {
    const corner: Box = { x: 2260, y: 950, ...WINDOW_COMPACT };
    const grown = resizeAboutCorner(corner, WINDOW_LOG, SCREEN, null);
    expect(grown.held).toBeNull();
    expect(grown.bounds.x + grown.bounds.width).toBe(2540);
    expect(grown.bounds.y + grown.bounds.height).toBe(1380);
  });
});

/** The KWin helper, run against a stand-in for KWin with one window: hers. */
function kwinWith(start: Box, area: Box = SCREEN) {
  type Handler = () => void;
  const signal = (): { connect(handler: Handler): void; fire(): void } => {
    const handlers: Handler[] = [];
    return {
      connect: (handler) => void handlers.push(handler),
      fire: () => handlers.forEach((run) => run()),
    };
  };
  let geometry = { ...start };
  const companion = {
    internalId: "w1",
    resourceClass: "ai-chan-desktop",
    caption: "AI-chan",
    normalWindow: true,
    interactiveMoveResizeStarted: signal(),
    interactiveMoveResizeFinished: signal(),
    frameGeometryChanged: signal(),
    captionChanged: signal(),
    get frameGeometry(): Box {
      return geometry;
    },
    set frameGeometry(next: Box) {
      geometry = { ...next };
      companion.frameGeometryChanged.fire();
    },
  };
  const workspace = {
    clientArea: () => area,
    windowList: () => [companion],
    windowAdded: signal(),
    virtualScreenGeometryChanged: signal(),
  };
  runInNewContext(helperScript("ai-chan-desktop", "AI-chan", { right: 20, bottom: 16 }), {
    workspace,
    KWin: { PlacementArea: 0 },
  });
  return {
    get geometry(): Box {
      return geometry;
    },
    /** The app asks for a new size; the compositor resizes about the top-left corner. */
    resize(size: { width: number; height: number }): void {
      companion.frameGeometry = { ...geometry, ...size };
    },
    /** The user drags the window to a new place. */
    drag(to: { x: number; y: number }): void {
      companion.interactiveMoveResizeStarted.fire();
      companion.frameGeometry = { ...geometry, ...to };
      companion.interactiveMoveResizeFinished.fire();
    },
  };
}

describe("the KWin helper's placing of her window", () => {
  it("puts her in the bottom-right corner and grows up and to the left from there", () => {
    const kwin = kwinWith({ x: 100, y: 100, ...WINDOW_COMPACT });
    expect(kwin.geometry).toEqual({ x: 2260, y: 950, ...WINDOW_COMPACT });
    kwin.resize(WINDOW_LOG);
    expect(kwin.geometry).toEqual({ x: 1780, y: 560, ...WINDOW_LOG });
  });

  it("keeps the whole window on screen when she stands at the left edge and the log opens", () => {
    const kwin = kwinWith({ x: 100, y: 100, ...WINDOW_COMPACT });
    kwin.drag({ x: 10, y: 950 });
    kwin.resize(WINDOW_LOG);
    expect(kwin.geometry).toEqual({ x: 0, y: 560, ...WINDOW_LOG });
    expect(inside(kwin.geometry, SCREEN)).toBe(true);
    // Closing it takes her back to where she was dragged, not to where the panel pushed her.
    kwin.resize(WINDOW_COMPACT);
    expect(kwin.geometry).toEqual({ x: 10, y: 950, ...WINDOW_COMPACT });
  });

  it("keeps the whole window on screen when she stands at the top and the balloon opens", () => {
    const area: Box = { x: 0, y: 44, width: 2560, height: 1352 };
    const kwin = kwinWith({ x: 100, y: 100, ...WINDOW_COMPACT }, area);
    kwin.drag({ x: 1200, y: 60 });
    kwin.resize(WINDOW_EXPANDED);
    expect(kwin.geometry.y).toBe(44);
    expect(inside(kwin.geometry, area)).toBe(true);
    kwin.resize(WINDOW_COMPACT);
    expect(kwin.geometry).toEqual({ x: 1200, y: 60, ...WINDOW_COMPACT });
  });
});

describe("a task that must not be started twice over", () => {
  it("does nothing for a second request while the first is still going", async () => {
    let started = 0;
    let finish: () => void = () => undefined;
    const run = oneAtATime(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          finish = resolve;
        }),
      () => undefined,
    );
    const first = run();
    await run();
    await run();
    expect(started).toBe(1);
    finish();
    await first;
    void run();
    expect(started).toBe(2);
    finish();
  });

  it("can be started again after it failed, and hands the failure over without throwing", async () => {
    const errors: unknown[] = [];
    let fail = true;
    let done = 0;
    const run = oneAtATime(
      () => {
        if (fail) return Promise.reject(new Error("the file could not be read"));
        done += 1;
        return Promise.resolve();
      },
      (error) => errors.push(error),
    );
    await expect(run()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    fail = false;
    await run();
    expect(done).toBe(1);
  });
});

describe("her window's page, for someone using a screen reader", () => {
  const page = readFile(join(import.meta.dirname, "../src/renderer/index.html"), "utf8");
  const tag = async (id: string): Promise<string> =>
    new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(await page)?.[0] ?? "";

  // The reply is rewritten many times a second while she writes it.
  it("does not read her reply out as each word lands, and has a place to say it once", async () => {
    expect(await tag("reply")).toContain('aria-live="off"');
    expect(await tag("reply-aloud")).toContain('aria-live="polite"');
  });

  it("announces a question at once, from a place that does not take the focus", async () => {
    expect(await tag("permission-ask")).toContain('role="alert"');
    expect(await tag("permission")).toContain('aria-labelledby="permission-title"');
  });

  it("gives no approval button the focus by default", async () => {
    for (const id of ["permission-deny", "permission-session", "permission-allow"]) {
      const button = await tag(id);
      expect(button).toContain('type="button"');
      expect(button).not.toContain("autofocus");
    }
  });

  it("lets the command and the reason be scrolled from the keyboard, and says when there is more", async () => {
    expect(await tag("permission-detail")).toContain('tabindex="0"');
    expect(await tag("permission-detail")).toContain('aria-describedby="permission-detail-more"');
    expect(await tag("permission-note")).toContain('tabindex="0"');
    expect(await tag("permission-note-more")).toContain("hidden");
  });
});

describe("what her window's page may ask of the app", () => {
  const preload = readFile(join(import.meta.dirname, "../src/preload/index.ts"), "utf8");
  const main = readFile(join(import.meta.dirname, "../src/main/index.ts"), "utf8");
  const desktopIpc = readFile(join(import.meta.dirname, "../src/main/desktopIpc.ts"), "utf8");
  const tray = readFile(join(import.meta.dirname, "../src/main/tray.ts"), "utf8");

  /** The handler the app registers for a channel, as written: up to where the next one starts. */
  async function handler(channel: string): Promise<string> {
    const source = await desktopIpc;
    const start = source.search(new RegExp(`ipcMain\\.(?:on|handle)\\(\\s*"${channel}"`));
    if (start === -1) return "";
    const next = source.indexOf("ipcMain.", start + 8);
    return source.slice(start, next === -1 ? undefined : next);
  }

  // Only her own window is given this bridge. Each handler checks that for itself, so a
  // page added later (or one opened by mistake) cannot send her messages, answer her
  // questions for the user, or open links.
  it("is taken only from her own window, channel by channel", async () => {
    const channels = [
      ...(await preload).matchAll(/ipcRenderer\.(?:send|invoke)\("([a-z:-]+)"/g),
    ].map((match) => match[1] ?? "");
    expect(channels).toContain("permission:answer");
    expect(channels).toContain("chat:send");
    expect(channels.length).toBeGreaterThanOrEqual(12);
    for (const channel of channels) {
      const body = await handler(channel);
      expect(body, `no handler found for ${channel}`).not.toBe("");
      expect(body, `${channel} does not check who is asking`).toContain("fromMainWindow(event)");
    }
  });

  it("keeps only the start of an error the page reports", async () => {
    const body = await handler("model:error");
    expect(body).toMatch(/message\.slice\(0, \d+\)/);
    expect(body).not.toMatch(/console\.error\([^)]*,\s*message\s*\)/);
  });

  // Each of these stops her reply, and with it drops what was waiting behind it; her
  // window is told every time, or it goes on waiting for answers that will never come.
  it("tells her window whenever her reply is stopped", async () => {
    const [source, traySource] = await Promise.all([main, tray]);
    const bare = [...source.matchAll(/brain\??\.interrupt\(\)/g)];
    // The one place that calls it directly is the helper that also tells the window.
    expect(bare).toHaveLength(1);
    expect(source).toMatch(
      /function interruptBrain\(\): void \{\s*brain\?\.interrupt\(\);\s*toldStopped\(\);/,
    );
    const refreshAt = source.indexOf("brain?.refreshInstructions()");
    expect(refreshAt, "refreshInstructions()").toBeGreaterThan(-1);
    expect(source.slice(refreshAt, refreshAt + 220), "refreshInstructions()").toContain(
      "toldStopped()",
    );
    const newConvAt = traySource.indexOf("?.newConversation()");
    expect(newConvAt, "newConversation()").toBeGreaterThan(-1);
    expect(traySource.slice(newConvAt, newConvAt + 220), "newConversation()").toContain(
      "deps.toldStopped()",
    );
  });
});
