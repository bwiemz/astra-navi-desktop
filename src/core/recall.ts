import { createHash } from "node:crypto";
import type { Embedder } from "./embedder.ts";
import {
  meaningfulTokens,
  searchableText,
  tokenize,
  type Memory,
  type MemoryKind,
  type MemoryStore,
} from "./memory.ts";
import { ftsQuery, packVector, unpackVector, type HerStore } from "./store.ts";

export interface Recalled {
  memory: Memory;
  /** How well it matches, 0 to 1. */
  score: number;
}

export interface RelevantOptions {
  limit?: number;
  /** Kinds to leave out, for example the ones already in her instructions. */
  skipKinds?: readonly MemoryKind[];
  /**
   * How long to wait for the meaning model. It takes a few seconds to load the first
   * time (and a download the very first time); a reply should not be held up for that.
   */
  patienceMs?: number;
}

/**
 * Scores from this model sit in a narrow band: unrelated texts land near 0.75 to 0.8 and
 * a real match near 0.85. So the bar is absolute and high, and only the best few clear it.
 */
const MIN_SCORE = 0.815;
/** A memory that also shares a meaningful word with the question gets this much added. */
const SHARED_WORD_BONUS = 0.03;
const NEAR_BEST = 0.035;

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

interface Stored {
  hash: string;
  vector: Float32Array;
}

/**
 * Finds the memories that bear on what was just said, by meaning rather than by exact
 * words. This is what lets her notes come back by themselves when a topic or task
 * returns, instead of depending on her to think of searching.
 */
export class Recall {
  private readonly store: MemoryStore;
  readonly embedder: Embedder;
  private readonly db: HerStore | null;
  /** Each memory's whole text as something to be found. Kept until the text changes. */
  private readonly passages = new Map<string, Stored>();
  /** Each memory's first line as a statement, for telling whether two notes say the same thing. */
  private readonly statements = new Map<string, Stored>();

  constructor(store: MemoryStore, embedder: Embedder, db?: HerStore) {
    this.store = store;
    this.embedder = embedder;
    this.db = db ?? null;
  }

