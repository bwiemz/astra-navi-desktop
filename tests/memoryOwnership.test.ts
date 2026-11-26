import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatHistoryItem } from "node-llama-cpp";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_CASES } from "../evals/cases/memory.ts";
import { Brain } from "../src/core/brain.ts";
import { ConfigStore } from "../src/core/config.ts";
import type { LocalEngine } from "../src/core/engine.ts";
import {
  buildMemoryManagerSnapshot,
  describeLearned,
  explainWhyRemembered,
  inferMemorySource,
} from "../src/core/learned.ts";
import { Learner, MAX_LEARNED_FACTS } from "../src/core/learner.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { Recall } from "../src/core/recall.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Memory ownership: pin, correct, forget, and provenance ('why do you remember this?')", () => {
  it("tracks provenance, prioritizes pinned older facts in snapshot(), and supports inline correction", async () => {
    const dir = await makeTempDir("astra-mem-own-");
    const file = join(dir, "memory.json");
    const store = new MemoryStore(file);

    const { memory: pinnedFact } = await store.save({
      kind: "fact",
      text: "Backup encryption hint is Blue Heron 42.",
      pinned: true,
      source: "explicit",
      reason: "Saved when you asked her to remember this.",
    });

    // Add 16 newer facts that would push an unpinned fact out of snapshot()'s top-12 recent window.
    for (let i = 1; i <= 16; i += 1) {
      await store.save({
        kind: "fact",
        text: `Everyday note number ${i} about desk supplies.`,
        tags: ["learned"],
        source: "learned",
        sourceExcerpt: `Mentioned desk supply item ${i}`,
      });
    }

    const snapText = store.snapshot();
    expect(snapText).toContain("Blue Heron 42");
    expect(snapText).toContain("(fact, pinned)");

    // Correcting text & points updates source to user-edited while keeping provenance explainable.
    const updated = await store.update(pinnedFact.id, "Backup encryption hint is Silver Heron 99.");
    expect(updated).not.toBeNull();
    expect(updated?.text).toBe("Backup encryption hint is Silver Heron 99.");
    expect(updated?.source).toBe("user-edited");

    const why = updated ? explainWhyRemembered(updated) : "";
    expect(why).toContain("Pinned by you");
    expect(why).toContain("Saved when you asked her to remember this.");

    // Snapshot builder sorts pinned items first and reports ownership stats.
    const manager = buildMemoryManagerSnapshot(store.all(), file);
    expect(manager.entries[0]?.id).toBe(pinnedFact.id);
    expect(manager.stats.pinned).toBe(1);
    expect(manager.stats.learned).toBe(16);
    expect(manager.stats.userEdited).toBe(1);

    // Markdown export reflects Astra Navi branding, [PINNED], and Why provenance.
    const md = describeLearned(store.all(), file);
    expect(md).toContain("# What Astra Navi has learned");
    expect(md).not.toContain("AI-chan");
    expect(md).toContain("[PINNED]");
    expect(md).toContain("_Why:_");

    // Forgetting deletes the note cleanly.
    expect(await store.forget(pinnedFact.id)).toBe(true);
    expect(store.get(pinnedFact.id)).toBeUndefined();
  });

  it("infers provenance cleanly for legacy notes without an explicit source field", () => {
    const legacyLearned = {
      id: "abcd1234",
      kind: "fact" as const,
      text: "Uses Arch Linux.",
      points: [],
      tags: ["learned"],
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      hits: 3,
    };
    expect(inferMemorySource(legacyLearned)).toBe("learned");
    expect(explainWhyRemembered(legacyLearned)).toContain("Picked up automatically");
    expect(explainWhyRemembered(legacyLearned)).toContain("3 times");
  });
});

