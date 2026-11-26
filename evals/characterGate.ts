import type { CaseResult, Report } from "./types.ts";

/**
 * Character & Form Regression Gate for Brain Tier Changes.
 *
 * Personality drift after a model or quantization change is one of the primary reasons
 * users abandon desktop companions. This gate evaluates the `character` category cases
 * (mood tags, by-name form, spoken conciseness, language adherence, plain formatting)
 * against a minimum pass-rate floor and an optional baseline report to block regressions.
 */

export const DEFAULT_CHARACTER_GATE_MIN_PASS_RATE = 0.85;
export const DEFAULT_CHARACTER_GATE_MAX_DROP = 0.05;

export interface CharacterGateOptions {
  /** Optional baseline report (previous brain tier / model) to check for personality drift. */
  baseline?: Report;
  /** Minimum pass rate required across all `character` cases (default: 0.85 = 85%). */
  minPassRate?: number;
  /** Maximum permitted drop relative to `baseline` (default: 0.05 = 5 percentage points). */
  maxDrop?: number;
}

export interface CharacterDriftEntry {
  id: string;
  baselinePassRate: number;
  candidatePassRate: number;
  delta: number;
  failures: string[];
}

export interface CharacterGateResult {
  passed: boolean;
  label: string;
  brain: string;
  totalCases: number;
  passedCases: number;
  passRate: number;
  minPassRate: number;
  baselineLabel: string | null;
  baselinePassRate: number | null;
  delta: number | null;
  maxDrop: number;
  reasons: string[];
  failedCases: { id: string; passRate: number; failures: string[] }[];
  regressedCases: CharacterDriftEntry[];
}

function characterCasesOf(report: Report): CaseResult[] {
  return report.cases.filter((entry) => entry.category === "character");
}

function averagePassRate(cases: readonly CaseResult[]): number {
  if (cases.length === 0) return 0;
  return cases.reduce((sum, entry) => sum + entry.passRate, 0) / cases.length;
}

/** Evaluates whether a candidate report passes the Character & Form personality-drift gate. */
export function evaluateCharacterGate(
  candidate: Report,
  options: CharacterGateOptions = {},
): CharacterGateResult {
  const minPassRate = options.minPassRate ?? DEFAULT_CHARACTER_GATE_MIN_PASS_RATE;
  const maxDrop = options.maxDrop ?? DEFAULT_CHARACTER_GATE_MAX_DROP;
  const charCases = characterCasesOf(candidate);
  const totalCases = charCases.length;
  const passedCases = charCases.filter((c) => c.passRate >= 1).length;
  const passRate = averagePassRate(charCases);

  const failedCases = charCases
    .filter((c) => c.passRate < 1)
    .map((c) => ({
      id: c.id,
      passRate: c.passRate,
      failures: [...new Set(c.runs.flatMap((run) => run.failures))],
    }));

  const reasons: string[] = [];
  if (totalCases === 0) {
    reasons.push("Report contains 0 'character' category cases.");
  } else if (passRate < minPassRate) {
    reasons.push(
      `Character & form pass rate ${(passRate * 100).toFixed(1)}% is below gate floor ${(minPassRate * 100).toFixed(1)}%.`,
    );
  }

  let baselinePassRate: number | null = null;
  let delta: number | null = null;
  const regressedCases: CharacterDriftEntry[] = [];

  if (options.baseline) {
    const baseCases = characterCasesOf(options.baseline);
    if (baseCases.length > 0) {
      baselinePassRate = averagePassRate(baseCases);
      delta = passRate - baselinePassRate;
      if (delta < -maxDrop) {
        reasons.push(
          `Character & form regressed by ${Math.abs(delta * 100).toFixed(1)} pts vs "${options.baseline.label}" (${(baselinePassRate * 100).toFixed(1)}% -> ${(passRate * 100).toFixed(1)}%, max allowed drop ${(maxDrop * 100).toFixed(1)} pts).`,
        );
      }
      const baseById = new Map(baseCases.map((entry) => [entry.id, entry]));
      for (const cand of charCases) {
        const base = baseById.get(cand.id);
        if (base && cand.passRate < base.passRate) {
          regressedCases.push({
            id: cand.id,
            baselinePassRate: base.passRate,
            candidatePassRate: cand.passRate,
            delta: cand.passRate - base.passRate,
            failures: [...new Set(cand.runs.flatMap((run) => run.failures))],
          });
        }
      }
    }
  }

  return {
    passed: reasons.length === 0,
    label: candidate.label,
    brain: candidate.brain,
    totalCases,
    passedCases,
    passRate,
    minPassRate,
    baselineLabel: options.baseline?.label ?? null,
    baselinePassRate,
    delta,
    maxDrop,
    reasons,
    failedCases,
    regressedCases,
  };
}

/** Formats a plain-English terminal summary for the Character & Form gate. */
export function formatCharacterGateReport(result: CharacterGateResult): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Character & Form Gate: ${result.passed ? "PASS" : "FAIL"} (${result.label} · ${result.brain})`,
    `  Score: ${pct(result.passRate)} (${result.passedCases}/${result.totalCases} full-pass, floor >= ${pct(result.minPassRate)})`,
  ];
  if (result.baselineLabel !== null && result.baselinePassRate !== null && result.delta !== null) {
    const sign = result.delta >= 0 ? "+" : "";
    lines.push(
      `  Drift vs ${result.baselineLabel}: ${pct(result.baselinePassRate)} -> ${pct(result.passRate)} (${sign}${(result.delta * 100).toFixed(1)} pts, max drop ${(result.maxDrop * 100).toFixed(1)} pts)`,
    );
  }
  for (const reason of result.reasons) {
    lines.push(`  REASON: ${reason}`);
  }
  if (result.regressedCases.length > 0) {
    lines.push("  Regressed cases:");
    for (const item of result.regressedCases) {
      lines.push(
        `    - ${item.id}: ${pct(item.baselinePassRate)} -> ${pct(item.candidatePassRate)} (${item.failures.join("; ") || "failed"})`,
      );
    }
  } else if (result.failedCases.length > 0) {
    lines.push("  Failed cases:");
    for (const item of result.failedCases) {
      lines.push(`    - ${item.id} (${pct(item.passRate)}): ${item.failures.join("; ") || "failed"}`);
    }
  }
  return lines.join("\n");
}
