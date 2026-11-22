import { describe, expect, it } from "vitest";
import { ApprovalDesk, type ApprovalCard } from "../src/core/missionApproval.ts";
import { describeFrom, planMission, type StepQuestion } from "../src/core/missionPlan.ts";

function question(sensitive = false): StepQuestion {
  const made = planMission(
    {
      title: "Update the server",
      steps: [
        { title: "Look", command: "ls /srv" },
        { title: "Upgrade", where: "proxmox", command: "apt-get -y upgrade" },
      ],
    },
    [{ id: "aaaaaaaaaaaaaaaa", name: "proxmox" }],
    new Date("2026-11-22T10:00:00Z"),
  );
  if ("problem" in made) throw new Error(made.problem);
  const step = made.mission.steps[1];
  if (!step) throw new Error("no step");
  return { mission: made.mission, index: 1, step, sensitive, reason: "It changes that machine." };
}

interface Rig {
  desk: ApprovalDesk;
  shown: { card: ApprovalCard; answer(allowed: boolean | null): void; closed: boolean }[];
  offered: ApprovalCard[];
  withdrawn: string[];
  answered: string[];
  game: { on: boolean };
}

function rig(): Rig {
  const shown: Rig["shown"] = [];
  const offered: ApprovalCard[] = [];
  const withdrawn: string[] = [];
  const answered: string[] = [];
  const game = { on: false };
  const desk = new ApprovalDesk({
    showAtPc: (card, _sensitive, signal) =>
      new Promise((resolve) => {
        const entry = { card, answer: resolve, closed: false };
        signal.addEventListener("abort", () => {
          entry.closed = true;
          resolve(null);
        });
        shown.push(entry);
      }),
    offer: (card) => offered.push(card),
    withdraw: (id) => withdrawn.push(id),
    gameOn: () => game.on,
    lookAgainMs: 10,
    onAnswered: (card, allowed, by) =>
      answered.push(`${card.command}: ${allowed} ${describeFrom(by)}`),
    now: () => new Date("2026-11-22T10:00:00Z"),
  });
  return { desk, shown, offered, withdrawn, answered, game };
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("putting a mission's step to the user", () => {
  it("asks at the PC and on the user's devices, with the exact command", async () => {
    const { desk, shown, offered } = rig();
    const asking = desk.ask(question(), new AbortController().signal);
    await tick();
    expect(shown).toHaveLength(1);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({
      mission: "Update the server",
      step: 2,
      steps: 2,
      title: "Upgrade",
      where: "proxmox",
      command: "apt-get -y upgrade",
      reason: "It changes that machine.",
    });
    expect(desk.cards().map((card) => card.id)).toEqual([offered[0]?.id]);
    shown[0]?.answer(true);
    await expect(asking).resolves.toEqual({ allowed: true, by: { from: "pc" } });
  });

  it("is settled by whoever answers first, and taken down everywhere else", async () => {
    const { desk, shown, offered, withdrawn, answered } = rig();
    const asking = desk.ask(question(), new AbortController().signal);
    await tick();
    const id = offered[0]?.id ?? "";
    expect(desk.answerFromDevice(id, false, "Galaxy S24+")).toBe(true);
    await expect(asking).resolves.toEqual({
      allowed: false,
      by: { from: "device", name: "Galaxy S24+" },
    });
    // The PC's question is closed, the card is taken down, and a second answer is no answer.
    expect(shown[0]?.closed).toBe(true);
    expect(withdrawn).toEqual([id]);
    expect(desk.answerFromDevice(id, true, "Galaxy S24+")).toBe(false);
    shown[0]?.answer(true);
    expect(desk.cards()).toEqual([]);
    expect(answered).toEqual(['apt-get -y upgrade: false on the device "Galaxy S24+"']);
  });

  it("keeps a step that touches secrets at the PC: no device is offered it or may answer it", async () => {
    const { desk, shown, offered } = rig();
    const asking = desk.ask(question(true), new AbortController().signal);
    await tick();
    expect(offered).toEqual([]);
    expect(desk.cards()).toEqual([]);
    const id = shown[0]?.card.id ?? "";
    expect(desk.answerFromDevice(id, true, "Galaxy S24+")).toBe(false);
    shown[0]?.answer(true);
    await expect(asking).resolves.toEqual({ allowed: true, by: { from: "pc" } });
  });

  it("puts nothing on the PC's screen over a game, but the phone can still answer", async () => {
    const { desk, shown, offered, game } = rig();
    game.on = true;
    const asking = desk.ask(question(), new AbortController().signal);
    await tick(40);
    expect(shown).toEqual([]);
    expect(offered).toHaveLength(1);
    game.on = false;
    await tick(40);
    expect(shown).toHaveLength(1);
    desk.answerFromDevice(offered[0]?.id ?? "", true, "Phone");
    await expect(asking).resolves.toMatchObject({
      allowed: true,
      by: { from: "device", name: "Phone" },
    });
  });

  it("answers nothing by itself: taken down unanswered, it is no answer at all", async () => {
    const { desk, shown, withdrawn } = rig();
    const stop = new AbortController();
    const asking = desk.ask(question(), stop.signal);
    await tick(30);
    stop.abort();
    await expect(asking).rejects.toThrow(/taken down before anyone answered/);
    expect(shown[0]?.closed).toBe(true);
    expect(withdrawn).toHaveLength(1);
    expect(desk.cards()).toEqual([]);
    // A question that was never open cannot be answered either.
    expect(desk.answerFromDevice("nonsense", true, "Phone")).toBe(false);
  });

  it("records an answer from a device as a device's, whatever the device calls itself", async () => {
    const { desk, offered, answered } = rig();
    const asking = desk.ask(question(), new AbortController().signal);
    await tick();
    // A phone that named itself "pc" is still a phone.
    expect(desk.answerFromDevice(offered[0]?.id ?? "", true, "pc")).toBe(true);
    await expect(asking).resolves.toEqual({ allowed: true, by: { from: "device", name: "pc" } });
    expect(answered).toEqual(['apt-get -y upgrade: true on the device "pc"']);
  });

  it("writes out, on the card, a character in the command that would not show", async () => {
    const { desk, shown, offered } = rig();
    const asked = question();
    // Not something a plan lets through: as if it had been written into the file.
    asked.step.command = "echo \u202Etxt.exe && rm -rf /srv/\u200Bold";
    void desk.ask(asked, new AbortController().signal).catch(() => undefined);
    await tick();
    expect(offered[0]?.command).toBe("echo <U+202E>txt.exe && rm -rf /srv/<U+200B>old");
    expect(shown[0]?.card.command).toBe(offered[0]?.command);
  });

  it("puts the question up at the PC again when it could not be shown", async () => {
    const offered: ApprovalCard[] = [];
    let tries = 0;
    let answer: (allowed: boolean | null) => void = () => undefined;
    const desk = new ApprovalDesk({
      showAtPc: () => {
        tries += 1;
        if (tries === 1) return Promise.reject(new Error("no window to show it in"));
        if (tries === 2) throw new Error("still none");
        return new Promise((resolve) => (answer = resolve));
      },
      offer: (card) => offered.push(card),
      lookAgainMs: 10,
    });
    const asking = desk.ask(question(true), new AbortController().signal);
    await tick(80);
    expect(tries).toBe(3);
    // Still open, and still answered by a person only.
    answer(true);
    await expect(asking).resolves.toEqual({ allowed: true, by: { from: "pc" } });
  });

  it("stops trying to show a question that has been answered elsewhere", async () => {
    const offered: ApprovalCard[] = [];
    let tries = 0;
    const desk = new ApprovalDesk({
      showAtPc: () => {
        tries += 1;
        return Promise.reject(new Error("no window to show it in"));
      },
      offer: (card) => offered.push(card),
      lookAgainMs: 10,
    });
    const asking = desk.ask(question(), new AbortController().signal);
    await tick(25);
    desk.answerFromDevice(offered[0]?.id ?? "", false, "Phone");
    await asking;
    const sofar = tries;
    await tick(50);
    expect(tries).toBe(sofar);
  });
});
