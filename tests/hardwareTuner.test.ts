import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkFirstLaunchHardware,
  benchmarkMemoryBandwidthGbps,
  parseNvidiaSmiProfile,
  recommendHardwareTier,
} from "../src/core/hardwareTuner.ts";
import { selectModelForHardware } from "../src/core/modelBundle.ts";
import {
  BRAIN_MODELS,
  estimateKvCacheBytes,
  MOE_WORKSTATION_MODELS,
  pickAutomatically,
  resolveBrain,
  selectQuantizationForBudget,
  verifyModelSha256,
} from "../src/core/models.ts";

const GIB = 1024 ** 3;

describe("BRAIN_MODELS xl & verifyModelSha256", () => {
  it("resolves xl tier cleanly while keeping pickAutomatically conservative", () => {
    expect(BRAIN_MODELS.xl.vramGb).toBe(48);
    expect(MOE_WORKSTATION_MODELS.xlMoe.architecture).toBe("moe");
    expect(pickAutomatically(96 * GIB).id).toBe("standard");
    const resolved = resolveBrain("xl", "/models", 96 * GIB);
    expect(resolved.download?.id).toBe("xl");
    expect(resolved.path).toBe("/models/Qwen3.5-72B-Q4_K_M.gguf");
  });

  it("computes KV-cache memory & selects highest fitting quantization precision", () => {
    const fullKv = estimateKvCacheBytes(BRAIN_MODELS.standard, 16_384, false);
    const leanKv = estimateKvCacheBytes(BRAIN_MODELS.standard, 16_384, true);
    expect(leanKv).toBeLessThan(fullKv);

    const highBudget = selectQuantizationForBudget(BRAIN_MODELS.standard, 16, 16_384, 900);
    expect(highBudget.fits).toBe(true);
    expect(highBudget.quantization).toBe("Q8_0");

    const tightBudget = selectQuantizationForBudget(BRAIN_MODELS.standard, 7.2, 8_192, 280);
    expect(tightBudget.fits).toBe(true);
    expect(tightBudget.quantization).not.toBe("Q8_0");
  });

  it("verifies model file SHA-256 digests in constant time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aichan-sha-"));
    try {
      const file = join(dir, "weights.gguf");
      const content = Buffer.from("gguf-sample-weights-v1");
      await writeFile(file, content);
      const digest = createHash("sha256").update(content).digest("hex");

      const ok = await verifyModelSha256(file, digest.toUpperCase());
      expect(ok).toEqual({ ok: true, actual: digest });

      const wrong = await verifyModelSha256(file, "0".repeat(64));
      expect(wrong.ok).toBe(false);
      expect(wrong.actual).toBe(digest);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hardwareTuner", () => {
  it("selects xl/large with expanded context and quant precision when workstation VRAM is ample", () => {
    const rec = recommendHardwareTier(
      {
        gpuName: "RTX PRO 6000",
        totalVramBytes: 96 * GIB,
        freeVramBytes: 94 * GIB,
        systemRamBytes: 128 * GIB,
        cpuThreads: 32,
        activeGameOrRender: false,
        memoryBandwidthGbps: 1_800,
      },
      "xl",
    );
    expect(rec.tier).toBe("xl");
    expect(rec.leanMemory).toBe(false);
    expect(rec.contextSize).toBe(32_768);
    expect(rec.architecture).toBe("dense");
    expect(rec.quantization).toBe("Q6_K");
    expect(rec.estimatedVramGb).toBeGreaterThan(40);
    expect(rec.stepDownFrom).toBeUndefined();
  });

  it("selects 120B MoE automatically on massive workstation VRAM via selectModelForHardware", () => {
    const { model, recommendation } = selectModelForHardware(
      {
        gpuName: "RTX PRO 6000",
        totalVramBytes: 96 * GIB,
        freeVramBytes: 94 * GIB,
        systemRamBytes: 128 * GIB,
        cpuThreads: 32,
        activeGameOrRender: false,
        memoryBandwidthGbps: 1_800,
      },
      "auto",
      "/models",
    );
    expect(recommendation.tier).toBe("xl");
    expect(recommendation.architecture).toBe("moe");
    expect(model.download?.fileName).toBe(MOE_WORKSTATION_MODELS.xlMoe.fileName);
  });

  it("steps down cleanly when a game holds VRAM or when running CPU-only", () => {
    const gaming = recommendHardwareTier(
      {
        gpuName: "RTX PRO 4500",
        totalVramBytes: 32 * GIB,
        freeVramBytes: 4.5 * GIB,
        systemRamBytes: 64 * GIB,
        cpuThreads: 16,
        activeGameOrRender: true,
      },
      "large",
    );
    expect(gaming.tier).toBe("small");
    expect(gaming.stepDownFrom).toBe("large");
    expect(gaming.reason).toContain("game/render active");

    const cpuOnly = recommendHardwareTier(
      {
        gpuName: null,
        totalVramBytes: 0,
        freeVramBytes: 0,
        systemRamBytes: 16 * GIB,
        cpuThreads: 8,
        activeGameOrRender: false,
      },
      "auto",
    );
    expect(cpuOnly.tier).toBe("small");
    expect(cpuOnly.leanMemory).toBe(true);
    expect(cpuOnly.contextSize).toBe(8_192);
  });

  it("parses nvidia-smi GPU query lines including memory clocks and PCIe link bandwidth", () => {
    const parsed = parseNvidiaSmiProfile("NVIDIA RTX PRO 4500, 32768, 28100, 14001, 5, 16\n");
    expect(parsed.gpuName).toBe("NVIDIA RTX PRO 4500");
    expect(Math.round(parsed.totalVramBytes / (1024 * 1024))).toBe(32_768);
    expect(Math.round(parsed.freeVramBytes / (1024 * 1024))).toBe(28_100);
    expect(parsed.memoryBandwidthGbps).toBeGreaterThan(500);
    expect(parsed.pcieBandwidthGbps).toBeGreaterThan(50);
  });

  it("benchmarks and caches first-launch hardware profile", async () => {
    const bw = benchmarkMemoryBandwidthGbps(2);
    expect(bw).toBeGreaterThanOrEqual(1);

    const dir = await mkdtemp(join(tmpdir(), "aichan-hwcache-"));
    try {
      const cacheFile = join(dir, "hw.json");
      let probes = 0;
      const first = await benchmarkFirstLaunchHardware(cacheFile, {
        preferred: "auto",
        probe: async () => {
          probes += 1;
          return {
            gpuName: "RTX 4070",
            totalVramBytes: 12 * GIB,
            freeVramBytes: 11 * GIB,
            systemRamBytes: 32 * GIB,
            cpuThreads: 16,
            activeGameOrRender: false,
            memoryBandwidthGbps: 504,
            pcieBandwidthGbps: 31.5,
          };
        },
      });
      expect(first.fromCache).toBe(false);
      expect(first.recommendation.tier).toBe("standard");
      expect(probes).toBe(1);

      const second = await benchmarkFirstLaunchHardware(cacheFile, {
        preferred: "auto",
        probe: async () => {
          probes += 1;
          return first.profile;
        },
      });
      expect(second.fromCache).toBe(true);
      expect(probes).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
