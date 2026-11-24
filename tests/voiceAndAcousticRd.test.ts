import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AcousticEventClassifier,
  decideAcousticReaction,
} from "../src/core/acousticEvents.ts";
import { openSignedCharacterBundle } from "../src/core/characterBundle.ts";
import { ShipEars, SHIP_EARS_RATE } from "../src/core/shipEars.ts";
import {
  ChatterboxNanoVoice,
  decodeWavPcm16,
  LlamaCppSpeechBackend,
} from "../src/core/voice/llamaSpeechBackend.ts";
import { ONNX_SHOOTOUT_CATALOG } from "../src/core/voice/onnxVoice.ts";
import { cleanForSpeech, parseProsodyScript } from "../src/core/voice/speechText.ts";
import {
  analyzeVoiceReferenceClip,
  encodePcm16Wav,
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

  it("enforces LAN-only SSRF guard and synthesizes PCM16 WAV via LlamaCppSpeechBackend + ChatterboxNanoVoice", async () => {
    expect(
      () => new LlamaCppSpeechBackend({ endpointUrl: "https://8.8.8.8/v1/audio/speech" }),
    ).toThrow(/Refusing non-LAN/);

    const samples = new Float32Array(2400);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 24_000) * 0.35;
    }
    const wavBytes = encodePcm16Wav(samples, 24_000);
    const decoded = decodeWavPcm16(wavBytes);
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.samples.length).toBe(2400);

    const srv = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wavBytes);
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const backend = new LlamaCppSpeechBackend({
        endpointUrl: `http://127.0.0.1:${port}`,
        voice: "af_heart",
      });
      await backend.warm();
      const audio = await backend.synthesize("Hello Captain.", "en");
      expect(audio.sampleRate).toBe(24_000);
      expect(audio.samples.length).toBe(2400);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    const cb = new ChatterboxNanoVoice({
      exaggeration: 1.5,
      runtime: {
        synthesize: async (inp) => ({
          samples: new Float32Array(Math.round(inp.exaggeration * 1000)),
          sampleRate: 24_000,
        }),
      },
    });
    const cbOut = await cb.synthesize("Nice!", "en");
    expect(cbOut.samples.length).toBe(1000); // clamped exaggeration=1.0
    expect(ONNX_SHOOTOUT_CATALOG.length).toBeGreaterThanOrEqual(4);
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
});
