import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * The open-weight language models the assistant can think with. All are Apache-2.0
 * licensed, download from Hugging Face without an account, and run entirely on this
 * computer.
 */
export type ModelQuantization = "IQ4_XS" | "Q4_K_M" | "Q5_K_M" | "Q6_K" | "Q8_0";

export interface BrainModel {
  id: "small" | "standard" | "large" | "xl";
  label: string;
  fileName: string;
  url: string;
  sizeBytes: number;
  /** Graphics memory it wants to run comfortably with its working context, in GB. */
  vramGb: number;
  architecture?: "dense" | "moe";
  quantization?: ModelQuantization;
  /** Approximate FP16 KV-cache bytes per token across all layers/heads. */
  kvBytesPerToken?: number;
  totalParamsB?: number;
  activeParamsB?: number;
  /** Optional expected lowercase SHA-256 hex digest for first-launch bundle verification. */
  sha256?: string;
}

export const BRAIN_MODELS: Record<BrainModel["id"], BrainModel> = {
  small: {
    id: "small",
    label: "Small (Qwen3.5 4B)",
    fileName: "Qwen3.5-4B-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    sizeBytes: 2_740_000_000,
    vramGb: 4,
    architecture: "dense",
    quantization: "Q4_K_M",
    kvBytesPerToken: 73_728,
    totalParamsB: 4,
    activeParamsB: 4,
  },
  standard: {
    id: "standard",
    label: "Standard (Qwen3.5 9B)",
    fileName: "Qwen3.5-9B-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
    sizeBytes: 5_680_000_000,
    vramGb: 7,
    architecture: "dense",
    quantization: "Q4_K_M",
    kvBytesPerToken: 98_304,
    totalParamsB: 9,
    activeParamsB: 9,
  },
  large: {
    id: "large",
    label: "Large (Qwen3.8 27B)",
    fileName: "Qwen3.8-27B-UD-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_M.gguf",
    sizeBytes: 16_560_000_000,
    vramGb: 19,
    architecture: "dense",
    quantization: "Q4_K_M",
    kvBytesPerToken: 147_456,
    totalParamsB: 27,
    activeParamsB: 27,
  },
  xl: {
    id: "xl",
    label: "Extra Large (Qwen3.5 72B Workstation)",
    fileName: "Qwen3.5-72B-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-72B-GGUF/resolve/main/Qwen3.5-72B-Q4_K_M.gguf",
    sizeBytes: 44_000_000_000,
    vramGb: 48,
    architecture: "dense",
    quantization: "Q4_K_M",
    kvBytesPerToken: 327_680,
    totalParamsB: 72,
    activeParamsB: 72,
  },
};

/** Optional workstation MoE catalog (120B+ total params with fast active-parameter inference). */
export const MOE_WORKSTATION_MODELS: Record<"xlMoe", BrainModel> = {
  xlMoe: {
    id: "xl",
    label: "Extra Large MoE (120B Workstation)",
    fileName: "Qwen3.5-120B-A16B-IQ4_XS.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-120B-GGUF/resolve/main/Qwen3.5-120B-A16B-IQ4_XS.gguf",
    sizeBytes: 63_000_000_000,
    vramGb: 66,
    architecture: "moe",
    quantization: "IQ4_XS",
    kvBytesPerToken: 163_840,
    totalParamsB: 120,
    activeParamsB: 16,
  },
};

const QUANT_MULTIPLIER: Record<ModelQuantization, number> = {
  Q8_0: 1.78,
  Q6_K: 1.42,
  Q5_K_M: 1.21,
  Q4_K_M: 1.0,
  IQ4_XS: 0.86,
};

const QUANT_PRECISION_ORDER: readonly ModelQuantization[] = [
  "Q8_0",
  "Q6_K",
  "Q5_K_M",
  "Q4_K_M",
  "IQ4_XS",
];

/** Estimates working KV-cache memory in bytes for a model, context length, and lean Q8_0 cache setting. */
export function estimateKvCacheBytes(
  model: BrainModel,
  contextSize: number,
  lean: boolean,
): number {
  const safeCtx = Math.max(512, Math.trunc(contextSize));
  const perTok = model.kvBytesPerToken ?? 98_304;
  return Math.round(perTok * safeCtx * (lean ? 0.55 : 1));
}

