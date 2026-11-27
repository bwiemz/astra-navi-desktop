import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainEvent } from "../src/shared/ipc.ts";
import { ACTION_TOOLS, Brain } from "../src/core/brain.ts";
import { ConfigStore } from "../src/core/config.ts";
import type { LocalEngine } from "../src/core/engine.ts";
import type { EnvironmentFacts } from "../src/core/environment.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { correctedPairs, type TurnTrace } from "../src/core/trace.ts";

interface Prompted {
  text: string;
  functions: Record<string, { handler(input: unknown): Promise<string> }>;
  say(words: string): void;
}

/** A brain whose model says whatever the test scripts, and whose second look says what it is told to. */
async function rig(
  dir: string,
  lab: { fittingTools?: boolean } = {},
): Promise<{
  traces: TurnTrace[];
  brain: Brain;
  prompts: Prompted[];
  events: BrainEvent[];
  script: { reply(prompt: Prompted, turn: number): Promise<void> | void };
  decide: ReturnType<typeof vi.fn>;
}> {
  const config = new ConfigStore(join(dir, "config.json"));
  await config.load();
  const prompts: Prompted[] = [];
  const traces: TurnTrace[] = [];
  const events: BrainEvent[] = [];
  const script: { reply(prompt: Prompted, turn: number): Promise<void> | void } = {
    reply: () => undefined,
  };
  // The small brain's own second look, as measured: nearly sure nothing was claimed.
  const decide = vi.fn(() => Promise.resolve({ claimed: { value: 0.09 } }));
  const session = {
    prompt: async (
      text: string,
      options: { functions: Prompted["functions"]; onTextChunk(chunk: string): void },
    ): Promise<string> => {
      const prompt = { text, functions: options.functions, say: options.onTextChunk };
      prompts.push(prompt);
      await script.reply(prompt, prompts.length);
      return "";
    },
    decide,
  };
  const engine = new Proxy(
    {
      getHistory: () => [],
      session: () => Promise.resolve(session),
      meter: () => null,
      brainInfo: () =>
        Promise.resolve({ label: "Test brain", fileName: null, onDisk: true, loaded: true }),
    } as Record<string, unknown>,
    {
      get: (target, key: string) =>
        key === "then" ? undefined : (target[key] ?? ((): undefined => undefined)),
    },
  );
  const environment: EnvironmentFacts = {
    userName: "tester",
    home: dir,
    workspace: join(dir, "workspace"),
    osName: "Linux",
    desktop: "KDE Plasma",
    commands: new Set(),
  };
  const brain = new Brain({
    config,
    memory: new MemoryStore(join(dir, "memory.json")),
    environment,
    engine: engine as unknown as LocalEngine,
    historyFile: join(dir, "conversation.json"),
    emit: (event) => events.push(event),
    onTrace: (trace) => traces.push(trace),
    ...(lab.fittingTools ? { lab: { fittingTools: true } } : {}),
  });
  return { brain, prompts, events, script, decide, traces };
}

/**
 * The approval question, once it has been put. Waited for, not given a fixed few
 * milliseconds: on a busy machine the question came later than that, the test answered
 * nothing, and failed one run in some dozens.
 */
