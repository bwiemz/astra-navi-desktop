import { isIP } from "node:net";
import type { Fleet, Machine } from "./fleet.ts";
import { isPrivateIpv4 } from "./permissions.ts";

/** Latency/scheduling class of a local or LAN compute request. */
export type WorkloadClass = "interactive" | "background_mission" | "batch_maintenance";

/** Logical workload categories schedulable across local or LAN compute nodes. */
export type TaskKind = "llm_standard" | "llm_small" | "research" | "embed" | "transcribe" | "eval";

export interface WorkerAccelerator {
  name: string;
  backend: "cuda" | "vulkan" | "rocm" | "cpu";
  vramTotalMb: number;
  vramFreeMb: number;
  tempC?: number;
}

export interface WorkerNode {
  id: string;
  name: string;
  host: string;
  transport: "ssh" | "station-mtls";
  accelerators: WorkerAccelerator[];
  cpuCores: number;
  load1m: number;
  loadedModels: string[];
  onBattery: boolean;
  thermalThrottled: boolean;
  /** Only hosts explicitly marked trusted may receive raw screen/notification/private-file payloads. */
  fullMirrorTrusted: boolean;
  lastHeartbeatAt: number;
  healthy: boolean;
}

export interface PrivacyScope {
  containsScreenCapture?: boolean;
  containsNotifications?: boolean;
  containsPrivateFiles?: boolean;
}

export interface WorkloadRequest {
  kind: TaskKind;
  latency: WorkloadClass;
  minVramMb: number;
  preferredModel?: string;
  privacy?: PrivacyScope;
}

export type RouteDecision =
  | { target: "local-gpu"; reason: string }
  | { target: "lan-worker"; node: WorkerNode; reason: string }
  | { target: "local-cpu-small"; reason: string };

const WORKER_PROBE_CMD =
  "nproc && cat /proc/loadavg && (nvidia-smi --query-gpu=memory.total,memory.free,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || true)";

/** True only for loopback or private LAN/VPN IP addresses; public internet hosts are refused. */
export function isPrivateLanHost(host: string): boolean {
  const trimmed = host.trim().replace(/^\[|\]$/g, "");
  if (!trimmed) return false;
  if (trimmed === "localhost" || trimmed === "::1") return true;
  if (trimmed.endsWith(".local")) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed)?.[1] ?? trimmed;
  return isIP(mapped) === 4 && isPrivateIpv4(mapped);
}

/** Parses `nproc && cat /proc/loadavg && nvidia-smi ...` output into worker metrics. */
export function parseWorkerProbeOutput(output: string): {
  cpuCores: number;
  load1m: number;
  accelerators: WorkerAccelerator[];
} {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cpuCores = Math.max(1, Number.parseInt(lines[0] ?? "1", 10) || 1);
  const loadToken = (lines[1] ?? "0").split(/\s+/)[0] ?? "0";
  const parsedLoad = Number.parseFloat(loadToken);
  const load1m = Number.isFinite(parsedLoad) && parsedLoad >= 0 ? parsedLoad : 0;

  const accelerators: WorkerAccelerator[] = [];
  for (const line of lines.slice(2)) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 2) continue;
    const totalMb = Number.parseFloat(parts[0] ?? "");
    const freeMb = Number.parseFloat(parts[1] ?? "");
    const tempC = parts[2] !== undefined ? Number.parseFloat(parts[2]) : undefined;
    if (!Number.isFinite(totalMb) || totalMb <= 0) continue;
    accelerators.push({
      name: "CUDA GPU",
      backend: "cuda",
      vramTotalMb: Math.round(totalMb),
      vramFreeMb: Number.isFinite(freeMb) && freeMb >= 0 ? Math.round(freeMb) : 0,
      ...(tempC !== undefined && Number.isFinite(tempC) ? { tempC } : {}),
    });
  }
  return { cpuCores, load1m, accelerators };
}

/**
 * Registry and latency/privacy-aware scheduler for offloading inference, embeddings,
 * transcription, and eval batches to idle GPUs/CPUs on the user's private LAN/VPN.
 */
export class WorkerMesh {
  private readonly registry = new Map<string, WorkerNode>();
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  enabled: boolean;

  constructor(options?: { enabled?: boolean; now?: () => number; staleAfterMs?: number }) {
    this.enabled = options?.enabled ?? false;
    this.now = options?.now ?? (() => Date.now());
    this.staleAfterMs = options?.staleAfterMs ?? 90_000;
  }

  register(node: WorkerNode): void {
    if (!isPrivateLanHost(node.host)) {
      throw new Error(`Refusing non-LAN worker host "${node.host}".`);
    }
    this.registry.set(node.id, {
      ...node,
      accelerators: node.accelerators.map((acc) => ({ ...acc })),
      loadedModels: [...node.loadedModels],
    });
  }

