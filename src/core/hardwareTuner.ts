import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  BRAIN_MODELS,
  MOE_WORKSTATION_MODELS,
  selectQuantizationForBudget,
  selectSpeculativeDraft,
  type BrainModel,
  type KvCachePrecision,
  type ModelQuantization,
  type SpeculativeDraftModel,
} from "./models.ts";
import { parseMacOsSysctlMemory } from "./platform/macos.ts";

const execFileAsync = promisify(execFile);

/** Hardware resources available on a local machine for sizing brain models and KV cache. */
export interface HardwareProfile {
  gpuName: string | null;
  totalVramBytes: number;
  freeVramBytes: number;
  systemRamBytes: number;
  cpuThreads: number;
  activeGameOrRender: boolean;
  /** True on Apple Silicon unified memory Macs where GPU & CPU share high-bandwidth RAM. */
  unifiedMemory?: boolean;
  platform?: NodeJS.Platform;
  /** GPU or system memory bandwidth in GB/s measured or inferred on first launch. */
  memoryBandwidthGbps?: number;
  /** PCIe link bandwidth in GB/s for host-to-GPU transfers. */
  pcieBandwidthGbps?: number;
}

/** Selected model tier, quantization precision, KV-cache config, and step-down explanation. */
export interface TierRecommendation {
  tier: BrainModel["id"];
  leanMemory: boolean;
  contextSize: number;
  quantization: ModelQuantization;
  architecture: "dense" | "moe";
  estimatedVramGb: number;
  kvCacheGb: number;
  kvCachePrecision?: KvCachePrecision;
  speculativeDraft?: {
    draftId: SpeculativeDraftModel["id"];
    fileName: string;
    extraVramGb: number;
    expectedSpeedup: number;
  } | null;
  moeHostCache?: {
    cacheSizeMb: number;
    cpuShare: number;
  } | null;
  stepDownFrom?: BrainModel["id"];
  reason: string;
}

const GIB = 1024 ** 3;
const TIER_ORDER: readonly BrainModel["id"][] = ["xl", "large", "standard", "small"];

function fitsBudget(
  model: BrainModel,
  budgetGb: number,
  contextSize: number,
  allowTight: boolean,
  bandwidthGbps?: number,
): { fits: boolean; quantization: ModelQuantization; lean: boolean; totalGb: number; kvGb: number } {
  const effectiveBudget = allowTight ? budgetGb * 1.08 : budgetGb;
  const q = selectQuantizationForBudget(model, effectiveBudget, contextSize, bandwidthGbps);
  const totalGb = Number((q.weightGb + q.kvGb).toFixed(2));
  const minRequired = allowTight ? model.vramGb * 0.85 : model.vramGb;
  const fits = q.fits && budgetGb >= minRequired;
  return {
    fits,
    quantization: q.quantization,
    lean: q.lean || allowTight,
    totalGb,
    kvGb: Number(q.kvGb.toFixed(2)),
  };
}

/**
 * Recommends the highest-capability brain tier, quantization precision, architecture (dense vs
 * MoE), and KV-cache budget that fit within current VRAM (or system RAM on CPU-only machines),
 * stepping down gracefully when a game or 3D render claims VRAM.
 */
