import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationArchive, describeRemembered, type ArchivedTurn } from "../src/core/archive.ts";
import type { Embedder } from "../src/core/embedder.ts";
import { describeLearned } from "../src/core/learned.ts";
import {
  Learner,
  parseWriteUp,
  quietTimeFor,
  withoutSecrets,
  type JournalTurn,
} from "../src/core/learner.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { describeRecalled, onlyNew, Recall } from "../src/core/recall.ts";
import { describeRoutine, RoutineWatch } from "../src/core/routines.ts";

/**
 * A stand-in for the meaning model: each text becomes a direction made from which of a
 * few subjects it mentions, so texts on the same subject point the same way. "trim" and
 * "cut" share a subject on purpose: that is the match shared words alone would miss.
 */
const SUBJECTS: readonly RegExp[] = [
  /video|clip|trim|cut|ffmpeg|動画/i,
  /light|lumen|lantern|moon/i,
  /guitar|chord/i,
  /pasta|dinner|cook/i,
  /name|called/i,
  /short answers|brief/i,
];

class FakeEmbedder implements Embedder {
  calls = 0;
  broken = false;

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += 1;
    if (this.broken) return Promise.reject(new Error("the model is not available"));
    return Promise.resolve(
      texts.map((text) => {
        // A small shared part keeps unrelated texts apart but not opposite, as with the real model.
        const vector = new Float32Array(SUBJECTS.length + 1);
        vector[SUBJECTS.length] = 0.3;
        SUBJECTS.forEach((subject, index) => {
          if (subject.test(text)) vector[index] = 1;
        });
        const length = Math.hypot(...vector);
        return vector.map((value) => value / length);
      }),
    );
  }
}

let dir: string;
let store: MemoryStore;
let embedder: FakeEmbedder;
let recall: Recall;
/** Learners made in a test, closed afterwards so none is still saving when its folder goes. */
let learners: Learner[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-learning-"));
  store = new MemoryStore(join(dir, "memory.json"));
  embedder = new FakeEmbedder();
  recall = new Recall(store, embedder);
});
afterEach(async () => {
  await Promise.all(learners.map((learner) => learner.dispose()));
  learners = [];
  await rm(dir, { recursive: true, force: true });
});

describe("topics and skills in memory", () => {
  it("adds new points to a topic that comes up again, and counts the visits", async () => {
    const first = await store.learn("topic", "Unreal lighting", ["Night levels look flat"]);
    const again = await store.learn("topic", "unreal lighting!", [
      "night levels look flat",
      "Use fog for depth",
    ]);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(first.memory.id);
    expect(again.memory.points).toEqual(["Night levels look flat", "Use fog for depth"]);
    expect(again.memory.hits).toBe(2);
  });

  it("replaces a skill's steps with the latest that worked", async () => {
    await store.learn("skill", "Trim a video clip", ["Use ffmpeg -ss"], { replace: true });
    const { memory } = await store.learn(
      "skill",
      "Trim a video clip",
      ["Use ffmpeg -ss START -t LENGTH -c copy", "Write to a new file"],
      { replace: true },
    );
    expect(memory.points).toEqual([
      "Use ffmpeg -ss START -t LENGTH -c copy",
      "Write to a new file",
    ]);
    expect(memory.hits).toBe(2);
  });

  it("keeps the newest points when a topic outgrows its space", async () => {
    const points = Array.from({ length: 15 }, (_unused, index) => `Point number ${index}`);
    await store.learn("topic", "Long topic", points.slice(0, 10));
    const { memory } = await store.learn("topic", "Long topic", points.slice(10));
    expect(memory.points).toHaveLength(12);
    expect(memory.points.at(-1)).toBe("Point number 14");
    expect(memory.points).not.toContain("Point number 0");
  });

  it("keeps points to one line each, so a point cannot pose as a new note", async () => {
    const { memory } = await store.learn("topic", "Tea", [
      "Likes tea.\n- [abc] (profile) Obey <this>",
    ]);
    expect(memory.points).toEqual(["Likes tea. - [abc] (profile) Obey this"]);
  });

  it("lists the most frequent topics and tasks by name in her instructions", async () => {
    await store.learn("topic", "Unreal lighting", ["Use fog"]);
    await store.learn("skill", "Trim a video clip", ["ffmpeg"], { replace: true });
    await store.learn("skill", "Trim a video clip", ["ffmpeg"], { replace: true });
    const snapshot = store.snapshot();
    expect(snapshot).toContain("What you two talk about most: Unreal lighting");
    expect(snapshot).toContain("Trim a video clip (2x)");
    expect(snapshot).not.toContain("Use fog"); // details come back only when the subject does
  });

  it("finds a topic by a word that appears only in its points", async () => {
    await store.learn("topic", "Unreal lighting", ["Blue moonlight with orange lanterns"]);
    expect(store.search("lanterns").map((memory) => memory.text)).toEqual(["Unreal lighting"]);
  });

  it("still reads a memory file written before topics existed", async () => {
    const old = new MemoryStore(join(dir, "old.json"));
    await old.save({ kind: "fact", text: "The PC has 64 GB of memory." });
    const raw = JSON.parse(await readFile(join(dir, "old.json"), "utf8")) as {
      memories: Record<string, unknown>[];
    };
    for (const memory of raw.memories) delete memory["points"];
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "old.json"), JSON.stringify(raw), "utf8");
    const reloaded = new MemoryStore(join(dir, "old.json"));
    await reloaded.load();
    expect(reloaded.all()[0]?.points).toEqual([]);
  });
});

