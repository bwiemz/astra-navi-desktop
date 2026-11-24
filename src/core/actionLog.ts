import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { saveReplayBundle, type ReplaySnapshot } from "./replay.ts";
import type { HerStore } from "./store.ts";

/** One thing she did, tried to do, or was stopped from doing. */
export interface ActionEntry {
  at: string;
  tool: string;
  /** What exactly: the command, the file, the search. Credentials are blanked out. */
  detail: string;
  /**
   * done: it ran and worked. failed: it ran and did not work. declined: the user said no.
   * refused: her hands were off the controls, so it never ran.
   */
  outcome: "done" | "failed" | "declined" | "refused";
  /** The user was shown this and asked first. */
  asked: boolean;
  /** Her in conversation, her research process working alone, or a mission carrying out its steps. */
  by: "her" | "research" | "mission";
  /** Monotonic hash-chain sequence number (1-indexed). */
  seq?: number;
  /** SHA-256 hex digest of the preceding entry (or `GENESIS_HASH` for seq 1). */
  prevHash?: string;
  /** SHA-256 hex digest over this entry's canonical fields + prevHash. */
  entryHash?: string;
  /** Optional detached approval/device attestation signature attached at ask-approval time. */
  approvalSig?: string;
}

export interface ActionQuery {
  tool?: string;
  toolPrefix?: string;
  outcome?: ActionEntry["outcome"];
  by?: ActionEntry["by"];
  /** Matches a host or machine name substring in `detail` (case-insensitive). */
  host?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ActionChainVerification {
  ok: boolean;
  checked: number;
  firstBrokenIndex: number | null;
  reason: string | null;
}

export interface ActionChainProof {
  headSeq: number;
  headHash: string;
  count: number;
  verified: boolean;
}

interface ActionRow {
  at: string;
  tool: string;
  detail: string;
  outcome: string;
  asked: number;
  by: string;
  seq: number | null;
  prev_hash: string | null;
  entry_hash: string | null;
  approval_sig: string | null;
}

export const GENESIS_HASH = "0".repeat(64);
const MAX_DETAIL_CHARS = 400;
const SLACK = 200;

function validOutcome(value: unknown): ActionEntry["outcome"] {
  return value === "failed" || value === "declined" || value === "refused" ? value : "done";
}

function validBy(value: unknown): ActionEntry["by"] {
  return value === "research" || value === "mission" ? value : "her";
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

function rowToEntry(row: ActionRow): ActionEntry {
  return {
    at: row.at,
    tool: row.tool,
    detail: row.detail,
    outcome: validOutcome(row.outcome),
    asked: row.asked === 1,
    by: validBy(row.by),
    ...(typeof row.seq === "number" && Number.isFinite(row.seq) ? { seq: row.seq } : {}),
    ...(typeof row.prev_hash === "string" ? { prevHash: row.prev_hash } : {}),
    ...(typeof row.entry_hash === "string" ? { entryHash: row.entry_hash } : {}),
    ...(typeof row.approval_sig === "string" ? { approvalSig: row.approval_sig } : {}),
  };
}

/** Computes canonical SHA-256 hex digest for a hash-chained ActionEntry. */
export function computeActionEntryHash(
  entry: Pick<ActionEntry, "at" | "tool" | "detail" | "outcome" | "asked" | "by" | "approvalSig"> & {
    seq: number;
    prevHash: string;
  },
): string {
  const payload = JSON.stringify({
    seq: entry.seq,
    prevHash: entry.prevHash,
    at: entry.at,
    tool: entry.tool,
    detail: entry.detail,
    outcome: entry.outcome,
    asked: entry.asked,
    by: entry.by,
    approvalSig: entry.approvalSig ?? null,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Verifies chronological hash-chain integrity across an ordered oldest-first array of entries. */
export function verifyActionChain(entries: readonly ActionEntry[]): ActionChainVerification {
  let prevChained: { seq: number; hash: string } | null = null;
  let checked = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const hasHashMeta =
      typeof entry.seq === "number" ||
      typeof entry.prevHash === "string" ||
      typeof entry.entryHash === "string";

    if (!hasHashMeta) {
      if (prevChained !== null) {
        return {
          ok: false,
          checked,
          firstBrokenIndex: i,
          reason: `Unchained entry at index ${i} appeared after hash-chained sequence ${prevChained.seq}.`,
        };
      }
      continue;
    }

    if (
      typeof entry.seq !== "number" ||
      !Number.isInteger(entry.seq) ||
      entry.seq < 1 ||
      typeof entry.prevHash !== "string" ||
      typeof entry.entryHash !== "string"
    ) {
      return {
        ok: false,
        checked,
        firstBrokenIndex: i,
        reason: `Incomplete hash-chain metadata at index ${i}.`,
      };
    }

    if (prevChained === null) {
      if (entry.seq === 1 && entry.prevHash !== GENESIS_HASH) {
        return {
          ok: false,
          checked,
          firstBrokenIndex: i,
          reason: `Genesis entry at index ${i} has non-zero prevHash.`,
        };
      }
    } else {
      if (entry.seq !== prevChained.seq + 1) {
        return {
          ok: false,
          checked,
          firstBrokenIndex: i,
          reason: `Sequence gap/reorder at index ${i}: expected seq ${prevChained.seq + 1}, got ${entry.seq}.`,
        };
      }
      if (entry.prevHash !== prevChained.hash) {
        return {
          ok: false,
          checked,
          firstBrokenIndex: i,
          reason: `Broken prevHash link at index ${i} (seq ${entry.seq}).`,
        };
      }
    }

    const expected = computeActionEntryHash({
      seq: entry.seq,
      prevHash: entry.prevHash,
      at: entry.at,
      tool: entry.tool,
      detail: entry.detail,
      outcome: entry.outcome,
      asked: entry.asked,
      by: entry.by,
      ...(entry.approvalSig !== undefined ? { approvalSig: entry.approvalSig } : {}),
    });
    if (expected !== entry.entryHash) {
      return {
        ok: false,
        checked,
        firstBrokenIndex: i,
        reason: `Entry hash mismatch at index ${i} (seq ${entry.seq}): record was modified.`,
      };
    }

    prevChained = { seq: entry.seq, hash: entry.entryHash };
    checked += 1;
  }

  return { ok: true, checked, firstBrokenIndex: null, reason: null };
}

/**
 * The flight recorder: every tool call, in order, kept in the SQLite store when handed
 * one (or in a plain file otherwise), readable only by the user. Entries carry a sequential
 * SHA-256 hash chain so retrospective tampering, deletions, or reordering can be detected.
 */
export class ActionLog {
  private readonly file: string;
  private readonly limit: number;
  private readonly store: HerStore | null;
  private entries: ActionEntry[] = [];
  private chainSeq = 0;
  private chainHeadHash = GENESIS_HASH;
  private readonly snapshots: ReplaySnapshot[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(file: string, limit = 3000, store?: HerStore) {
    this.file = file;
    this.limit = limit;
    this.store = store ?? null;
  }

  private syncChainHead(entries: readonly ActionEntry[]): void {
    let lastSeq = 0;
    let lastHash = GENESIS_HASH;
    for (const e of entries) {
      if (typeof e.seq === "number" && typeof e.entryHash === "string") {
        lastSeq = e.seq;
        lastHash = e.entryHash;
      } else {
        lastSeq += 1;
      }
    }
    this.chainSeq = lastSeq;
    this.chainHeadHash = lastHash;
  }

  private parseLegacy(raw: string): ActionEntry[] {
    const entries: ActionEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Partial<ActionEntry>;
        if (typeof entry.at === "string" && typeof entry.tool === "string") {
          entries.push({
            at: entry.at,
            tool: entry.tool,
            detail: typeof entry.detail === "string" ? entry.detail : "",
            outcome: validOutcome(entry.outcome),
            asked: entry.asked === true,
            by: validBy(entry.by),
            ...(typeof entry.seq === "number" && Number.isFinite(entry.seq) ? { seq: entry.seq } : {}),
            ...(typeof entry.prevHash === "string" ? { prevHash: entry.prevHash } : {}),
            ...(typeof entry.entryHash === "string" ? { entryHash: entry.entryHash } : {}),
            ...(typeof entry.approvalSig === "string" ? { approvalSig: entry.approvalSig } : {}),
          });
        }
      } catch {
        // a damaged line is skipped, the rest of the record stands
      }
    }
    return entries;
  }

  async load(): Promise<void> {
    if (this.store) {
      const store = this.store;
      if (!store.isOpen) return;
      if (!store.wasBroughtOver("actions.jsonl")) {
        let raw: string | null = null;
        try {
          raw = await readFile(this.file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn("[actions] could not read the record of what she did:", error);
            return;
          }
        }
        const imported = raw ? this.parseLegacy(raw).slice(-this.limit) : [];
        store.together(() => {
          for (const entry of imported) {
            store.run(
              "INSERT INTO actions (at, tool, detail, outcome, asked, by, seq, prev_hash, entry_hash, approval_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              entry.at,
              entry.tool,
              entry.detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS),
              entry.outcome,
              entry.asked ? 1 : 0,
              entry.by,
              entry.seq ?? null,
              entry.prevHash ?? null,
              entry.entryHash ?? null,
              entry.approvalSig ?? null,
            );
          }
          store.noteBroughtOver("actions.jsonl", new Date());
        });
      }
      const tail = store.all<{ seq: number | null; entry_hash: string | null }>(
        "SELECT seq, entry_hash FROM actions ORDER BY id DESC LIMIT 1",
      )[0];
      if (tail && typeof tail.seq === "number" && typeof tail.entry_hash === "string") {
        this.chainSeq = tail.seq;
        this.chainHeadHash = tail.entry_hash;
      } else {
        const countRow = store.all<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM actions")[0];
        this.chainSeq = countRow?.cnt ?? 0;
        this.chainHeadHash = GENESIS_HASH;
      }
      return;
    }

    try {
      const raw = await readFile(this.file, "utf8");
      this.entries = this.parseLegacy(raw).slice(-this.limit);
      this.syncChainHead(this.entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[actions] could not read the record of what she did:", error);
      }
    }
  }

  add(entry: ActionEntry): void {
    const cleanDetail = entry.detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
    const seq = this.chainSeq + 1;
    const prevHash = this.chainHeadHash;
    const entryHash = computeActionEntryHash({
      seq,
      prevHash,
      at: entry.at,
      tool: entry.tool,
      detail: cleanDetail,
      outcome: entry.outcome,
      asked: entry.asked,
      by: entry.by,
      ...(entry.approvalSig !== undefined ? { approvalSig: entry.approvalSig } : {}),
    });
    this.chainSeq = seq;
    this.chainHeadHash = entryHash;

    const kept: ActionEntry = {
      ...entry,
      detail: cleanDetail,
      seq,
      prevHash,
      entryHash,
    };

    if (this.store) {
      const store = this.store;
      if (!store.isOpen) return;
      store.together(() => {
        store.run(
          "INSERT INTO actions (at, tool, detail, outcome, asked, by, seq, prev_hash, entry_hash, approval_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          kept.at,
          kept.tool,
          kept.detail,
          kept.outcome,
          kept.asked ? 1 : 0,
          kept.by,
          seq,
          prevHash,
          entryHash,
          kept.approvalSig ?? null,
        );
        store.run(
          "DELETE FROM actions WHERE id NOT IN (SELECT id FROM actions ORDER BY id DESC LIMIT ?)",
          this.limit,
        );
      });
      return;
    }

    this.entries.push(kept);
    if (this.entries.length > this.limit + SLACK) {
      this.entries = this.entries.slice(-this.limit);
      const body = this.entries.map((line) => JSON.stringify(line)).join("\n");
      this.writeChain = this.writeChain
        .then(async () => {
          const tmp = `${this.file}.tmp`;
          await writeFile(tmp, `${body}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(tmp, this.file);
        })
        .catch((error: unknown) => console.warn("[actions] could not tidy the record:", error));
      return;
    }
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(kept)}\n`, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error: unknown) => console.warn("[actions] could not save to the record:", error));
  }

  private chronologicalEntries(): ActionEntry[] {
    if (this.store) {
      if (!this.store.isOpen) return [];
      const rows = this.store.all<ActionRow>(
        "SELECT at, tool, detail, outcome, asked, by, seq, prev_hash, entry_hash, approval_sig FROM actions ORDER BY id ASC",
      );
      return rows.map(rowToEntry);
    }
    return [...this.entries];
  }

  /** Verifies hash-chain integrity across all currently retained entries. */
  verifyChain(): ActionChainVerification {
    return verifyActionChain(this.chronologicalEntries());
  }

  /** Exports the current cryptographic hash-chain head and verification proof. */
  exportChainProof(): ActionChainProof {
    const entries = this.chronologicalEntries();
    const verification = verifyActionChain(entries);
    const last = entries[entries.length - 1];
    return {
      headSeq: last?.seq ?? this.chainSeq,
      headHash: last?.entryHash ?? this.chainHeadHash,
      count: entries.length,
      verified: verification.ok,
    };
  }

  /** The latest entries, newest first. */
  recent(count = 200): ActionEntry[] {
    if (count <= 0) return [];
    if (this.store) {
      if (!this.store.isOpen) return [];
      const rows = this.store.all<ActionRow>(
        "SELECT at, tool, detail, outcome, asked, by, seq, prev_hash, entry_hash, approval_sig FROM actions ORDER BY id DESC LIMIT ?",
        Math.floor(count),
      );
      return rows.map(rowToEntry);
    }
    return this.entries.slice(-count).reverse();
  }

  /** Structured lookup over recorded actions, newest first. */
  query(filter: ActionQuery = {}): ActionEntry[] {
    const limit = Math.max(0, Math.floor(filter.limit ?? 200));
    if (limit === 0) return [];
    if (this.store) {
      if (!this.store.isOpen) return [];
      const clauses: string[] = [];
      const values: SQLInputValue[] = [];
      if (filter.tool !== undefined) {
        clauses.push("tool = ?");
        values.push(filter.tool);
      }
      if (filter.toolPrefix !== undefined) {
        clauses.push("tool LIKE ? ESCAPE '\\'");
        values.push(`${escapeLike(filter.toolPrefix)}%`);
      }
      if (filter.outcome !== undefined) {
        clauses.push("outcome = ?");
        values.push(filter.outcome);
      }
      if (filter.by !== undefined) {
        clauses.push("by = ?");
        values.push(filter.by);
      }
      if (filter.host !== undefined && filter.host !== "") {
        clauses.push("LOWER(detail) LIKE ? ESCAPE '\\'");
        values.push(`%${escapeLike(filter.host.toLowerCase())}%`);
      }
      if (filter.since !== undefined) {
        clauses.push("at >= ?");
        values.push(filter.since);
      }
      if (filter.until !== undefined) {
        clauses.push("at <= ?");
        values.push(filter.until);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      values.push(limit);
      return this.store
        .all<ActionRow>(
          `SELECT at, tool, detail, outcome, asked, by, seq, prev_hash, entry_hash, approval_sig FROM actions ${where} ORDER BY id DESC LIMIT ?`,
          ...values,
        )
        .map(rowToEntry);
    }

    const hostLower = filter.host?.toLowerCase();
    const matched: ActionEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (!entry) continue;
      if (filter.tool !== undefined && entry.tool !== filter.tool) continue;
      if (filter.toolPrefix !== undefined && !entry.tool.startsWith(filter.toolPrefix)) continue;
      if (filter.outcome !== undefined && entry.outcome !== filter.outcome) continue;
      if (filter.by !== undefined && entry.by !== filter.by) continue;
      if (hostLower && !entry.detail.toLowerCase().includes(hostLower)) continue;
      if (filter.since !== undefined && entry.at < filter.since) continue;
      if (filter.until !== undefined && entry.at > filter.until) continue;
      matched.push(entry);
      if (matched.length >= limit) break;
    }
    return matched;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  /** Records an in-memory deterministic replay snapshot (capped at 250 recent turns). */
  recordSnapshot(snapshot: ReplaySnapshot): void {
    this.snapshots.push(snapshot);
    if (this.snapshots.length > 250) {
      this.snapshots.splice(0, this.snapshots.length - 250);
    }
  }

  /** Returns recently recorded replay snapshots, oldest first. */
  recentSnapshots(limit = 50): ReplaySnapshot[] {
    if (limit <= 0) return [];
    return this.snapshots.slice(-Math.floor(limit));
  }

  /** Writes a scrubbed, compressed deterministic `.gz` replay bundle (`0600`). */
  exportReplayBundle(filePath: string): Promise<{ saved: number; skippedWithheld: number }> {
    return saveReplayBundle(filePath, this.snapshots);
  }
}

const OUTCOME_WORDS: Record<ActionEntry["outcome"], string> = {
  done: "done",
  failed: "failed",
  declined: "you said no",
  refused: "blocked: hands off",
};

/** The record as a page a person can read, newest first, grouped by day. */
export function describeActions(entries: readonly ActionEntry[], file: string): string {
  const lines = [
    "# What AI-chan has done",
    "",
    'Every use of her tools, newest first. "asked" means you were shown it and approved it first. The full record is in the file below.',
    "",
    `File: \`${file}\``,
  ];
  if (entries.length === 0) lines.push("", "Nothing yet.");
  let day = "";
  for (const entry of entries) {
    const when = new Date(entry.at);
    const thisDay = Number.isNaN(when.getTime())
      ? entry.at.slice(0, 10)
      : when.toLocaleDateString("en-CA");
    if (thisDay !== day) {
      day = thisDay;
      lines.push("", `## ${day}`, "");
    }
    const time = Number.isNaN(when.getTime())
      ? ""
      : when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const marks = [
      OUTCOME_WORDS[entry.outcome],
      entry.asked ? "asked" : "",
      entry.by !== "her" ? entry.by : "",
    ]
      .filter(Boolean)
      .join(", ");
    // Backticks in the detail would end the code span early.
    const detail = entry.detail ? ` \`${entry.detail.replaceAll("`", "'")}\`` : "";
    lines.push(`- ${time} **${entry.tool}**${detail} (${marks})`);
  }
  return `${lines.join("\n")}\n`;
}
