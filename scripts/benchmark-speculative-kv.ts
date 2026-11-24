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

async function benchSpeculative(
  targetPath: string,
  draftPath: string,
): Promise<Record<string, unknown>> {
  const llama = await getLlama();
  const targetModel = await llama.loadModel({ modelPath: targetPath });
  const draftModel = await llama.loadModel({ modelPath: draftPath });
  const targetCtx = await targetModel.createContext({ contextSize: 4096, flashAttention: true });
  const draftCtx = await draftModel.createContext({ contextSize: 4096, flashAttention: true });

  try {
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
      supported: true,
      tokens: counted,
      ttftMs: firstTokenAt > 0 ? Math.round(firstTokenAt - t0) : Math.round(totalMs),
      tokPerSec: Number(((counted / decodeMs) * 1000).toFixed(1)),
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await draftCtx.dispose().catch(() => undefined);
    await targetCtx.dispose().catch(() => undefined);
    await draftModel.dispose().catch(() => undefined);
    await targetModel.dispose().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const dir = modelsDir();
  const target9b = join(dir, "Qwen3.5-9B-Q4_K_M.gguf");
  const draft4b = join(dir, "Qwen3.5-4B-Q4_K_M.gguf");

  if (!existsSync(target9b)) {
    console.error(`Missing ${target9b}`);
    process.exit(1);
  }

  const kvResults = [
    await benchKvMode(target9b, "9B FP16 KV"),
    await benchKvMode(target9b, "9B Q8_0 KV (lean)", GgmlType.Q8_0),
    await benchKvMode(target9b, "9B Q4_0 KV (ultra-lean)", GgmlType.Q4_0),
  ];

  const speculativeResult = existsSync(draft4b)
    ? await benchSpeculative(target9b, draft4b)
    : { supported: false, reason: "Draft GGUF missing." };

  console.log(JSON.stringify({ kvResults, speculativeResult }, null, 2));
}

main().catch((err: unknown) => {
  console.error("[benchmark-speculative-kv]", err);
  process.exit(1);
});
