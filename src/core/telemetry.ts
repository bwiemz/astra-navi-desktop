import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TelemetrySnapshot {
  takenAt: number;
  gpu: {
    tempC: number | null;
    vramUsedMb: number | null;
    vramTotalMb: number | null;
    throttled: boolean;
  };
  cpu: {
    throttled: boolean;
  };
  storage: {
    smartHealthy: boolean | null;
    wearPercent: number | null;
    poolHealth: "online" | "degraded" | "unknown";
  };
  power: {
    onUpsBattery: boolean;
    upsLoadPercent: number | null;
    batteryRuntimeSec: number | null;
  };
  network: {
    gatewayRttMs: number | null;
    packetLossPct: number | null;
    lanPresenceOnline: boolean | null;
  };
}

export interface HeavyJobDecision {
  allowed: boolean;
  deferReasons: string[];
}

export interface TelemetryLimits {
  maxGpuTempC?: number;
  minBatteryRuntimeSec?: number;
  maxPacketLossPct?: number;
  maxGatewayRttMs?: number;
}

/** Parses `smartctl -H -A` output for overall health and NVMe percentage used. */
export function parseSmartHealth(output: string): {
  healthy: boolean | null;
  wearPercent: number | null;
} {
  let healthy: boolean | null = null;
  if (/overall-health self-assessment test result:\s*PASSED|\bHealth Status:\s*OK\b/i.test(output)) {
    healthy = true;
  } else if (
    /overall-health self-assessment test result:\s*FAILED|\bHealth Status:\s*(?:CRITICAL|FAILED)/i.test(
      output,
    )
  ) {
    healthy = false;
  }
  const wearMatch = /Percentage Used:\s*(\d+)\s*%/i.exec(output);
  const wearPercent = wearMatch?.[1] ? Number.parseInt(wearMatch[1], 10) : null;
  return { healthy, wearPercent };
}

/** Parses `zpool status -x` or `btrfs device stats` output into pool health status. */
export function parsePoolHealth(output: string): "online" | "degraded" | "unknown" {
  const lower = output.toLowerCase();
  if (!lower.trim()) return "unknown";
  if (lower.includes("all pools are healthy")) return "online";
  if (/(?:degraded|faulted|offline|unavail|corrupt)/i.test(output)) return "degraded";
  const btrfsErr = /\.(?:write_io_errs|read_io_errs|corruption_errs)\s+(\d+)/g;
  let sawBtrfsStat = false;
  let match: RegExpExecArray | null;
  while ((match = btrfsErr.exec(output)) !== null) {
    sawBtrfsStat = true;
    if (Number(match[1]) > 0) return "degraded";
  }
  return sawBtrfsStat ? "online" : "unknown";
}

/** Parses NUT `upsc <ups>` key: value output. */
export function parseUpscOutput(output: string): {
  onUpsBattery: boolean;
  upsLoadPercent: number | null;
  batteryRuntimeSec: number | null;
} {
  const kv = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    kv.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const status = kv.get("ups.status") ?? "";
  const onUpsBattery = /\bOB\b/.test(status);
  const loadRaw = Number(kv.get("ups.load"));
  const runtimeRaw = Number(kv.get("battery.runtime"));
  return {
    onUpsBattery,
    upsLoadPercent: Number.isFinite(loadRaw) ? loadRaw : null,
    batteryRuntimeSec: Number.isFinite(runtimeRaw) ? runtimeRaw : null,
  };
}

/** Parses Linux `ping -c ...` summary for packet loss % and average RTT ms. */
export function parsePingOutput(output: string): {
  packetLossPct: number | null;
  gatewayRttMs: number | null;
} {
  const lossMatch = /(\d+(?:\.\d+)?)%\s+packet loss/i.exec(output);
  const rttMatch = /(?:rtt|round-trip)[^=]*=\s*[\d.]+\/([\d.]+)\//i.exec(output);
  const packetLossPct = lossMatch?.[1] ? Number.parseFloat(lossMatch[1]) : null;
  const gatewayRttMs = rttMatch?.[1] ? Number.parseFloat(rttMatch[1]) : null;
  return {
    packetLossPct: Number.isFinite(packetLossPct) ? packetLossPct : null,
    gatewayRttMs: Number.isFinite(gatewayRttMs) ? gatewayRttMs : null,
  };
}

