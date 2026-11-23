import { describe, expect, it } from "vitest";
import {
  changedBlockIndices,
  computeBlockGridLuma,
  ContinuousVisionStreamer,
  DuplexSpeechToSpeechPipeline,
  type S2sStreamChunk,
} from "../src/core/multimodal.ts";

function toneFrame(length: number, amplitude: number, freqStep = 0.35): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin(i * freqStep);
  }
  return out;
}

describe("Pillar 2: Full-Duplex Native Speech-to-Speech & Continuous Vision", () => {
  it("streams native S2S turns with pre-roll, silence endpointing, and instant barge-in abort", async () => {
    expect(
      () =>
        new DuplexSpeechToSpeechPipeline({
          transport: {
            name: "remote-s2s",
            endpointHost: "203.0.113.10",
            async *streamTurn(): AsyncIterable<S2sStreamChunk> {
              yield { textDelta: "never" };
            },
          },
        }),
    ).toThrow(/non-local/);

    const deltas: string[] = [];
    const audioSizes: number[] = [];
    let bargeIns = 0;
    const chunkGate = { release: (): void => undefined };

    const pipeline = new DuplexSpeechToSpeechPipeline({
      enabled: true,
      silenceEndpointMs: 120,
      preRollMs: 64,
      onTextDelta: (d) => deltas.push(d),
      onAudioChunk: (s) => audioSizes.push(s.length),
      onBargeIn: () => {
        bargeIns += 1;
      },
      transport: {
        name: "local-native-s2s",
        endpointHost: "127.0.0.1",
        async *streamTurn(_pcm, cue, signal): AsyncIterable<S2sStreamChunk> {
          yield { textDelta: `Copy (${cue.mood}) `, audioOut: new Float32Array([0.1, 0.2]), sampleRate: 24_000 };
          await new Promise<void>((resolve) => {
            chunkGate.release = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (signal.aborted) return;
          yield { textDelta: "standing by.", done: true };
        },
      },
    });

    const quiet = new Float32Array(512);
    const voiced = toneFrame(512, 0.22);

    // Pre-roll + speech onset + silence endpoint triggers turn automatically.
    await pipeline.pushAudioFrame(quiet, 100);
    await pipeline.pushAudioFrame(voiced, 200);
    const turnPromise = pipeline.pushAudioFrame(quiet, 350);
    // Let first chunk arrive before releasing second chunk.
    await new Promise((r) => setTimeout(r, 15));
    expect(deltas.join("")).toContain("Copy");
    expect(audioSizes).toEqual([2]);
    chunkGate.release();

    const completed = await turnPromise;
    expect(completed?.metrics.usedNativeS2s).toBe(true);
    expect(completed?.replyText).toBe(`Copy (${completed?.cue.mood ?? ""}) standing by.`);
    expect(completed?.metrics.firstTextMs).not.toBeNull();
    expect(completed?.metrics.firstAudioMs).not.toBeNull();

    // Test barge-in while assistant is actively streaming.
    await pipeline.pushAudioFrame(voiced, 500);
    const activeTurn = pipeline.pushAudioFrame(quiet, 700);
    await new Promise((r) => setTimeout(r, 15));
    expect(pipeline.state).toBe("assistant_speaking");
    await pipeline.pushAudioFrame(voiced, 750);
    expect(bargeIns).toBe(1);
    expect(pipeline.bargeInCount).toBe(1);
    const abortedRes = await activeTurn;
    expect(abortedRes?.metrics.bargeInTriggered).toBe(true);
  });

  it("falls back automatically to local STT->LLM->TTS cascade when native S2S errors", async () => {
    const pipeline = new DuplexSpeechToSpeechPipeline({
      enabled: true,
      silenceEndpointMs: 100,
      transport: {
        name: "failing-native",
        endpointHost: "127.0.0.1",
        async *streamTurn(): AsyncIterable<S2sStreamChunk> {
          if (Date.now() > 0) throw new Error("audio codec offline");
          yield { done: true };
        },
      },
      fallback: {
        transcribe: async () => "check reactor",
        respond: async (text) => `Fallback handled: ${text}`,
        synthesize: async () => ({ samples: new Float32Array([0.3]), sampleRate: 16_000 }),
      },
    });

    await pipeline.pushAudioFrame(toneFrame(512, 0.12), 100);
    const outcome = await pipeline.pushAudioFrame(new Float32Array(512), 250);
    expect(outcome?.transcript).toBe("check reactor");
    expect(outcome?.replyText).toBe("Fallback handled: check reactor");
    expect(outcome?.metrics.usedNativeS2s).toBe(false);
  });

  it("streams lightweight spatial block deltas with token budgets, live coaching cues, and privacy drops", () => {
    const w = 16;
    const h = 16;
    const frameA = new Uint8Array(w * h).fill(30);
    const frameB = new Uint8Array(frameA);
    // Alter bottom-right region only.
    for (let y = 12; y < 16; y += 1) {
      for (let x = 12; x < 16; x += 1) frameB[y * w + x] = 240;
    }

    const gridA = computeBlockGridLuma(frameA, w, h, 8, 8);
    const gridB = computeBlockGridLuma(frameB, w, h, 8, 8);
    expect(changedBlockIndices(gridA, gridB, 0.1).length).toBeGreaterThan(0);

    const cues: string[] = [];
    const streamer = new ContinuousVisionStreamer({
      mode: "coaching",
      changeThreshold: 0.05,
      tokensPerKeyframe: 80,
      maxTokenBudget: 200, // caps at 2 keyframes
      coachingCooldownMs: 500,
      onCoachingCue: (cue) => cues.push(cue.summary),
    });

    const f1 = streamer.ingestFrame({
      atMs: 1000,
      width: w,
      height: h,
      luma: frameA,
      app: "eldenring",
      title: "Boss Arena",
    });
    expect(f1.accepted).toBe(true);

    // Throttled under 4 fps (< 250ms)
    expect(
      streamer.ingestFrame({ atMs: 1100, width: w, height: h, luma: frameB, app: "eldenring", title: "Boss Arena" }).reason,
    ).toBe("throttled");

    // Static duplicate dropped
    expect(
      streamer.ingestFrame({ atMs: 1300, width: w, height: h, luma: frameA, app: "eldenring", title: "Boss Arena" }).reason,
    ).toBe("static");

    // Significant delta emits live coaching cue
    const f2 = streamer.ingestFrame({
      atMs: 1600,
      width: w,
      height: h,
      luma: frameB,
      app: "eldenring",
      title: "Boss Arena",
    });
    expect(f2.accepted).toBe(true);
    expect(cues).toHaveLength(2);
    expect(streamer.estimatedTokens).toBeLessThanOrEqual(200);
    expect(streamer.getContextSummary()).toContain("eldenring");

    // Private window or handsOff blocked unconditionally
    expect(
      streamer.ingestFrame({
        atMs: 2200,
        width: w,
        height: h,
        luma: frameA,
        app: "firefox",
        title: "Bitwarden Vault - Private Browsing",
      }).reason,
    ).toBe("private");

    expect(
      streamer.ingestFrame(
        { atMs: 2600, width: w, height: h, luma: frameA, app: "code", title: "App" },
        { handsOff: true },
      ).reason,
    ).toBe("paused");
  });
});
