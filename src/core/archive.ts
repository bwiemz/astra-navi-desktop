import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Embedder } from "./embedder.ts";
import { tokenize } from "./memory.ts";
import { ftsQuery, packVector, unpackVector, type HerStore } from "./store.ts";

/** One exchange as it is kept: what the user said and what she answered. */
export interface ArchivedTurn {
  at: string;
  said: string;
  reply: string;
  /** Her reply was written with text from outside (a web page, a file) in the conversation. */
  outside: boolean;
}

interface Stored extends ArchivedTurn {
  vector: Float32Array | null;
}

interface TurnRow {
  id: number;
  at: string;
  said: string;
  reply: string;
  outside: number;
  vector: Uint8Array | null;
}

export interface Remembered {
  turn: ArchivedTurn;
  score: number;
}

const MAX_SAID_CHARS = 700;
const MAX_REPLY_CHARS = 900;
/** As for her notes: scores sit in a narrow band, so the bar is absolute and high. */
const MIN_SCORE = 0.81;
const SHARED_WORD_BONUS = 0.03;
/** The file is tidied (old exchanges dropped) once it has grown this far past its limit. */
const SLACK = 200;

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function sharedWordCount(words: ReadonlySet<string>, turn: ArchivedTurn): number {
  if (words.size === 0) return 0;
  const have = new Set(tokenize(`${turn.said} ${turn.reply}`));
  let shared = 0;
  for (const word of words) if (have.has(word)) shared += 1;
  return shared;
}

function scoreTurn(
  turn: ArchivedTurn,
  turnVector: Float32Array | null,
  queryVector: Float32Array | undefined,
  words: ReadonlySet<string>,
  ftsHit: boolean,
): number {
  const shared = sharedWordCount(words, turn);
  if (queryVector && turnVector && turnVector.length === queryVector.length) {
    return dot(queryVector, turnVector) + (ftsHit || shared > 0 ? SHARED_WORD_BONUS : 0);
  }
  // Without the meaning model: found only when most of the question's words are there.
  return words.size > 0 && shared / words.size >= 0.6 ? MIN_SCORE + 0.01 * shared : 0;
}

/**
 * Everything the two of them have said, kept on this computer so she can answer "what
 * did we decide about that last week?". Her notes hold what was worth learning; this
 * holds the conversations themselves, word for word, and is searched by meaning.
 *
 * Kept in the SQLite store when one is handed in, or in a plain file otherwise.
 */
export class ConversationArchive {
  private readonly file: string;
  private readonly embedder: Embedder;
  private readonly limit: number;
  private readonly store: HerStore | null;
  private turns: Stored[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private sinceTidy = 0;

  constructor(file: string, embedder: Embedder, limit = 4000, store?: HerStore) {
    this.file = file;
    this.embedder = embedder;
    this.limit = limit;
    this.store = store ?? null;
  }

  get count(): number {
    if (this.store) {
      if (!this.store.isOpen) return 0;
      return Number(this.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM turns")?.n ?? 0);
    }
    return this.turns.length;
  }

  private parseLegacy(raw: string): Stored[] {
    const turns: Stored[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (typeof entry["at"] !== "string" || typeof entry["said"] !== "string") continue;
        const packed = typeof entry["v"] === "string" ? Buffer.from(entry["v"], "base64") : null;
        turns.push({
          at: entry["at"],
          said: entry["said"],
          reply: typeof entry["reply"] === "string" ? entry["reply"] : "",
          outside: entry["outside"] === true,
          vector:
            packed && packed.length % 4 === 0 && packed.length > 0
              ? new Float32Array(
                  packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.length),
                )
              : null,
        });
      } catch {
        // one damaged line is not a reason to lose the rest
      }
    }
    return turns;
  }

  private insertTurnInStore(store: HerStore, turn: Stored): void {
    const id = store.run(
      "INSERT INTO turns (at, said, reply, outside, vector) VALUES (?, ?, ?, ?, ?)",
      turn.at,
      turn.said,
      turn.reply,
      turn.outside ? 1 : 0,
      turn.vector ? packVector(turn.vector) : null,
    );
    const ftsWords = `${turn.said} ${turn.reply} ${tokenize(`${turn.said} ${turn.reply}`).join(" ")}`.trim();
    if (ftsWords) {
      store.run("INSERT INTO turn_words (rowid, words) VALUES (?, ?)", id, ftsWords);
    }
  }

