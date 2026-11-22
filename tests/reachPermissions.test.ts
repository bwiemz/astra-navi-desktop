import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guarded, type ToolHost } from "../src/core/agentTools.ts";
import type { WindowDetail } from "../src/core/desktop.ts";
import {
  changesSomething,
  TOOLS,
  toolVerdict,
  type PolicyContext,
  type RequestSummary,
} from "../src/core/permissions.ts";
import { describeRequest } from "../src/core/requestWords.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-chan-reach-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function win(over: Partial<WindowDetail> & { id: string; app: string }): WindowDetail {
  return {
    title: over.app,
    active: false,
    minimized: false,
    pid: 1000,
    fullScreen: false,
    dialog: false,
    order: 1,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    ...over,
  };
}

const kate = win({ id: "{p-kate}", app: "org.kde.kate", title: "notes.txt — Kate", active: true });
const konsole = win({ id: "{p-term}", app: "org.kde.konsole", title: "~ : bash" });

function context(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    workspace: dir,
    home: dir,
    windows: () => Promise.resolve([kate, konsole]),
    ownApps: ["ai-chan-desktop"],
    ...over,
  };
}

describe("the phone", () => {
  it("may always be looked for and rung: it is the user's own", async () => {
    for (const tainted of [false, true]) {
      for (const action of ["list", "ring"]) {
        expect(
          await toolVerdict(TOOLS.phone, { action }, context({ readOutsideText: tainted })),
          `${action} tainted=${String(tainted)}`,
        ).toEqual({ decision: "allow" });
      }
    }
  });

  it("is sent things freely until outside text has been read, then each is checked", async () => {
    const sends = [
      { action: "send_text", text: "milk, eggs" },
      { action: "send_link", link: "https://example.org/recipe" },
      { action: "ping", text: "Dinner is ready" },
      { action: "send_file", path: "shopping.txt" },
    ];
    for (const input of sends) {
      expect(await toolVerdict(TOOLS.phone, input, context()), input.action).toEqual({
        decision: "allow",
      });
      const tainted = await toolVerdict(TOOLS.phone, input, context({ readOutsideText: true }));
      expect(tainted, input.action).toMatchObject({ decision: "ask", sensitive: false });
      if (tainted.decision === "ask") expect(tainted.reason).toContain("sent to your phone");
    }
  });

  it("asks before sending a file from a private place, tainted or not", async () => {
    for (const path of [
      "~/.ssh/id_ed25519",
      "~/.config/keepassxc/keepassxc.ini",
      "~/passwords.kdbx",
    ]) {
      for (const tainted of [false, true]) {
        expect(
          await toolVerdict(
            TOOLS.phone,
            { action: "send_file", path },
            context({ readOutsideText: tainted }),
          ),
          path,
        ).toMatchObject({ decision: "ask", sensitive: true });
      }
    }
  });

  it("treats her own settings and records as a private place too", async () => {
    const data = join(dir, "her-data");
    expect(
      await toolVerdict(
        TOOLS.phone,
        { action: "send_file", path: join(data, "config.json") },
        context({ privateDirs: [data] }),
      ),
    ).toMatchObject({ decision: "ask", sensitive: true });
  });

  it("counts as changing something for everything but looking for it", () => {
    expect(changesSomething(TOOLS.phone, { action: "list" })).toBe(false);
    for (const action of ["ring", "send_text", "send_link", "send_file", "ping"]) {
      expect(changesSomething(TOOLS.phone, { action }), action).toBe(true);
    }
    expect(changesSomething(TOOLS.phone, {})).toBe(true);
  });

  it("is put to the user by what would be sent", () => {
    expect(describeRequest(TOOLS.phone, { action: "send_text", text: "milk, eggs" })).toEqual({
      title: "Send this to your phone?",
      detail: "send text: milk, eggs",
      note: null,
    });
    expect(
      describeRequest(TOOLS.phone, { action: "send_link", link: "https://example.org" }).detail,
    ).toBe("send link: https://example.org");
    expect(describeRequest(TOOLS.phone, { action: "send_file", path: "/tmp/a.pdf" }).detail).toBe(
      "send file: /tmp/a.pdf",
    );
    expect(describeRequest(TOOLS.phone, { action: "ring" }).detail).toBe("ring");
  });
});

describe("hearing the PC", () => {
  it("is only listening: never asked about, never counted as a change", async () => {
    for (const tainted of [false, true]) {
      expect(
        await toolVerdict(TOOLS.listenToPc, { seconds: 30 }, context({ readOutsideText: tainted })),
      ).toEqual({ decision: "allow" });
    }
    expect(changesSomething(TOOLS.listenToPc, { seconds: 30 })).toBe(false);
    expect(describeRequest(TOOLS.listenToPc, {})).toEqual({
      title: "Let her listen to what the PC played?",
      detail: "",
      note: null,
    });
  });
});

