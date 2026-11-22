import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fleet, Machine } from "../src/core/fleet.ts";
import { planMission, type MissionStep } from "../src/core/missionPlan.ts";
import { judgeStep, NOT_AS_APPROVED, runStep, stepFingerprint } from "../src/core/missionRules.ts";
import {
  changesSomething,
  describePlan,
  missionFor,
  missionRequest,
  TOOLS,
  toolVerdict,
  type PolicyContext,
} from "../src/core/permissions.ts";

const nas: Machine = {
  id: "bbbbbbbbbbbbbbbb",
  name: "nas",
  host: "nas.local",
  port: 22,
  user: "admin",
  lookWithoutAsking: true,
};

function context(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    workspace: "/tmp/ws",
    home: "/home/captain",
    findMachine: (name) => {
      if (name.toLowerCase() !== "nas") throw new Error(`No machine is called "${name}".`);
      return nas;
    },
    machines: () => [nas],
    ...over,
  };
}

function step(command: string, where = "here"): MissionStep {
  return {
    title: "A step",
    where: where === "here" ? "here" : nas.id,
    whereName: where === "here" ? "this PC" : "nas",
    command,
    state: "waiting",
    retries: 0,
    tried: 0,
    output: "",
    approved: null,
    finishedAt: null,
  };
}

describe("what the rules say about a mission's step", () => {
  it("lets a step that only looks run, here and on a machine she may look at", async () => {
    expect(await judgeStep(step("ls -la /tmp/ws"), context())).toEqual({ decision: "allow" });
    expect(await judgeStep(step("uptime && df -h /", "nas"), context())).toEqual({
      decision: "allow",
    });
  });

  it("asks about a step that changes something, as it would in conversation", async () => {
    const local = await judgeStep(step("rm -rf /tmp/ws/old"), context());
    expect(local.decision).toBe("ask");
    const remote = await judgeStep(step("systemctl restart nginx", "nas"), context());
    expect(remote).toMatchObject({ decision: "ask", sensitive: false });
    // A place where secrets are kept is marked, so that it is asked at the PC only.
    const secret = await judgeStep(step("cat /home/captain/.ssh/id_ed25519"), context());
    expect(secret).toMatchObject({ decision: "ask", sensitive: true });
  });

  it("does nothing that changes anything while her hands are off the controls", async () => {
    const off = context({ handsOff: true });
    expect(await judgeStep(step("rm -rf /tmp/ws/old"), off)).toMatchObject({
      decision: "refuse",
      reason: expect.stringContaining("Hands off"),
    });
    // As in conversation, where any command on this PC counts as hers to keep off;
    // a plain status check on a machine does not.
    expect(await judgeStep(step("ls /tmp/ws"), off)).toMatchObject({ decision: "refuse" });
    expect(await judgeStep(step("uptime", "nas"), off)).toEqual({ decision: "allow" });
  });

  it("refuses a step whose machine is gone or is no longer the one the plan named", async () => {
    expect(await judgeStep(step("uptime", "nas"), context({ machines: () => [] }))).toMatchObject({
      decision: "refuse",
      reason: expect.stringContaining("no longer on the list"),
    });
    const renamed = context({ machines: () => [{ ...nas, name: "backup-box" }] });
    expect(await judgeStep(step("uptime", "nas"), renamed)).toMatchObject({
      decision: "refuse",
      reason: expect.stringContaining('now called "backup-box"'),
    });
  });

  it("judges the machine the step will run on, not another of the same name", async () => {
    // Two machines called "nas": she may look at one without asking, and not at the other.
    const other: Machine = { ...nas, id: "cccccccccccccccc", lookWithoutAsking: false };
    const both = context({
      machines: () => [other, nas],
      // Looked up by name, the rules would be shown the first of the two.
      findMachine: () => other,
    });
    expect(await judgeStep(step("uptime", "nas"), both)).toEqual({ decision: "allow" });
    const onOther = { ...step("uptime", "nas"), where: other.id };
    expect(await judgeStep(onOther, both)).toMatchObject({ decision: "ask" });
  });

  it("refuses a step whose command holds characters that cannot be seen", async () => {
    expect(await judgeStep(step("echo \u202Etxt.exe"), context())).toMatchObject({
      decision: "refuse",
      reason: expect.stringContaining("cannot be seen"),
    });
  });

  it("takes a yes as given to the command, the place and the machine's address and account", () => {
    const remote = step("apt-get -y upgrade", "nas");
    const print = stepFingerprint(remote, [nas]);
    expect(stepFingerprint(remote, [{ ...nas }])).toBe(print);
    // Whether she may look without asking does not change what a yes was given to.
    expect(stepFingerprint(remote, [{ ...nas, lookWithoutAsking: false }])).toBe(print);
    expect(stepFingerprint(remote, [{ ...nas, host: "10.0.0.66" }])).not.toBe(print);
    expect(stepFingerprint(remote, [{ ...nas, user: "root" }])).not.toBe(print);
    expect(stepFingerprint(remote, [{ ...nas, port: 2222 }])).not.toBe(print);
    expect(stepFingerprint(remote, [])).not.toBe(print);
    expect(stepFingerprint({ ...remote, command: "apt-get -y dist-upgrade" }, [nas])).not.toBe(
      print,
    );
    const local = step("ls");
    expect(stepFingerprint(local, [nas])).toBe(stepFingerprint(local, []));
  });
});

