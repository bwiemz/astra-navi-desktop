import { describe, expect, it, vi } from "vitest";
import { guarded, type ToolHost } from "../src/core/agentTools.ts";
import type { WindowDetail } from "../src/core/desktop.ts";
import {
  forbidden,
  isCalmKey,
  isRiskyName,
  listedControl,
  OPERATE_ACTIONS,
  operateVerdict,
  rememberListed,
} from "../src/core/operateRules.ts";
import {
  TOOLS,
  toolVerdict,
  type PolicyContext,
  type RequestSummary,
  type Verdict,
} from "../src/core/permissions.ts";
import { describeRequest } from "../src/core/requestWords.ts";

/**
 * What the independent review of the tier-8 round changed in the rules: the cases it
 * found, written down so they stay closed.
 */

const OWN = ["ai-chan-desktop"];

function win(over: Partial<WindowDetail> & { id: string; app: string }): WindowDetail {
  return {
    title: over.app,
    active: false,
    minimized: false,
    pid: 1000,
    fullScreen: false,
    dialog: false,
    order: 0,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    ...over,
  };
}

function context(windows: WindowDetail[], over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    workspace: "/tmp/ai-chan-test",
    windows: () => Promise.resolve(windows),
    ownApps: OWN,
    ...over,
  };
}

function asked(verdict: Verdict): Extract<Verdict, { decision: "ask" }> {
  if (verdict.decision !== "ask") throw new Error("expected the user to be asked");
  return verdict;
}

describe("keys are judged as they will be pressed", () => {
  it.each([
    "shift + tab",
    "Shift+Tab",
    " ctrl + f ",
    "ctrl   +   home",
    "PageDown",
    // A space joins keys just as a plus does, and is pressed that way.
    "ctrl f",
  ])("%j only moves about", (keys) => {
    expect(isCalmKey(keys)).toBe(true);
  });

  // Spaces separate keys. "h o m e" is four letters typed one after another, not Home.
  it.each(["h o m e", "u p", "f 6", "t a b", "e s c", "down enter"])(
    "%j is not taken for a key that only moves about",
    (keys) => {
      expect(isCalmKey(keys)).toBe(false);
    },
  );

  it("shows such a spelled-out key to the user on its own", async () => {
    const kate = win({
      id: "{keys}",
      app: "org.kde.kate",
      title: "notes.txt — Kate",
      active: true,
    });
    const verdict = asked(
      await operateVerdict({ action: "key", window: "kate", keys: "h o m e" }, context([kate])),
    );
    expect(verdict.rememberable).toBe(false);
    expect(verdict.summary?.title).toBe("Let her do this?");
  });
});

describe("names that are shown on their own", () => {
  it.each([
    "Save",
    "Save As…",
    "Commit",
    "Push",
    "Rename",
    "Transfer",
    "Download",
    "Enable",
    "Withdraw",
    "Subscribe",
    "Cut",
    "保存",
    "ゴミ箱に移動",
    "移到回收站",
  ])("%s", (name) => {
    expect(isRiskyName(name)).toBe(true);
  });

  it.each(["Bold", "Next page", "Zoom in", "Seven", "Find", "Italic", "Play", "次へ", "下一页"])(
    "%s is not one of them",
    (name) => {
      expect(isRiskyName(name)).toBe(false);
    },
  );
});

describe("windows that are private", () => {
  const privateTab = win({
    id: "{private-tab}",
    app: "firefox",
    title: "My bank — Mozilla Firefox Private Browsing",
    active: true,
  });
  const signIn = win({
    id: "{sign-in}",
    app: "org.kde.falkon",
    title: "Sign in – Google Accounts",
    active: true,
  });
  const passwords = win({
    id: "{passwords}",
    app: "org.kde.kate",
    title: "passwords.txt — Kate",
    active: true,
  });

  it.each(OPERATE_ACTIONS)("are not read or touched: %s", (action) => {
    for (const window of [privateTab, signIn, passwords]) {
      expect(forbidden(window, action, OWN), window.title).toMatch(/^That window is private/);
    }
  });

  it("are refused before any question, even to read their controls with standing permission", async () => {
    for (const window of [privateTab, signIn]) {
      await expect(
        operateVerdict(
          { action: "controls", window: window.app.split(".").pop() },
          context([window], { maySeeScreen: true }),
        ),
      ).rejects.toThrow(/^That window is private/);
      await expect(
        operateVerdict({ action: "press", name: "Continue" }, context([window])),
      ).rejects.toThrow(/^That window is private/);
    }
  });

  it("leaves an ordinary window of the same program alone", () => {
    const ordinary = win({ id: "{news}", app: "firefox", title: "News — Mozilla Firefox" });
    for (const action of OPERATE_ACTIONS) expect(forbidden(ordinary, action, OWN)).toBeNull();
    // "Design in…" is not a sign-in page.
    expect(
      forbidden(win({ id: "{figma}", app: "firefox", title: "Design in Figma" }), "press", OWN),
    ).toBeNull();
  });

  it("still says the system is asking, for the windows where it is", () => {
    for (const app of [
      "polkit-kde-authentication-agent-1",
      "org.kde.polkit-kde-authentication-agent-1",
      "kscreenlocker_greet",
    ]) {
      expect(forbidden({ app, title: "Authentication Required" }, "press", OWN)).toMatch(
        /^That window is the system asking Captain/,
      );
    }
    // Even when the title also speaks of a password.
    expect(
      forbidden(
        { app: "polkit-kde-authentication-agent-1", title: "Password for root" },
        "controls",
        OWN,
      ),
    ).toMatch(/^That window is the system asking Captain/);
  });
});

