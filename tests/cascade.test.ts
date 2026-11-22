import { describe, expect, it } from "vitest";
import {
  buildStitchPrompt,
  DEFAULT_CASCADE_CONFIG,
  hasMultiStepIntent,
  isHighImpactCall,
  shouldEscalate,
} from "../src/core/cascade.ts";
import { TOOLS } from "../src/core/permissions.ts";

describe("Speculative small-to-9B cascade", () => {
  const enabledCfg = { ...DEFAULT_CASCADE_CONFIG, enabled: true };

  it("stays disabled by default and keeps simple queries on the small brain when enabled", () => {
    expect(DEFAULT_CASCADE_CONFIG.enabled).toBe(false);
    expect(
      shouldEscalate({
        text: "What time is it?",
        draftConfidence: 0.2,
        multiStepRequested: true,
        claimCheckFlagged: true,
      }).escalate,
    ).toBe(false);

    const simple = shouldEscalate(
      {
        text: "Pause the music",
        draftConfidence: 0.91,
        plannedToolCalls: [{ tool: TOOLS.sound, args: { action: "pause" } }],
      },
      enabledCfg,
    );
    expect(simple).toEqual({ escalate: false, reasons: [] });
  });

  it("escalates on all four triggers: multi-step, low confidence, high-impact scope, and claim flag", () => {
    expect(hasMultiStepIntent("Check logs and then restart nginx")).toBe(true);
    expect(isHighImpactCall({ tool: TOOLS.remote, args: { action: "write_file" } })).toBe(true);
    expect(isHighImpactCall({ tool: TOOLS.remote, args: { action: "list" } })).toBe(false);
    expect(isHighImpactCall({ tool: TOOLS.operate, args: { action: "controls" } })).toBe(false);
    expect(isHighImpactCall({ tool: TOOLS.operate, args: { action: "click" } })).toBe(true);

    const decision = shouldEscalate(
      {
        text: "Update the config on all servers and then verify it",
        draftConfidence: 0.55,
        plannedToolCalls: [
          { tool: TOOLS.remote, args: { action: "list" } },
          { tool: TOOLS.remote, args: { action: "run" } },
        ],
        claimCheckFlagged: true,
      },
      enabledCfg,
    );
    expect(decision.escalate).toBe(true);
    expect(decision.reasons).toEqual([
      "multi_step",
      "low_confidence",
      "high_impact_scope",
      "claim_flagged",
    ]);
  });

  it("builds a seamless stitch prompt preserving spoken acknowledgments and gathered tool context", () => {
    const stitched = buildStitchPrompt(
      "Check nginx status and fix port",
      "Checking your server now.",
      [{ tool: TOOLS.remote, result: "nginx inactive" }],
    );
    expect(stitched).toContain("without repeating the opening acknowledgment");
    expect(stitched).toContain("Checking your server now.");
    expect(stitched).toContain("[remote]: nginx inactive");
  });
});
