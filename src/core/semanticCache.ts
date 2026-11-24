import type { Embedder } from "./embedder.ts";
import { TOOLS } from "./permissions.ts";

/**
 * Low-Latency Semantic Cache for Recurring Safe Desktop Queries.
 *
 * Lets exact or near-identical recurring utility prompts ("pause music", "volume 40",
 * "what's on my agenda today") bypass full LLM tool-selection overhead and dispatch in
 * sub-100ms while preserving strict safety gates:
 * - Only explicitly allowlisted safe/idempotent tools may ever be cached.
 * - Any numeric slot mismatch (e.g. "volume 40" vs "volume 80") refuses cache reuse so
 *   arguments are never stale-aliased.
 * - Unconditional bypass when `readOutsideText === true` or `handsOff === true`.
 */

const CACHEABLE_SAFE_TOOLS = new Set<string>([
  TOOLS.sound,
  TOOLS.agenda,
  TOOLS.weather,
  TOOLS.shipStatus,
  TOOLS.reminders,
  TOOLS.windows,
]);

export interface CachedToolDispatch {
  query: string;
  tool: string;
  args: Record<string, unknown>;
  numbers: number[];
  vector?: Float32Array;
  createdAtMs: number;
  hits: number;
}

export interface SemanticCacheLookupResult {
  hit: boolean;
  reason: "bypass_tainted" | "bypass_hands_off" | "number_mismatch" | "miss" | "exact" | "semantic";
  tool?: string;
  args?: Record<string, unknown>;
  similarity?: number;
}

function normalizeQuery(text: string): string {
  return text.trim().toLowerCase().replace(/[.?!。！？]+$/g, "").replace(/\s+/g, " ");
}

function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number.parseFloat(m)).filter((n) => Number.isFinite(n));
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, idx) => v === b[idx]);
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-8 ? dot / denom : 0;
}

export class SemanticCommandCache {
  private readonly embedder: Embedder | null;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly minSimilarity: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CachedToolDispatch>();

  constructor(
    options: {
      embedder?: Embedder | null;
      maxEntries?: number;
      ttlMs?: number;
      minSimilarity?: number;
      now?: () => number;
    } = {},
  ) {
    this.embedder = options.embedder ?? null;
    this.maxEntries = Math.max(8, options.maxEntries ?? 128);
    this.ttlMs = Math.max(1000, options.ttlMs ?? 30 * 60_000);
    this.minSimilarity = Math.max(0.75, Math.min(0.99, options.minSimilarity ?? 0.91));
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  /** Stores a verified safe tool invocation for future fast-path lookup. */
  async record(
    query: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (!CACHEABLE_SAFE_TOOLS.has(tool)) return false;
    const norm = normalizeQuery(query);
    if (!norm || norm.length > 160) return false;

    const clonedArgs = structuredClone(args);
    let vector: Float32Array | undefined;
    if (this.embedder) {
      try {
        const vecs = await this.embedder.embed([norm], "query");
        vector = vecs[0];
      } catch {
        vector = undefined;
      }
    }

    if (this.entries.has(norm)) this.entries.delete(norm);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
      else break;
    }

    this.entries.set(norm, {
      query: norm,
      tool,
      args: clonedArgs,
      numbers: extractNumbers(norm),
      vector,
      createdAtMs: this.now(),
      hits: 0,
    });
    return true;
  }

  async lookup(
    query: string,
    policy: { readOutsideText?: boolean; handsOff?: boolean } = {},
  ): Promise<SemanticCacheLookupResult> {
    if (policy.readOutsideText) return { hit: false, reason: "bypass_tainted" };
    if (policy.handsOff) return { hit: false, reason: "bypass_hands_off" };

    const norm = normalizeQuery(query);
    if (!norm || norm.length > 160) return { hit: false, reason: "miss" };

    const currentMs = this.now();
    for (const [k, entry] of this.entries.entries()) {
      if (currentMs - entry.createdAtMs > this.ttlMs) {
        this.entries.delete(k);
      }
    }

    const qNumbers = extractNumbers(norm);
    const exact = this.entries.get(norm);
    if (exact) {
      exact.hits += 1;
      return {
        hit: true,
        reason: "exact",
        tool: exact.tool,
        args: structuredClone(exact.args),
        similarity: 1,
      };
    }

    if (!this.embedder || this.entries.size === 0) {
      return { hit: false, reason: "miss" };
    }

    let qVec: Float32Array | undefined;
    try {
      const res = await this.embedder.embed([norm], "query");
      qVec = res[0];
    } catch {
      return { hit: false, reason: "miss" };
    }
    if (!qVec) return { hit: false, reason: "miss" };

    let best: { entry: CachedToolDispatch; sim: number } | null = null;
    for (const entry of this.entries.values()) {
      if (!entry.vector) continue;
      const sim = cosineSim(qVec, entry.vector);
      if (sim >= this.minSimilarity && (!best || sim > best.sim)) {
        best = { entry, sim };
      }
    }
    if (!best) return { hit: false, reason: "miss" };
    if (!sameNumbers(qNumbers, best.entry.numbers)) {
      return {
        hit: false,
        reason: "number_mismatch",
        similarity: Number(best.sim.toFixed(4)),
      };
    }
    best.entry.hits += 1;
    return {
      hit: true,
      reason: "semantic",
      tool: best.entry.tool,
      args: structuredClone(best.entry.args),
      similarity: Number(best.sim.toFixed(4)),
    };
  }

  clear(): void {
    this.entries.clear();
  }
}