describe("working in other programs, as the rules see it", () => {
  it("counts reading controls as looking and everything else as a change", () => {
    expect(changesSomething(TOOLS.operate, { action: "controls" })).toBe(false);
    for (const action of ["press", "fill", "click", "type", "key", "scroll"]) {
      expect(changesSomething(TOOLS.operate, { action }), action).toBe(true);
    }
    // A call too garbled to read is treated as a change, so "hands off" stops it.
    expect(changesSomething(TOOLS.operate, {})).toBe(true);
    expect(changesSomething(TOOLS.operate, { action: 7 })).toBe(true);
  });

  it("hands the decision to the rules for other programs", async () => {
    const verdict = await toolVerdict(
      TOOLS.operate,
      { action: "press", window: "kate", name: "Bold" },
      context(),
    );
    expect(verdict).toMatchObject({
      decision: "ask",
      rememberable: true,
      summary: { title: "Let her work in this program?", detail: "org.kde.kate" },
    });
    await expect(
      toolVerdict(TOOLS.operate, { action: "type", window: "konsole", text: "ls" }, context()),
    ).rejects.toThrow("That is a terminal");
    await expect(
      toolVerdict(TOOLS.operate, { action: "press", name: "x" }, { workspace: dir }),
    ).rejects.toThrow("not available here");
  });

  it("describes a step for the record by what she asked for", () => {
    expect(
      describeRequest(TOOLS.operate, { action: "press", window: "kate", name: "Save" }),
    ).toEqual({ title: "Let her do this?", detail: 'Press "Save" in "kate"', note: null });
    expect(describeRequest(TOOLS.operate, { action: "type", text: "hello" }).detail).toBe(
      "Type into the window in front:\nhello",
    );
    expect(
      describeRequest(TOOLS.operate, { action: "key", window: "kate", keys: "ctrl+s" }).detail,
    ).toBe('Press the key ctrl+s in "kate"');
    expect(describeRequest(TOOLS.operate, { action: "controls", window: "kate" }).detail).toBe(
      'Read the controls of "kate"',
    );
    // A call it cannot read still gets a line in the record, without throwing.
    expect(describeRequest(TOOLS.operate, { action: "smash" })).toEqual({
      title: "Let her work in a program?",
      detail: "",
      note: null,
    });
    expect(describeRequest(TOOLS.operate, null).title).toBe("Let her work in a program?");
  });
});

describe("the gate, when a rule says how its question should be put", () => {
  type Asked = RequestSummary & { sensitive: boolean; rememberable: boolean };

  function makeHost(policy: Partial<PolicyContext> = {}): { host: ToolHost; asked: Asked[] } {
    const asked: Asked[] = [];
    let steps = 0;
    const host: ToolHost = {
      policy: () => context(policy),
      memory: undefined as never,
      learnAddresses: () => undefined,
      noteOutsideText: () => undefined,
      noteChange: () => undefined,
      signal: () => undefined,
      activity: () => undefined,
      ran: () => undefined,
      ask: (request) => {
        asked.push(request);
        return Promise.resolve(true);
      },
      step: () => (steps += 1),
    };
    return { host, asked };
  }

  const through = (host: ToolHost, tool: string): ((input: unknown) => Promise<string>) =>
    guarded<unknown>(
      host,
      tool,
      () => "x",
      () => Promise.resolve("ran"),
    );

  it('shows the rule\'s own question and its reason, and offers "for this chat" as the rule says', async () => {
    const { host, asked } = makeHost();
    const operate = through(host, TOOLS.operate);
    expect(await operate({ action: "press", window: "kate", name: "Bold" })).toBe("ran");
    expect(asked[0]).toMatchObject({
      title: "Let her work in this program?",
      detail: "org.kde.kate",
      sensitive: false,
      rememberable: true,
    });
    // The first step and the rule's reason both reach the user.
    expect(asked[0]?.note).toContain('First step: Press "Bold" in "notes.txt — Kate"');
    expect(asked[0]?.note).toContain("without asking each step");
  });

  it('does not offer "for this chat" when the rule says the step stands alone', async () => {
    const { host, asked } = makeHost();
    const operate = through(host, TOOLS.operate);
    await operate({ action: "press", window: "kate", name: "Delete" });
    expect(asked[0]).toMatchObject({
      title: "Let her do this?",
      detail: 'Press "Delete" in org.kde.kate ("notes.txt — Kate")',
      rememberable: false,
    });
    expect(asked[0]?.note).toBe("This could be hard to undo, so it is shown to you on its own.");
  });

  it('offers "for this chat" for reading controls, which is the same question every time', async () => {
    const { host, asked } = makeHost();
    await through(host, TOOLS.operate)({ action: "controls", window: "kate" });
    expect(asked[0]).toMatchObject({
      title: "Let her read this window's controls?",
      rememberable: true,
    });
  });

  it("keeps its usual answer for tools whose rules say nothing about it", async () => {
    const { host, asked } = makeHost({ readOutsideText: true });
    await through(host, TOOLS.lookAtScreen)({});
    await through(host, TOOLS.clipboard)({ action: "write", text: "pasted later" });
    await through(host, TOOLS.phone)({ action: "send_text", text: "milk" });
    expect(asked.map((request) => [request.title, request.rememberable])).toEqual([
      ["Let her look at your screen?", true],
      [asked[1]?.title, false],
      ["Send this to your phone?", false],
    ]);
  });

  it("asks nothing and runs nothing where the rule refuses outright", async () => {
    const { host, asked } = makeHost();
    const audited: string[] = [];
    host.audit = (entry) => audited.push(`${entry.outcome}:${entry.detail.replace(/\n/g, " ")}`);
    let ran = false;
    const operate = guarded<unknown>(
      host,
      TOOLS.operate,
      () => "x",
      () => {
        ran = true;
        return Promise.resolve("ran");
      },
    );
    expect(await operate({ action: "type", window: "konsole", text: "rm -rf ~" })).toMatch(
      /^That failed: That is a terminal/,
    );
    expect(ran).toBe(false);
    expect(asked).toEqual([]);
    expect(audited).toEqual(['failed:Type into "konsole": rm -rf ~']);
  });
});
