import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_CASES } from "../evals/cases/memory.ts";
import {
  buildMemoryManagerSnapshot,
  describeLearned,
  explainWhyRemembered,
  inferMemorySource,
} from "../src/core/learned.ts";
import { MemoryStore } from "../src/core/memory.ts";

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

  it("renders Settings Memory Manager safely without innerHTML", () => {
    const root = join(import.meta.dirname, "..");
    const memUi = readFileSync(join(root, "src/renderer/src/settings/memory.ts"), "utf8");
    const settingsHtml = readFileSync(join(root, "src/renderer/settings.html"), "utf8");
    const wbMemUi = readFileSync(join(root, "src/renderer/src/mission-control/memory.ts"), "utf8");

    expect(memUi).not.toContain("innerHTML");
    expect(wbMemUi).not.toContain("innerHTML");
    expect(settingsHtml).toContain('id="memory-list"');
    expect(settingsHtml).toContain('id="memory-add-form"');
    expect(wbMemUi).toContain("Why do you remember this?");
  });
});
