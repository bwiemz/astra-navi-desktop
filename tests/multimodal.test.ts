import { describe, expect, it } from "vitest";
import { MoodStream } from "../src/core/moodStream.ts";
import {
  frameDifference,
  inferParalinguisticCue,
  LocalSpeechToSpeechSession,
  VideoBufferWatch,
  type ParalinguisticCue,
  type PostureHint,
} from "../src/core/multimodal.ts";
import { Sight } from "../src/core/sight.ts";
import type { Mood } from "../src/shared/ipc.ts";

describe("Native Speech-to-Speech & Video-Buffer Awareness", () => {
  it("extracts paralinguistic mood/urgency/hesitation/pitch-trend cues and posture hints", async () => {
    const highEnergy = new Float32Array(1600);
    for (let i = 0; i < highEnergy.length; i += 1) {
      highEnergy[i] = 0.28 * Math.sin(i * 1.4);
    }
    const cue = inferParalinguisticCue(highEnergy);
    expect(cue.urgency).toBe("high");
    expect(["excited", "worried"]).toContain(cue.mood);
    expect(cue.posture.leanForward).toBeGreaterThan(0.5);
    expect(cue.posture.energyScale).toBeGreaterThan(1.2);

    // Hesitation + rising inflection: voiced start, long internal silence, high-pitch voiced end.
    const hesitantRising = new Float32Array(512 * 8);
    for (let i = 0; i < 512; i += 1) hesitantRising[i] = 0.08 * Math.sin(i * 0.2);
    for (let i = 512 * 5; i < 512 * 8; i += 1) hesitantRising[i] = 0.09 * Math.sin(i * 0.9);
    const hesitantCue = inferParalinguisticCue(hesitantRising);
    expect(hesitantCue.hesitationRatio).toBeGreaterThanOrEqual(0.35);
    expect(hesitantCue.pitchTrend).toBe("rising");
    expect(hesitantCue.posture.headTiltDeg).toBeGreaterThan(0);

    expect(
      () =>
        new LocalSpeechToSpeechSession({
          enabled: true,
          transport: {
            name: "remote",
            endpointHost: "8.8.8.8",
            processTurn: async () => ({ transcript: "", replyText: "" }),
          },
        }),
    ).toThrow(/non-local/);

    const moods: Mood[] = [];
    const cues: ParalinguisticCue[] = [];
    const session = new LocalSpeechToSpeechSession({
      transport: {
        name: "local-s2s",
        endpointHost: "127.0.0.1",
        processTurn: async (_pcm, c) => ({
          transcript: "Quick status check!",
          replyText: `Copy that (${c.urgency}).`,
        }),
      },
      onMood: (m) => moods.push(m),
      onCue: (c) => cues.push(c),
    });

    await expect(session.handleTurn(highEnergy)).rejects.toThrow(/disabled/);
    session.enabled = true;
    const result = await session.handleTurn(highEnergy);
    expect(result.replyText).toContain("high");
    expect(moods[0]).toBe(cue.mood);
    expect(cues[0]?.posture).toEqual(cue.posture);

    // MoodStream integration forwards both mood and posture hints.
    const emittedPostures: PostureHint[] = [];
    const emittedMoods: Mood[] = [];
    const stream = new MoodStream({
      text: () => undefined,
      mood: (m) => emittedMoods.push(m),
      posture: (p) => emittedPostures.push(p),
    });
    stream.pushParalinguistic(hesitantCue);
    expect(emittedMoods).toEqual([hesitantCue.mood]);
    expect(emittedPostures).toEqual([hesitantCue.posture]);
  });

  it("drops private video frames unconditionally, detects significant changes, and bounds ring buffer", () => {
    const frameA = new Uint8Array(64).fill(20);
    const frameB = new Uint8Array(64).fill(22);
    const frameC = new Uint8Array(64).fill(200);
    expect(frameDifference(frameA, frameB)).toBeLessThan(0.02);
    expect(frameDifference(frameA, frameC)).toBeGreaterThan(0.5);

    const changes: number[] = [];
    const watch = new VideoBufferWatch({
      maxFrames: 3,
      changeThreshold: 0.08,
      onSignificantChange: ({ changeScore }) => changes.push(changeScore),
    });

    const p1 = watch.pushFrame({
      atMs: 1000,
      width: 8,
      height: 8,
      luma: frameA,
      app: "firefox",
      title: "Docs",
    });
    expect(p1.buffered).toBe(true);

    // Private frames must never enter the buffer.
    const priv = watch.pushFrame({
      atMs: 2000,
      width: 8,
      height: 8,
      luma: frameC,
      app: "keepassxc",
      title: "Passwords.kdbx",
      isPrivate: true,
    });
    expect(priv).toEqual({ buffered: false, droppedPrivate: true, changed: false, changeScore: 0 });
    expect(watch.size).toBe(1);

    const quiet = watch.pushFrame({
      atMs: 3000,
      width: 8,
      height: 8,
      luma: frameB,
      app: "firefox",
      title: "Docs",
    });
    expect(quiet.changed).toBe(false);

    const sceneChange = watch.pushFrame({
      atMs: 4000,
      width: 8,
      height: 8,
      luma: frameC,
      app: "konsole",
      title: "Build",
    });
    expect(sceneChange.changed).toBe(true);
    expect(changes).toHaveLength(1);

    // Push extra frames to test ring eviction at maxFrames=3.
    watch.pushFrame({ atMs: 5000, width: 8, height: 8, luma: frameA, app: "kate", title: "1" });
    watch.pushFrame({ atMs: 6000, width: 8, height: 8, luma: frameB, app: "kate", title: "2" });
    expect(watch.size).toBe(3);
    expect(watch.recent().map((f) => f.atMs)).toEqual([4000, 5000, 6000]);

    watch.clear();
    expect(watch.size).toBe(0);
  });

  it("integrates VideoBufferWatch into Sight with private filtering and non-overlapping sampler ticks", async () => {
    const changes: string[] = [];
    const sight = new Sight("/tmp/unused-cache", "/tmp/unused-work", {
      videoBufferMaxFrames: 4,
      videoChangeThreshold: 0.1,
      onVideoChange: ({ frame }) => changes.push(frame.title),
    });

    sight.pushVideoFrame({
      atMs: 1_700_000_000_000,
      width: 64,
      height: 36,
      luma: new Uint8Array(32).fill(10),
      app: "blender",
      title: "Blender Viewport",
    });
    const skipped = sight.pushVideoFrame({
      atMs: 1_700_000_001_000,
      width: 64,
      height: 36,
      luma: new Uint8Array(32).fill(240),
      app: "bitwarden",
      title: "Vault",
      isPrivate: true,
    });
    expect(skipped.droppedPrivate).toBe(true);
    sight.pushVideoFrame({
      atMs: 1_700_000_002_000,
      width: 64,
      height: 36,
      luma: new Uint8Array(32).fill(210),
      app: "firefox",
      title: "Shader Tutorial",
    });

    expect(changes).toEqual(["Shader Tutorial"]);
    expect(sight.recentVideoFrames()).toHaveLength(2);
    expect(sight.recentVideoContext()).toContain("Blender Viewport");
    expect(sight.recentVideoContext()).not.toContain("Vault");

    let ticks = 0;
    sight.startVideoBufferLoop({
      intervalMs: 250,
      sample: async () => {
        ticks += 1;
        return {
          atMs: 1_700_000_003_000 + ticks,
          width: 64,
          height: 36,
          luma: new Uint8Array(32).fill(50),
          app: "firefox",
          title: "Loop Frame",
        };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 320));
    await sight.rest();
    expect(ticks).toBeGreaterThanOrEqual(1);
    sight.clearVideoBuffer();
    expect(sight.recentVideoContext()).toBe("");
  });
});