  heartbeat(
    id: string,
    patch: Partial<Omit<WorkerNode, "id" | "host" | "fullMirrorTrusted">>,
  ): boolean {
    const existing = this.registry.get(id);
    if (!existing) return false;
    this.registry.set(id, {
      ...existing,
      ...patch,
      lastHeartbeatAt: patch.lastHeartbeatAt ?? this.now(),
    });
    return true;
  }

  unregister(id: string): boolean {
    return this.registry.delete(id);
  }

  pruneStale(): number {
    const cutoff = this.now() - this.staleAfterMs;
    let removed = 0;
    for (const [id, node] of this.registry) {
      if (node.lastHeartbeatAt < cutoff) {
        this.registry.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  nodes(): WorkerNode[] {
    return [...this.registry.values()];
  }

  /** Computes eligibility and placement score (`-Infinity` when ineligible or privacy-blocked). */
  scoreNode(node: WorkerNode, request: WorkloadRequest): number {
    if (!node.healthy || node.onBattery || node.thermalThrottled) return -Infinity;
    if (this.now() - node.lastHeartbeatAt > this.staleAfterMs) return -Infinity;

    const sensitive =
      request.privacy?.containsScreenCapture === true ||
      request.privacy?.containsNotifications === true ||
      request.privacy?.containsPrivateFiles === true;
    if (sensitive && !node.fullMirrorTrusted) return -Infinity;

    const maxFreeVram = node.accelerators.reduce(
      (best, acc) => Math.max(best, acc.vramFreeMb),
      0,
    );
    if (request.minVramMb > 0 && maxFreeVram < request.minVramMb) return -Infinity;

    let score = maxFreeVram / 256;
    if (request.preferredModel && node.loadedModels.includes(request.preferredModel)) {
      score += 50;
    }
    const loadRatio = node.load1m / Math.max(1, node.cpuCores);
    score += Math.max(0, 1 - loadRatio) * 20;

    const hottest = node.accelerators.reduce(
      (max, acc) => Math.max(max, acc.tempC ?? 0),
      0,
    );
    if (hottest >= 85) score -= 40;
    else if (hottest >= 75) score -= 10;

    return score;
  }

  /** Selects local GPU, best eligible LAN worker, or local CPU small-brain fallback. */
  route(
    request: WorkloadRequest,
    local: { gpuBusyByGame: boolean; localFreeVramMb: number },
  ): RouteDecision {
    const localFitsGpu = !local.gpuBusyByGame && local.localFreeVramMb >= request.minVramMb;

    if (request.latency === "interactive" && localFitsGpu) {
      return { target: "local-gpu", reason: "Local GPU is idle and fits request." };
    }

    if (this.enabled) {
      let bestNode: WorkerNode | null = null;
      let bestScore = -Infinity;
      for (const node of this.registry.values()) {
        const score = this.scoreNode(node, request);
        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      }
      if (bestNode) {
        return {
          target: "lan-worker",
          node: bestNode,
          reason: local.gpuBusyByGame
            ? `Offloaded to LAN worker "${bestNode.name}" while workstation GPU serves a game.`
            : `Routed to LAN worker "${bestNode.name}" (score ${bestScore.toFixed(1)}).`,
        };
      }
    }

    if (localFitsGpu) {
      return { target: "local-gpu", reason: "No eligible LAN worker; using local GPU." };
    }

    return {
      target: "local-cpu-small",
      reason: local.gpuBusyByGame
        ? "Workstation GPU held by game and no LAN worker available; falling back to local CPU small brain."
        : "Insufficient free local VRAM and no eligible LAN worker; falling back to local CPU small brain.",
    };
  }

  /** Probes an SSH-paired LAN machine with a read-only resource command and registers its capabilities. */
  async probeOverFleet(
    fleet: Pick<Fleet, "run">,
    machine: Machine,
    signal?: AbortSignal,
  ): Promise<WorkerNode | null> {
    if (!isPrivateLanHost(machine.host)) return null;
    const result = await fleet.run(machine, WORKER_PROBE_CMD, { timeoutMs: 15_000, signal });
    if (result.timedOut || result.code !== 0) {
      this.heartbeat(machine.id, { healthy: false });
      return null;
    }
    const parsed = parseWorkerProbeOutput(result.output);
    const existing = this.registry.get(machine.id);
    const node: WorkerNode = {
      id: machine.id,
      name: machine.name,
      host: machine.host,
      transport: "ssh",
      accelerators: parsed.accelerators,
      cpuCores: parsed.cpuCores,
      load1m: parsed.load1m,
      loadedModels: existing?.loadedModels ?? [],
      onBattery: false,
      thermalThrottled: parsed.accelerators.some((acc) => (acc.tempC ?? 0) >= 92),
      fullMirrorTrusted: machine.fullMirrorTrusted === true,
      lastHeartbeatAt: this.now(),
      healthy: true,
    };
    this.register(node);
    return node;
  }
}