describe("taking a stopped mission up again", () => {
  it("is always put to the user, and never remembered", async () => {
    const verdict = await toolVerdict(TOOLS.missions, { resume: "m-abc123" }, context());
    expect(verdict).toMatchObject({ decision: "ask", sensitive: false, rememberable: false });
    // Stopping one, and looking, are as before.
    expect(await toolVerdict(TOOLS.missions, { stop: "m-abc123" }, context())).toEqual({
      decision: "allow",
    });
    expect(await toolVerdict(TOOLS.missions, {}, context())).toEqual({ decision: "allow" });
  });

  it("is not done for a message that came from another device", async () => {
    await expect(
      toolVerdict(TOOLS.missions, { resume: "m-abc123" }, context({ away: true })),
    ).rejects.toThrow(/at the PC only/);
    // Asking how the missions stand is still fine from there.
    expect(await toolVerdict(TOOLS.missions, {}, context({ away: true }))).toEqual({
      decision: "allow",
    });
  });
});

describe("taking a mission on", () => {
  const input = (): Record<string, unknown> => ({
    title: "Tidy the NAS",
    goal: "Free some room",
    steps: [
      { title: "See how full it is", where: "nas", command: "df -h /", retries: 0 },
      { title: "Clear old logs", where: "nas", command: "rm -rf /var/log/old", retries: 1 },
    ],
    start_in_minutes: 0,
  });

  it("shows the user the whole plan, step by step with each command, before she takes it on", async () => {
    const call = input();
    const verdict = await toolVerdict(TOOLS.planMission, call, context());
    if (verdict.decision !== "ask") throw new Error("expected a question");
    expect(verdict.summary?.title).toBe("Let her take on this mission?");
    expect(verdict.summary?.detail).toBe(
      [
        "Tidy the NAS",
        "For: Free some room",
        "",
        "1. See how full it is (on nas)",
        "   df -h /",
        "2. Clear old logs (on nas)",
        "   rm -rf /var/log/old",
        "   tried again up to 1 times if it fails",
      ].join("\n"),
    );
    expect(verdict.reason).toContain("put to you again");
    // The mission that runs is the one that was shown.
    expect(missionFor(call)?.steps.map((made) => made.command)).toEqual([
      "df -h /",
      "rm -rf /var/log/old",
    ]);
  });

  it("puts no question for a plan that cannot be made, so the tool can say why", async () => {
    const bad = { ...input(), steps: [{ title: "x", where: "mars", command: "ls" }] };
    expect(await toolVerdict(TOOLS.planMission, bad, context())).toEqual({ decision: "allow" });
    expect(missionFor(bad)).toBeUndefined();
  });

  it("reads a start time given in minutes, and ignores what is not a number", () => {
    const before = Date.now();
    const later = missionRequest({ ...input(), start_in_minutes: 90 });
    expect(Date.parse(later.notBefore ?? "")).toBeGreaterThanOrEqual(before + 90 * 60_000 - 1000);
    expect(missionRequest({ ...input(), start_in_minutes: "soon" }).notBefore).toBeNull();
    expect(missionRequest({ ...input(), start_in_minutes: 0 }).notBefore).toBeNull();
    expect(missionRequest("nonsense").steps).toEqual([]);
  });

  it("writes out a character in a plan's command that would not show", () => {
    const made = planMission(
      { title: "t", steps: [{ title: "x", command: "ls" }] },
      [],
      new Date(),
    );
    if ("problem" in made) throw new Error(made.problem);
    const only = made.mission.steps[0];
    if (!only) throw new Error("no step");
    // Not something a plan lets through: as if it had been written into the file.
    only.command = "echo \u202Etxt.exe";
    expect(describePlan(made.mission)).toContain("   echo <U+202E>txt.exe");
  });

  it("puts no question for a plan with an unseen character in a command", async () => {
    const bad = { ...input(), steps: [{ title: "x", where: "nas", command: "rm /srv/\u200Bx" }] };
    expect(await toolVerdict(TOOLS.planMission, bad, context())).toEqual({ decision: "allow" });
    expect(missionFor(bad)).toBeUndefined();
  });

  it("describes a plan that is to begin later with its time", () => {
    const made = planMission(
      { title: "Later", steps: [{ title: "x", command: "ls" }], notBefore: "2026-11-23T03:00:00Z" },
      [],
      new Date("2026-11-22T10:00:00Z"),
    );
    if ("problem" in made) throw new Error(made.problem);
    expect(describePlan(made.mission)).toMatch(/^Later\n\n1\. x\n {3}ls\nNot before /);
  });
});

