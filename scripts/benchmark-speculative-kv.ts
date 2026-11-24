/**
 * Live GPU Benchmark: KV Cache Quantization (`F16` vs `Q8_0` vs `Q4_0`) and
 * Speculative Decoding (`DraftSequenceTokenPredictor` pairing Qwen3.5-9B with 4B)
 * via `node-llama-cpp` on local GPU.
 *
 * Usage:
 *   node scripts/benchmark-speculative-kv.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DraftSequenceTokenPredictor,
  GgmlType,
  getLlama,
  LlamaChatSession,
  type LlamaContext,
  type LlamaModel,
} from "node-llama-cpp";
import { modelsDir } from "../src/core/paths.ts";

const PROMPT =
  "List four concise steps to verify an NVMe drive's SMART health, free space, and systemd mount status on Linux.";

async function benchKvMode(
  modelPath: string,
  label: string,
  kvType?: GgmlType,
): Promise<Record<string, unknown>> {
  const llama = await getLlama();
  const vramBefore = await llama.getVramState().catch(() => ({ used: 0, total: 0 }));
  const tLoad = performance.now();
  const model = await llama.loadModel({ modelPath });
  const loadMs = performance.now() - tLoad;

  const ctx = await model.createContext({
    contextSize: 8192,
    flashAttention: true,
    ...(kvType !== undefined
      ? {
          experimentalKvCacheKeyType: kvType,
          experimentalKvCacheValueType: kvType,
        }
      : {}),
  });
  const vramLoaded = await llama.getVramState().catch(() => ({ used: 0, total: 0 }));
  const seq = ctx.getSequence();
  const session = new LlamaChatSession({ contextSequence: seq });

  // Warmup
  await session.prompt("Say ok.", { maxTokens: 8, temperature: 0 });

  let firstTokenAt = 0;
  let tokenCount = 0;
  const tGen0 = performance.now();
  const reply = await session.prompt(PROMPT, {
    maxTokens: 160,
    temperature: 0,
    onResponseChunk: (chunk) => {
      if (firstTokenAt === 0 && chunk.tokens.length > 0) firstTokenAt = performance.now();
      tokenCount += chunk.tokens.length;
    },
  });
  const totalGenMs = performance.now() - tGen0;
  const counted = tokenCount > 0 ? tokenCount : model.tokenize(reply).length;
  const decodeMs = firstTokenAt > 0 ? Math.max(1, performance.now() - firstTokenAt) : totalGenMs;

  await ctx.dispose();
  await model.dispose();

  return {
    mode: label,
    kvKeyType: kvType !== undefined ? GgmlType[kvType] : "F16",
    loadMs: Math.round(loadMs),
    vramDeltaMb: Math.round((vramLoaded.used - vramBefore.used) / (1024 * 1024)),
    ttftMs: firstTokenAt > 0 ? Math.round(firstTokenAt - tGen0) : Math.round(totalGenMs),
    tokens: counted,
    tokPerSec: Number(((counted / decodeMs) * 1000).toFixed(1)),
  };
}

async function warmGpuClocks(modelPath: string): Promise<void> {
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const ctx = await model.createContext({ contextSize: 2048, flashAttention: true });
  try {
    const seq = ctx.getSequence();
    const session = new LlamaChatSession({ contextSequence: seq });
    await session.prompt(PROMPT, { maxTokens: 64, temperature: 0 });
  } finally {
    await ctx.dispose().catch(() => undefined);
    await model.dispose().catch(() => undefined);
  }
}

async function benchSpeculative(
  targetPath: string,
  draftPath: string,
  pairLabel: string,
  kvType?: GgmlType,
): Promise<Record<string, unknown>> {
  const llama = await getLlama();
  let targetModel: LlamaModel | null = null;
  let draftModel: LlamaModel | null = null;
  let targetCtx: LlamaContext | null = null;
  let draftCtx: LlamaContext | null = null;

  try {
    targetModel = await llama.loadModel({ modelPath: targetPath });
    draftModel = await llama.loadModel({ modelPath: draftPath });
    targetCtx = await targetModel.createContext({
      contextSize: 4096,
      flashAttention: true,
      ...(kvType !== undefined
        ? {
            experimentalKvCacheKeyType: kvType,
            experimentalKvCacheValueType: kvType,
          }
        : {}),
    });
    draftCtx = await draftModel.createContext({
      contextSize: 4096,
      flashAttention: true,
      ...(kvType !== undefined
        ? {
            experimentalKvCacheKeyType: kvType,
            experimentalKvCacheValueType: kvType,
          }
        : {}),
    });
    const targetSeq = targetCtx.getSequence({
      tokenPredictor: new DraftSequenceTokenPredictor(draftCtx.getSequence(), {
        minTokens: 1,
        maxTokens: 5,
      }),
    });
    const session = new LlamaChatSession({ contextSequence: targetSeq });
    await session.prompt("Say ok.", { maxTokens: 8, temperature: 0 });

    let firstTokenAt = 0;
    let tokenCount = 0;
    const t0 = performance.now();
    const reply = await session.prompt(PROMPT, {
      maxTokens: 160,
      temperature: 0,
      onResponseChunk: (chunk) => {
        if (firstTokenAt === 0 && chunk.tokens.length > 0) firstTokenAt = performance.now();
        tokenCount += chunk.tokens.length;
      },
    });
    const totalMs = performance.now() - t0;
    const counted = tokenCount > 0 ? tokenCount : targetModel.tokenize(reply).length;
    const decodeMs = firstTokenAt > 0 ? Math.max(1, performance.now() - firstTokenAt) : totalMs;
    return {
      pair: pairLabel,
      supported: true,
      tokens: counted,
      ttftMs: firstTokenAt > 0 ? Math.round(firstTokenAt - t0) : Math.round(totalMs),
      tokPerSec: Number(((counted / decodeMs) * 1000).toFixed(1)),
    };
  } catch (error) {
    return {
      pair: pairLabel,
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await draftCtx?.dispose().catch(() => undefined);
    await targetCtx?.dispose().catch(() => undefined);
    await draftModel?.dispose().catch(() => undefined);
    await targetModel?.dispose().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const dir = modelsDir();
  const target9b = join(dir, "Qwen3.5-9B-Q4_K_M.gguf");
  const target27b = join(dir, "Qwen3.8-27B-UD-Q4_K_M.gguf");
  const draft08b = join(dir, "Qwen3.5-0.8B-Q4_K_M.gguf");
  const draft2b = join(dir, "Qwen3.5-2B-Q4_K_M.gguf");
  const draft4b = join(dir, "Qwen3.5-4B-Q4_K_M.gguf");

  if (!existsSync(target9b)) {
    console.error(`Missing ${target9b}`);
    process.exit(1);
  }

  await warmGpuClocks(target9b);

  const kvResults = [
    await benchKvMode(target9b, "9B FP16 KV"),
    await benchKvMode(target9b, "9B Q8_0 KV (lean)", GgmlType.Q8_0),
    await benchKvMode(target9b, "9B Q4_0 KV (ultra-lean)", GgmlType.Q4_0),
  ];

  const speculativePairs: Array<{ target: string; draft: string; label: string; kv?: GgmlType }> = [
    { target: target9b, draft: draft08b, label: "9B + 0.8B draft" },
    { target: target9b, draft: draft2b, label: "9B + 2B draft" },
    { target: target9b, draft: draft4b, label: "9B + 4B draft (control)" },
    { target: target27b, draft: draft2b, label: "27B + 2B draft", kv: GgmlType.Q8_0 },
    { target: target27b, draft: draft4b, label: "27B + 4B draft", kv: GgmlType.Q8_0 },
  ];

  const baseline27b = existsSync(target27b)
    ? await benchKvMode(target27b, "27B Q8_0 KV (baseline)", GgmlType.Q8_0).catch((error: unknown) => ({
        mode: "27B Q8_0 KV (baseline)",
        supported: false,
        reason: error instanceof Error ? error.message : String(error),
      }))
    : { mode: "27B Q8_0 KV (baseline)", supported: false, reason: "27B GGUF missing." };

  const speculativeResults: Record<string, unknown>[] = [];
  for (const spec of speculativePairs) {
    if (!existsSync(spec.target) || !existsSync(spec.draft)) {
      speculativeResults.push({
        pair: spec.label,
        supported: false,
        reason: `Missing GGUF (${!existsSync(spec.target) ? spec.target : spec.draft})`,
      });
      continue;
    }
    speculativeResults.push(await benchSpeculative(spec.target, spec.draft, spec.label, spec.kv));
  }

  console.log(JSON.stringify({ kvResults, baseline27b, speculativeResults }, null, 2));
}

main().catch((err: unknown) => {
  console.error("[benchmark-speculative-kv]", err);
  process.exit(1);
});
