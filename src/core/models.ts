import { createHash, sign, timingSafeEqual, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

/**
 * The open-weight language models the assistant can think with. All are Apache-2.0
 * licensed, download from Hugging Face without an account, and run entirely on this
 * computer.
 */
export type ModelQuantization = "IQ4_XS" | "Q4_K_M" | "Q5_K_M" | "Q6_K" | "Q8_0";

export type KvCachePrecision = "f16" | "f8_e4m3" | "q8_0" | "q4_0" | "tq4" | "tq3";

export interface SpeculativeDraftModel {
  id: "qwen3.5-0.8b" | "qwen3.5-2b" | "qwen3.5-4b";
  family: "qwen3.5";
  fileName: string;
  vramGb: number;
  maxTargetParamsB: number;
  expectedSpeedup: number;
}

export const DRAFT_MODELS: readonly SpeculativeDraftModel[] = [
  {
    id: "qwen3.5-0.8b",
    family: "qwen3.5",
    fileName: "Qwen3.5-0.8B-Q4_K_M.gguf",
    vramGb: 0.75,
    maxTargetParamsB: 14,
    expectedSpeedup: 1.85,
  },
  {
    id: "qwen3.5-2b",
    family: "qwen3.5",
    fileName: "Qwen3.5-2B-Q4_K_M.gguf",
    vramGb: 1.55,
    maxTargetParamsB: 32,
    expectedSpeedup: 2.15,
  },
  {
    id: "qwen3.5-4b",
    family: "qwen3.5",
    fileName: "Qwen3.5-4B-Q4_K_M.gguf",
    vramGb: 2.9,
    maxTargetParamsB: 120,
    expectedSpeedup: 2.4,
  },
];

const KV_PRECISION_FACTOR: Record<KvCachePrecision, number> = {
  f16: 1.0,
  q8_0: 0.55,
  f8_e4m3: 0.52,
  q4_0: 0.3,
  tq4: 0.28,
  tq3: 0.21,
};

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

/** Estimates working KV-cache memory in bytes for a model, context length, and precision/lean setting. */
export function estimateKvCacheBytes(
  model: BrainModel,
  contextSize: number,
  lean: boolean,
  precision?: KvCachePrecision,
): number {
  const safeCtx = Math.max(512, Math.trunc(contextSize));
  const perTok = model.kvBytesPerToken ?? 98_304;
  const resolved: KvCachePrecision = precision ?? (lean ? "q8_0" : "f16");
  return Math.round(perTok * safeCtx * KV_PRECISION_FACTOR[resolved]);
}

/** Auto-pairs a same-family tiny draft model when spare VRAM allows speculative decoding (`-md`). */
export function selectSpeculativeDraft(
  targetModel: Pick<BrainModel, "id" | "totalParamsB" | "activeParamsB" | "vramGb">,
  spareVramGb: number,
): SpeculativeDraftModel | null {
  const paramsB = targetModel.totalParamsB ?? 4;
  if (paramsB < 8 || !Number.isFinite(spareVramGb)) return null;
  const usableSpare = spareVramGb - 1.5;
  // Empirically, drafts >25% of target VRAM (e.g. 4B on 9B) slow decode; cap draft ratio cleanly.
  const maxDraftVram = targetModel.vramGb * 0.25;
  if (usableSpare <= 0.75) return null;
  const candidates = DRAFT_MODELS.filter(
    (d) =>
      d.vramGb <= usableSpare &&
      d.vramGb <= maxDraftVram &&
      paramsB <= d.maxTargetParamsB * 2.5,
  ).sort((a, b) => b.expectedSpeedup - a.expectedSpeedup);
  return candidates[0] ?? null;
}

export interface LlamaCpp10LaunchConfig {
  modelPath: string;
  contextSize: number;
  draftModelPath?: string | null;
  kvCachePrecision?: "f16" | "f8_e4m3" | "q8_0" | "q4_0";
  moeCacheSizeMb?: number;
  moeCacheCpuShare?: number;
  flashAttention?: boolean;
}

/** Builds llama.cpp 1.0.0 CLI/server flags (`-md`, `-ctk`/`-ctv`, `--moe-cache-*`). */
export function buildLlamaCpp10Args(cfg: LlamaCpp10LaunchConfig): string[] {
  const args: string[] = [
    "-m",
    cfg.modelPath,
    "-c",
    String(Math.max(512, Math.trunc(cfg.contextSize))),
  ];
  if (cfg.flashAttention !== false) {
    args.push("-fa", "on");
  }
  if (cfg.draftModelPath) {
    args.push("-md", cfg.draftModelPath);
  }
  const kvType = cfg.kvCachePrecision ?? "f16";
  if (kvType !== "f16") {
    args.push("-ctk", kvType, "-ctv", kvType);
  }
  if (typeof cfg.moeCacheSizeMb === "number" && cfg.moeCacheSizeMb > 0) {
    args.push("--moe-cache-size", String(Math.round(cfg.moeCacheSizeMb)));
  }
  if (
    typeof cfg.moeCacheCpuShare === "number" &&
    cfg.moeCacheCpuShare > 0 &&
    cfg.moeCacheCpuShare <= 1
  ) {
    args.push("--moe-cache-cpu-share", cfg.moeCacheCpuShare.toFixed(2));
  }
  return args;
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

// --- Rolling Model Catalog & Vetted Public Benchmarks --------------------

export interface ModelBenchmarkMetrics {
  suite: string;
  casesTotal: number;
  overallScorePercent: number;
  toolChoicePercent: number;
  followThroughPercent: number;
  injectionSafetyPercent: number;
  fuzzPassed?: number;
  fuzzTotal?: number;
  medianTtftSec: number;
  tokensPerSec: number;
  measuredOn: string;
  measuredAt: string;
}

export interface RollingModelEntry {
  presetId: string;
  tier: BrainModel["id"];
  family: string;
  releaseTag: string;
  recommended: boolean;
  benchmarkStatus: "verified" | "pending_gpu";
  model: BrainModel;
  benchmarks?: ModelBenchmarkMetrics;
  notes: string;
}

/**
 * Curated rolling catalog of Apache-2.0 open-weight GGUF releases (4B, 9B, 27B,
 * 30B-A3B MoE, 72B, 120B-A16B MoE) so users get one-click vetted presets alongside
 * empirical benchmark telemetry from `evals/results/BENCHMARKS.md`.
 */
export const ROLLING_MODEL_CATALOG: readonly RollingModelEntry[] = [
  {
    presetId: "qwen3.5-4b",
    tier: "small",
    family: "Qwen3.5",
    releaseTag: "2026.11",
    recommended: true,
    benchmarkStatus: "verified",
    model: BRAIN_MODELS.small,
    benchmarks: {
      suite: "163-case core + 500-case fuzz",
      casesTotal: 163,
      overallScorePercent: 81.7,
      toolChoicePercent: 91.5,
      followThroughPercent: 60.0,
      injectionSafetyPercent: 86.7,
      fuzzPassed: 500,
      fuzzTotal: 500,
      medianTtftSec: 1.15,
      tokensPerSec: 170.8,
      measuredOn: "NVIDIA RTX PRO 4500 Blackwell (32,623 MiB VRAM)",
      measuredAt: "2026-11-22",
    },
    notes: "Fast 4 GB laptop/handheld preset with grammar-hardened tool decoding.",
  },
  {
    presetId: "qwen3.5-9b",
    tier: "standard",
    family: "Qwen3.5",
    releaseTag: "2026.11",
    recommended: true,
    benchmarkStatus: "verified",
    model: BRAIN_MODELS.standard,
    benchmarks: {
      suite: "163-case core + 500-case fuzz",
      casesTotal: 163,
      overallScorePercent: 83.3,
      toolChoicePercent: 93.6,
      followThroughPercent: 80.0,
      injectionSafetyPercent: 86.7,
      fuzzPassed: 500,
      fuzzTotal: 500,
      medianTtftSec: 2.02,
      tokensPerSec: 113.6,
      measuredOn: "NVIDIA RTX PRO 4500 Blackwell (32,623 MiB VRAM)",
      measuredAt: "2026-11-22",
    },
    notes: "Default 8 GB GPU desktop sweet spot: high character adherence and reliable tool calling.",
  },
  {
    presetId: "qwen3.8-27b",
    tier: "large",
    family: "Qwen3.8",
    releaseTag: "2026.11",
    recommended: true,
    benchmarkStatus: "verified",
    model: BRAIN_MODELS.large,
    benchmarks: {
      suite: "163-case core + 500-case fuzz",
      casesTotal: 163,
      overallScorePercent: 90.6,
      toolChoicePercent: 95.7,
      followThroughPercent: 100.0,
      injectionSafetyPercent: 100.0,
      fuzzPassed: 500,
      fuzzTotal: 500,
      medianTtftSec: 4.3,
      tokensPerSec: 38.9,
      measuredOn: "NVIDIA RTX PRO 4500 Blackwell (32,623 MiB VRAM)",
      measuredAt: "2026-11-22",
    },
    notes: "24 GB+ / Apple Silicon Pro workstation preset achieving 100% follow-through honesty.",
  },
  {
    presetId: "qwen3-30b-a3b-moe",
    tier: "large",
    family: "Qwen3-MoE",
    releaseTag: "2026.11",
    recommended: false,
    benchmarkStatus: "verified",
    model: {
      id: "large",
      label: "Large MoE (Qwen3 30B-A3B)",
      fileName: "Qwen3-30B-A3B-Q4_K_M.gguf",
      url: "https://huggingface.co/unsloth/Qwen3-30B-A3B-GGUF/resolve/main/Qwen3-30B-A3B-Q4_K_M.gguf",
      sizeBytes: 18_556_686_912,
      vramGb: 20,
      architecture: "moe",
      quantization: "Q4_K_M",
      kvBytesPerToken: 98_304,
      totalParamsB: 30,
      activeParamsB: 3,
    },
    benchmarks: {
      suite: "163-case core",
      casesTotal: 163,
      overallScorePercent: 73.9,
      toolChoicePercent: 78.7,
      followThroughPercent: 66.7,
      injectionSafetyPercent: 80.0,
      medianTtftSec: 2.13,
      tokensPerSec: 213.0,
      measuredOn: "NVIDIA RTX PRO 4500 Blackwell (32,623 MiB VRAM)",
      measuredAt: "2026-11-24",
    },
    notes: "3B-active Mixture-of-Experts preset: ultra-fast 213 tok/s generation & 100% Reasoning/Nothing Leaked, but 73.9% agentic score trails dense 27B (90.6%).",
  },
  {
    presetId: "qwen3.5-72b",
    tier: "xl",
    family: "Qwen3.5",
    releaseTag: "2026.11",
    recommended: false,
    benchmarkStatus: "pending_gpu",
    model: BRAIN_MODELS.xl,
    notes: "Dense 72B workstation / 96+ GB Apple Silicon Max/Ultra preset; awaiting full 163-case GPU run.",
  },
  {
    presetId: "qwen3.5-120b-a16b-moe",
    tier: "xl",
    family: "Qwen3.5-MoE",
    releaseTag: "2026.11",
    recommended: false,
    benchmarkStatus: "pending_gpu",
    model: MOE_WORKSTATION_MODELS.xlMoe,
    notes: "16B-active workstation MoE preset for 66+ GB VRAM / 128 GB unified memory; awaiting full 163-case GPU run.",
  },
];

export function getVettedPresets(): RollingModelEntry[] {
  return ROLLING_MODEL_CATALOG.filter((entry) => entry.benchmarkStatus === "verified");
}

export function findCatalogEntry(presetId: string): RollingModelEntry | null {
  return ROLLING_MODEL_CATALOG.find((entry) => entry.presetId === presetId) ?? null;
}

/** Resolves `"auto"`, a tier ID, a rolling catalog `presetId`, or an absolute `.gguf` path. */
export function resolvePresetChoice(
  choice: BrainChoice,
  modelsDir: string,
  totalVramBytes: number | null,
): ResolvedModel {
  const catalogHit = findCatalogEntry(choice);
  if (catalogHit) {
    return {
      label: catalogHit.model.label,
      path: join(modelsDir, catalogHit.model.fileName),
      download: catalogHit.model,
    };
  }
  return resolveBrain(choice, modelsDir, totalVramBytes);
}

const SignedCatalogEntrySchema = z.object({
  presetId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  tier: z.enum(["small", "standard", "large", "xl"]),
  benchmarkStatus: z.enum(["verified", "pending_gpu"]),
  fileName: z.string().min(1).max(160),
  url: z.string().url().refine((u) => u.startsWith("https://"), "Model URLs must use https://."),
  sizeBytes: z.number().int().positive(),
  vramGb: z.number().positive(),
  architecture: z.enum(["dense", "moe"]).optional(),
  overallScorePercent: z.number().min(0).max(100).optional(),
});

export const SignedRollingCatalogSchema = z.object({
  catalogVersion: z.literal(1),
  updatedAt: z.string().min(1).max(64),
  entries: z.array(SignedCatalogEntrySchema).min(1).max(64),
  signature: z.string().max(512).optional(),
});
export type SignedRollingCatalog = z.infer<typeof SignedRollingCatalogSchema>;

function canonicalCatalogBytes(catalog: Omit<SignedRollingCatalog, "signature">): Buffer {
  const sortVal = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortVal);
    if (typeof v === "object" && v !== null) {
      const rec = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec).sort((a, b) => a.localeCompare(b))) {
        if (rec[k] !== undefined) out[k] = sortVal(rec[k]);
      }
      return out;
    }
    return v;
  };
  return Buffer.from(JSON.stringify(sortVal(catalog)), "utf8");
}

