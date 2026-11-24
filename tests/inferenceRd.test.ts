import { describe, expect, it } from "vitest";
import { planMissionKvRetention } from "../src/core/compaction.ts";
import { verifyConsensusBeforeDryRun } from "../src/core/dryRun.ts";
import { recommendHardwareTier } from "../src/core/hardwareTuner.ts";
import {
  dequantizeKvVector,
  estimateLongHorizonMissionKv,
  fwhtInPlace,
  measureQuantizationFidelity,
  quantizeKvVector,
} from "../src/core/kvCompression.ts";
import {
  BRAIN_MODELS,
  buildLlamaCpp10Args,
  estimateKvCacheBytes,
  MOE_WORKSTATION_MODELS,
  selectSpeculativeDraft,
} from "../src/core/models.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { evaluatePlanConsensus, runPlanConsensus } from "../src/core/planConsensus.ts";
import { SemanticCommandCache } from "../src/core/semanticCache.ts";
import type { Embedder } from "../src/core/embedder.ts";

const GIB = 1024 ** 3;

describe("Post-v1 Inference & ML R&D (Track 1)", () => {
  it("scales KV cache bytes cleanly across FP16, FP8, Q8_0, Q4_0, TQ4, TQ3 and builds llama.cpp 1.0 args", () => {
    const model = BRAIN_MODELS.standard;
    const f16 = estimateKvCacheBytes(model, 16_384, false, "f16");
    const f8 = estimateKvCacheBytes(model, 16_384, false, "f8_e4m3");
    const q8 = estimateKvCacheBytes(model, 16_384, true, "q8_0");
    const q4 = estimateKvCacheBytes(model, 16_384, true, "q4_0");
    const tq4 = estimateKvCacheBytes(model, 16_384, true, "tq4");
    const tq3 = estimateKvCacheBytes(model, 16_384, true, "tq3");

    expect(f16).toBeGreaterThan(f8);
    expect(q8).toBeGreaterThan(q4);
    expect(tq4).toBeGreaterThan(tq3);

    const args = buildLlamaCpp10Args({
      modelPath: "/models/qwen3.5-9b.gguf",
      contextSize: 16_384,
      kvCachePrecision: "f8_e4m3",
      flashAttention: true,
      draftModelPath: "/models/qwen3.5-2b.gguf",
      moeCacheSizeMb: 8192,
      moeCacheCpuShare: 0.75,
    });
    expect(args).toContain("-ctk");
    expect(args).toContain("f8_e4m3");
    expect(args).toContain("-ctv");
    expect(args).toContain("-fa");
    expect(args).toContain("on");
    expect(args).toContain("-md");
    expect(args).toContain("/models/qwen3.5-2b.gguf");
  });

  it("enforces empirical <=25% draft VRAM ratio cap in selectSpeculativeDraft and tuner recommendations", () => {
    // 4B tiny target must never pair with a draft
    expect(selectSpeculativeDraft(BRAIN_MODELS.small, 8)).toBeNull();

    // 9B standard target (7 GB) allows 2B draft (1.55 GB <= 1.75 GB = 25% of 7 GB)
    const draft9b = selectSpeculativeDraft(BRAIN_MODELS.standard, 8);
    expect(draft9b).not.toBeNull();
    expect(draft9b?.vramGb ?? 99).toBeLessThanOrEqual(BRAIN_MODELS.standard.vramGb * 0.25);

    // 27B large target pairs fast 4B draft when spare VRAM >= 6 GB
    const draft27b = selectSpeculativeDraft(BRAIN_MODELS.large, 8);
    expect(draft27b?.id).toBe("qwen3.5-4b");

    // Hardware tuner surfaces kvCachePrecision, speculativeDraft, and moeHostCache
    const rec20Gb = recommendHardwareTier({
      gpuName: "RTX PRO 4500",
      totalVramBytes: 20 * GIB,
      freeVramBytes: 19 * GIB,
      systemRamBytes: 64 * GIB,
      cpuThreads: 16,
      activeGameOrRender: false,
      memoryBandwidthGbps: 620,
    });
    expect(rec20Gb.kvCachePrecision).toBe("f8_e4m3");
    expect(rec20Gb.speculativeDraft?.draftId).toBe("qwen3.5-2b");

    const rec96Gb = recommendHardwareTier({
      gpuName: "RTX PRO 6000",
      totalVramBytes: 96 * GIB,
      freeVramBytes: 94 * GIB,
      systemRamBytes: 192 * GIB,
      cpuThreads: 32,
      activeGameOrRender: false,
      memoryBandwidthGbps: 1400,
    });
    expect(rec96Gb.tier).toBe("xl");
    expect(rec96Gb.architecture).toBe("moe");
    expect(MOE_WORKSTATION_MODELS.xlMoe.architecture).toBe("moe");
    expect(rec96Gb.moeHostCache?.cacheSizeMb ?? 0).toBeGreaterThan(0);
  });

  it("preserves vector fidelity in FWHT + Lloyd-Max 3/4-bit KV compression and plans long-horizon missions", () => {
    const dim = 128;
    const original = new Float32Array(dim);
    for (let i = 0; i < dim; i += 1) {
      original[i] = Math.sin(i * 0.27) + (i === 7 ? 3.5 : 0); // includes outlier spike
    }
    const copy = new Float32Array(original);
    fwhtInPlace(copy);
    // Normalized FWHT is unitary -> energy preserved
    const normOrig = original.reduce((s, v) => s + v * v, 0);
    const normRot = copy.reduce((s, v) => s + v * v, 0);
    expect(Math.abs(normOrig - normRot)).toBeLessThan(1e-3);

    const q4 = quantizeKvVector(original, 4);
    const rec4 = dequantizeKvVector(q4);
    const fid4 = measureQuantizationFidelity(original, rec4);
    expect(fid4.cosineSimilarity).toBeGreaterThanOrEqual(0.95);
    expect(q4.compressedBytes).toBeLessThan(dim * 2);

    const q3 = quantizeKvVector(original, 3);
    const rec3 = dequantizeKvVector(q3);
    const fid3 = measureQuantizationFidelity(original, rec3);
    expect(fid3.cosineSimilarity).toBeGreaterThanOrEqual(0.88);

    const est = estimateLongHorizonMissionKv({
      totalTokens: 120_000,
      kvBytesPerToken: 98_304,
      bits: 4,
    });
    expect(est.compressionRatio).toBeGreaterThan(3.5);
    expect(est.savedMb).toBeGreaterThan(1000);

    const plan = planMissionKvRetention(
      [
        { type: "user", text: "Analyze multi-week build logs cleanly. ".repeat(40) },
        { type: "model", response: ["Running step by step analysis. ".repeat(40)] },
      ],
      { bits: 4, vramBudgetMb: 512 },
    );
    expect(plan.estimatedTokens).toBeGreaterThan(100);
    expect(plan.fitsVramBudget).toBe(true);
  });

  it("catches divergent candidate plans via self-consistency consensus before dry-run", async () => {
    const unanimous = await runPlanConsensus(async () => ({
      commands: ["systemctl restart nginx"],
      targetControls: ["btn-ok"],
      targetPaths: ["/tmp/out.log"],
    }));
    expect(unanimous.agreed).toBe(true);
    expect(unanimous.requireManualReview).toBe(false);

    const split = verifyConsensusBeforeDryRun([
      { commands: ["rm -rf /tmp/cache"], targetPaths: ["/tmp/cache"] },
      { commands: ["rm -rf /var/lib/important"], targetPaths: ["/var/lib/important"] },
      { commands: ["rm -rf /tmp/cache"], targetPaths: ["/tmp/cache"] },
    ]);
    expect(split.agreed).toBe(false);
    expect(split.requireManualReview).toBe(true);
    expect(split.disagreements.length).toBeGreaterThan(0);

    const strictFail = evaluatePlanConsensus([
      { commands: ["echo ok"] },
    ]);
    expect(strictFail.agreed).toBe(false);
  });

  it("caches safe recurring queries while blocking numeric mismatches, tainted turns, and hands-off", async () => {
    const mockEmbedder = {
      embed: async (texts: readonly string[]) =>
        texts.map((t) =>
          t.toLowerCase().includes("volume")
            ? new Float32Array([0.99, 0.08, 0.02])
            : new Float32Array([0.1, 0.99, 0.01]),
        ),
      available: async () => true,
    } as unknown as Embedder;

    const cache = new SemanticCommandCache({ embedder: mockEmbedder, minSimilarity: 0.9 });
    expect(await cache.record("set volume to 35", TOOLS.sound, { action: "set_volume", level: 35 })).toBe(true);
    expect(await cache.record("danger shell", TOOLS.runCommand, { command: "rm -rf /tmp/x" })).toBe(false);

    const sameNum = await cache.lookup("please set the audio volume to 35");
    expect(sameNum.hit).toBe(true);
    expect(sameNum.tool).toBe(TOOLS.sound);

    const diffNum = await cache.lookup("please set the audio volume to 90");
    expect(diffNum.hit).toBe(false);
    expect(diffNum.reason).toBe("number_mismatch");

    const tainted = await cache.lookup("set volume to 35", { readOutsideText: true });
    expect(tainted.hit).toBe(false);
    expect(tainted.reason).toBe("bypass_tainted");

    const handsOff = await cache.lookup("set volume to 35", { handsOff: true });
    expect(handsOff.hit).toBe(false);
    expect(handsOff.reason).toBe("bypass_hands_off");
  });
});
