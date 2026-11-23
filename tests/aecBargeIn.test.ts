import { describe, expect, it } from "vitest";
import {
  BargeInController,
  buildPipeWireAecArgs,
  computeErleDb,
  computeRms,
  evaluateWakeRoomGate,
  NlmsEchoCanceller,
} from "../src/core/voice/aec.ts";
import { Speaker } from "../src/core/voice/speaker.ts";

describe("Full-Duplex AEC, Sub-150ms Barge-In & Room Wake Gating (Tier 10 §7.1)", () => {
  it("builds safe fixed-arg PipeWire module-echo-cancel argv", () => {
    const spec = buildPipeWireAecArgs({
      captureTarget: "alsa_input.usb-Mic",
      playbackTarget: "alsa_output.pci-Speakers",
      nodeName: "aichan_ec",
    });
    expect(spec.program).toBe("pactl");
    expect(spec.args).toEqual([
      "load-module",
      "module-echo-cancel",
      "aec_method=webrtc",
      "source_name=aichan_ec_source",
      "sink_name=aichan_ec_sink",
      "source_master=alsa_input.usb-Mic",
      "sink_master=alsa_output.pci-Speakers",
    ]);
  });

  it("cancels correlated speaker echo with adaptive NLMS filter (>12 dB ERLE)", () => {
    const sampleCount = 1600;
    const ref = new Float32Array(sampleCount);
    const mic = new Float32Array(sampleCount);
    // Room impulse response (delayed attenuated echo)
    const ir = [0, 0, 0.55, -0.25, 0.12, -0.05];
    for (let i = 0; i < sampleCount; i += 1) {
      ref[i] = 0.5 * Math.sin(i * 0.17) + 0.3 * Math.cos(i * 0.43);
      let echo = 0;
      for (let k = 0; k < ir.length; k += 1) {
        if (i - k >= 0) echo += (ir[k] ?? 0) * (ref[i - k] ?? 0);
      }
      mic[i] = echo;
    }

    const aec = new NlmsEchoCanceller({ filterLength: 32, stepSize: 0.45 });
    const residual = aec.process(mic, ref);
    // Measure ERLE on converged second half of signal.
    const erleDb = computeErleDb(mic.subarray(800), residual.subarray(800));
    expect(erleDb).toBeGreaterThan(12);
    expect(computeRms(residual.subarray(800))).toBeLessThan(computeRms(mic.subarray(800)) * 0.25);
  });

  it("triggers barge-in within <=150ms of sustained speech and records spoken word offset", () => {
    const events: { heardText: string; spokenWordOffset: number }[] = [];
    const controller = new BargeInController({
      frameMs: 32,
      triggerMs: 120,
      onBargeIn: (ev) => events.push({ heardText: ev.heardText, spokenWordOffset: ev.spokenWordOffset }),
    });
    controller.beginSpeaking("Checking all six telemetry sensors right now Captain.", 2000, 10_000);

    // Three 32ms frames = 96ms (<120ms): no trigger yet.
    expect(controller.processFrame({ speechProbability: 0.9, residualRms: 0.08, nowMs: 10_200 })).toBeNull();
    expect(controller.processFrame({ speechProbability: 0.9, residualRms: 0.08, nowMs: 10_232 })).toBeNull();
    expect(controller.processFrame({ speechProbability: 0.9, residualRms: 0.08, nowMs: 10_264 })).toBeNull();
    // Fourth 32ms frame = 128ms (>=120ms and <=150ms budget): interrupts!
    const ev = controller.processFrame({ speechProbability: 0.92, residualRms: 0.09, nowMs: 11_000 });
    expect(ev).not.toBeNull();
    expect(ev?.elapsedMs).toBe(1000);
    expect(ev?.spokenWordOffset).toBeGreaterThanOrEqual(3);
    expect(ev?.spokenWordOffset).toBeLessThanOrEqual(5);
    expect(controller.speaking).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("emits visemes from Speaker.push and reports interrupt offset via Speaker.interrupt", async () => {
    const emitted: { sampleRate: number; visemeCount: number; text?: string }[] = [];
    const interrupted: { heardText: string; spokenWordOffset: number }[] = [];
    const speaker = new Speaker({
      language: "en",
      backend: {
        label: "mock-voice",
        supports: () => true,
        warm: async () => undefined,
        rest: async () => undefined,
        dispose: async () => undefined,
        synthesize: async () => ({ samples: new Float32Array(16_000), sampleRate: 16_000 }),
      },
      onAudio: (_samples, sampleRate, meta) => {
        emitted.push({ sampleRate, visemeCount: meta?.visemes.length ?? 0, text: meta?.text });
      },
      onBargeIn: (ev) => interrupted.push({ heardText: ev.heardText, spokenWordOffset: ev.spokenWordOffset }),
      onError: () => undefined,
    });

    speaker.say("All four servers are healthy today.");
    await new Promise((r) => setTimeout(r, 25));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.visemeCount).toBeGreaterThan(5);

    const stopReport = speaker.interrupt(Date.now() + 500);
    expect(stopReport).not.toBeNull();
    expect(stopReport?.spokenWordOffset).toBeGreaterThanOrEqual(1);
    expect(interrupted).toHaveLength(1);
  });

  it("rejects low-SNR ambient noise and mismatched speaker profile in live room wake gating", () => {
    const noisy = evaluateWakeRoomGate({
      text: "Astra open terminal",
      signalRms: 0.03,
      noiseFloorRms: 0.025, // ~1.6 dB SNR < 6 dB
    });
    expect(noisy.accepted).toBe(false);

    const wrongSpeaker = evaluateWakeRoomGate({
      text: "Astra check temps",
      signalRms: 0.15,
      noiseFloorRms: 0.02,
      speakerCosine: 0.45,
    });
    expect(wrongSpeaker.accepted).toBe(false);

    const valid = evaluateWakeRoomGate({
      text: "Hey Astra Navi, what are the CPU temperatures?",
      signalRms: 0.18,
      noiseFloorRms: 0.02,
      speakerCosine: 0.89,
    });
    expect(valid.accepted).toBe(true);
    expect(valid.remainder).toBe("what are the CPU temperatures?");
    expect(valid.snrDb).toBeGreaterThan(15);
  });
});
