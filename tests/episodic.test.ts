import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContextBucket,
  classifyImplicitReaction,
  DEFAULT_TAU_ACT,
  DEFAULT_TAU_SPEAK,
  EpisodicGraph,
  OBSERVATION_WINDOW_MS,
  QUICK_DISMISS_MS,
} from "../src/core/episodic.ts";
import { Initiative } from "../src/core/initiative.ts";
import { HerStore, LAYOUT_VERSION } from "../src/core/store.ts";

describe("Implicit-Feedback Episodic Graph & Self-Calibrating Thresholds (Tier 10 §6.1)", () => {
  it("migrates SQLite to v3 with episodic tables and vacuums safely", () => {
    const store = new HerStore(":memory:");
    expect(LAYOUT_VERSION).toBeGreaterThanOrEqual(3);
    const tables = store
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["episodes", "episode_feedback", "episode_thresholds"]),
    );
    expect(() => store.vacuum()).not.toThrow();
    store.close();
  });

  it("classifies implicit feedback inside the 120s window and ignores late or slow dismissals", () => {
    expect(classifyImplicitReaction({ kind: "undo", delayMs: 2500 })).toEqual({
      signal: "undo",
      reward: -1.0,
    });
    expect(classifyImplicitReaction({ kind: "dismissed", delayMs: QUICK_DISMISS_MS })).toEqual({
      signal: "quick_dismiss",
      reward: -0.8,
    });
    expect(classifyImplicitReaction({ kind: "dismissed", delayMs: QUICK_DISMISS_MS + 1 })).toBeNull();
    expect(classifyImplicitReaction({ kind: "acted", delayMs: OBSERVATION_WINDOW_MS })).toEqual({
      signal: "acted",
      reward: 1.0,
    });
    expect(classifyImplicitReaction({ kind: "acted", delayMs: OBSERVATION_WINDOW_MS + 1 })).toBeNull();
  });

  it("adapts tauAct and tauSpeak via EMA per context bucket and gates Initiative events", async () => {
    const store = new HerStore(":memory:");
    const graph = new EpisodicGraph(store, {
      now: () => new Date("2026-11-22T14:00:00.000Z"),
    });
    const bucket = buildContextBucket({ mode: "deep_focus", app: "code", hour: 14 });
    expect(bucket).toBe("afternoon:deep_focus:code");
    expect(graph.thresholdsFor(bucket).tauAct).toBe(DEFAULT_TAU_ACT);
    expect(graph.thresholdsFor(bucket).tauSpeak).toBe(DEFAULT_TAU_SPEAK);

    // Repeated negative implicit feedback increases thresholds.
    for (let i = 0; i < 4; i += 1) {
      const epId = graph.recordEpisode({
        kind: "proactive_alert",
        contextBucket: bucket,
        activeApp: "code",
        mode: "deep_focus",
        summary: `Alert ${i}`,
      });
      graph.recordReaction(epId, { kind: "undo", delayMs: 1200 });
    }
    const quiet = graph.thresholdsFor(bucket);
    expect(quiet.sampleCount).toBe(4);
    expect(quiet.tauAct).toBeGreaterThan(DEFAULT_TAU_ACT);
    expect(quiet.tauSpeak).toBeGreaterThan(DEFAULT_TAU_SPEAK);
    expect(graph.shouldSpeak(bucket, 0.6)).toBe(false);

    // Wire Initiative with calibrated thresholds: low-confidence unrequested event is held.
    const delivered: string[] = [];
    const initiative = new Initiative({
      deliver: (text) => delivered.push(text),
      whenFree: async () => undefined,
      doNotDisturb: () => false,
      calibratedThresholds: (b) => graph.thresholdsFor(b),
    });
    initiative.raise({
      kind: "alert",
      requested: false,
      text: "Minor RSS update",
      confidence: 0.6,
      contextBucket: bucket,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toEqual([]);
    expect(initiative.heldCount).toBe(1);

    // User-requested item still delivers cleanly.
    initiative.raise({
      kind: "reminder",
      requested: true,
      text: "Meeting in 5 minutes",
      confidence: 0.4,
      contextBucket: bucket,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toEqual(["Meeting in 5 minutes"]);

    // Repeated positive engagement in a fresh bucket lowers thresholds.
    const morning = buildContextBucket({ mode: "idle_at_desk", app: "dolphin", hour: 9 });
    for (let i = 0; i < 4; i += 1) {
      const id = graph.recordEpisode({
        kind: "routine_offer",
        contextBucket: morning,
        activeApp: "dolphin",
        mode: "idle_at_desk",
        summary: `Helpful offer ${i}`,
      });
      graph.recordReaction(id, { kind: "acted", delayMs: 5000 });
    }
    expect(graph.thresholdsFor(morning).tauSpeak).toBeLessThan(DEFAULT_TAU_SPEAK);
    expect(join(tmpdir(), "noop")).toBeTruthy();
    store.close();
  });
});