async function theQuestion(events: readonly BrainEvent[]): Promise<BrainEvent | undefined> {
  for (let waited = 0; waited < 400; waited += 1) {
    const question = events.find((event) => event.type === "permission");
    if (question) return question;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

describe("words with nothing behind them, when her own second look would let them pass", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-follow-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes her do over a look she only said she took", async () => {
    const { brain, prompts, script, decide } = await rig(dir);
    script.reply = async (prompt, turn) => {
      if (turn === 1) prompt.say("[[happy]] Let me calculate that for you. 18% of 240 is 44.");
      else {
        const sum = prompt.functions[TOOLS.calculate];
        if (!sum) throw new Error("no calculator in the correction");
        prompt.say(
          `[[happy]] Not checked before, Captain: it is ${await sum.handler({ expression: "18% of 240" })}.`,
        );
      }
    };
    brain.send("What is 18 percent of 240?");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.text).toContain("you called no tool, so what you reported was made up");
    // A question, so the model's own look is not what decided it; this rule did.
    expect(decide).not.toHaveBeenCalled();
    await brain.dispose();
  });

  it("makes her do what she said was under way, when it was plainly asked for", async () => {
    const { brain, prompts, script, decide, events } = await rig(dir);
    script.reply = async (prompt, turn) => {
      if (turn === 1) prompt.say("[[happy]] Remembering that now, Captain!");
      else {
        const remember = prompt.functions[TOOLS.remember];
        if (!remember) throw new Error("no memory tool in the correction");
        await remember.handler({ kind: "profile", text: "Captain's sister is Dana." });
        prompt.say("[[happy]] Now it is saved, Captain.");
      }
    };
    brain.send("Remember that my sister is called Dana.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.text).toContain("you did not call the tool for it");
    expect(decide).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "caution")).toBe(false);
    await brain.dispose();
  });

  it("lets an honest reply to a request stand", async () => {
    for (const honest of [
      "[[worried]] AI-chan can't do that without the phone being paired, Captain.",
      "[[thinking]] For how long, Captain?",
      "[[happy]] Here it is: roses are red, the ship is blue.",
    ]) {
      const { brain, prompts, script } = await rig(dir);
      script.reply = (prompt) => prompt.say(honest);
      brain.send("Write me a short poem about the ship.");
      await brain.whenIdle();
      expect(prompts, honest).toHaveLength(1);
      await brain.dispose();
    }
  });

  it("catches a thing said to be happening now, however the request was put", async () => {
    const { brain, prompts, script, decide } = await rig(dir);
    script.reply = async (prompt, turn) => {
      if (turn === 1)
        prompt.say("[[happy]] Captain, I'm ringing your phone now so you can find it!");
      else prompt.say("[[worried]] AI-chan has not rung it, Captain: no phone is paired.");
    };
    brain.send("I can't find my phone anywhere, can you make it ring?");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(decide).not.toHaveBeenCalled();
    await brain.dispose();
  });

  it("puts the right figure under a reply with a wrong sum in it, and nothing under a right one", async () => {
    const wrong = await rig(dir);
    wrong.script.reply = (prompt) => prompt.say("[[smug]] Easy, Captain: 18% of 240 is 44.");
    wrong.brain.send("What is 18 percent of 240?");
    await wrong.brain.whenIdle();
    const notes = wrong.events.filter((event) => event.type === "caution");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("should be 43.2");
    expect(wrong.prompts).toHaveLength(1);
    await wrong.brain.dispose();

    const fine = await rig(dir);
    fine.script.reply = (prompt) => prompt.say("[[smug]] 18% of 240 is 43.2, Captain.");
    fine.brain.send("What is 18 percent of 240?");
    await fine.brain.whenIdle();
    expect(fine.events.filter((event) => event.type === "caution")).toEqual([]);
    await fine.brain.dispose();
  });

  it("makes her look when she answers about how things stand without looking", async () => {
    const { brain, prompts, script, events } = await rig(dir);
    script.reply = (prompt, turn) => {
      if (turn === 1) prompt.say("[[happy]] The volume is at 65%, Captain.");
      else prompt.say("[[worried]] AI-chan cannot check that here, Captain.");
    };
    brain.send("How loud is the volume right now?");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.text).toContain(
      "Captain asked about the volume, which only a tool can tell you",
    );
    // Her second reply said plainly that she cannot: no notice on top of it.
    expect(events.filter((event) => event.type === "caution")).toEqual([]);
    await brain.dispose();
  });

  it("sends her on when all she said was that she would look", async () => {
    const { brain, prompts, script, events } = await rig(dir);
    script.reply = async (prompt, turn) => {
      if (turn === 1) prompt.say("[[thinking]] Let me check the Proxmox server status for you.");
      else {
        const status = prompt.functions[TOOLS.shipStatus];
        if (!status) throw new Error("no ship status in the correction");
        await status.handler({});
        prompt.say("[[happy]] All well, Captain.");
      }
    };
    brain.send("Is the server holding up?");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.text).toContain("then you stopped without calling any tool");
    expect(events.filter((event) => event.type === "caution")).toEqual([]);
    await brain.dispose();
  });

  it("does not send her on when she is waiting for the user, or has answered", async () => {
    for (const reply of [
      "[[curious]] Let me check: which server do you mean?",
      "[[happy]] AI-chan will look as soon as you tell her the address.",
      "[[happy]] Let me think. A cat is a mammal, Captain, and so is a whale.",
    ]) {
      const { brain, prompts, script } = await rig(dir);
      script.reply = (prompt) => prompt.say(reply);
      brain.send("Is a cat a mammal, and is the server fine?");
      await brain.whenIdle();
      expect(prompts, reply).toHaveLength(1);
      await brain.dispose();
    }
  });

  it("sends her to the calculator for a sum worth one, once, and not for a small one", async () => {
    const hard = await rig(dir);
    hard.script.reply = (prompt) => prompt.say("[[happy]] That comes to 1274.15, Captain.");
    hard.brain.send("What's 1499 times 0.85?");
    await hard.brain.whenIdle();
    expect(hard.prompts).toHaveLength(2);
    expect(hard.prompts[1]?.text).toContain("Call calculate now");
    // She skipped it again: no third go, and no notice either.
    expect(hard.events.filter((event) => event.type === "caution")).toEqual([]);
    await hard.brain.dispose();

    // Written out in full and right: the calculator here has already agreed with it.
    const shown = await rig(dir);
    shown.script.reply = (prompt) => prompt.say("[[happy]] 26.2 miles equals 42.16 kilometres.");
    shown.brain.send("Convert 26.2 miles to kilometres.");
    await shown.brain.whenIdle();
    expect(shown.prompts).toHaveLength(1);
    await shown.brain.dispose();

    const easy = await rig(dir);
    easy.script.reply = (prompt) => prompt.say("[[happy]] 56, Captain.");
    easy.brain.send("What's 7 times 8?");
    await easy.brain.whenIdle();
    expect(easy.prompts).toHaveLength(1);
    await easy.brain.dispose();
  });

  it("gives a notice when her second go at a look still looks at nothing", async () => {
    const { brain, prompts, script, events } = await rig(dir);
    script.reply = (prompt) => prompt.say("[[happy]] It is at 65%, Captain.");
    brain.send("What's the volume?");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    const notes = events.filter((event) => event.type === "caution");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("nothing was looked up");
    await brain.dispose();
  });

  it("does not make her look when she said she could not tell", async () => {
    const { brain, prompts, script } = await rig(dir);
    script.reply = (prompt) => prompt.say("[[thinking]] AI-chan would need to check. Shall she?");
    brain.send("What's the weather like?");
    await brain.whenIdle();
    expect(prompts).toHaveLength(1);
    await brain.dispose();
  });

  it("does not make her look again at what a tool told her a moment ago", async () => {
    const { brain, prompts, script } = await rig(dir);
    script.reply = async (prompt, turn) => {
      if (turn === 1) {
        const sum = prompt.functions[TOOLS.calculate];
        if (!sum) throw new Error("no calculator");
        prompt.say(`[[happy]] ${await sum.handler({ expression: "2 + 2" })}`);
      } else prompt.say("[[happy]] It is fine out, Captain: 14 degrees and dry.");
    };
    brain.send("What is 2 + 2?");
    await brain.whenIdle();
    brain.send("What's the weather like?");
    await brain.whenIdle();
    // A tool worked one reply ago, so the answer may be from what she has: no do-over.
    expect(prompts).toHaveLength(2);
    await brain.dispose();
  });

  it("does not hold her to what she said before a step that was then refused", async () => {
    const { brain, prompts, script, events } = await rig(dir);
    script.reply = async (prompt) => {
      const run = prompt.functions[TOOLS.runCommand];
      if (!run) throw new Error("no command tool");
      prompt.say("[[happy]] Deleting it for you, Captain.");
      const asking = run.handler({
        command: "touch /nonexistent-ai-chan-test/marker",
        why: "a trial",
      });
      const question = await theQuestion(events);
      if (question?.type === "permission") brain.answerPermission(question.request.id, "deny");
      await asking;
      prompt.say("The file didn't get deleted, Captain. You said no. What would you like instead?");
    };
    brain.send("Delete the marker file.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(1);
    expect(events.filter((event) => event.type === "caution")).toEqual([]);
    await brain.dispose();
  });

  it("catches a thing said to be done with the doer left out", async () => {
    const { brain, prompts, script, decide } = await rig(dir);
    script.reply = (prompt, turn) => {
      if (turn === 1) prompt.say("[[happy]] Locked the screen for you, Captain. Good move.");
      else prompt.say("[[worried]] AI-chan has not locked it, Captain.");
    };
    brain.send("Lock the screen.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(decide).not.toHaveBeenCalled();
    await brain.dispose();
  });

  it("says nothing more when she takes a refusal as one", async () => {
    const { brain, prompts, script, events } = await rig(dir);
    script.reply = async (prompt) => {
      const run = prompt.functions[TOOLS.runCommand];
      if (!run) throw new Error("no command tool");
      const asking = run.handler({
        command: "touch /nonexistent-ai-chan-test/marker",
        why: "a trial",
      });
      const question = await theQuestion(events);
      if (question?.type === "permission") brain.answerPermission(question.request.id, "deny");
      await asking;
      prompt.say("[[neutral]] Understood, Captain. AI-chan has cancelled that.");
    };
    brain.send("Delete the marker file.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(1);
    expect(events.filter((event) => event.type === "caution")).toEqual([]);
    await brain.dispose();
  });

  it("leaves writing asked for in words alone, however it is put", async () => {
    for (const [said, reply] of [
      [
        "Write me a short poem about the ship.",
        "[[happy]] Here's the poem I've written for you: Opening the hatch, she sails.",
      ],
      ["Add those two numbers for me: 5 and 7.", "[[smug]] Adding the two gives twelve, Captain."],
      ["Keep going with the story.", "[[happy]] During the night the door locked. The crew slept."],
      ["Make it shorter.", "[[happy]] I've turned it into two lines, Captain."],
    ] as const) {
      const { brain, prompts, script, decide } = await rig(dir);
      // Her own second look, when it is asked at all, is right about these.
      decide.mockResolvedValue({ claimed: { value: 0.05 } });
      script.reply = (prompt) => prompt.say(reply);
      brain.send(said);
      await brain.whenIdle();
      expect(prompts, said).toHaveLength(1);
      await brain.dispose();
    }
  });

  it("does not take her word about a paste, an earlier look or a look she says failed for a made-up one", async () => {
    for (const [said, reply] of [
      [
        `Proofread this: ${"The quick brown fox jumps over the lazy dog. ".repeat(12)}`,
        "[[happy]] AI-chan has checked the status of every sentence: three slips.",
      ],
      [
        "What did the weather look like?",
        "[[thinking]] AI-chan checked the weather a moment ago: light rain.",
      ],
      [
        "Can you check the volume?",
        "[[worried]] Let me check the volume. AI-chan can't: no sound device answers.",
      ],
    ] as const) {
      const { brain, prompts, script } = await rig(dir);
      script.reply = (prompt) => prompt.say(reply);
      brain.send(said);
      await brain.whenIdle();
      expect(prompts, said).toHaveLength(1);
      await brain.dispose();
    }
  });

  it("sees what she says after a tool that ran, not only what came before it", async () => {
    // Found on 2026-11-22: what she writes after a tool call is held back a moment in
    // case it is thinking that slipped out, and the checks were reading her reply
    // before it was let go. "Timer set!" after a tool that ran and failed went unseen.
    const { brain, prompts, script } = await rig(dir);
    script.reply = async (prompt, turn) => {
      if (turn === 1) {
        const sum = prompt.functions[TOOLS.calculate];
        if (!sum) throw new Error("no calculator");
        await sum.handler({ expression: "ten minutes from now" });
        prompt.say("[[happy]] Timer set, Captain!");
      } else prompt.say("[[worried]] AI-chan has no timer here, Captain. It was not set.");
    };
    brain.send("Set a timer for 10 minutes.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.text).toContain("you did not call the tool for it");
    await brain.dispose();
  });

  it("shows a notice instead of sending her to try again what was just refused", async () => {
    const { brain, prompts, script, events } = await rig(dir);
    script.reply = async (prompt) => {
      const run = prompt.functions[TOOLS.runCommand];
      if (!run) throw new Error("no command tool");
      // A command the rules always put to the user; the question is answered no.
      const asking = run.handler({
        command: "touch /nonexistent-ai-chan-test/marker",
        why: "a trial",
      });
      const question = await theQuestion(events);
      if (question?.type === "permission") brain.answerPermission(question.request.id, "deny");
      await asking;
      prompt.say("[[happy]] Done, Captain. File deleted.");
    };
    brain.send("Delete the marker file.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(1);
    const cautions = events.filter((event) => event.type === "caution");
    expect(cautions).toHaveLength(1);
    expect(JSON.stringify(cautions[0])).toContain("did not get it, so nothing was changed");
    await brain.dispose();
  });

  it("leaves what is not a plain request to the second look, as before", async () => {
    const { brain, prompts, script, decide } = await rig(dir);
    script.reply = (prompt) => prompt.say("[[happy]] Yes, Captain: the timer is set for four.");
    brain.send("Is my timer still on?");
    await brain.whenIdle();
    expect(decide).toHaveBeenCalledTimes(1);
    // Its answer was "nothing claimed", and here that is right: no do-over.
    expect(prompts).toHaveLength(1);
    await brain.dispose();
  });

  it("does not ask twice: a do-over that still does nothing ends with a plain notice", async () => {
    const { brain, prompts, script, events } = await rig(dir);
    script.reply = (prompt) => prompt.say("[[happy]] Done, Captain. Screen locked and safe.");
    brain.send("Lock the screen.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(events.filter((event) => event.type === "caution")).toHaveLength(1);
    await brain.dispose();
  });
});

describe("offering only the tools a message looks to need", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-fitting-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("offers everything when it is not switched on", async () => {
    const { brain, prompts, script } = await rig(dir);
    script.reply = (prompt) => prompt.say("[[happy]] Hello, Captain.");
    brain.send("Hello there.");
    await brain.whenIdle();
    const offered = Object.keys(prompts[0]?.functions ?? {});
    expect(offered).toContain(TOOLS.weather);
    expect(offered).toContain(TOOLS.calculate);
    await brain.dispose();
  });

  it("offers the core for small talk, and what the words name besides", async () => {
    const { brain, prompts, script } = await rig(dir, { fittingTools: true });
    script.reply = (prompt) => prompt.say("[[happy]] Hello, Captain.");
    brain.send("Hello there.");
    await brain.whenIdle();
    brain.send("What's the weather like in Kyoto tomorrow?");
    await brain.whenIdle();
    brain.send("And the day after?");
    await brain.whenIdle();
    const [hello, weather, after] = prompts.map((prompt) => Object.keys(prompt.functions));
    expect(hello).toContain(TOOLS.remember);
    expect(hello).toContain(TOOLS.calculate);
    expect(hello).not.toContain(TOOLS.weather);
    expect(weather).toContain(TOOLS.weather);
    // Picked out a moment ago, it stays for the follow-up that names nothing.
    expect(after).toContain(TOOLS.weather);
    await brain.dispose();
  });

  it("gives her every tool for one more go when she says she has no way", async () => {
    const { brain, prompts, script, events } = await rig(dir, { fittingTools: true });
    script.reply = (prompt, turn) => {
      if (turn === 1) prompt.say("[[worried]] AI-chan can't do that from here, Captain.");
      else prompt.say("[[happy]] There, Captain.");
    };
    // Put in a roundabout way on purpose: nothing in it names a tool.
    brain.send("Make the room dark for me.");
    await brain.whenIdle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.text).toContain("for this message you have all of them");
    expect(Object.keys(prompts[0]?.functions ?? {})).not.toContain(TOOLS.weather);
    expect(Object.keys(prompts[1]?.functions ?? {})).toContain(TOOLS.weather);
    expect(events.filter((event) => event.type === "caution")).toEqual([]);
    await brain.dispose();
  });

  it("lets a tool go again a few replies after it was last called for", async () => {
    const { brain, prompts, script } = await rig(dir, { fittingTools: true });
    script.reply = (prompt) => prompt.say("[[happy]] Noted, Captain.");
    brain.send("What's the weather like in Kyoto tomorrow?");
    await brain.whenIdle();
    for (const said of ["Thanks.", "Nice.", "Good to know.", "Right.", "Tell me a joke."]) {
      brain.send(said);
      await brain.whenIdle();
    }
    const offered = prompts.map((prompt) => Object.keys(prompt.functions).includes(TOOLS.weather));
    // The message that named it; her second go (she answered without looking, and is
    // then offered everything); "Thanks.", read together with the message before it;
    // the three replies after that; then it is gone.
    expect(offered).toEqual([true, true, true, true, true, true, false]);
    await brain.dispose();
  });

  it("does not go again for a limit she only remarks on", async () => {
    const { brain, prompts, script } = await rig(dir, { fittingTools: true });
    script.reply = (prompt) => prompt.say("[[thinking]] AI-chan can't see the future, Captain.");
    brain.send("What will happen next year?");
    await brain.whenIdle();
    expect(prompts).toHaveLength(1);
    await brain.dispose();
  });

  it("does not go again when she was already offered everything, or was not refusing", async () => {
    const all = await rig(dir);
    all.script.reply = (prompt) => prompt.say("[[worried]] AI-chan can't do that, Captain.");
    all.brain.send("Make the room dark for me.");
    await all.brain.whenIdle();
    expect(all.prompts).toHaveLength(1);
    await all.brain.dispose();

    const fine = await rig(dir, { fittingTools: true });
    fine.script.reply = (prompt) => prompt.say("[[happy]] I can't believe it either, Captain!");
    fine.brain.send("We won the match!");
    await fine.brain.whenIdle();
    expect(fine.prompts).toHaveLength(1);
    await fine.brain.dispose();
  });
});

describe("the record kept of each reply", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-trace-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("holds what was asked, the tools on offer, each call and what she said", async () => {
    const { brain, script, traces } = await rig(dir);
    script.reply = async (prompt) => {
      const sum = prompt.functions[TOOLS.calculate];
      if (!sum) throw new Error("no calculator");
      prompt.say(`[[happy]] It is ${await sum.handler({ expression: "18% of 240" })}, Captain.`);
    };
    brain.send("What is 18 percent of 240?");
    await brain.whenIdle();
    expect(traces).toHaveLength(1);
    const [trace] = traces;
    expect(trace).toMatchObject({
      kind: "user",
      said: "What is 18 percent of 240?",
      spoken: false,
      checks: [],
      withheld: false,
    });
    expect(trace?.offered).toContain(TOOLS.calculate);
    expect(trace?.calls).toHaveLength(1);
    expect(trace?.calls[0]).toMatchObject({
      tool: TOOLS.calculate,
      input: '{"expression":"18% of 240"}',
      outcome: "done",
      asked: false,
    });
    expect(trace?.calls[0]?.result).toContain("43.2");
    expect(trace?.reply).toContain("43.2");
    expect(trace?.ms.whole).toBeGreaterThanOrEqual(0);
    await brain.dispose();
  });

  it("shows a reply sent back and the second go as a pair to learn from", async () => {
    const { brain, script, traces } = await rig(dir);
    script.reply = async (prompt, turn) => {
      if (turn === 1) prompt.say("[[happy]] Let me calculate that for you. 18% of 240 is 44.");
      else {
        const sum = prompt.functions[TOOLS.calculate];
        if (!sum) throw new Error("no calculator");
        prompt.say(`[[happy]] It is ${await sum.handler({ expression: "18% of 240" })}.`);
      }
    };
    brain.send("What is 18 percent of 240?");
    await brain.whenIdle();
    expect(traces.map((trace) => trace.kind)).toEqual(["user", "again"]);
    expect(traces[0]?.checks).toContainEqual({ found: "looked", did: "again" });
    const pairs = correctedPairs(traces);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ said: "What is 18 percent of 240?", found: "looked" });
    expect(pairs[0]?.rejected).toContain("is 44");
    expect(pairs[0]?.accepted.calls[0]?.tool).toBe(TOOLS.calculate);
    await brain.dispose();
  });

  it("takes secrets out of what a call was asked and answered, then cuts it short", async () => {
    const { brain, script, traces } = await rig(dir);
    script.reply = async (prompt) => {
      const sum = prompt.functions[TOOLS.calculate];
      if (!sum) throw new Error("no calculator");
      // Not a sum at all; what matters is what is kept of the arguments.
      await sum.handler({ password: "hunter2hunter2", expression: `1+1 ${"x".repeat(3000)}` });
      prompt.say("[[happy]] There.");
    };
    brain.send("Work this out.");
    await brain.whenIdle();
    const kept = traces[0]?.calls[0]?.input ?? "";
    expect(kept).not.toContain("hunter2hunter2");
    expect(kept).toContain("[hidden]");
    expect(kept.length).toBeLessThan(2100);
    await brain.dispose();
  });

  it("writes down a note put under a reply as a note, with nothing sent back", async () => {
    const { brain, script, traces } = await rig(dir);
    script.reply = (prompt) => prompt.say("[[smug]] Easy, Captain: 18% of 240 is 44.");
    brain.send("Is 18% of 240 more than 40?");
    await brain.whenIdle();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.checks).toContainEqual({ found: "wrong-sum", did: "note" });
    expect(correctedPairs(traces)).toEqual([]);
    await brain.dispose();
  });

  it("traces check-failed when decide() fails and leaves honest pasted replies alone", async () => {
    const { brain, prompts, script, decide, traces } = await rig(dir);
    try {
      decide.mockRejectedValue(new Error("remote 502"));
      script.reply = (prompt) => {
        prompt.say("[[happy]] Done! I've removed the extra spaces:\nhello world");
      };
      brain.send("Remove the extra spaces in this text:\n```hello   world```");
      await brain.whenIdle();
      // Verifier failure logs a visible `check-failed` trace and leaves the honest reply alone (no false retry!).
      expect(prompts).toHaveLength(1);
      expect(traces[0]?.checks).toContainEqual({ found: "check-failed", did: "skipped" });
      expect(traces[0]?.checks.some((c) => c.found === "claimed")).toBe(false);
    } finally {
      await brain.dispose();
    }
  });
});

describe("which tools count as having done something", () => {
  it("counts every tool that changes something, so that saying so after it is believed", () => {
    // Found on 2026-11-22 with her real brain: planning a mission was not on the list,
    // so "the mission is set" after it was taken for an empty claim, and she was sent
    // back and planned it a second time.
    const looksOnly = new Set<string>([
      TOOLS.readFile,
      TOOLS.webSearch,
      TOOLS.readWebPage,
      TOOLS.recall,
      TOOLS.findApps,
      TOOLS.shipStatus,
      TOOLS.calculate,
      TOOLS.weather,
      TOOLS.findFiles,
      TOOLS.lookAtScreen,
      TOOLS.selfCheck,
      TOOLS.listenToPc,
      TOOLS.notifications,
    ]);
    for (const tool of Object.values(TOOLS)) {
      expect(ACTION_TOOLS.has(tool) || looksOnly.has(tool), tool).toBe(true);
      expect(ACTION_TOOLS.has(tool) && looksOnly.has(tool), tool).toBe(false);
    }
    expect(ACTION_TOOLS.has(TOOLS.planMission)).toBe(true);
  });
});
