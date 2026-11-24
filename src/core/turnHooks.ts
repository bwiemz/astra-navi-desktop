import { evaluatePlanConsensus, type PlanCandidate, type PlanConsensusResult } from "./planConsensus.ts";
import type { SemanticCacheLookupResult, SemanticCommandCache } from "./semanticCache.ts";

/**
 * Shared context passed through optional experimental turn hooks in `Brain`.
 * Hooks remain opt-in and feature-flagged so default behavior is unchanged.
 */
export interface TurnHookContext {
  userText: string;
  spoken: boolean;
  isEvent: boolean;
  away: boolean;
  readOutsideText: boolean;
  handsOff: boolean;
  offeredTools: string[];
  usedTools: string[];
  replyText: string;
  falseClaim: boolean;
  cachedHit?: SemanticCacheLookupResult;
  consensusVerdict?: PlanConsensusResult;
  flags: Record<string, unknown>;
}

export interface BeforeRouteDecision {
  /** Short-circuit reply without invoking the model (for verified safe cache hits). */
  shortCircuitReply?: string;
  /** Optional allowlist narrowing the offered tools for this turn. */
  offeredTools?: string[];
}

export interface AfterPlanDecision {
  requireManualReview?: boolean;
  consensusVerdict?: PlanConsensusResult;
}

export interface TurnHook {
  readonly id: string;
  beforeRoute?(
    ctx: TurnHookContext,
  ): Promise<BeforeRouteDecision | undefined> | BeforeRouteDecision | undefined;
  afterPlan?(
    ctx: TurnHookContext,
  ): Promise<AfterPlanDecision | undefined> | AfterPlanDecision | undefined;
  beforeCommit?(ctx: TurnHookContext): unknown;
}

/**
 * Error-isolated pipeline of turn hooks invoked around routing, planning, and commit.
 * Failures inside any hook are logged and ignored so core chat never breaks.
 */
export class TurnHookPipeline {
  private readonly hooks: TurnHook[] = [];

  register(hook: TurnHook): void {
    const idx = this.hooks.findIndex((existing) => existing.id === hook.id);
    if (idx >= 0) this.hooks[idx] = hook;
    else this.hooks.push(hook);
  }

  unregister(id: string): boolean {
    const idx = this.hooks.findIndex((existing) => existing.id === id);
    if (idx < 0) return false;
    this.hooks.splice(idx, 1);
    return true;
  }

  list(): readonly string[] {
    return this.hooks.map((hook) => hook.id);
  }

  async runBeforeRoute(ctx: TurnHookContext): Promise<BeforeRouteDecision> {
    const merged: BeforeRouteDecision = {};
    for (const hook of this.hooks) {
      if (!hook.beforeRoute) continue;
      try {
        const res = await hook.beforeRoute(ctx);
        if (!res) continue;
        if (res.offeredTools) {
          merged.offeredTools = [...res.offeredTools];
          ctx.offeredTools = [...res.offeredTools];
        }
        if (res.shortCircuitReply !== undefined) {
          merged.shortCircuitReply = res.shortCircuitReply;
          break;
        }
      } catch (error) {
        console.warn(`[turnHooks] ${hook.id}.beforeRoute failed:`, error);
      }
    }
    return merged;
  }

  async runAfterPlan(ctx: TurnHookContext): Promise<AfterPlanDecision> {
    const merged: AfterPlanDecision = {};
    for (const hook of this.hooks) {
      if (!hook.afterPlan) continue;
      try {
        const res = await hook.afterPlan(ctx);
        if (!res) continue;
        if (typeof res.requireManualReview === "boolean" && merged.requireManualReview !== true) {
          merged.requireManualReview = res.requireManualReview;
        }
        if (res.consensusVerdict) merged.consensusVerdict = res.consensusVerdict;
      } catch (error) {
        console.warn(`[turnHooks] ${hook.id}.afterPlan failed:`, error);
      }
    }
    return merged;
  }

  async runBeforeCommit(ctx: TurnHookContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.beforeCommit) continue;
      try {
        await hook.beforeCommit(ctx);
      } catch (error) {
        console.warn(`[turnHooks] ${hook.id}.beforeCommit failed:`, error);
      }
    }
  }
}

function parseArgsObject(ctx: TurnHookContext): Record<string, unknown> {
  const explicit = ctx.flags.lastToolArgs;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    return explicit as Record<string, unknown>;
  }
  const raw = ctx.flags.lastToolInput;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall back to empty args when traced input was truncated or non-JSON.
    }
  }
  return {};
}

/**
 * Feature-flagged seam for `SemanticCommandCache`: looks up safe recurring commands in
 * `beforeRoute` and populates validated single-tool turns in `beforeCommit`.
 */
export function createSemanticCacheHook(
  cache: SemanticCommandCache,
  isEnabled: () => boolean,
  resolveCachedReply?: (
    hit: SemanticCacheLookupResult,
    ctx: TurnHookContext,
  ) => Promise<string | null> | string | null,
): TurnHook {
  return {
    id: "semantic-cache",
    async beforeRoute(ctx) {
      if (!isEnabled() || ctx.isEvent) return;
      const lookup = await cache.lookup(ctx.userText, {
        readOutsideText: ctx.readOutsideText,
        handsOff: ctx.handsOff,
      });
      ctx.cachedHit = lookup;
      if (!lookup.hit || !resolveCachedReply) return;
      const reply = await resolveCachedReply(lookup, ctx);
      if (typeof reply === "string" && reply.length > 0) {
        return { shortCircuitReply: reply };
      }
    },
    async beforeCommit(ctx) {
      if (!isEnabled() || ctx.isEvent || ctx.falseClaim || ctx.readOutsideText || ctx.handsOff) {
        return;
      }
      if (ctx.usedTools.length !== 1) return;
      const tool = ctx.usedTools[0];
      if (!tool) return;
      await cache.record(ctx.userText, tool, parseArgsObject(ctx));
    },
  };
}

/**
 * Feature-flagged seam for self-consistency plan consensus (`evaluatePlanConsensus`):
 * checks multi-sample agreement in `afterPlan` and marks disagreement for manual review.
 */
export function createPlanConsensusHook(
  isEnabled: () => boolean,
  generateCandidates: (
    ctx: TurnHookContext,
  ) => Promise<readonly PlanCandidate[] | null> | readonly PlanCandidate[] | null,
  minAgreement = 1.0,
): TurnHook {
  return {
    id: "plan-consensus",
    async afterPlan(ctx) {
      if (!isEnabled() || ctx.isEvent || ctx.falseClaim) return;
      const candidates = await generateCandidates(ctx);
      if (!candidates) return;
      const verdict = evaluatePlanConsensus(candidates, minAgreement);
      ctx.consensusVerdict = verdict;
      ctx.flags.consensusRequireManualReview = verdict.requireManualReview;
      return {
        requireManualReview: verdict.requireManualReview,
        consensusVerdict: verdict,
      };
    },
  };
}