export function recommendHardwareTier(
  profile: HardwareProfile,
  preferred: "auto" | BrainModel["id"] = "auto",
): TierRecommendation {
  const isUnifiedMac = profile.unifiedMemory === true;
  const effectiveVramBytes =
    isUnifiedMac && profile.totalVramBytes <= 0
      ? Math.round(profile.systemRamBytes * 0.75)
      : profile.totalVramBytes;
  const hasDiscreteGpu = effectiveVramBytes > 0;
  const effectiveGb = hasDiscreteGpu
    ? (profile.activeGameOrRender && profile.freeVramBytes > 0
        ? profile.freeVramBytes
        : isUnifiedMac
          ? effectiveVramBytes * 0.92
          : effectiveVramBytes * 0.85) / GIB
    : (profile.systemRamBytes * 0.45) / GIB;

  let targetList: readonly BrainModel["id"][];
  if (preferred !== "auto") {
    targetList = TIER_ORDER.slice(TIER_ORDER.indexOf(preferred));
  } else if (!hasDiscreteGpu) {
    targetList = ["small"];
  } else if (profile.activeGameOrRender) {
    targetList = ["standard", "small"];
  } else if (effectiveGb >= MOE_WORKSTATION_MODELS.xlMoe.vramGb || (isUnifiedMac && effectiveGb >= 46)) {
    targetList = ["xl", "large", "standard", "small"];
  } else if (
    effectiveGb >= 24 &&
    (isUnifiedMac || (profile.memoryBandwidthGbps ?? 600) >= 450)
  ) {
    targetList = ["large", "standard", "small"];
  } else {
    targetList = ["standard", "small"];
  }

  let chosen: BrainModel["id"] = "small";
  let architecture: "dense" | "moe" = "dense";
  let leanMemory = false;
  let selectedModel: BrainModel = BRAIN_MODELS.small;

  for (const candidate of targetList) {
    // On high-VRAM workstation GPUs under auto selection, prefer the Qwen3.5 122B-A10B MoE preset.
    const modelForTier =
      candidate === "xl" &&
      preferred === "auto" &&
      effectiveGb >= MOE_WORKSTATION_MODELS.xlMoe.vramGb
        ? MOE_WORKSTATION_MODELS.xlMoe
        : BRAIN_MODELS[candidate];

    const prelimCtx = candidate === "xl" || candidate === "large" ? 32_768 : 16_384;
    const tightCheck = fitsBudget(
      modelForTier,
      effectiveGb,
      prelimCtx,
      false,
      profile.memoryBandwidthGbps,
    );
    if (tightCheck.fits) {
      chosen = candidate;
      architecture = modelForTier.architecture ?? "dense";
      selectedModel = modelForTier;
      leanMemory = effectiveGb < modelForTier.vramGb * 1.15;
      break;
    }
    const reducedCtx = candidate === "xl" || candidate === "large" ? 16_384 : 8_192;
    const relaxedCheck = fitsBudget(
      modelForTier,
      effectiveGb,
      reducedCtx,
      true,
      profile.memoryBandwidthGbps,
    );
    if (relaxedCheck.fits) {
      chosen = candidate;
      architecture = modelForTier.architecture ?? "dense";
      selectedModel = modelForTier;
      leanMemory = true;
      break;
    }
  }

  if (!hasDiscreteGpu) {
    leanMemory = true;
    if (chosen !== "small") {
      chosen =
        effectiveGb >= BRAIN_MODELS.standard.vramGb * 1.4 && preferred !== "auto"
          ? "standard"
          : "small";
      selectedModel = BRAIN_MODELS[chosen];
      architecture = selectedModel.architecture ?? "dense";
    }
  }

  const reqGb = selectedModel.vramGb;
  const headroomGb = effectiveGb - reqGb;
  let contextSize = 16_384;
  if (!hasDiscreteGpu || leanMemory || headroomGb < 1.5) {
    contextSize = 8_192;
  } else if ((chosen === "xl" || chosen === "large") && headroomGb >= 4) {
    contextSize = 32_768;
  }

  const quantFit = selectQuantizationForBudget(
    selectedModel,
    effectiveGb,
    contextSize,
    profile.memoryBandwidthGbps,
  );
  const estimatedVramGb = Number((quantFit.weightGb + quantFit.kvGb).toFixed(2));
  const kvCacheGb = Number(quantFit.kvGb.toFixed(2));
  const spareVramGb = hasDiscreteGpu ? Math.max(0, effectiveGb - estimatedVramGb) : 0;
  const kvCachePrecision: KvCachePrecision =
    leanMemory || (hasDiscreteGpu && effectiveGb >= 10 && effectiveGb <= 18) ? "f8_e4m3" : "f16";
  const draft =
    hasDiscreteGpu && !profile.activeGameOrRender
      ? selectSpeculativeDraft(selectedModel, spareVramGb)
      : null;
  const systemRamGb = profile.systemRamBytes / GIB;
  const moeHostCache =
    architecture === "moe" && systemRamGb >= 32
      ? {
          cacheSizeMb: Math.min(32_768, Math.round(systemRamGb * 0.25 * 1024)),
          cpuShare: Number(Math.max(0.25, Math.min(0.85, 1 - spareVramGb / 32)).toFixed(2)),
        }
      : null;

  const stepDownFrom =
    preferred !== "auto" && preferred !== chosen ? preferred : undefined;
  const where = hasDiscreteGpu
    ? `${effectiveGb.toFixed(1)} GB effective VRAM (${profile.gpuName ?? "GPU"})`
    : `${effectiveGb.toFixed(1)} GB CPU RAM budget (no discrete GPU)`;

  const reason = stepDownFrom
    ? `Stepped down from ${stepDownFrom} to ${chosen} (${quantFit.quantization} ${architecture}, ${where}${profile.activeGameOrRender ? ", game/render active" : ""}).`
    : `Selected ${chosen} (${quantFit.quantization} ${architecture}) with${leanMemory ? " lean" : " standard"} KV cache (${where}).`;

  return {
    tier: chosen,
    leanMemory,
    contextSize,
    quantization: quantFit.quantization,
    architecture,
    estimatedVramGb,
    kvCacheGb,
    kvCachePrecision,
    speculativeDraft: draft
      ? {
          draftId: draft.id,
          fileName: draft.fileName,
          extraVramGb: draft.vramGb,
          expectedSpeedup: draft.expectedSpeedup,
        }
      : null,
    moeHostCache,
    ...(stepDownFrom ? { stepDownFrom } : {}),
    reason,
  };
}