/**
 * Picks the highest quantization precision for `model` whose weight + KV cache + 0.8 GB driver
 * margin fit inside `availableVramGb`. Lower-bandwidth devices avoid oversized Q8_0 weights.
 */
export function selectQuantizationForBudget(
  model: BrainModel,
  availableVramGb: number,
  contextSize = 16_384,
  memoryBandwidthGbps?: number,
): { quantization: ModelQuantization; weightGb: number; kvGb: number; lean: boolean; fits: boolean } {
  const GIB = 1024 ** 3;
  const baseWeightGb = model.sizeBytes / GIB;
  const baseMult = QUANT_MULTIPLIER[model.quantization ?? "Q4_K_M"];
  const normalizedBaseGb = baseWeightGb / baseMult;
  const overheadGb = 0.8;

  for (const lean of [false, true]) {
    const kvGb = estimateKvCacheBytes(model, contextSize, lean) / GIB;
    for (const quant of QUANT_PRECISION_ORDER) {
      // On slow memory buses, skip Q8_0 for large models so token latency stays interactive.
      if (
        quant === "Q8_0" &&
        memoryBandwidthGbps !== undefined &&
        memoryBandwidthGbps < 450 &&
        (model.activeParamsB ?? model.vramGb) >= 9
      ) {
        continue;
      }
      const weightGb = normalizedBaseGb * QUANT_MULTIPLIER[quant];
      if (weightGb + kvGb + overheadGb <= availableVramGb) {
        return { quantization: quant, weightGb, kvGb, lean, fits: true };
      }
    }
  }

  const fallbackQuant = model.quantization ?? "IQ4_XS";
  const weightGb = normalizedBaseGb * QUANT_MULTIPLIER[fallbackQuant];
  const kvGb = estimateKvCacheBytes(model, Math.min(8192, contextSize), true) / GIB;
  return {
    quantization: fallbackQuant,
    weightGb,
    kvGb,
    lean: true,
    fits: weightGb + kvGb + 0.5 <= availableVramGb,
  };
}

export type BrainChoice = "auto" | BrainModel["id"] | string;

/**
 * "auto" takes the standard model when the graphics card can hold it and the small one
 * otherwise. The large model is never picked automatically: it answers better, but it
 * takes most of even a big card's memory away from games and other work.
 */
export function pickAutomatically(totalVramBytes: number | null): BrainModel {
  const vramGb = (totalVramBytes ?? 0) / 1024 ** 3;
  return vramGb >= BRAIN_MODELS.standard.vramGb ? BRAIN_MODELS.standard : BRAIN_MODELS.small;
}

export interface ResolvedModel {
  label: string;
  path: string;
  /** Present when the file may need downloading first. */
  download: BrainModel | null;
}

/** Works out which model file to use from the setting: "auto", a size, or a path to any GGUF file. */
export function resolveBrain(
  choice: BrainChoice,
  modelsDir: string,
  totalVramBytes: number | null,
): ResolvedModel {
  if (choice !== "auto" && !(choice in BRAIN_MODELS)) {
    if (!isAbsolute(choice) || !choice.toLowerCase().endsWith(".gguf")) {
      throw new Error(
        `The "brain" setting "${choice}" is not one of auto, small, standard, large, xl, or a full path to a .gguf file.`,
      );
    }
    return { label: choice.split("/").pop() ?? choice, path: choice, download: null };
  }
  const model =
    choice === "auto"
      ? pickAutomatically(totalVramBytes)
      : BRAIN_MODELS[choice as BrainModel["id"]];
  return { label: model.label, path: join(modelsDir, model.fileName), download: model };
}

export async function isDownloaded(model: ResolvedModel): Promise<boolean> {
  try {
    const info = await stat(model.path);
    // A file much smaller than expected is a download that was cut off.
    return info.isFile() && (!model.download || info.size >= model.download.sizeBytes * 0.98);
  } catch {
    return false;
  }
}

/** Streams a local model file and verifies its SHA-256 digest in constant time. */
export async function verifyModelSha256(
  filePath: string,
  expectedHex: string,
): Promise<{ ok: boolean; actual: string }> {
  const normalized = expectedHex.trim().toLowerCase();
  const actual = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    return { ok: false, actual };
  }
  const expectedBuf = Buffer.from(normalized, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  const ok =
    expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  return { ok, actual };
}