describe("Expanded memory eval suite & Settings UI safety", () => {
  it("expands MEMORY_CASES to 27 unique cases covering pinning, remembering, forgetting, and corrections", () => {
    expect(MEMORY_CASES.length).toBeGreaterThanOrEqual(27);
    const ids = MEMORY_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("memory/pinned-old-fact");
    expect(ids).toContain("memory/save-explicit-remember");
    expect(ids).toContain("memory/forget-explicit-request");
    expect(ids).toContain("memory/updated-fact-supersedes-old");
    expect(ids).toContain("memory/cross-turn-correction");
    expect(ids).toContain("memory/provenance-natural-explanation");
  });

  it("protects pinned and user-edited memories & skills from Learner eviction and skill replacement", async () => {
    const dir = await makeTempDir("astra-learner-hygiene-");
    const store = new MemoryStore(join(dir, "memory.json"));
    const stubEmbedder = {
      embed: async (texts: readonly string[]) =>
        texts.map((t) => {
          // Hash distinct words into 32 buckets so unrelated sentences do not collide at >= 0.94 cosine!
          const vec = new Float32Array(32);
          for (const word of t.toLowerCase().split(/\W+/).filter(Boolean)) {
            let h = 2166136261;
            for (let i = 0; i < word.length; i += 1) {
              h = Math.imul(h ^ word.charCodeAt(i), 16777619);
            }
            const bucket = (h >>> 0) % 32;
            vec[bucket] = (vec[bucket] ?? 0) + 1;
          }
          const norm = Math.hypot(...vec) || 1;
          for (let i = 0; i < 32; i += 1) vec[i] = (vec[i] ?? 0) / norm;
          return vec;
        }),
    };
    const recall = new Recall(store, stubEmbedder);

    // Seed MAX_LEARNED_FACTS + 3 learned `profile`/`preference`/`project` facts (real cap = 40):
    // #1 pinned + #2 user-edited + 41 unpinned -> plus 1 new learned fact = 42 unpinned -> 2 evicted!
    const seededIds: string[] = [];
    for (let i = 1; i <= MAX_LEARNED_FACTS + 3; i += 1) {
      const { memory } = await store.save({
        kind: "project",
        text: `Working on unique subsystem alpha number ${i}.`,
        tags: ["learned"],
        source: "learned",
      });
      // Stagger updatedAt monotonically so oldest ordering is deterministic (not millisecond-tied).
      memory.updatedAt = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
      seededIds.push(memory.id);
    }
    const oldestPinnedId = seededIds[0] ?? "";
    const secondEditedId = seededIds[1] ?? "";
    const thirdUnpinnedId = seededIds[2] ?? "";
    await store.pin(oldestPinnedId, true);
    await store.update(secondEditedId, "Working on critical kernel driver v2.");
    // Re-stamp oldest timestamps on #1 and #2 so they would be evicted FIRST if protection failed!
    const oldestPinned = store.get(oldestPinnedId);
    const secondEdited = store.get(secondEditedId);
    if (oldestPinned) oldestPinned.updatedAt = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString();
    if (secondEdited) secondEdited.updatedAt = new Date(Date.UTC(2025, 0, 2, 0, 0, 0)).toISOString();

    // Seed a skill and user-correct its steps.
    const { memory: skill } = await store.learn("skill", "backup nas", ["Run old script"], {
      source: "learned",
    });
    await store.update(skill.id, "backup nas", {
      points: ["Always run rsync --dry-run before copying to /mnt/nas"],
    });

    const learner = new Learner({
      memory: store,
      recall,
      journalFile: join(dir, "journal.json"),
      quietMs: 60_000,
      ask: async () =>
        [
          "PROJECT: I am building a brand new weather dashboard project in Rust.",
          "TASK: backup nas",
          "- Overwrite everything with naive cp -rf /data /mnt/nas",
        ].join("\n"),
    });

    learner.record({
      at: new Date().toISOString(),
      said: "I am building a brand new weather dashboard project in Rust and just ran backup nas.",
      reply: "Got it.",
      did: [{ tool: "run_command", detail: "cp -rf /data /mnt/nas", ok: true }],
    });

    await learner.reflect();

    // Prove eviction actually ran: the unpinned/unedited oldest fact (#3) MUST be evicted!
    expect(store.get(thirdUnpinnedId)).toBeUndefined();
    // Pinned oldest fact (#1) AND user-edited fact (#2) MUST both survive Learner.dropOldestLearnedFacts()!
    expect(store.get(oldestPinnedId)).toBeDefined();
    expect(store.get(oldestPinnedId)?.pinned).toBe(true);
    expect(store.get(secondEditedId)).toBeDefined();
    expect(store.get(secondEditedId)?.text).toBe("Working on critical kernel driver v2.");
    // User-corrected skill steps MUST NOT be overwritten by Learner's `replace: true`!
    const afterSkill = store.get(skill.id);
    expect(afterSkill?.points).toEqual(["Always run rsync --dry-run before copying to /mnt/nas"]);
    await learner.dispose();
  });

  it("refreshes Brain instructions on next turn via markInstructionsDirty() without interrupting or unloading the model", async () => {
    const dir = await makeTempDir("astra-mem-dirty-");
    const config = new ConfigStore(join(dir, "config.json"));
    await config.load();
    const memory = new MemoryStore(join(dir, "memory.json"));

    let unloadCalls = 0;
    let refreshCalls = 0;
    const seenSystemPrompts: string[] = [];
    let history: ChatHistoryItem[] = [];

    const fakeEngine = {
      getHistory: () => history,
      setHistory: (items: ChatHistoryItem[]) => {
        history = items;
      },
      meter: () => null,
      hooks: () => null,
      unload: async () => {
        unloadCalls += 1;
      },
      refresh: () => {
        refreshCalls += 1;
      },
      anchor: async () => undefined,
      wordBias: () => null,
      restingNow: () => undefined,
      dispose: async () => undefined,
      brainInfo: async () => ({ label: "stub", fileName: null, onDisk: true, loaded: true }),
      session: async (systemPrompt: string) => {
        seenSystemPrompts.push(systemPrompt);
        return {
          prompt: async () => "[[calm]] Understood.",
          decide: async () => ({ claimed: { value: 0 } }),
        };
      },
    } as unknown as LocalEngine;

    const brain = new Brain({
      config,
      memory,
      environment: {
        osName: "Linux",
        desktop: "KDE",
        userName: "brandon",
        home: dir,
        workspace: join(dir, "ws"),
        commands: new Set(),
      },
      engine: fakeEngine,
      historyFile: join(dir, "history.json"),
      emit: () => undefined,
    });

    brain.send("Hello!");
    await brain.whenIdle();
    expect(seenSystemPrompts).toHaveLength(1);
    expect(seenSystemPrompts[0]).not.toContain("Prefers dark espresso");

    // Simulate pinning/adding a note in Settings -> Memory Manager: marks dirty, NEVER unloads VRAM!
    await memory.save({
      kind: "preference",
      text: "Prefers dark espresso.",
      pinned: true,
      source: "user-edited",
    });
    brain.markInstructionsDirty();
    expect(unloadCalls).toBe(0);

    brain.send("What coffee do I like?");
    await brain.whenIdle();
    expect(unloadCalls).toBe(0);
    expect(refreshCalls).toBe(1);
    expect(seenSystemPrompts).toHaveLength(2);
    expect(seenSystemPrompts[1]).toContain("Prefers dark espresso");
    await brain.dispose();
  });
});
