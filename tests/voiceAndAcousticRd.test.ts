import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AcousticEventClassifier,
  decideAcousticReaction,
} from "../src/core/acousticEvents.ts";
import { openSignedCharacterBundle } from "../src/core/characterBundle.ts";
import { ShipEars, SHIP_EARS_RATE } from "../src/core/shipEars.ts";
import { Qwen3StreamingTtsBackend } from "../src/core/voice/experimentalMultilingualVoice.ts";
import { ONNX_SHOOTOUT_CATALOG } from "../src/core/voice/onnxVoice.ts";
import { cleanForSpeech, parseProsodyScript } from "../src/core/voice/speechText.ts";
import { evaluateRoomCalibration, generateCalibrationTone } from "../src/core/voice/aec.ts";
import {
  analyzeVoiceReferenceClip,
  packageClonedVoiceArchive,
} from "../src/core/voiceCloneStudio.ts";

describe("Post-v1 Voice, Prosody & Acoustic Intelligence R&D (Track 2)", () => {
  it("strips prosody markers cleanly in cleanForSpeech and extracts cues in parseProsodyScript", () => {
    const raw = "[emphasis] All checks passed! [pause 300ms] [whisper] Standing by. [sigh]";
    expect(cleanForSpeech(raw)).toBe("All checks passed! Standing by.");

    const parsed = parseProsodyScript(raw, { lateNight: true });
    expect(parsed.speakText).toBe("All checks passed! Standing by.");
    expect(parsed.gainScale).toBeLessThanOrEqual(0.55);
    expect(parsed.pausesMs).toContain(300);
    expect(parsed.gestureHints).toContain("nod");
    expect(parsed.cues.length).toBeGreaterThanOrEqual(3);
  });

  it("enforces LAN-only SSRF guard on Qwen3StreamingTtsBackend and verifies pruned shootout catalog", () => {
    expect(
      () => new Qwen3StreamingTtsBackend({ endpointUrl: "https://8.8.8.8/v1/tts/stream" }),
    ).toThrow(/non-LAN/i);
    expect(ONNX_SHOOTOUT_CATALOG.map((e) => e.id)).toEqual(["kokoro-82m", "qwen3-tts-0.6b"]);
  });

  it("classifies silence vs high-pitch chime/alarm & routes ShipEars.classifyRecent into reactions", async () => {
    const classifier = new AcousticEventClassifier();
    const quiet = await classifier.classify(new Float32Array(16_000), SHIP_EARS_RATE);
    expect(quiet.label).toBe("silence");
    expect(decideAcousticReaction(quiet).staySilent).toBe(false);

    // Sustained 1200 Hz periodic alarm tone
    const alarmBuf = new Float32Array(SHIP_EARS_RATE);
    for (let i = 0; i < alarmBuf.length; i += 1) {
      alarmBuf[i] = Math.sin((2 * Math.PI * 1200 * i) / SHIP_EARS_RATE) * 0.4;
    }
    const alarm = await classifier.classify(alarmBuf, SHIP_EARS_RATE);
    expect(alarm.label).toBe("alarm");
    expect(decideAcousticReaction(alarm).pingPhone).toBe(true);

    // Speech call simulation: alternating speech burst & silent gaps
    const callBuf = new Float32Array(SHIP_EARS_RATE * 2);
    for (let i = 0; i < callBuf.length; i += 1) {
      const block = Math.floor(i / (SHIP_EARS_RATE * 0.05));
      if (block % 2 === 0) {
        callBuf[i] = Math.sin((2 * Math.PI * 180 * i) / SHIP_EARS_RATE) * 0.25;
      }
    }
    const callRes = await classifier.classify(callBuf, SHIP_EARS_RATE);
    expect(callRes.label).toBe("voice_call");
    expect(decideAcousticReaction(callRes).staySilent).toBe(true);

    const ears = new ShipEars({
      source: "default",
      onProblem: () => undefined,
      spawn: () =>
        ({
          stdout: { on: () => undefined },
          on: () => undefined,
          kill: () => undefined,
        }) as never,
    });
    const recentClass = await ears.classifyRecent(1, classifier);
    expect(recentClass.label).toBe("silence");
  });

  it("validates clone audio SNR/duration quality and packs signed character bundles", async () => {
    const tooShort = analyzeVoiceReferenceClip(new Float32Array(8000), 24_000);
    expect(tooShort.ok).toBe(false);

    // Build clean 5-second dynamic speech-like clip at 24 kHz (low background noise + active bursts)
    const sr = 24_000;
    const len = sr * 5;
    const cleanClip = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      const sec = i / sr;
      if (sec >= 1 && sec <= 4.2) {
        cleanClip[i] = 0.25 * Math.sin(2 * Math.PI * 210 * sec) + 0.1 * Math.sin(2 * Math.PI * 420 * sec);
      } else {
        cleanClip[i] = 0.0005 * Math.sin(2 * Math.PI * 60 * sec);
      }
    }

    const dir = mkdtempSync(join(tmpdir(), "astra-voice-clone-"));
    try {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const srcDir = join(dir, "src");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, "avatar.vrm"), Buffer.from("glTF\x02\x00\x00\x00\x00\x00\x00\x00"));
      const outBundle = join(dir, "custom-voice.bundle");
      const res = await packageClonedVoiceArchive({
        samples: cleanClip,
        sampleRate: sr,
        transcript: "Ready whenever you are, Captain.",
        bundleDir: srcDir,
        outBundleFile: outBundle,
        privateKeyPem: privPem,
        manifest: {
          version: "1.0.0",
          id: "clone-test",
          name: "Clone Test",
          author: "Tester",
          license: "MIT",
          modelEntry: "avatar.vrm",
          modelFormat: "vrm",
          voice: {
            engine: "full",
            design: "af_heart",
            speed: 1,
          },
        },
      });
      expect(res.quality.ok).toBe(true);
      expect(res.quality.snrDb).toBeGreaterThanOrEqual(20);
      expect(res.packed.files).toBeGreaterThanOrEqual(3);

      const opened = await openSignedCharacterBundle(outBundle, {
        trustedPublicKeysPem: [pubPem],
        requireSignature: true,
      });
      expect(opened.verifiedSignature).toBe(true);
      expect(opened.manifest.voice?.speakerRefEntry).toBe("voice-ref.wav");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evaluates live-room NLMS AEC ERLE and multilingual EN/JA/ZH wake gating + TV rejection", () => {
    const sampleRate = 16_000;
    const reference = generateCalibrationTone(sampleRate, 1.0);
    expect(reference.length).toBe(sampleRate);
    for (const s of reference) {
      expect(Math.abs(s)).toBeLessThanOrEqual(0.6);
    }

    // Delayed two-tap room echo + low ambient room hum
    const recorded = new Float32Array(reference.length);
    for (let i = 0; i < reference.length; i += 1) {
      const e1 = i >= 10 ? 0.5 * (reference[i - 10] ?? 0) : 0;
      const e2 = i >= 28 ? 0.22 * (reference[i - 28] ?? 0) : 0;
      const hum = 0.006 * Math.sin((2 * Math.PI * 60 * i) / sampleRate);
      recorded[i] = Math.max(-1, Math.min(1, e1 + e2 + hum));
    }

    const report = evaluateRoomCalibration({
      reference,
      recorded,
      sampleRate,
      otherNames: ["Computer"],
    });
    expect(report.erleDb).toBeGreaterThanOrEqual(10);
    expect(report.bargeInReady).toBe(true);
    expect(report.residualRms).toBeLessThan(report.rawMicRms);
    expect(report.recommendedMinSnrDb).toBeGreaterThanOrEqual(6);
    expect(report.recommendedMinResidualRms).toBeGreaterThanOrEqual(0.01);
    expect(report.pipewireAecCommand).toContain("module-echo-cancel");
    expect(report.wakePassRate).toBe(1);
    expect(report.wakeChecks.some((w) => w.phrase.includes("アストラナビ") && w.accepted)).toBe(true);
    expect(report.wakeChecks.some((w) => w.phrase.includes("星航") && w.accepted)).toBe(true);
    expect(report.wakeChecks.some((w) => w.phrase.includes("TV news") && !w.accepted)).toBe(true);
  });
});