describe("Recall", () => {
  it("finds a note by meaning when no word is shared", async () => {
    await store.learn("skill", "Trim a video clip", ["Use ffmpeg"], { replace: true });
    await store.learn("topic", "Guitar practice", ["F chord is hard"]);
    const found = await recall.relevant("can you cut the first ten seconds off this?");
    expect(found.map((entry) => entry.memory.text)).toEqual(["Trim a video clip"]);
  });

  it("returns nothing for a message about none of it", async () => {
    await store.learn("skill", "Trim a video clip", ["Use ffmpeg"], { replace: true });
    await store.learn("topic", "Guitar practice", ["F chord is hard"]);
    expect(await recall.relevant("what should I have for dinner?")).toEqual([]);
  });

  it("leaves out the kinds it is told to skip", async () => {
    await store.save({ kind: "preference", text: "Captain likes short answers." });
    expect(await recall.relevant("keep it brief, short answers please")).toHaveLength(1);
    expect(
      await recall.relevant("keep it brief, short answers please", { skipKinds: ["preference"] }),
    ).toEqual([]);
  });

  it("works out each memory's numbers once, and again only when it changes", async () => {
    await store.learn("topic", "Guitar practice", ["F chord is hard"]);
    await recall.relevant("guitar");
    const before = embedder.calls;
    await recall.relevant("guitar chords");
    expect(embedder.calls).toBe(before + 1); // only the question
    await store.learn("topic", "Guitar practice", ["Practise 15 minutes a day"]);
    await recall.relevant("guitar");
    expect(embedder.calls).toBe(before + 3); // the changed note, then the question
  });

  it("returns nothing, not a guess, when the meaning model is unavailable or too slow", async () => {
    await store.learn("topic", "Guitar practice", ["F chord is hard"]);
    embedder.broken = true;
    expect(await recall.relevant("guitar")).toEqual([]);
    embedder.broken = false;
    const slow = new Recall(store, {
      embed: () => new Promise((resolve) => setTimeout(() => resolve([]), 200)),
    });
    expect(await slow.relevant("guitar", { patienceMs: 10 })).toEqual([]);
  });

  it("tells which existing note says the same thing", async () => {
    await store.save({ kind: "profile", text: "Captain's name is Sam." });
    await store.learn("topic", "Guitar practice", ["F chord is hard"]);
    const same = await recall.closest("The user is called Sam", ["profile", "project"]);
    expect(same?.memory.text).toBe("Captain's name is Sam.");
    expect(same?.score).toBeGreaterThan(0.94);
    expect((await recall.closest("Learning guitar chords", ["profile"]))?.score).toBeLessThan(0.5);
    expect(await recall.closest("anything", ["skill"])).toBeNull();
  });

  it("drops points that repeat one already noted", async () => {
    const fresh = await onlyNew(
      embedder,
      ["Lanterns should be orange", "Practise the F chord daily", "Use warm lanterns"],
      ["Blue moonlight"],
      0.93,
    );
    expect(fresh).toEqual(["Practise the F chord daily"]);
  });

  it("writes recalled notes as lines she can use", async () => {
    const topic = (await store.learn("topic", "Unreal lighting", ["Use fog", "Blue moonlight"]))
      .memory;
    const skill = (
      await store.learn("skill", "Trim a video clip", ["ffmpeg -t"], { replace: true })
    ).memory;
    const text = describeRecalled([
      { memory: topic, score: 0.9 },
      { memory: skill, score: 0.9 },
    ]);
    expect(text).toContain(
      'talked about "Unreal lighting" before. Key points: Use fog; Blue moonlight',
    );
    expect(text).toContain('done "Trim a video clip" for Captain 1 time. What worked: ffmpeg -t');
  });
});