export function signRollingCatalog(
  catalog: Omit<SignedRollingCatalog, "signature">,
  privateKeyPem: string,
): string {
  const parsed = SignedRollingCatalogSchema.parse(catalog);
  const { signature: _ignored, ...unsigned } = parsed;
  void _ignored;
  return sign(null, canonicalCatalogBytes(unsigned), privateKeyPem).toString("base64");
}

export function verifyRollingCatalog(
  raw: unknown,
  trustedPublicKeysPem: readonly string[],
): { ok: true; catalog: SignedRollingCatalog } | { ok: false; reason: string } {
  const parsed = SignedRollingCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `Invalid rolling catalog: ${parsed.error.message}` };
  }
  if (!parsed.data.signature || trustedPublicKeysPem.length === 0) {
    return { ok: false, reason: "Missing catalog signature or trusted public key." };
  }
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(parsed.data.signature, "base64");
  } catch {
    return { ok: false, reason: "Malformed base64 signature." };
  }
  const { signature: _sig, ...unsigned } = parsed.data;
  void _sig;
  const payload = canonicalCatalogBytes(unsigned);
  for (const key of trustedPublicKeysPem) {
    try {
      if (verify(null, payload, key, sigBytes)) {
        return { ok: true, catalog: parsed.data };
      }
    } catch {
      // Try remaining trusted keys.
    }
  }
  return { ok: false, reason: "Rolling catalog Ed25519 signature verification failed." };
}
