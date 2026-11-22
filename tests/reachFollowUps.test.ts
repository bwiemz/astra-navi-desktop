import { describe, expect, it } from "vitest";
import { isOutward, isRiskyName } from "../src/core/operateRules.ts";
import { TOOLS, toolVerdict } from "../src/core/permissions.ts";

describe("follow-ups from the first round of tier-8 tests", () => {
  it.each(["_Delete", "&Send", "De_lete", "Don't _Save"])(
    "sees through the shortcut mark in %s",
    (name) => {
      expect(isRiskyName(name)).toBe(true);
    },
  );

  it.each(["_Bold", "&Next page"])("leaves the calm name %s alone", (name) => {
    expect(isRiskyName(name)).toBe(false);
  });

  it.each(["org.kde.kontact", "eu.betterbird.Betterbird", "org.kde.akregator"])(
    "shows every step in %s, which reaches outside the PC",
    (app) => {
      expect(isOutward({ app })).toBe(true);
    },
  );

  it("does not ask before thinking back over what the watch saw", async () => {
    const context = { workspace: "/tmp/ws", maySeeScreen: false };
    expect(await toolVerdict(TOOLS.lookAtScreen, { when: "earlier" }, context)).toEqual({
      decision: "allow",
    });
    // A fresh look still asks.
    expect((await toolVerdict(TOOLS.lookAtScreen, {}, context)).decision).toBe("ask");
    expect((await toolVerdict(TOOLS.lookAtScreen, { when: "now" }, context)).decision).toBe("ask");
  });
});
