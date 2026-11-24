import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * What she remembers, by kind:
 * - profile, preference, project, fact, episode: single notes she saves in conversation.
 * - topic: something the two of them talk about, with the key points so far.
 * - skill: a task the user asks for, with the steps that worked last time.
 * Topics and skills are mostly written by the learner after a conversation, not by her
 * in the moment, and they grow: each time the subject comes back, its note is added to.
 */
export const MEMORY_KINDS = [
  "profile",
  "preference",
  "project",
  "fact",
  "episode",
  "topic",
  "skill",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
/** The kinds she may save directly with her remember tool. */
export const NOTE_KINDS = ["profile", "preference", "project", "fact", "episode"] as const;

const MemorySchema = z.object({
  id: z.string(),
  kind: z.enum(MEMORY_KINDS),
  /** The note itself, or for a topic or skill its title. */
  text: z.string(),
  /** For a topic its key points, for a skill its steps. */
  points: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** How often this came up: found in a search, discussed again, or done again. */
  hits: z.number().default(0),
  /** Pinned notes stay prioritized in Mission Control's inspector and recall views. */
  pinned: z.boolean().optional(),
  /** Optional household vault namespace isolating one family member's notes from another's. */
  namespace: z.string().optional(),
});
export type Memory = z.infer<typeof MemorySchema>;

const FileSchema = z.object({ version: z.literal(1), memories: z.array(MemorySchema) });

const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be but by did do does for from going had has have how if in into is it its " +
    "me my not of on or our so than that the their them then there these they this to up was we " +
    "were what when where which who why will with you your"
  ).split(" "),
);

/** Kinds that describe the user and are always shown to the assistant. */
const ALWAYS_LOADED: readonly MemoryKind[] = ["profile", "preference"];
const MAX_POINTS = 12;
const MAX_POINT_CHARS = 220;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    // CJK has no spaces: index overlapping pairs so partial phrases still match.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) tokens.push(word);
      for (let i = 0; i < chars.length - 1; i++) tokens.push(`${chars[i]}${chars[i + 1]}`);
    } else if (word.length > 1) {
      tokens.push(word);
    }
  }
  return tokens;
}

/** Unique tokens in `text`, dropping filler words when anything else remains. */
export function meaningfulTokens(text: string): string[] {
  const all = [...new Set(tokenize(text))];
  const meaningful = all.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : all;
}