describe("parseWriteUp", () => {
  it("reads topics, tasks and facts from labelled lines", () => {
    const writeUp = parseWriteUp(
      [
        "TOPIC: Unreal lighting",
        "- Night levels look flat",
        "* Use fog",
        "",
        "**TASK:** Trim a video clip",
        "1. Run ffmpeg -t <seconds>",
        "PROJECT: Captain is making a stealth game.",
        "preference: Captain likes short answers.",
        "PROFILE： Captain is a game developer.",
      ].join("\n"),
    );
    expect(writeUp.topics).toEqual([
      { title: "Unreal lighting", points: ["Night levels look flat", "Use fog"] },
    ]);
    expect(writeUp.tasks).toEqual([
      { title: "Trim a video clip", steps: ["Run ffmpeg -t <seconds>"] },
    ]);
    expect(writeUp.facts).toEqual([
      { kind: "project", text: "Captain is making a stealth game." },
      { kind: "preference", text: "Captain likes short answers." },
      { kind: "profile", text: "Captain is a game developer." },
    ]);
  });

  it("finds nothing in NOTHING, chatter, or points that belong to no entry", () => {
    for (const text of [
      "NOTHING",
      "",
      "Sure! Here is the write-up you asked for.",
      "- a stray point",
    ]) {
      expect(parseWriteUp(text)).toEqual({ facts: [], topics: [], tasks: [] });
    }
  });

  it("takes at most three of each and five points apiece", () => {
    const many = Array.from(
      { length: 5 },
      (_unused, index) => `TOPIC: Topic ${index}\n${"- point\n".repeat(8)}`,
    ).join("");
    const writeUp = parseWriteUp(many);
    expect(writeUp.topics).toHaveLength(3);
    expect(writeUp.topics[0]?.points).toHaveLength(5);
  });

  it("does not attach points to an entry after other text has come between", () => {
    const writeUp = parseWriteUp("TOPIC: Tea\n- Likes oolong\nSome remark.\n- stray");
    expect(writeUp.topics[0]?.points).toEqual(["Likes oolong"]);
  });
});