  /** Drops vector & FTS entries for forgotten memory IDs immediately. */
  drop(ids: readonly string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.passages.delete(id);
      this.statements.delete(id);
    }
    const db = this.db && this.db.isOpen ? this.db : null;
    if (!db) return;
    db.together(() => {
      for (const id of ids) {
        db.run("DELETE FROM memory_vectors WHERE id = ?", id);
        db.run("DELETE FROM memory_words WHERE id = ?", id);
      }
    });
    db.settle();
  }

  /** Loads the meaning model and prepares every memory, so the first real question is quick. */
  async warm(): Promise<void> {
    await this.refresh(this.passages, this.store.all(), searchableText, "passage", "passage");
  }

  /** Works out numbers for any memory that is new or has changed, and drops those that are gone. */
  private async refresh(
    cache: Map<string, Stored>,
    memories: readonly Memory[],
    textOf: (memory: Memory) => string,
    kind: "query" | "passage",
    cacheKind: "passage" | "statement",
  ): Promise<void> {
    const db = this.db && this.db.isOpen ? this.db : null;
    if (db && memories.some((memory) => !cache.has(memory.id))) {
      const rows = db.all<{ id: string; hash: string; vector: Uint8Array }>(
        "SELECT id, hash, vector FROM memory_vectors WHERE kind = ?",
        cacheKind,
      );
      for (const row of rows) {
        if (cache.has(row.id)) continue;
        const vector = unpackVector(row.vector);
        if (vector) cache.set(row.id, { hash: row.hash, vector });
      }
    }

    const stale: { id: string; text: string; hash: string }[] = [];
    for (const memory of memories) {
      const text = textOf(memory);
      const hash = hashOf(text);
      if (cache.get(memory.id)?.hash !== hash) stale.push({ id: memory.id, text, hash });
    }
    const present = new Set(this.store.all().map((memory) => memory.id));
    for (const id of [...cache.keys()]) if (!present.has(id)) cache.delete(id);

    if (db) {
      const orphanIds = db
        .all<{ id: string }>("SELECT id FROM memory_vectors WHERE kind = ?", cacheKind)
        .map((row) => row.id)
        .filter((id) => !present.has(id));
      const ftsOrphans =
        cacheKind === "passage"
          ? db
              .all<{ id: string }>("SELECT id FROM memory_words")
              .map((row) => row.id)
              .filter((id) => !present.has(id))
          : [];
      if (orphanIds.length > 0 || ftsOrphans.length > 0) {
        db.together(() => {
          for (const id of orphanIds) {
            db.run("DELETE FROM memory_vectors WHERE id = ? AND kind = ?", id, cacheKind);
          }
          for (const id of new Set([...orphanIds, ...ftsOrphans])) {
            if (cacheKind === "passage") db.run("DELETE FROM memory_words WHERE id = ?", id);
          }
        });
        db.settle();
      }
      if (stale.length > 0 && cacheKind === "passage") {
        db.together(() => {
          for (const entry of stale) {
            db.run("DELETE FROM memory_words WHERE id = ?", entry.id);
            const ftsWords = `${entry.text} ${tokenize(entry.text).join(" ")}`.trim();
            if (ftsWords) db.run("INSERT INTO memory_words (id, words) VALUES (?, ?)", entry.id, ftsWords);
          }
        });
      }
    }

    if (stale.length === 0) return;
    const vectors = await this.embedder.embed(
      stale.map((entry) => entry.text),
      kind,
    );
    const updated: { id: string; hash: string; vector: Float32Array }[] = [];
    stale.forEach((entry, index) => {
      const vector = vectors[index];
      if (!vector) return;
      cache.set(entry.id, { hash: entry.hash, vector });
      updated.push({ id: entry.id, hash: entry.hash, vector });
    });
    if (db && db.isOpen && updated.length > 0) {
      db.together(() => {
        for (const entry of updated) {
          db.run(
            "INSERT OR REPLACE INTO memory_vectors (id, kind, hash, vector) VALUES (?, ?, ?, ?)",
            entry.id,
            cacheKind,
            entry.hash,
            packVector(entry.vector),
          );
        }
      });
    }
  }

  private async questionVector(
    query: string,
    patienceMs: number | undefined,
  ): Promise<Float32Array | undefined> {
    const work = (async (): Promise<Float32Array | undefined> => {
      await this.refresh(this.passages, this.store.all(), searchableText, "passage", "passage");
      return (await this.embedder.embed([query], "query"))[0];
    })();
    try {
      if (patienceMs === undefined) return await work;
      // Still finishes in the background when it loses the race, so the next question is quick.
      work.catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const tooSlow = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), patienceMs);
      });
      return await Promise.race([work, tooSlow]).finally(() => clearTimeout(timer));
    } catch (error) {
      console.warn("[recall] matching by meaning is unavailable:", error);
      return undefined;
    }
  }

  /**
   * The memories most relevant to `query`, best first. Empty when nothing clears the bar,
   * and also when the meaning model is not ready in time: a wrong note is worse than none.
   */
  async relevant(query: string, options: RelevantOptions = {}): Promise<Recalled[]> {
    const limit = options.limit ?? 4;
    const skip = new Set<MemoryKind>(options.skipKinds ?? []);
    const wordMatches = this.store.scored(query).filter((entry) => !skip.has(entry.memory.kind));
    const queryVector = await this.questionVector(query, options.patienceMs);
    if (!queryVector) return [];

    const sharesWord = new Set(wordMatches.map((entry) => entry.memory.id));
    if (this.db && this.db.isOpen) {
      const matchExpr = ftsQuery(meaningfulTokens(query));
      if (matchExpr) {
        const rows = this.db.all<{ id: string }>(
          "SELECT id FROM memory_words WHERE memory_words MATCH ?",
          matchExpr,
        );
        for (const row of rows) sharesWord.add(row.id);
      }
    }
    const scored: Recalled[] = [];
    for (const memory of this.store.all()) {
      if (skip.has(memory.kind)) continue;
      const stored = this.passages.get(memory.id);
      if (!stored) continue;
      const score =
        dot(queryVector, stored.vector) + (sharesWord.has(memory.id) ? SHARED_WORD_BONUS : 0);
      if (score >= MIN_SCORE) scored.push({ memory, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    return scored.filter((entry) => entry.score >= best - NEAR_BEST).slice(0, limit);
  }

  /**
   * The existing note of this kind that says most nearly the same thing as `text`, with
   * how close it is. Used to add to a note that exists instead of starting a second one.
   * Returns null when there is none or the meaning model cannot be used.
   */
  async closest(text: string, kinds: readonly MemoryKind[]): Promise<Recalled | null> {
    const candidates = this.store.all().filter((memory) => kinds.includes(memory.kind));
    if (candidates.length === 0) return null;
    try {
      // Both sides are embedded the same way here: this compares two statements with
      // each other, where `relevant` matches a question to things that answer it.
      await this.refresh(
        this.statements,
        this.store.all(),
        (memory) => memory.text,
        "query",
        "statement",
      );
      const [vector] = await this.embedder.embed([text], "query");
      if (!vector) return null;
      let best: Recalled | null = null;
      for (const memory of candidates) {
        const stored = this.statements.get(memory.id);
        if (!stored) continue;
        const score = dot(vector, stored.vector);
        if (!best || score > best.score) best = { memory, score };
      }
      return best;
    } catch (error) {
      console.warn("[recall] could not compare notes by meaning:", error);
      return null;
    }
  }
}

/** A topic can hold a dozen points; this many of the newest are enough to pick it up again. */
const POINTS_SHOWN = 6;

/**
 * The lines of `candidates` that say something not already said in `existing` or earlier
 * in `candidates`. Used so a topic's points do not fill up with one point in five wordings.
 * When the meaning model cannot be used, everything is treated as new.
 */
export async function onlyNew(
  embedder: Embedder,
  candidates: readonly string[],
  existing: readonly string[],
  sameAbove: number,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  let vectors: Float32Array[];
  try {
    vectors = await embedder.embed([...existing, ...candidates], "query");
  } catch {
    return [...candidates];
  }
  const kept: Float32Array[] = vectors.slice(0, existing.length);
  const fresh: string[] = [];
  candidates.forEach((candidate, index) => {
    const vector = vectors[existing.length + index];
    if (!vector || kept.some((other) => dot(vector, other) >= sameAbove)) return;
    kept.push(vector);
    fresh.push(candidate);
  });
  return fresh;
}

/** Writes recalled memories as the short block put after the user's message. */
export function describeRecalled(recalled: readonly Recalled[]): string {
  return recalled
    .map(({ memory }) => {
      const points = memory.points.slice(-POINTS_SHOWN).join("; ");
      switch (memory.kind) {
        case "topic":
          return `- You two have talked about "${memory.text}" before. Key points: ${points || "(none noted)"}`;
        case "skill":
          return `- You have done "${memory.text}" for Captain ${memory.hits} time${memory.hits === 1 ? "" : "s"}. What worked: ${points || "(no steps noted)"}`;
        default:
          return `- (${memory.kind}) ${memory.text}`;
      }
    })
    .join("\n");
}