/** Evaluates whether heavy compute, compaction, evals, or backups should proceed right now. */
export function evaluateHeavyJobPolicy(
  snapshot: TelemetrySnapshot,
  limits?: TelemetryLimits,
): HeavyJobDecision {
  const maxGpuTempC = limits?.maxGpuTempC ?? 85;
  const minBatteryRuntimeSec = limits?.minBatteryRuntimeSec ?? 600;
  const maxPacketLossPct = limits?.maxPacketLossPct ?? 5;
  const maxGatewayRttMs = limits?.maxGatewayRttMs ?? 150;

  const deferReasons: string[] = [];

  if (snapshot.power.onUpsBattery) {
    deferReasons.push("Workstation is running on UPS battery power.");
  } else if (
    snapshot.power.batteryRuntimeSec !== null &&
    snapshot.power.batteryRuntimeSec < minBatteryRuntimeSec
  ) {
    deferReasons.push(
      `UPS battery runtime too low (${snapshot.power.batteryRuntimeSec}s < ${minBatteryRuntimeSec}s).`,
    );
  }

  if (snapshot.gpu.throttled) {
    deferReasons.push("GPU is thermally or power throttled.");
  } else if (snapshot.gpu.tempC !== null && snapshot.gpu.tempC >= maxGpuTempC) {
    deferReasons.push(`GPU temperature high (${snapshot.gpu.tempC}C >= ${maxGpuTempC}C).`);
  }

  if (snapshot.cpu.throttled) {
    deferReasons.push("CPU package is thermally throttled.");
  }

  if (snapshot.storage.smartHealthy === false) {
    deferReasons.push("Storage SMART health reported failure.");
  }
  if (snapshot.storage.poolHealth === "degraded") {
    deferReasons.push("Storage pool health is degraded.");
  }

  if (
    snapshot.network.packetLossPct !== null &&
    snapshot.network.packetLossPct >= maxPacketLossPct
  ) {
    deferReasons.push(`LAN/WAN packet loss high (${snapshot.network.packetLossPct}%).`);
  } else if (
    snapshot.network.gatewayRttMs !== null &&
    snapshot.network.gatewayRttMs >= maxGatewayRttMs
  ) {
    deferReasons.push(`Gateway RTT indicates bufferbloat (${snapshot.network.gatewayRttMs}ms).`);
  }

  return {
    allowed: deferReasons.length === 0,
    deferReasons,
  };
}

export class TelemetryCollector {
  private readonly run: (program: string, args: readonly string[]) => Promise<string>;
  private readonly gatewayIp?: string;
  private readonly upsName?: string;
  private readonly smartDevice?: string;
  private readonly now: () => number;

  constructor(options?: {
    run?: (program: string, args: readonly string[]) => Promise<string>;
    gatewayIp?: string;
    upsName?: string;
    smartDevice?: string;
    now?: () => number;
  }) {
    this.run =
      options?.run ??
      (async (program, args) => {
        const res = await execFileAsync(program, args, { timeout: 4_000, encoding: "utf8" });
        return res.stdout;
      });
    this.gatewayIp = options?.gatewayIp;
    this.upsName = options?.upsName;
    this.smartDevice = options?.smartDevice;
    this.now = options?.now ?? (() => Date.now());
  }

  async collect(lanPresenceOnline: boolean | null = null): Promise<TelemetrySnapshot> {
    const [gpuOut, smartOut, zpoolOut, upscOut, pingOut] = await Promise.all([
      this.run("nvidia-smi", [
        "--query-gpu=temperature.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ]).catch(() => ""),
      this.smartDevice
        ? this.run("smartctl", ["-H", "-A", this.smartDevice]).catch(() => "")
        : Promise.resolve(""),
      this.run("zpool", ["status", "-x"]).catch(() => ""),
      this.upsName ? this.run("upsc", [this.upsName]).catch(() => "") : Promise.resolve(""),
      this.gatewayIp
        ? this.run("ping", ["-c", "3", "-W", "1", this.gatewayIp]).catch(() => "")
        : Promise.resolve(""),
    ]);

    const gpuParts = gpuOut
      .split(/\r?\n/)[0]
      ?.split(",")
      .map((s) => Number(s.trim()));
    const gpuTemp =
      gpuParts?.[0] !== undefined && Number.isFinite(gpuParts[0]) ? gpuParts[0] : null;
    const vramUsed =
      gpuParts?.[1] !== undefined && Number.isFinite(gpuParts[1]) ? gpuParts[1] : null;
    const vramTotal =
      gpuParts?.[2] !== undefined && Number.isFinite(gpuParts[2]) ? gpuParts[2] : null;

    const smart = parseSmartHealth(smartOut);
    const poolHealth = parsePoolHealth(zpoolOut);
    const power = parseUpscOutput(upscOut);
    const ping = parsePingOutput(pingOut);

    return {
      takenAt: this.now(),
      gpu: {
        tempC: gpuTemp,
        vramUsedMb: vramUsed,
        vramTotalMb: vramTotal,
        throttled: gpuTemp !== null && gpuTemp >= 90,
      },
      cpu: { throttled: false },
      storage: { smartHealthy: smart.healthy, wearPercent: smart.wearPercent, poolHealth },
      power,
      network: {
        gatewayRttMs: ping.gatewayRttMs,
        packetLossPct: ping.packetLossPct,
        lanPresenceOnline,
      },
    };
  }
}
