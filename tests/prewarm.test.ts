import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextPrewarmer } from "../src/core/prewarm.ts";

describe("ContextPrewarmer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips work when disabled or when a game holds the GPU", async () => {
    let enabled = false;
    let gameBusy = false;
    const recallNotes = vi.fn(async () => ["note 1"]);
    const warmPrefix = vi.fn(async () => undefined);

    const prewarmer = new ContextPrewarmer({
      enabled: () => enabled,
      gpuBusy: () => gameBusy,
      recallNotes,
      warmPrefix,
      debounceMs: 50,
    });

    prewarmer.notify({ kind: "window-focus", app: "code", title: "app.ts" });
    await prewarmer.flushNow({ kind: "wake-word" });
    expect(recallNotes).not.toHaveBeenCalled();

    enabled = true;
    gameBusy = true;
    await prewarmer.flushNow({ kind: "wake-word" });
    expect(recallNotes).not.toHaveBeenCalled();
    expect(warmPrefix).not.toHaveBeenCalled();
    prewarmer.dispose();
  });

  it("debounces focus changes, warms prefix when idle, and expires context past TTL", async () => {
    vi.useFakeTimers();
    const clock = 10_000;
    const recallNotes = vi.fn(async (q: string) => [`Relevant to ${q}`]);
    const warmPrefix = vi.fn(async () => undefined);

    const prewarmer = new ContextPrewarmer({
      enabled: () => true,
      gpuBusy: () => false,
      recallNotes,
      activeMissions: () => "Deploy release (running)",
      fleetSummary: () => "proxmox online",
      warmPrefix,
      now: () => clock,
      debounceMs: 200,
      ttlMs: 5_000,
    });

    prewarmer.notify({ kind: "window-focus", app: "firefox", title: "Old tab" });
    prewarmer.notify({ kind: "window-focus", app: "kate", title: "deploy.yaml" });

    await vi.advanceTimersByTimeAsync(250);
    expect(recallNotes).toHaveBeenCalledTimes(1);
    expect(recallNotes).toHaveBeenCalledWith("kate deploy.yaml", expect.any(AbortSignal));
    expect(warmPrefix).toHaveBeenCalledTimes(1);

    const peeked = prewarmer.peek(clock + 1_000);
    expect(peeked?.combined).toContain("Relevant to kate deploy.yaml");
    expect(peeked?.combined).toContain("Deploy release");

    // Past TTL -> expired cleanly
    expect(prewarmer.take(clock + 6_000)).toBeNull();
    prewarmer.dispose();
  });
});
