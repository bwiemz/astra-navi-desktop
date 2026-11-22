import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";

/**
 * Her records in one database file on this computer: the conversations word for word
 * and the record of what she did. They used to be a plain file each, read whole into
 * memory when she started and written out whole again whenever old lines were let go.
 *
 * A database gives three things those files could not: a change is written all at once
 * or not at all, so a crash half-way cannot leave half a record; a search by word goes
 * through an index and not through every line; and old entries are let go one at a
 * time.
 *
 * It is SQLite, which is part of the runtime she is built on: nothing is installed for
 * it and nothing listens on the network. The file can be read by this account only.
 * What is forgotten is overwritten in the file, not merely unlisted.
 *
 * Each table belongs to the class that reads and writes it (`ConversationArchive`,
 * `ActionLog`); this file only opens the database and brings its layout up to date.
 */

/**
 * How the layout came to be, one step a version. A step is never edited once it has
 * been out: a database made by an older version is brought forward by the steps after
 * its own.
 *
 * The index of words is told to take a forgotten entry's words out there and then
 * ('secure-delete'). Left to itself it only marks them as gone, and they stay readable
 * in the file until it next tidies itself: measured, with the leaner kind of index that
 * keeps no copy of the words, one forgotten entry was still in the file afterwards.
 */
const LAYOUT: readonly string[] = [
  // 1: conversations, the words in them for searching, and the record of what she did.
  `
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    said TEXT NOT NULL,
    reply TEXT NOT NULL,
    outside INTEGER NOT NULL DEFAULT 0,
    vector BLOB
  );
  CREATE VIRTUAL TABLE turn_words USING fts5(
    words,
    tokenize = "unicode61 remove_diacritics 0"
  );
  INSERT INTO turn_words (turn_words, rank) VALUES ('secure-delete', 1);
  CREATE TABLE actions (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    tool TEXT NOT NULL,
    detail TEXT NOT NULL,
    outcome TEXT NOT NULL,
    asked INTEGER NOT NULL DEFAULT 0,
    by TEXT NOT NULL DEFAULT 'her'
  );
  CREATE TABLE brought_over (
    what TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );
  `,
  // 2: indexes, play log, standing orders, and cached note vectors + words.
  `
  CREATE INDEX idx_turns_at ON turns (at);
  CREATE INDEX idx_actions_at ON actions (at);
  CREATE INDEX idx_actions_tool ON actions (tool);
  CREATE TABLE play_sessions (
    id INTEGER PRIMARY KEY,
    game TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL
  );
  CREATE INDEX idx_play_sessions_ended ON play_sessions (ended_at);
  CREATE TABLE play_open (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    game TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE standing_orders (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    check_json TEXT NOT NULL,
    tell_when TEXT NOT NULL,
    value TEXT NOT NULL,
    every_minutes INTEGER NOT NULL,
    repeat INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    baseline TEXT,
    held INTEGER,
    last_checked_at TEXT
  );
  CREATE TABLE memory_vectors (
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    hash TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (id, kind)
  );
  CREATE VIRTUAL TABLE memory_words USING fts5(
    id UNINDEXED,
    words,
    tokenize = "unicode61 remove_diacritics 0"
  );
  INSERT INTO memory_words (memory_words, rank) VALUES ('secure-delete', 1);
  `,
  // 3: implicit-feedback episodic graph and context threshold calibration.
  `
  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    context_bucket TEXT NOT NULL,
    active_app TEXT NOT NULL,
    mode TEXT NOT NULL,
    summary TEXT NOT NULL,
    action_key TEXT
  );
  CREATE INDEX idx_episodes_bucket_at ON episodes (context_bucket, at);
  CREATE TABLE episode_feedback (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    signal TEXT NOT NULL,
    reward REAL NOT NULL,
    delay_ms INTEGER NOT NULL
  );
  CREATE INDEX idx_episode_feedback_ep ON episode_feedback (episode_id);
  CREATE TABLE episode_thresholds (
    context_bucket TEXT PRIMARY KEY,
    ema_reward REAL NOT NULL,
    tau_act REAL NOT NULL,
    tau_speak REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

/** The newest layout this version knows. A database from a later version is not opened. */
export const LAYOUT_VERSION = LAYOUT.length;

export class StoreFromTheFuture extends Error {
  constructor(found: number) {
    super(
      `Her records were written by a newer version of her (layout ${found}; this one knows ${LAYOUT_VERSION}). They are left untouched.`,
    );
  }
}

export class HerStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  /** Opens the database at `file`, making it if need be. `":memory:"` keeps it nowhere. */
  constructor(file: string) {
    const onDisk = file !== ":memory:";
    if (onDisk) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(file);
    try {
      // Its side files (the write-ahead log) take their permissions from the main one.
      if (onDisk) chmodSync(file, 0o600);
      // What is deleted is overwritten with zeros: "forget" has to mean it.
      this.db.exec("PRAGMA secure_delete = ON");
      if (onDisk) this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA busy_timeout = 2000");
      this.bringUpToDate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private bringUpToDate(): void {
    const found = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (found > LAYOUT_VERSION) throw new StoreFromTheFuture(found);
    for (let version = found; version < LAYOUT_VERSION; version += 1) {
      const step = LAYOUT[version];
      if (step === undefined) break;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(step);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /** A statement, made ready once and kept: the same text gives the same statement. */
  private statement(sql: string): StatementSync {
    let made = this.statements.get(sql);
    if (!made) {
      made = this.db.prepare(sql);
      this.statements.set(sql, made);
    }
    return made;
  }

  /** Runs a statement that changes something. Returns the id of a row it added. */
  run(sql: string, ...values: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...values).lastInsertRowid);
  }

  /** Every row a question finds. */
  all<Row>(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...values) as Row[];
  }

  /** The first row a question finds, or undefined. */
  one<Row>(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...values) as Row | undefined;
  }

  /** Does all of `work` or none of it. */
  together<Result>(work: () => Result): Result {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** True once the named older file has been brought over into the database. */
  wasBroughtOver(what: string): boolean {
    return this.one("SELECT 1 AS found FROM brought_over WHERE what = ?", what) !== undefined;
  }

  noteBroughtOver(what: string, at: Date): void {
    this.run(
      "INSERT OR REPLACE INTO brought_over (what, at) VALUES (?, ?)",
      what,
      at.toISOString(),
    );
  }

  /**
   * After something was forgotten: what was deleted is cleared out of the side file as
   * well, so that it is in no file at all.
   */
  settle(): void {
    if (this.closed) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Another reader holds it; the next settle or the close does it.
    }
  }

  /** Reclaims unused pages during idle/nightly hygiene without failing when closed or busy. */
  vacuum(): void {
    if (this.closed) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("VACUUM");
    } catch {
      // Skipped cleanly when in-memory/busy.
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // closing all the same
    }
    this.db.close();
  }
}

/** Joins search tokens into a quoted OR query for FTS5, or null when nothing is searchable. */
export function ftsQuery(tokens: readonly string[]): string | null {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    unique.push(`"${token.replaceAll('"', '""')}"`);
    if (unique.length >= 24) break;
  }
  return unique.length > 0 ? unique.join(" OR ") : null;
}

/** Views a vector's raw bytes for storing in a BLOB column. */
export function packVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Copies a stored BLOB back into an aligned Float32Array, or null when missing or malformed. */
export function unpackVector(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0 || blob.byteLength % 4 !== 0) {
    return null;
  }
  return new Float32Array(blob.slice().buffer);
}