  async load(): Promise<void> {
    if (this.store) {
      const store = this.store;
      if (!store.isOpen || store.wasBroughtOver("conversations.jsonl")) return;
      let raw: string | null = null;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn("[archive] could not read past conversations:", error);
          return;
        }
      }
      const imported = raw ? this.parseLegacy(raw).slice(-this.limit) : [];
      store.together(() => {
        for (const turn of imported) this.insertTurnInStore(store, turn);
        store.noteBroughtOver("conversations.jsonl", new Date());
      });
      return;
    }

    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[archive] could not read past conversations:", error);
      }
      return;
    }
    const turns = this.parseLegacy(raw);
    this.turns = turns.slice(-this.limit);
    if (turns.length > this.limit) await this.rewrite();
  }

  /** Keeps one finished exchange. */
  async add(turn: ArchivedTurn): Promise<void> {
    const kept: Stored = {
      at: turn.at,
      said: clipText(turn.said, MAX_SAID_CHARS),
      reply: clipText(turn.reply, MAX_REPLY_CHARS),
      outside: turn.outside,
      vector: null,
    };
    if (kept.said.length === 0) return;
    try {
      [kept.vector = null] = await this.embedder.embed(
        [`${kept.said} ${kept.reply}`.slice(0, 900)],
        "passage",
      );
    } catch {
      // Kept without its numbers; it can still be found by its words.
    }
    if (this.store) {
      const store = this.store;
      if (!store.isOpen) return;
      store.together(() => {
        this.insertTurnInStore(store, kept);
        const overflow = store.all<{ id: number }>(
          "SELECT id FROM turns ORDER BY id DESC LIMIT -1 OFFSET ?",
          this.limit,
        );
        for (const row of overflow) {
          store.run("DELETE FROM turn_words WHERE rowid = ?", row.id);
          store.run("DELETE FROM turns WHERE id = ?", row.id);
        }
      });
      return;
    }

    this.turns.push(kept);
    this.sinceTidy += 1;
    if (this.turns.length > this.limit + SLACK || this.sinceTidy > 5000) {
      this.turns = this.turns.slice(-this.limit);
      await this.rewrite();
      return;
    }
    const line = `${JSON.stringify(this.pack(kept))}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error: unknown) => console.warn("[archive] could not save the exchange:", error));
    await this.writeChain;
  }

  /** The most recent exchanges, oldest first, as they were said: for showing, not for searching. */
  latest(count: number): ArchivedTurn[] {
    if (count <= 0) return [];
    if (this.store) {
      if (!this.store.isOpen) return [];
      const rows = this.store.all<Omit<TurnRow, "id" | "vector">>(
        "SELECT at, said, reply, outside FROM turns ORDER BY id DESC LIMIT ?",
        Math.floor(count),
      );
      return rows.reverse().map((row) => ({
        at: row.at,
        said: row.said,
        reply: row.reply,
        outside: row.outside === 1,
      }));
    }
    return this.turns
      .slice(-Math.floor(count))
      .map(({ at, said, reply, outside }) => ({ at, said, reply, outside }));
  }

  /** The past exchanges that best match what is being asked about, best first. */
  async search(query: string, limit = 3): Promise<Remembered[]> {
    const tokens = tokenize(query);
    const words = new Set(tokens.filter((word) => word.length > 2));
    let vector: Float32Array | undefined;
    try {
      [vector] = await this.embedder.embed([query], "query");
    } catch {
      vector = undefined;
    }
    if (this.store) {
      if (!this.store.isOpen) return [];
      const ftsHits = new Set<number>();
      const matchExpr = ftsQuery(tokens);
      if (matchExpr) {
        const matched = this.store.all<{ rowid: number }>(
          "SELECT rowid FROM turn_words WHERE turn_words MATCH ? ORDER BY bm25(turn_words) LIMIT 80",
          matchExpr,
        );
        for (const row of matched) ftsHits.add(row.rowid);
      }
      let rows: TurnRow[];
      if (vector || ftsHits.size === 0) {
        rows =
          !vector && words.size === 0
            ? []
            : this.store.all<TurnRow>("SELECT id, at, said, reply, outside, vector FROM turns");
      } else {
        const ids = [...ftsHits];
        const placeholders = ids.map(() => "?").join(", ");
        rows = this.store.all<TurnRow>(
          `SELECT id, at, said, reply, outside, vector FROM turns WHERE id IN (${placeholders})`,
          ...ids,
        );
      }
      const scored: Remembered[] = [];
      for (const row of rows) {
        const turn: ArchivedTurn = {
          at: row.at,
          said: row.said,
          reply: row.reply,
          outside: row.outside === 1,
        };
        const score = scoreTurn(turn, unpackVector(row.vector), vector, words, ftsHits.has(row.id));
        if (score >= MIN_SCORE) scored.push({ turn, score });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    const scored: Remembered[] = [];
    for (const turn of this.turns) {
      const score = scoreTurn(turn, turn.vector, vector, words, false);
      if (score >= MIN_SCORE) {
        scored.push({
          turn: { at: turn.at, said: turn.said, reply: turn.reply, outside: turn.outside },
          score,
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Removes and returns the newest archived turn (for Forget Last Turn / Edit & Resend). */
  async removeLast(): Promise<ArchivedTurn | null> {
    if (this.store) {
      const store = this.store;
      if (!store.isOpen) return null;
      const latest = store.one<Omit<TurnRow, "vector">>(
        "SELECT id, at, said, reply, outside FROM turns ORDER BY id DESC LIMIT 1",
      );
      if (!latest) return null;
      store.together(() => {
        store.run("DELETE FROM turn_words WHERE rowid = ?", latest.id);
        store.run("DELETE FROM turns WHERE id = ?", latest.id);
      });
      store.settle();
      return {
        at: latest.at,
        said: latest.said,
        reply: latest.reply,
        outside: latest.outside === 1,
      };
    }
    await this.writeChain.catch(() => undefined);
    const removed = this.turns.pop();
    if (!removed) return null;
    await this.rewrite();
    return {
      at: removed.at,
      said: removed.said,
      reply: removed.reply,
      outside: removed.outside,
    };
  }

  /** Forgets every past conversation. */
  async clear(): Promise<void> {
    if (this.store) {
      const store = this.store;
      if (store.isOpen) {
        store.together(() => {
          store.run("DELETE FROM turn_words");
          store.run("DELETE FROM turns");
        });
        store.settle();
      }
      await rm(this.file, { force: true });
      return;
    }
    this.turns = [];
    this.writeChain = this.writeChain
      .then(() => rm(this.file, { force: true }))
      .catch(() => undefined);
    await this.writeChain;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private pack(turn: Stored): Record<string, unknown> {
    return {
      at: turn.at,
      said: turn.said,
      reply: turn.reply,
      ...(turn.outside ? { outside: true } : {}),
      ...(turn.vector
        ? {
            v: Buffer.from(
              turn.vector.buffer,
              turn.vector.byteOffset,
              turn.vector.byteLength,
            ).toString("base64"),
          }
        : {}),
    };
  }

  private rewrite(): Promise<void> {
    this.sinceTidy = 0;
    const body = this.turns.map((turn) => JSON.stringify(this.pack(turn))).join("\n");
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((error: unknown) =>
        console.warn("[archive] could not tidy past conversations:", error),
      );
    return this.writeChain;
  }
}

/** Writes found exchanges the way she is shown them. */
export function describeRemembered(found: readonly Remembered[], userAddress?: string): string {
  const speaker =
    userAddress === undefined || userAddress.trim() === "Captain" ? "Captain" : "The user";
  return found
    .map(
      ({ turn }) =>
        `[${turn.at.slice(0, 10)}] ${speaker} said: ${turn.said}\n   You answered: ${turn.reply || "(nothing recorded)"}`,
    )
    .join("\n");
}
