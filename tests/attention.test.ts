import { describe, expect, it } from "vitest";
import { AttentionArbiter, deriveAttentionState } from "../src/core/attention.ts";

describe("Cross-Device Attention & Interruption Arbiter (Tier 10 §6.2)", () => {
  it("derives all five attention states cleanly from system and presence signals", () => {
    expect(
      deriveAttentionState({
        gameActive: true,
        voiceActive: true,
        screenLocked: false,
        idleSeconds: 0,
        phoneOnLan: true,
      }),
    ).toBe("gaming");

    expect(
      deriveAttentionState({
        gameActive: false,
        voiceActive: false,
        screenLocked: true,
        idleSeconds: 10,
        phoneOnLan: true,
      }),
    ).toBe("away_from_desk");

    expect(
      deriveAttentionState({
        gameActive: false,
        voiceActive: false,
        screenLocked: false,
        idleSeconds: 300,
        phoneOnLan: false,
      }),
    ).toBe("away_from_desk");

    expect(
      deriveAttentionState({
        gameActive: false,
        voiceActive: true,
        screenLocked: false,
        idleSeconds: 0,
        phoneOnLan: false,
      }),
    ).toBe("conversational");

    expect(
      deriveAttentionState({
        gameActive: false,
        voiceActive: false,
        screenLocked: false,
        idleSeconds: 5,
        phoneOnLan: true,
        activeApp: "code",
      }),
    ).toBe("deep_focus");

    expect(
      deriveAttentionState({
        gameActive: false,
        voiceActive: false,
        screenLocked: false,
        idleSeconds: 5,
        phoneOnLan: true,
        activeApp: "firefox",
      }),
    ).toBe("idle_at_desk");
  });

  it("queues digestible/timely events during gaming/focus with zero GPU wake and flushes post-session digest", () => {
    const arbiter = new AttentionArbiter({ now: () => new Date("2026-11-22T20:00:00.000Z") });
    const gamingSignals = {
      gameActive: true,
      voiceActive: false,
      screenLocked: false,
      idleSeconds: 0,
      phoneOnLan: true,
    };

    const timely = arbiter.route(
      { id: "1", kind: "order", urgency: "timely", text: "Backup archive completed." },
      gamingSignals,
    );
    expect(timely.state).toBe("gaming");
    expect(timely.action).toBe("queue_digest");
    expect(timely.wakeGpu).toBe(false);
    expect(arbiter.queuedCount).toBe(1);

    const critical = arbiter.route(
      { id: "2", kind: "alert", urgency: "critical", text: "UPS switched to battery!" },
      gamingSignals,
    );
    expect(critical.action).toBe("overlay_non_intrusive");
    expect(critical.wakeGpu).toBe(false);
    expect(critical.notifyMobile).toBe(true);
    expect(arbiter.queuedCount).toBe(1);

    const flushed = arbiter.flushDigest("While you played:");
    expect(flushed.count).toBe(1);
    expect(flushed.summary).toContain("While you played:");
    expect(flushed.summary).toContain("Backup archive completed.");
    expect(arbiter.queuedCount).toBe(0);
  });

  it("routes critical/timely alerts to mobile when away_from_desk and wakes desktop when idle_at_desk", () => {
    const arbiter = new AttentionArbiter();
    const away = {
      gameActive: false,
      voiceActive: false,
      screenLocked: true,
      idleSeconds: 600,
      phoneOnLan: false,
    };
    const mobile = arbiter.route(
      { id: "m1", kind: "mission", urgency: "timely", text: "Deploy awaits approval." },
      away,
    );
    expect(mobile.action).toBe("route_mobile");
    expect(mobile.notifyMobile).toBe(true);
    expect(mobile.wakeGpu).toBe(false);

    const desk = arbiter.route(
      { id: "d1", kind: "reminder", urgency: "digestible", text: "Water plants." },
      { gameActive: false, voiceActive: false, screenLocked: false, idleSeconds: 10, phoneOnLan: true },
    );
    expect(desk.state).toBe("idle_at_desk");
    expect(desk.action).toBe("deliver_desktop");
    expect(desk.wakeGpu).toBe(true);
  });
});