/** Parses `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`. */
export function parseNvidiaSmiProfile(output: string): {
  gpuName: string | null;
  totalVramBytes: number;
  freeVramBytes: number;
  memoryBandwidthGbps?: number;
  pcieBandwidthGbps?: number;
} {
  let bestName: string | null = null;
  let bestTotalMb = 0;
  let bestFreeMb = 0;
  let bestMemBw: number | undefined;
  let bestPcieBw: number | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 3) continue;
    const totalMb = Number(parts[1]);
    const freeMb = Number(parts[2]);
    if (!Number.isFinite(totalMb) || totalMb <= 0) continue;
    if (totalMb > bestTotalMb) {
      bestName = parts[0] || null;
      bestTotalMb = totalMb;
      bestFreeMb = Number.isFinite(freeMb) && freeMb >= 0 ? freeMb : 0;

      // Optional trailing fields: clocks.max.memory (MHz), pcie.link.gen.max, pcie.link.width.max
      const memClockMhz = Number(parts[3]);
      const pcieGen = Number(parts[4]);
      const pcieWidth = Number(parts[5]);
      if (Number.isFinite(memClockMhz) && memClockMhz > 0) {
        const busBytes = totalMb >= 49_152 ? 48 : totalMb >= 20_480 ? 32 : 24;
        bestMemBw = Number(((memClockMhz * 2 * busBytes) / 1000).toFixed(1));
      }
      if (Number.isFinite(pcieGen) && Number.isFinite(pcieWidth) && pcieGen > 0 && pcieWidth > 0) {
        const perLane = pcieGen >= 5 ? 3.938 : pcieGen === 4 ? 1.969 : 0.985;
        bestPcieBw = Number((perLane * pcieWidth).toFixed(1));
      }
    }
  }
  const MIB = 1024 * 1024;
  return {
    gpuName: bestName,
    totalVramBytes: Math.round(bestTotalMb * MIB),
    freeVramBytes: Math.round(bestFreeMb * MIB),
    ...(bestMemBw !== undefined ? { memoryBandwidthGbps: bestMemBw } : {}),
    ...(bestPcieBw !== undefined ? { pcieBandwidthGbps: bestPcieBw } : {}),
  };
}

/** Runs a quick non-blocking typed-array memory copy micro-benchmark (GB/s). */
export function benchmarkMemoryBandwidthGbps(sampleMb = 8): number {
  const bytes = Math.max(1, Math.min(32, Math.trunc(sampleMb))) * 1024 * 1024;
  const src = new Uint8Array(bytes);
  const dst = new Uint8Array(bytes);
  src.fill(0x5a);
  const started = performance.now();
  const passes = 4;
  for (let i = 0; i < passes; i += 1) {
    dst.set(src);
  }
  const elapsedSec = Math.max(0.0005, (performance.now() - started) / 1000);
  const gbps = (bytes * passes * 2) / 1e9 / elapsedSec;
  return Number(Math.max(1, gbps).toFixed(1));
}

