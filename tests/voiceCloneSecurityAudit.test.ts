import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeVoiceReferenceClip, packageClonedVoiceArchive } from "../src/core/voiceCloneStudio.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aichan-vc-sec-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Experimental Security Audit: voiceCloneStudio.ts (Wave 3)", () => {
  it("rejects non-finite PCM samples, invalid sample rates, withheld consent, and traversal manifest IDs", async () => {
    const rate = 24_000;
    const validSamples = new Float32Array(rate * 5);
    for (let i = 0; i < validSamples.length; i += 1) {
      validSamples[i] = i % 12_000 < 2_000 ? 0.0005 : 0.22 * Math.sin((2 * Math.PI * 220 * i) / rate);
    }

    const nanSamples = new Float32Array(validSamples);
    nanSamples[1234] = Number.NaN;
    const nanReport = analyzeVoiceReferenceClip(nanSamples, rate);
    expect(nanReport.ok).toBe(false);
    expect(nanReport.issues[0]).toContain("Non-finite");

    const hiRateReport = analyzeVoiceReferenceClip(validSamples, 500_000);
    expect(hiRateReport.ok).toBe(false);

    const dir = await makeTempDir();
    await expect(
      packageClonedVoiceArchive({
        samples: validSamples,
        sampleRate: rate,
        transcript: "Hello ship",
        bundleDir: join(dir, "b1"),
        manifest: {
          version: 1,
          id: "test-voice",
          name: "Test Voice",
        } as never,
        outBundleFile: join(dir, "b1.bundle"),
        consentConfirmed: false,
      }),
    ).rejects.toThrow(/consent/i);

    await expect(
      packageClonedVoiceArchive({
        samples: validSamples,
        sampleRate: rate,
        transcript: "Hello ship",
        bundleDir: join(dir, "b2"),
        manifest: {
          version: 1,
          id: "../../escape",
          name: "Bad",
        } as never,
        outBundleFile: join(dir, "b2.bundle"),
        consentConfirmed: true,
      }),
    ).rejects.toThrow(/Unsafe character manifest id/i);
  });
});