/** Two notes are the same fact when they differ only in case, spacing or punctuation. */
function normalize(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

/** Notes are single lines, so one cannot pose as several entries or as a heading in the prompt. */
function oneLine(text: string): string {
  // Angle brackets are dropped too: the notes sit inside a tagged block of her instructions,
  // and a note must not be able to close that block.
  return text.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

/** Everything about a memory that a search should match on. */
export function searchableText(memory: Memory): string {
  return [memory.text, ...memory.points, ...memory.tags].join(" ");
}

export interface SaveInput {
  kind: MemoryKind;
  text: string;
  tags?: string[];
  namespace?: string;
}

/**
 * Long-term memory: a small JSON file the user can read and edit. The notes about the
 * user are always in the assistant's context; the rest is found by search.
 */
export class MemoryStore {
  private readonly file: string;
  private memories: Memory[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners: (() => void)[] = [];

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Never silently start empty over an unreadable file: the next save would erase it.
      throw new Error(
        `Memory file ${this.file} is not in the expected format: ${parsed.error.message}`,
      );
    }
    this.memories = parsed.data.memories;
  }

  private scoped(namespace?: string): Memory[] {
    if (namespace === undefined) return this.memories;
    return this.memories.filter((memory) => memory.namespace === namespace);
  }

  all(namespace?: string): readonly Memory[] {
    return this.scoped(namespace);
  }

  get(id: string): Memory | undefined {
    return this.memories.find((memory) => memory.id === id);
  }

  /** Calls back whenever the memories change, so anything built from them can be refreshed. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  async save(input: SaveInput): Promise<{ memory: Memory; merged: boolean }> {
    const text = oneLine(input.text);
    if (text.length === 0) throw new Error("A memory needs some text.");
    const now = new Date().toISOString();
    const tags = [
      ...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
    ];

    const key = normalize(text);
    const existing = this.memories.find(
      (m) => m.kind === input.kind && m.namespace === input.namespace && normalize(m.text) === key,
    );
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...tags])];
      existing.updatedAt = now;
      await this.persist();
      return { memory: existing, merged: true };
    }

    const memory: Memory = {
      id: randomBytes(4).toString("hex"),
      kind: input.kind,
      text,
      points: [],
      tags,
      createdAt: now,
      updatedAt: now,
      hits: 0,
      ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
    };
    this.memories.push(memory);
    await this.persist();
    return { memory, merged: false };
  }

  /**
   * Adds to what is known about a topic or a task, or starts a new note for it.
   * @param existingId The note this belongs with, when the caller has already matched it.
   *   Without it, a note with the same title (ignoring case and punctuation) is used.
   * @param replace For a skill: the new steps take the place of the old, since the latest
   *   way that worked is the one to follow. For a topic the points accumulate.
   */
  async learn(
    kind: "topic" | "skill",
    title: string,
    points: readonly string[],
    options: { existingId?: string; replace?: boolean } = {},
  ): Promise<{ memory: Memory; created: boolean }> {
    const cleanTitle = oneLine(title).slice(0, 120);
    const cleanPoints = points
      .map((point) => oneLine(point).slice(0, MAX_POINT_CHARS))
      .filter(Boolean);
    if (cleanTitle.length === 0) throw new Error("A topic or task needs a name.");
    const now = new Date().toISOString();

    const existing =
      (options.existingId
        ? this.memories.find((m) => m.id === options.existingId && m.kind === kind)
        : undefined) ??
      this.memories.find((m) => m.kind === kind && normalize(m.text) === normalize(cleanTitle));
    if (existing) {
      if (options.replace && cleanPoints.length > 0) {
        existing.points = cleanPoints.slice(0, MAX_POINTS);
      } else {
        const known = new Set(existing.points.map(normalize));
        const fresh = cleanPoints.filter((point) => !known.has(normalize(point)));
        // The newest points are kept when a topic outgrows its space.
        existing.points = [...existing.points, ...fresh].slice(-MAX_POINTS);
      }
      existing.hits += 1;
      existing.updatedAt = now;
      await this.persist();
      return { memory: existing, created: false };
    }

    const memory: Memory = {
      id: randomBytes(4).toString("hex"),
      kind,
      text: cleanTitle,
      points: cleanPoints.slice(0, MAX_POINTS),
      tags: [],
      createdAt: now,
      updatedAt: now,
      hits: 1,
    };
    this.memories.push(memory);
    await this.persist();
    return { memory, created: true };
  }

  async update(id: string, text: string): Promise<Memory | null> {
    const memory = this.memories.find((m) => m.id === id);
    if (!memory) return null;
    const trimmed = oneLine(text);
    if (trimmed.length === 0) throw new Error("A memory needs some text.");
    memory.text = trimmed;
    memory.updatedAt = new Date().toISOString();
    await this.persist();
    return memory;
  }

  /** Marks or unmarks a stored note as pinned without rewriting its creation time. */
  async pin(id: string, pinned: boolean): Promise<Memory | null> {
    const memory = this.memories.find((m) => m.id === id);
    if (!memory) return null;
    memory.pinned = pinned;
    memory.updatedAt = new Date().toISOString();
    await this.persist();
    return memory;
  }

  async forget(id: string): Promise<boolean> {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length === before) return false;
    await this.persist();
    return true;
  }

  async forgetIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const drop = new Set(ids);
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !drop.has(m.id));
    const removed = before - this.memories.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  /** Removes memories newly created on or after `sinceIso` and returns their IDs. */
  async forgetCreatedSince(sinceIso: string): Promise<string[]> {
    const cutoff = Date.parse(sinceIso);
    if (!Number.isFinite(cutoff)) return [];
    const removedIds: string[] = [];
    const kept: Memory[] = [];
    for (const mem of this.memories) {
      const createdMs = Date.parse(mem.createdAt);
      if (Number.isFinite(createdMs) && createdMs >= cutoff) {
        removedIds.push(mem.id);
      } else {
        kept.push(mem);
      }
    }
    if (removedIds.length === 0) return [];
    this.memories = kept;
    await this.persist();
    return removedIds;
  }

  /** Search by shared words. Used as a fallback, and to break ties, beside search by meaning. */
  search(query: string, limit = 8, namespace?: string): Memory[] {
    return this.scored(query, namespace)
      .slice(0, Math.max(1, limit))
      .map((entry) => entry.memory);
  }

  /** Word-overlap scores for every memory that shares a meaningful word with the query. */
  scored(query: string, namespace?: string): { memory: Memory; score: number }[] {
    const queryTokens = meaningfulTokens(query);
    if (queryTokens.length === 0) return [];

    const docs = this.scoped(namespace).map((memory) => ({
      memory,
      tokens: tokenize(searchableText(memory)),
    }));
    const docCount = docs.length;
    const now = Date.now();

    return docs
      .map(({ memory, tokens }) => {
        let score = 0;
        for (const term of queryTokens) {
          const tf = tokens.filter((t) => t === term).length;
          if (tf === 0) continue;
          const df = docs.filter((d) => d.tokens.includes(term)).length;
          const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
          score += idf * (tf / (tf + 1.2));
        }
        if (score === 0) return { memory, score };
        const ageDays = (now - Date.parse(memory.updatedAt)) / 86_400_000;
        const recency = 1 + 0.15 / (1 + ageDays / 30);
        return { memory, score: score * recency };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /** The block of memory placed in the assistant's instructions at the start of a conversation. */
  snapshot(maxChars = 6000, namespace?: string): string {
    const list = this.scoped(namespace);
    const byRecent = (a: Memory, b: Memory): number => b.updatedAt.localeCompare(a.updatedAt);
    const byUse = (a: Memory, b: Memory): number => b.hits - a.hits || byRecent(a, b);
    const of = (kind: MemoryKind): Memory[] => list.filter((m) => m.kind === kind);

    const always = list.filter((m) => ALWAYS_LOADED.includes(m.kind)).sort(byRecent);
    const recent = list
      .filter((m) => !ALWAYS_LOADED.includes(m.kind) && m.kind !== "topic" && m.kind !== "skill")
      .sort(byRecent)
      .slice(0, 12);

    const lines: string[] = [];
    let used = 0;
    for (const memory of [...always, ...recent]) {
      const line = `- [${memory.id}] (${memory.kind}) ${memory.text}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    // Topics and skills are listed by name only; their details are brought in when they come up.
    const topics = of("topic").sort(byUse).slice(0, 10);
    if (topics.length > 0) {
      lines.push(`What you two talk about most: ${topics.map((m) => m.text).join("; ")}`);
    }
    const skills = of("skill").sort(byUse).slice(0, 10);
    if (skills.length > 0) {
      lines.push(
        `What Captain most often asks you to do: ${skills.map((m) => `${m.text} (${m.hits}x)`).join("; ")}`,
      );
    }
    const shown = always.length + recent.length + topics.length + skills.length;
    const hidden = list.length - Math.min(shown, list.length);
    if (hidden > 0) lines.push(`(${hidden} more memories are stored; find them with recall.)`);
    return lines.length > 0
      ? lines.join("\n")
      : "(Nothing saved yet. This is a brand-new friendship.)";
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify({ version: 1, memories: this.memories }, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, this.file);
      });
    for (const listener of this.listeners) listener();
    return this.writeChain;
  }
}
