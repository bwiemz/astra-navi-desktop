import { replaceInternalCaptain } from "./characterLayer.ts";
import { TOOLS } from "./permissions.ts";

/** Reason the small-to-9B speculative cascade escalated a turn. */
export type EscalationReason =
  | "multi_step"
  | "low_confidence"
  | "high_impact_scope"
  | "claim_flagged";

export interface CascadeConfig {
  /** Strictly default-off until opted in by user Settings. */
  enabled: boolean;
  /** Minimum router/argument confidence required to stay on the small brain (`0..1`). */
  confidenceThreshold: number;
  escalateOnMultiStep: boolean;
  escalateOnHighImpact: boolean;
  escalateOnClaimFlag: boolean;
}

export const DEFAULT_CASCADE_CONFIG: CascadeConfig = {
  enabled: false,
  confidenceThreshold: 0.72,
  escalateOnMultiStep: true,
  escalateOnHighImpact: true,
  escalateOnClaimFlag: true,
};

export interface PlannedToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

export interface CascadeInput {
  text: string;
  multiStepRequested?: boolean;
  draftConfidence?: number;
  plannedToolCalls?: readonly PlannedToolCall[];
  claimCheckFlagged?: boolean;
}

export interface CascadeDecision {
  escalate: boolean;
  reasons: EscalationReason[];
}

const MULTI_STEP_PHRASES =
  /\b(?:and then|after that|followed by|step by step|on every machine|across (?:my |all )?servers|first .+ then)\b/i;

const ALWAYS_HIGH_IMPACT_TOOLS: ReadonlySet<string> = new Set([
  TOOLS.runCommand,
  TOOLS.writeFile,
  TOOLS.startMission,
  TOOLS.planMission,
  TOOLS.tidyStorage,
]);

/** True when a planned tool call mutates files, services, GUI programs, or remote hosts. */
export function isHighImpactCall(call: PlannedToolCall): boolean {
  if (ALWAYS_HIGH_IMPACT_TOOLS.has(call.tool)) return true;
  const action = typeof call.args?.["action"] === "string" ? call.args["action"] : "";
  if (call.tool === TOOLS.remote) {
    return action === "run" || action === "write_file" || action === "send_file" || action === "restore";
  }
  if (call.tool === TOOLS.operate) {
    return action !== "" && action !== "controls";
  }
  return call.tool.startsWith("sandbox_");
}

/** True when user phrasing indicates chained multi-step reasoning or coordination. */
export function hasMultiStepIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (MULTI_STEP_PHRASES.test(trimmed)) return true;
  return /(?:^|\n)\s*1[.)]\s+\S+[\s\S]*\n\s*2[.)]\s+\S+/.test(trimmed);
}

/**
 * Evaluates Spec §3.2 escalation rules to decide whether a turn handled initially by the
 * small router brain must escalate to the 9B (or larger) standard brain.
 */
export function shouldEscalate(
  input: CascadeInput,
  config: CascadeConfig = DEFAULT_CASCADE_CONFIG,
): CascadeDecision {
  if (!config.enabled) {
    return { escalate: false, reasons: [] };
  }

  const reasons: EscalationReason[] = [];
  const calls = input.plannedToolCalls ?? [];

  if (
    config.escalateOnMultiStep &&
    (input.multiStepRequested === true || calls.length > 1 || hasMultiStepIntent(input.text))
  ) {
    reasons.push("multi_step");
  }

  if (
    input.draftConfidence !== undefined &&
    Number.isFinite(input.draftConfidence) &&
    input.draftConfidence < config.confidenceThreshold
  ) {
    reasons.push("low_confidence");
  }

  if (config.escalateOnHighImpact && calls.some(isHighImpactCall)) {
    reasons.push("high_impact_scope");
  }

  if (config.escalateOnClaimFlag && input.claimCheckFlagged === true) {
    reasons.push("claim_flagged");
  }

  return { escalate: reasons.length > 0, reasons };
}

/**
 * Builds the seamless escalation handoff prompt for the 9B model after the small brain
 * already spoke or retrieved initial tool context, preventing duplicate opening filler.
 */
export function buildStitchPrompt(
  originalPrompt: string,
  spokenAck: string,
  toolResults: readonly { tool: string; result: string }[],
  userAddress?: string,
): string {
  const sections: string[] = [
    replaceInternalCaptain(
      "Continue seamlessly for Captain without repeating the opening acknowledgment already spoken.",
      userAddress,
    ),
    `Original request:\n${originalPrompt.trim()}`,
  ];
  const ack = spokenAck.trim();
  if (ack) {
    sections.push(`Already spoken to user (do not repeat verbatim):\n${ack}`);
  }
  if (toolResults.length > 0) {
    const formatted = toolResults
      .map((entry, idx) => `${idx + 1}. [${entry.tool}]: ${entry.result.slice(0, 1200)}`)
      .join("\n");
    sections.push(`Initial tool observations already gathered:\n${formatted}`);
  }
  return sections.join("\n\n");
}