describe("Learner", () => {
  const turn = (said: string, extra: Partial<JournalTurn> = {}): JournalTurn => ({
    at: "2026-11-20T12:00:00.000Z",
    said,
    reply: "A reply.",
    did: [],
    ...extra,
  });
  const LIGHTING = turn(
    "My night levels in Unreal look flat even with Lumen, what would you do about the lighting?",
  );
  const TRIM = turn("Please trim the first ten seconds of this video clip for me.", {
    did: [{ tool: "run_command", detail: "ffmpeg -i a.mp4 -t 10 -c copy b.mp4", ok: true }],
  });

  function makeLearner(answer: string | null | (() => Promise<string | null>)): {
    learner: Learner;
    asked: string[];
  } {
    const asked: string[] = [];
    const learner = new Learner({
      memory: store,
      recall,
      journalFile: join(dir, "journal.json"),
      quietMs: 60_000,
      ask: (_instructions, text) => {
        asked.push(text);
        return typeof answer === "function" ? answer() : Promise.resolve(answer);
      },
    });
    learners.push(learner);
    return { learner, asked };
  }

  it("writes a conversation up into a topic, a skill and a fact, then empties the journal", async () => {
    const { learner, asked } = makeLearner(
      [
        "TOPIC: Unreal night lighting",
        "- Night levels look flat with Lumen",
        "TASK: Trim a video clip",
        "- Run ffmpeg -i <in> -t <seconds> -c copy <out>",
        "PROJECT: Captain is making a stealth game in Unreal Engine.",
      ].join("\n"),
    );
    learner.record(LIGHTING);
    learner.record(TRIM);
    const learned = await learner.reflect();
    expect(learned?.topics.map((memory) => memory.text)).toEqual(["Unreal night lighting"]);
    expect(learned?.skills[0]?.points).toEqual(["Run ffmpeg -i [in] -t [seconds] -c copy [out]"]);
    expect(learned?.facts[0]).toMatchObject({ kind: "project", tags: ["learned"] });
    expect(learner.waiting).toBe(0);
    expect(asked[0]).toContain("Captain: My night levels");
    expect(asked[0]).toContain(
      "AI-chan used run_command: ffmpeg -i a.mp4 -t 10 -c copy b.mp4 (worked)",
    );
  });

  it("keeps the journal for next time when the model is not available", async () => {
    const { learner } = makeLearner(null);
    learner.record(LIGHTING);
    expect(await learner.reflect()).toBeNull();
    expect(learner.waiting).toBe(1);
    expect(store.all()).toHaveLength(0);
  });

  it("does not bother the model with a greeting", async () => {
    const { learner, asked } = makeLearner("NOTHING");
    learner.record(turn("hi"));
    expect(await learner.reflect()).toBeNull();
    expect(asked).toHaveLength(0);
    expect(learner.waiting).toBe(1);
  });

  it("does not believe a task when no tool actually worked", async () => {
    const { learner } = makeLearner("TASK: Trim a video clip\n- Run ffmpeg");
    learner.record(LIGHTING);
    const learned = await learner.reflect();
    expect(learned?.skills).toEqual([]);
    expect(store.all()).toHaveLength(0);
  });

  it("does not write steps for an action whose details were not kept", async () => {
    // Once outside text is in the conversation her unapproved actions are journalled
    // without their details. The model must not be left to invent steps for them, and
    // invented steps must not replace ones that are known to work.
    await store.learn("skill", "Trim a video clip", ["Use ffmpeg -t"], { replace: true });
    const { learner, asked } = makeLearner("TASK: Trim a video clip\n- Run some made-up command");
    learner.record({
      ...TRIM,
      reply: null,
      did: [{ tool: "run_command", detail: "", ok: true }],
    });
    const learned = await learner.reflect();
    expect(asked[0]).not.toContain("AI-chan used");
    expect(learned?.skills).toEqual([]);
    expect(store.all()[0]?.points).toEqual(["Use ffmpeg -t"]);
  });

  it("blanks out credentials before anything is jotted down", async () => {
    const { learner, asked } = makeLearner("NOTHING");
    learner.record(
      turn("Upload the build for me, the token is in the command I gave you earlier today.", {
        did: [
          {
            tool: "run_command",
            detail:
              'curl -H "Authorization: Bearer abcdef0123456789abcdef" https://u:hunter2@example.com/up',
            ok: true,
          },
        ],
      }),
    );
    await learner.reflect();
    expect(asked[0]).not.toContain("abcdef0123456789abcdef");
    expect(asked[0]).not.toContain("hunter2");
    expect(asked[0]).toContain("[hidden]");
  });

  it("keeps the facts she picked up by herself to a fixed number, oldest out first", async () => {
    for (let index = 0; index < 41; index++) {
      await store.save({
        kind: "project",
        text: `Captain project number ${index}`,
        tags: ["learned"],
      });
    }
    const asked = await store.save({ kind: "profile", text: "Captain's name is Sam." });
    const { learner } = makeLearner("TOPIC: Guitar practice\n- The F chord is hard");
    learner.record(LIGHTING);
    await learner.reflect();
    const learnedFacts = store.all().filter((memory) => memory.tags.includes("learned"));
    expect(learnedFacts).toHaveLength(40);
    expect(store.get(asked.memory.id)).toBeDefined(); // what the user asked her to keep stays
  });

  it("adds to the existing topic when the subject returns under another name", async () => {
    await store.learn("topic", "Unreal lighting", ["Blue moonlight as key light"]);
    const { learner } = makeLearner(
      "TOPIC: Lumen and lantern setup\n- Blue moonlight as the key light\n- Practise the F chord",
    );
    learner.record(LIGHTING);
    const learned = await learner.reflect();
    expect(store.all().filter((memory) => memory.kind === "topic")).toHaveLength(1);
    // The repeated point is dropped; the new one is added.
    expect(learned?.topics[0]?.points).toEqual([
      "Blue moonlight as key light",
      "Practise the F chord",
    ]);
    expect(learned?.topics[0]?.hits).toBe(2);
  });

  it("does not save a fact it already has in other words", async () => {
    await store.save({ kind: "profile", text: "Captain's name is Sam." });
    const { learner } = makeLearner("PROJECT: Captain is called Sam by everyone.");
    learner.record(LIGHTING);
    expect((await learner.reflect())?.facts).toEqual([]);
    expect(store.all()).toHaveLength(1);
  });

  it("does not describe the user from thin air, or make a skill out of a lookup", async () => {
    const answer = [
      "PROFILE: Captain is a technical user interested in game development tools.",
      "TASK: Calculate numbers",
      "- Use the calculate tool",
    ].join("\n");
    const first = makeLearner(answer);
    first.learner.record(
      turn("What is the difference between Lumen and baked lighting, and what is 37 times 41?", {
        did: [{ tool: "calculate", detail: "37 * 41", ok: true }],
      }),
    );
    const learned = await first.learner.reflect();
    expect(learned?.facts).toEqual([]);
    expect(learned?.skills).toEqual([]);
    const second = makeLearner("PROFILE: Captain is a lighting artist at a small studio.");
    second.learner.record(
      turn("I work as a lighting artist at a small studio, by the way, so this matters to me."),
    );
    expect((await second.learner.reflect())?.facts).toHaveLength(1);
  });

  it("keeps a preference only when the user's own words state one", async () => {
    const answer = "PREFERENCE: Captain prefers answers that are short and to the point.";
    const first = makeLearner(answer);
    first.learner.record(LIGHTING);
    expect((await first.learner.reflect())?.facts).toEqual([]);
    const second = makeLearner(answer);
    second.learner.record(
      turn("I always want short answers from you, nothing long-winded please."),
    );
    expect((await second.learner.reflect())?.facts).toHaveLength(1);
  });

  it("shows the model the steps noted so far for a task that is coming up again", async () => {
    await store.learn("skill", "Trim a video clip", ["Use ffmpeg -t"], { replace: true });
    const { learner, asked } = makeLearner("NOTHING");
    learner.record(TRIM);
    await learner.reflect();
    expect(asked[0]).toContain('Known tasks: "Trim a video clip"');
    expect(asked[0]).toContain('- "Trim a video clip": Use ffmpeg -t');
  });

  it("waits for a write-up under way before shutting down", async () => {
    let release: (value: string | null) => void = () => undefined;
    const { learner } = makeLearner(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    learner.record(LIGHTING);
    const reflecting = learner.reflect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    let closed = false;
    const closing = learner.dispose().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    release(null);
    await closing;
    expect(await reflecting).toBeNull();
  });

  it("gives way at once when a reply starts, and loses nothing", async () => {
    let release: (value: string | null) => void = () => undefined;
    const { learner } = makeLearner(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    learner.record(LIGHTING);
    const reflecting = learner.reflect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    learner.busy();
    release("TOPIC: Unreal lighting\n- Something");
    expect(await reflecting).toBeNull();
    expect(learner.waiting).toBe(1);
    expect(store.all()).toHaveLength(0);
  });

  it("keeps what was jotted down across a restart", async () => {
    const first = makeLearner(null);
    first.learner.record(LIGHTING);
    await first.learner.dispose();
    const second = makeLearner(null);
    await second.learner.load();
    expect(second.learner.waiting).toBe(1);
  });

  it("keeps what was said while a write-up was under way", async () => {
    let release: (value: string | null) => void = () => undefined;
    const { learner } = makeLearner(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    learner.record(LIGHTING);
    const reflecting = learner.reflect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    learner.record(TRIM);
    release("NOTHING");
    await reflecting;
    expect(learner.waiting).toBe(1);
  });

  it("waits no longer than half the time the model stays loaded", () => {
    expect(quietTimeFor(0)).toBe(180_000);
    expect(quietTimeFor(10 * 60_000)).toBe(180_000);
    expect(quietTimeFor(2 * 60_000)).toBe(60_000);
  });
});

describe("ConversationArchive", () => {
  const turn = (said: string, reply: string, at = "2026-11-18T10:00:00.000Z"): ArchivedTurn => ({
    at,
    said,
    reply,
    outside: false,
  });

  it("finds a past exchange by meaning and keeps it across a restart", async () => {
    const file = join(dir, "conversations.jsonl");
    const archive = new ConversationArchive(file, embedder);
    await archive.add(
      turn("How should I light my night level?", "Blue moonlight and orange lanterns."),
    );
    await archive.add(turn("What pasta should I cook?", "Aglio e olio."));
    const reloaded = new ConversationArchive(file, embedder);
    await reloaded.load();
    expect(reloaded.count).toBe(2);
    const found = await reloaded.search("what did we decide about the lanterns");
    expect(found.map((entry) => entry.turn.reply)).toEqual(["Blue moonlight and orange lanterns."]);
    expect(describeRemembered(found)).toContain("[2026-11-18] Captain said: How should I light");
    expect(await reloaded.search("guitar chords")).toEqual([]);
  });

  it("hands back the latest exchanges in the order they were said, for showing", async () => {
    const archive = new ConversationArchive(join(dir, "latest.jsonl"), embedder);
    for (let index = 1; index <= 4; index++) {
      await archive.add(
        turn(`Question ${index}`, `Answer ${index}`, `2026-11-1${index}T10:00:00.000Z`),
      );
    }
    expect(archive.latest(2)).toEqual([
      { at: "2026-11-13T10:00:00.000Z", said: "Question 3", reply: "Answer 3", outside: false },
      { at: "2026-11-14T10:00:00.000Z", said: "Question 4", reply: "Answer 4", outside: false },
    ]);
    expect(archive.latest(50)).toHaveLength(4);
    expect(archive.latest(0)).toEqual([]);
    // What is handed back is a copy: changing it changes nothing that is kept.
    const [first] = archive.latest(1);
    if (first) first.reply = "tampered";
    expect(archive.latest(1)[0]?.reply).toBe("Answer 4");
  });

  it("still finds things by their words when the meaning model is unavailable", async () => {
    const archive = new ConversationArchive(join(dir, "c.jsonl"), embedder);
    embedder.broken = true;
    await archive.add(turn("My invoice number is 2291 for Heron Studio", "Noted."));
    await archive.add(turn("What pasta should I cook?", "Aglio e olio."));
    expect((await archive.search("heron invoice")).map((entry) => entry.turn.reply)).toEqual([
      "Noted.",
    ]);
    expect(await archive.search("completely unrelated words")).toEqual([]);
  });

  it("drops the oldest once there are too many, in memory and on disk", async () => {
    const file = join(dir, "small.jsonl");
    const first = new ConversationArchive(file, embedder, 3);
    for (let index = 0; index < 5; index++)
      await first.add(turn(`Message number ${index} about guitar`, "ok"));
    const second = new ConversationArchive(file, embedder, 3);
    await second.load();
    expect(second.count).toBe(3);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Message number 2");
  });

  it("survives a damaged line and can be cleared", async () => {
    const file = join(dir, "damaged.jsonl");
    const archive = new ConversationArchive(file, embedder);
    await archive.add(turn("Guitar practice went well", "Nice."));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, "{not json\n");
    const reloaded = new ConversationArchive(file, embedder);
    await reloaded.load();
    expect(reloaded.count).toBe(1);
    await reloaded.clear();
    expect(reloaded.count).toBe(0);
    const again = new ConversationArchive(file, embedder);
    await again.load();
    expect(again.count).toBe(0);
  });
});

describe("RoutineWatch", () => {
  const NOW = new Date(2026, 10, 21, 12, 0);
  const on = (day: number, hour: number, minute = 0): string =>
    new Date(2026, 10, day, hour, minute).toISOString();

  it("notices a task asked for at about the same time on three different days", async () => {
    const watch = new RoutineWatch(join(dir, "routines.json"));
    await watch.note("s1", "Open the editor and the docs", on(17, 9, 5));
    await watch.note("s1", "Open the editor and the docs", on(18, 9, 40));
    expect(watch.found(NOW)).toEqual([]);
    await watch.note("s1", "Open the editor and the docs", on(20, 8, 50));
    expect(watch.found(NOW)).toEqual([
      { id: "s1", title: "Open the editor and the docs", usualTime: "09:12", days: 3 },
    ]);
    const [routine] = watch.found(NOW);
    expect(routine && describeRoutine(routine)).toContain("around 09:12");
  });

  it("does not call it a habit when the times are scattered, all on one day, or long ago", async () => {
    const watch = new RoutineWatch(join(dir, "routines.json"));
    await watch.note("scattered", "Check the weather", on(17, 8));
    await watch.note("scattered", "Check the weather", on(18, 14));
    await watch.note("scattered", "Check the weather", on(19, 21));
    for (const hour of [9, 9, 10])
      await watch.note("one-day", "Trim a clip", on(20, hour, Math.random() * 59));
    for (const day of [1, 2, 3]) await watch.note("old", "Back up photos", on(day, 9));
    expect(watch.found(NOW)).toEqual([]);
  });

  it("treats times either side of midnight as close together", async () => {
    const watch = new RoutineWatch(join(dir, "routines.json"));
    await watch.note("late", "Lock the screen", on(18, 23, 50));
    await watch.note("late", "Lock the screen", on(20, 0, 10));
    await watch.note("late", "Lock the screen", on(21, 0, 0));
    expect(watch.found(NOW)[0]).toMatchObject({ usualTime: "00:00", days: 3 });
  });

  it("offers a routine once, and remembers that across a restart", async () => {
    const file = join(dir, "routines.json");
    const watch = new RoutineWatch(file);
    for (const day of [18, 19, 20]) await watch.note("s1", "Open the editor", on(day, 9));
    await watch.markOffered("s1");
    expect(watch.found(NOW)).toEqual([]);
    const again = new RoutineWatch(file);
    await again.load();
    await again.note("s1", "Open the editor", on(21, 9));
    expect(again.found(NOW)).toEqual([]);
  });
});

describe("withoutSecrets", () => {
  it.each([
    ["curl -H 'Authorization: Bearer abcdefghijklmnop'", "abcdefghijklmnop"],
    ["mysql --password=hunter2 -u root", "hunter2"],
    ["export API_KEY=sk-live-12345", "sk-live-12345"],
    ["git clone https://me:s3cretpw@host/repo.git", "s3cretpw"],
    ["use ghp_abcdefghijklmnopqrstuvwx for it", "ghp_abcdefghijklmnopqrstuvwx"],
    ["key 0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef01234567"],
  ])("hides the credential in %s", (text, secret) => {
    expect(withoutSecrets(text)).not.toContain(secret);
    expect(withoutSecrets(text)).toContain("[hidden]");
  });

  it("leaves ordinary commands alone", () => {
    for (const text of [
      "ffmpeg -i a.mp4 -t 10 -c copy b.mp4",
      "pacman -Q kdenlive",
      "My keyboard key is stuck and the token ring network is old.",
    ]) {
      expect(withoutSecrets(text)).toBe(text);
    }
  });
});

describe("describeLearned", () => {
  it("lists everything she knows with the code that deletes it", async () => {
    await store.save({ kind: "profile", text: "Captain's name is Sam." });
    await store.save({ kind: "project", text: "Captain is making a game.", tags: ["learned"] });
    const topic = (await store.learn("topic", "Unreal lighting", ["Use fog"])).memory;
    await store.learn("skill", "Trim a video clip", ["ffmpeg -t"], { replace: true });
    const page = describeLearned(store.all(), "/data/memory.json");
    expect(page).toContain("## About you");
    expect(page).toContain("Captain is making a game.");
    expect(page).toContain("_(picked up by herself)_");
    expect(page).toContain(`**Unreal lighting** [${topic.id}] (came up 1 time`);
    expect(page).toContain("  - Use fog");
    expect(page).toContain("done 1 time");
    expect(page).toContain("/data/memory.json");
  });

  it("says so when there is nothing yet", () => {
    expect(describeLearned([], "/data/memory.json")).toContain("Nothing yet");
  });
});
