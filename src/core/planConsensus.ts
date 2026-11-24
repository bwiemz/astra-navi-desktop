/**
 * Self-Consistency Consensus for High-Risk / Multi-Step Plans.
 *
 * Samples 2–3 low-temperature candidate trajectories and verifies exact agreement on
 * canonicalized commands, target controls, and touched paths before surfacing an
 * approval card—catching silent small/9B misreads prior to user confirmation.
 */

export interface PlanCandidate {
  commands: readonly string[];
  targetControls?: readonly string[];
  targetPaths?: readonly string[];
}

export interface PlanConsensusResult {
  agreed: boolean;
  runs: number;
  matchingRuns: number;
  consensusRatio: number;
  canonicalPlan: PlanCandidate | null;
  disagreements: string[];
  requireManualReview: boolean;
}

function canonicalSignature(plan: PlanCandidate): {
  sig: string;
  normalized: PlanCandidate;
} {
  const normCmds = plan.commands.map((c) => c.trim().replace(/\s+/g, " "));
  const normCtrls = (plan.targetControls ?? []).map((c) => c.trim().toLowerCase());
  const normPaths = (plan.targetPaths ?? []).map((p) => p.trim().replace(/\\/g, "/"));
  const normalized: PlanCandidate = {
    commands: normCmds,
    targetControls: normCtrls,
    targetPaths: normPaths,
  };
  return {
    sig: JSON.stringify(normalized),
    normalized,
  };
}

/** Checks whether low-temperature candidate plans agree on exact commands, controls, and paths. */
export function evaluatePlanConsensus(
  candidates: readonly PlanCandidate[],
  minAgreementRatio = 1.0,
): PlanConsensusResult {
  if (candidates.length === 0) {
    return {
      agreed: false,
      runs: 0,
      matchingRuns: 0,
      consensusRatio: 0,
      canonicalPlan: null,
      disagreements: ["No candidate trajectories supplied for consensus check."],
      requireManualReview: true,
    };
  }

  const buckets = new Map<string, { count: number; plan: PlanCandidate }>();
  for (const cand of candidates) {
    const { sig, normalized } = canonicalSignature(cand);
    const prev = buckets.get(sig);
    if (prev) prev.count += 1;
    else buckets.set(sig, { count: 1, plan: normalized });
  }

  let best: { sig: string; count: number; plan: PlanCandidate } | null = null;
  for (const [sig, entry] of buckets.entries()) {
    if (!best || entry.count > best.count) {
      best = { sig, count: entry.count, plan: entry.plan };
    }
  }

  const total = candidates.length;
  const ratio = best ? best.count / total : 0;
  const agreed = total >= 2 && ratio >= minAgreementRatio;
  const disagreements: string[] = [];

  if (buckets.size > 1 && best) {
    const altPlans = [...buckets.values()]
      .filter((b) => JSON.stringify(b.plan) !== best.sig)
      .map((b) => `${b.count}x: ${b.plan.commands.join(" && ") || "(empty)"}`);
    disagreements.push(
      `Majority (${best.count}/${total}) differed from alternative(s): ${altPlans.join(" | ")}`,
    );
  }

  return {
    agreed,
    runs: total,
    matchingRuns: best?.count ?? 0,
    consensusRatio: Number(ratio.toFixed(3)),
    canonicalPlan: agreed && best ? best.plan : null,
    disagreements,
    requireManualReview: !agreed,
  };
}

/** Runs `runs` independent low-temperature trajectory generators and scores self-consistency. */
export async function runPlanConsensus(
  generateCandidate: (runIndex: number) => Promise<PlanCandidate>,
  options: { runs?: number; minAgreement?: number } = {},
): Promise<PlanConsensusResult> {
  const runs = Math.max(2, Math.min(5, Math.round(options.runs ?? 3)));
  const minAgreement = Math.max(0.5, Math.min(1, options.minAgreement ?? 1.0));
  const candidates: PlanCandidate[] = [];
  for (let i = 0; i < runs; i += 1) {
    candidates.push(await generateCandidate(i));
  }
  return evaluatePlanConsensus(candidates, minAgreement);
}
