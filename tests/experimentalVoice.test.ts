import { describe, expect, it } from "vitest";
import { UltraLightOnnxVoice } from "../src/core/voice/experimentalUltraLightVoice.ts";
import {
  detectCodeSwitchSpans,
  Qwen3AsrMultilingualClient,
  Qwen3StreamingTtsBackend,
} from "../src/core/voice/experimentalMultilingualVoice.ts";
import { extractExpressiveCues } from "../src/core/voice/expressiveAudio.ts";
import { blendExpressiveGesture, evaluateGestureMotion } from "../src/shared/gestures.ts";
import { sampleExpressiveCue } from "../src/shared/visemes.ts";

describe("Expressive Audio Cue Extraction & Blending", () => {
  it("extracts F0 pitch, pause regions, emphasis, and periodic laughter modulation", () => {
    const sr = 16_000;
    // 0.6s silence -> 0.4s pitched tone (200Hz, high amp) -> 0.8s bursty 5Hz laugh modulation
    const samples = new Float32Array(sr * 2);
    for (let i = Math.floor(sr * 0.6); i < Math.floor(sr * 1.1); i += 1) {
      samples[i] = 0.45 * Math.sin((2 * Math.PI * 200 * i) / sr);
    }
    for (let i = Math.floor(sr * 1.2); i < samples.length; i += 1) {
      const t = (i - sr * 1.2) / sr;
      const burst = Math.sin(2 * Math.PI * 5 * t) > 0 ? 0.55 : 0.02;
      samples[i] = burst * Math.sin((2 * Math.PI * 240 * i) / sr);
    }

    const cues = extractExpressiveCues(samples, sr, 20);
    expect(cues.length).toBeGreaterThan(80);
    // Silence region marked pause
    const silentCue = sampleExpressiveCue(cues, 200);
    expect(silentCue.pause).toBe(true);
    // Pitched region detects F0 near 200 Hz and active voice
    const voicedCue = sampleExpressiveCue(cues, 850);
    expect(voicedCue.pause).toBe(false);
    expect(voicedCue.pitchHz).toBeGreaterThan(170);
    expect(voicedCue.pitchHz).toBeLessThan(230);
    // Bursty laugh region raises laugh modulation
    const maxLaugh = Math.max(...cues.slice(65).map((c) => c.laugh));
    expect(maxLaugh).toBeGreaterThan(0.15);

    const gesture = evaluateGestureMotion("nod", 0.5);
    const blended = blendExpressiveGesture(gesture, {
      ...voicedCue,
      emphasis: 0.9,
      eyebrowRaise: 0.7,
      headTiltDeg: 8,
      nodDrive: 0.8,
      laugh: 0.4,
      postureEnergy: 1.2,
    });
    expect(blended.eyebrowRaise).toBeCloseTo(0.7, 3);
    expect(blended.headTiltDeg).toBe(8);
    expect(blended.perk).toBeGreaterThan(0);
  });
});

describe("Experimental Ultra-Light CPU & Multilingual Streaming Backends", () => {
  it("streams Phonon-31M runtime chunks with zero Python and attaches expressive cues", async () => {
    const sr = 24_000;
    const tone = new Float32Array(sr * 0.25);
    for (let i = 0; i < tone.length; i += 1) {
      tone[i] = 0.25 * Math.sin((2 * Math.PI * 180 * i) / sr);
    }
    const voice = new UltraLightOnnxVoice({
      engine: "phonon-31m",
      cacheDir: "/tmp",
      phononRuntime: {
        async *synthesizeStream() {
          yield { samples: tone, sampleRate: sr };
          yield { samples: tone, sampleRate: sr };
        },
      },
    });
    expect(voice.supports("en")).toBe(true);
    expect(voice.supports("ja")).toBe(false);

    const chunks = [];
    for await (const c of voice.synthesizeStream("First clause. Second clause!", "en")) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.cues.length).toBeGreaterThan(0);

    const full = await voice.synthesize("First clause. Second clause!", "en");
    expect(full.samples.length).toBe(tone.length * 2);
  });

  it("blocks public SSRF hosts and streams chunked PCM16 + 3s voice clone on private LAN", async () => {
    expect(
      () => new Qwen3StreamingTtsBackend({ endpointUrl: "http://evil.example.com:8080" }),
    ).toThrow(/non-LAN/i);
    expect(
      () => new Qwen3AsrMultilingualClient({ endpointUrl: "https://8.8.8.8/asr" }),
    ).toThrow(/non-LAN/i);

    let capturedBody = "";
    const pcm = Buffer.alloc(16);
    pcm.writeInt16LE(12000, 0);
    pcm.writeInt16LE(-12000, 2);

    const backend = new Qwen3StreamingTtsBackend({
      endpointUrl: "http://192.168.1.50:9090",
      fetchImpl: async (_url, init) => {
        capturedBody = String(init?.body ?? "");
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(pcm.subarray(0, 7)); // odd byte boundary split
            controller.enqueue(pcm.subarray(7));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });

    backend.setReferenceVoice(new Float32Array([0.1, -0.1, 0.2]), 24_000, "Hello world");
    const spans = detectCodeSwitchSpans("Hello 世界 and こんにちは");
    expect(spans.map((s) => s.language)).toEqual(["en", "ja", "en", "ja"]);

    const out = await backend.synthesize("Check this: こんにちは", "ja");
    expect(out.samples.length).toBe(8);
    expect(capturedBody).toContain("reference_voice");
    expect(capturedBody).toContain("qwen3-tts-0.6b");
  });
});