describe("running a step", () => {
  const never = new AbortController().signal;

  it("runs a step that is still what was approved, and one that needed no yes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "aichan-step-"));
    try {
      const plain = await runStep(step("echo one"), { workspace, machines: () => [] }, never);
      expect(plain).toMatchObject({ ok: true });
      expect(plain.output).toContain("one");
      const approved: MissionStep = {
        ...step("echo two"),
        approved: {
          at: "2026-11-22T10:00:00.000Z",
          by: { from: "pc" },
          print: stepFingerprint(step("echo two"), []),
        },
      };
      const ran = await runStep(approved, { workspace, machines: () => [] }, never);
      expect(ran).toMatchObject({ ok: true });
      expect(ran.output).toContain("two");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not run a step whose yes was for something else", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "aichan-step-"));
    try {
      // The command under the yes is not the command that was approved.
      const swapped: MissionStep = {
        ...step("touch made-it"),
        approved: {
          at: "2026-11-22T10:00:00.000Z",
          by: { from: "pc" },
          print: stepFingerprint(step("ls"), []),
        },
      };
      expect(await runStep(swapped, { workspace, machines: () => [] }, never)).toEqual({
        ok: false,
        output: NOT_AS_APPROVED,
      });
      expect(existsSync(join(workspace, "made-it"))).toBe(false);

      // The machine was pointed somewhere else between the yes and the run.
      const sent: string[] = [];
      const fleet = {
        run: (machine: Machine, command: string) => {
          sent.push(`${machine.host}: ${command}`);
          return Promise.resolve({ code: 0, output: "", timedOut: false });
        },
      } as unknown as Fleet;
      const remote: MissionStep = {
        ...step("systemctl restart nginx", "nas"),
        approved: {
          at: "2026-11-22T10:00:00.000Z",
          by: { from: "device", name: "Galaxy" },
          print: stepFingerprint(step("systemctl restart nginx", "nas"), [nas]),
        },
      };
      const moved = [{ ...nas, host: "10.66.66.66" }];
      expect(await runStep(remote, { workspace, fleet, machines: () => moved }, never)).toEqual({
        ok: false,
        output: NOT_AS_APPROVED,
      });
      expect(sent).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Milestone 2 mission rules & device-pinning permissions", () => {
  const awayCtx: PolicyContext = { workspace: "/tmp/aichan-rules-test", away: true };
  const pcCtx: PolicyContext = { workspace: "/tmp/aichan-rules-test", away: false };

  it("refuses pin_to_devices, missions({ pin }), and missions({ unpin: true }) when away is true", async () => {
    await expect(
      toolVerdict(
        TOOLS.planMission,
        {
          title: "Deploy",
          steps: [{ title: "Step", command: "echo hi" }],
          pin_to_devices: true,
        },
        awayCtx,
      ),
    ).rejects.toThrow(/pinned to devices/i);

    await expect(toolVerdict(TOOLS.missions, { pin: "m-a1b2c3" }, awayCtx)).rejects.toThrow(
      /at the PC/i,
    );

    await expect(toolVerdict(TOOLS.missions, { unpin: true }, awayCtx)).rejects.toThrow(
      /at the PC/i,
    );
  });

  it("asks for approval when pinning a mission at the PC", async () => {
    const verdict = await toolVerdict(TOOLS.missions, { pin: "m-a1b2c3" }, pcCtx);
    expect(verdict).toMatchObject({ decision: "ask", rememberable: false });
  });

  it("describes wake triggers and pinned status in describePlan and detects state changes", () => {
    const made = planMission(
      missionRequest({
        title: "Nightly check",
        goal: "Check uptime",
        steps: [{ title: "Check", command: "uname -a" }],
        cron: "0 3 * * *",
        repeat_cron: true,
        pin_to_devices: true,
      }),
      [],
      new Date("2026-11-22T10:00:00Z"),
    );
    if ("problem" in made) throw new Error(made.problem);
    const text = describePlan(made.mission);
    expect(text).toContain("Wake trigger:");
    expect(text).toContain("Shared with your signed-in devices");

    expect(changesSomething(TOOLS.missions, { pin: "m-a1b2c3" })).toBe(true);
    expect(changesSomething(TOOLS.missions, { unpin: true })).toBe(true);
    expect(changesSomething(TOOLS.missions, { id: "m-a1b2c3", note: "keep going" })).toBe(true);
    expect(changesSomething(TOOLS.missions, {})).toBe(false);
  });
});