describe("what a message from another device may set going", () => {
  const kate = win({
    id: "{away-kate}",
    app: "org.kde.kate",
    title: "notes.txt — Kate",
    active: true,
  });

  it("does not read a window's controls on standing permission", async () => {
    const input = { action: "controls", window: "kate" };
    expect(await operateVerdict(input, context([kate], { maySeeScreen: true }))).toEqual({
      decision: "allow",
    });
    const away = asked(
      await operateVerdict(input, context([kate], { maySeeScreen: true, away: true })),
    );
    expect(away.summary?.title).toBe("Let her read this window's controls?");
  });

  it("does not look at the screen, think back over it, or listen back, without being asked at the PC", async () => {
    const standing: PolicyContext = { workspace: "/tmp/ws", maySeeScreen: true };
    expect(await toolVerdict(TOOLS.lookAtScreen, {}, standing)).toEqual({ decision: "allow" });
    expect(await toolVerdict(TOOLS.lookAtScreen, { when: "earlier" }, standing)).toEqual({
      decision: "allow",
    });
    expect(await toolVerdict(TOOLS.listenToPc, {}, standing)).toEqual({ decision: "allow" });

    const away: PolicyContext = { ...standing, away: true };
    for (const [tool, input] of [
      [TOOLS.lookAtScreen, {}],
      [TOOLS.lookAtScreen, { when: "now" }],
      [TOOLS.lookAtScreen, { when: "earlier" }],
      [TOOLS.listenToPc, {}],
      [TOOLS.listenToPc, { seconds: 60 }],
    ] as const) {
      const verdict = asked(await toolVerdict(tool, input, away));
      expect(verdict.reason).toBe("This was asked for from another device, not at this PC.");
      expect(verdict.sensitive).toBe(false);
    }
  });

  it("leaves the things that show nothing of the PC as they were", async () => {
    const away: PolicyContext = { workspace: "/tmp/ws", away: true };
    for (const tool of [TOOLS.calculate, TOOLS.weather, TOOLS.webSearch, TOOLS.setReminder]) {
      expect(await toolVerdict(tool, {}, away), tool).toEqual({ decision: "allow" });
    }
  });
});

describe("how a step is put on record", () => {
  it("names her words until the rules have settled on a program, and the program after", async () => {
    const kate = win({
      id: "{record-kate}",
      app: "org.kde.kate",
      title: "notes.txt — Kate",
      active: true,
    });
    const input = { action: "press", window: "notes", name: "Bold" };
    expect(describeRequest(TOOLS.operate, input).detail).toBe('Press "Bold" in "notes"');
    await operateVerdict(input, context([kate]));
    expect(describeRequest(TOOLS.operate, input).detail).toBe('Press "Bold" in org.kde.kate');
    // Another call with the same words has not been settled, and says only what she said.
    expect(describeRequest(TOOLS.operate, { ...input }).detail).toBe('Press "Bold" in "notes"');
  });

  it("says the window in front when she named none, then which program that was", async () => {
    const calc = win({ id: "{record-calc}", app: "org.kde.kcalc", title: "KCalc", active: true });
    const input = { action: "scroll", amount: -2 };
    expect(describeRequest(TOOLS.operate, input).detail).toBe("Scroll up in the window in front");
    await operateVerdict(input, context([calc]));
    expect(describeRequest(TOOLS.operate, input).detail).toBe("Scroll up in org.kde.kcalc");
  });
});