/** Probes local GPU/VRAM/bandwidth/RAM/CPU capabilities with graceful CPU-only & Apple Silicon fallback. */
export async function probeLocalHardware(options?: {
  platform?: NodeJS.Platform;
  activeGameOrRender?: boolean;
  nvidiaSmiCommand?: string;
  measureBandwidth?: boolean;
}): Promise<HardwareProfile> {
  const platform = options?.platform ?? process.platform;
  if (platform === "darwin") {
    try {
      const [{ stdout: memOut }, { stdout: vmOut }, { stdout: brandOut }] = await Promise.all([
        execFileAsync("sysctl", ["-n", "hw.memsize"], { timeout: 3_000, encoding: "utf8" }),
        execFileAsync("vm_stat", [], { timeout: 3_000, encoding: "utf8" }),
        execFileAsync("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 3_000, encoding: "utf8" }),
      ]);
      const mac = parseMacOsSysctlMemory(memOut, vmOut, brandOut);
      return {
        gpuName: mac.chipName,
        totalVramBytes: mac.totalBytes,
        freeVramBytes: mac.freeBytes,
        systemRamBytes: mac.totalSystemBytes || totalmem(),
        cpuThreads: Math.max(1, cpus().length),
        activeGameOrRender: options?.activeGameOrRender ?? false,
        unifiedMemory: mac.unifiedMemory,
        platform: "darwin",
        memoryBandwidthGbps: mac.estimatedBandwidthGbps,
      };
    } catch {
      // Fall through to generic probe on minimal sandboxes.
    }
  }

  const queryWithBw = await execFileAsync(
    options?.nvidiaSmiCommand ?? "nvidia-smi",
    [
      "--query-gpu=name,memory.total,memory.free,clocks.max.memory,pcie.link.gen.max,pcie.link.width.max",
      "--format=csv,noheader,nounits",
    ],
    { timeout: 4_000, encoding: "utf8" },
  )
    .then((res) => parseNvidiaSmiProfile(res.stdout))
    .catch(() => null);

  const gpu: ReturnType<typeof parseNvidiaSmiProfile> =
    queryWithBw ??
    (await execFileAsync(
      options?.nvidiaSmiCommand ?? "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 4_000, encoding: "utf8" },
    )
      .then((res) => parseNvidiaSmiProfile(res.stdout))
      .catch(
        (): ReturnType<typeof parseNvidiaSmiProfile> => ({
          gpuName: null,
          totalVramBytes: 0,
          freeVramBytes: 0,
        }),
      ));

  const measuredBw =
    gpu.memoryBandwidthGbps ??
    (options?.measureBandwidth === false ? undefined : benchmarkMemoryBandwidthGbps(4));

  return {
    ...gpu,
    ...(measuredBw !== undefined ? { memoryBandwidthGbps: measuredBw } : {}),
    systemRamBytes: totalmem(),
    cpuThreads: Math.max(1, cpus().length),
    activeGameOrRender: options?.activeGameOrRender ?? false,
  };
}

/** Runs first-launch hardware & bandwidth benchmarking, caching results atomically under `cacheFile`. */
export async function benchmarkFirstLaunchHardware(
  cacheFile: string,
  options?: {
    preferred?: "auto" | BrainModel["id"];
    force?: boolean;
    activeGameOrRender?: boolean;
    probe?: () => Promise<HardwareProfile>;
  },
): Promise<{
  profile: HardwareProfile;
  recommendation: TierRecommendation;
  fromCache: boolean;
}> {
  if (!options?.force) {
    try {
      const raw = JSON.parse(await readFile(cacheFile, "utf8")) as {
        version?: number;
        profile?: HardwareProfile;
      };
      if (
        raw.version === 1 &&
        raw.profile &&
        typeof raw.profile.totalVramBytes === "number" &&
        typeof raw.profile.systemRamBytes === "number"
      ) {
        const profile = {
          ...raw.profile,
          activeGameOrRender: options?.activeGameOrRender ?? raw.profile.activeGameOrRender,
        };
        return {
          profile,
          recommendation: recommendHardwareTier(profile, options?.preferred ?? "auto"),
          fromCache: true,
        };
      }
    } catch {
      // Cache absent or corrupted — run a fresh benchmark below.
    }
  }

  const profile = options?.probe
    ? await options.probe()
    : await probeLocalHardware({ activeGameOrRender: options?.activeGameOrRender });
  const recommendation = recommendHardwareTier(profile, options?.preferred ?? "auto");

  await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
  const tmp = `${cacheFile}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ version: 1, benchmarkedAt: new Date().toISOString(), profile }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(tmp, cacheFile);

  return { profile, recommendation, fromCache: false };
}