describe("what a number stands for", () => {
  it("is kept per window, with the kind and the name apart", () => {
    rememberListed("{numbers-a}", [
      { n: 1, kind: "button", name: "Play" },
      { n: 2, kind: "menu item", name: "Quit" },
    ]);
    rememberListed("{numbers-b}", [{ n: 1, kind: "link", name: "Next" }]);
    expect(listedControl("{numbers-a}", 2)).toEqual({ kind: "menu item", name: "Quit" });
    expect(listedControl("{numbers-b}", 1)).toEqual({ kind: "link", name: "Next" });
    expect(listedControl("{numbers-b}", 2)).toBeUndefined();
    expect(listedControl("{numbers-never}", 1)).toBeUndefined();
    // A new list for a window replaces the old one whole.
    rememberListed("{numbers-a}", [{ n: 1, kind: "button", name: "Pause" }]);
    expect(listedControl("{numbers-a}", 1)).toEqual({ kind: "button", name: "Pause" });
    expect(listedControl("{numbers-a}", 2)).toBeUndefined();
  });

  it("judges a bare number by the name behind it, in the window it was listed for", async () => {
    const one = win({ id: "{judge-a}", app: "org.kde.elisa", title: "Elisa", active: true });
    const two = win({ id: "{judge-b}", app: "org.kde.dragonplayer", title: "Dragon" });
    rememberListed("{judge-a}", [{ n: 1, kind: "button", name: "Delete playlist" }]);
    const mine = asked(
      await operateVerdict({ action: "press", window: "elisa", which: 1 }, context([one, two])),
    );
    expect(mine.reason).toContain("hard to undo");
    expect(mine.summary?.detail).toBe(
      'Press number 1 (the button "Delete playlist") in org.kde.elisa ("Elisa")',
    );
    // The same number in a window nothing was listed for stands for nothing she can name.
    const other = asked(
      await operateVerdict(
        { action: "press", window: "dragonplayer", which: 1 },
        context([one, two]),
      ),
    );
    expect(other.rememberable).toBe(false);
    expect(other.summary?.detail).toBe(
      'Press number 1 (she did not say which control that is) in org.kde.dragonplayer ("Dragon")',
    );
  });
});

describe("a question there is nobody to put to", () => {
  interface Heard extends RequestSummary {
    sensitive: boolean;
    rememberable: boolean;
  }

  function host(over: Partial<ToolHost>): {
    host: ToolHost;
    asked: Heard[];
    audited: { outcome: string; asked: boolean }[];
  } {
    const heard: Heard[] = [];
    const audited: { outcome: string; asked: boolean }[] = [];
    let steps = 0;
    return {
      asked: heard,
      audited,
      host: {
        policy: () => ({ workspace: "/tmp/ai-chan-test", home: "/tmp/ai-chan-test" }),
        memory: undefined as never,
        learnAddresses: () => undefined,
        noteOutsideText: () => undefined,
        noteChange: () => undefined,
        signal: () => undefined,
        activity: () => undefined,
        ran: () => undefined,
        audit: (entry) => audited.push({ outcome: entry.outcome, asked: entry.asked }),
        ask: (request) => {
          heard.push(request);
          return Promise.resolve(false);
        },
        step: () => (steps += 1),
        ...over,
      },
    };
  }

  // Deleting unused models always asks, whatever the conversation holds.
  const tidy = (toolHost: ToolHost, run: () => Promise<string>): Promise<string> =>
    guarded<Record<string, never>>(toolHost, TOOLS.tidyStorage, () => "Tidying", run)({});

  it("is answered in the words given for that case, and recorded as refused, not declined", async () => {
    const rig = host({
      nobodyToAsk: true,
      nobodyToAskReply: "Not done. Nobody is at the PC to say yes.",
    });
    const run = vi.fn(() => Promise.resolve("deleted"));
    expect(await tidy(rig.host, run)).toBe("Not done. Nobody is at the PC to say yes.");
    expect(run).not.toHaveBeenCalled();
    expect(rig.audited).toEqual([{ outcome: "refused", asked: false }]);
  });

  it("falls back to the usual words when none were given", async () => {
    const rig = host({ nobodyToAsk: true });
    const run = vi.fn(() => Promise.resolve("deleted"));
    expect(await tidy(rig.host, run)).toMatch(/^The user said no to this\./);
    expect(run).not.toHaveBeenCalled();
    expect(rig.audited).toEqual([{ outcome: "refused", asked: false }]);
  });

  it("keeps the usual words when somebody was there and said no", async () => {
    const rig = host({ nobodyToAskReply: "Not done. Nobody is at the PC to say yes." });
    const run = vi.fn(() => Promise.resolve("deleted"));
    expect(await tidy(rig.host, run)).toMatch(/^The user said no to this\./);
    expect(rig.asked).toHaveLength(1);
    expect(rig.audited).toEqual([{ outcome: "declined", asked: true }]);
  });

  it("makes no difference to what needs no question", async () => {
    const rig = host({ nobodyToAsk: true, nobodyToAskReply: "Not done." });
    const sum = guarded<Record<string, never>>(
      rig.host,
      TOOLS.calculate,
      () => "Working it out",
      () => Promise.resolve("4"),
    );
    expect(await sum({})).toBe("4");
    expect(rig.asked).toHaveLength(0);
    expect(rig.audited).toEqual([{ outcome: "done", asked: false }]);
  });
});
