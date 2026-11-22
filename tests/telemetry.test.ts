import { describe, expect, it, vi } from "vitest";
import {
  evaluateHeavyJobPolicy,
  parsePingOutput,
  parsePoolHealth,
  parseSmartHealth,
  parseUpscOutput,
  TelemetryCollector,
  type TelemetrySnapshot,
} from "../src/core/telemetry.ts";

function healthySnapshot(): TelemetrySnapshot {
  return {
    takenAt: 1000,
    gpu: { tempC: 54, vramUsedMb: 1200, vramTotalMb: 32_768, throttled: false },
    cpu: { throttled: false },
    storage: { smartHealthy: true, wearPercent: 4, poolHealth: "online" },
    power: { onUpsBattery: false, upsLoadPercent: 18, batteryRuntimeSec: 2400 },
    network: { gatewayRttMs: 2.4, packetLossPct: 0, lanPresenceOnline: true },
  };
}

describe("Telemetry parsers & heavy-job coupling policy", () => {
  it("parses SMART, ZFS/Btrfs pools, upsc UPS, and ping outputs accurately", () => {
    expect(
      parseSmartHealth("SMART overall-health self-assessment test result: PASSED\nPercentage Used: 12%"),
    ).toEqual({ healthy: true, wearPercent: 12 });
    expect(
      parseSmartHealth("SMART overall-health self-assessment test result: FAILED"),
    ).toEqual({ healthy: false, wearPercent: null });

    expect(parsePoolHealth("all pools are healthy\n")).toBe("online");
    expect(parsePoolHealth("  pool: tank\n state: DEGRADED\n")).toBe("degraded");
    expect(parsePoolHealth("[/dev/nvme0n1].corruption_errs    2\n")).toBe("degraded");

    expect(parseUpscOutput("ups.status: OB DISCHRG\nups.load: 45\nbattery.runtime: 510\n")).toEqual({
      onUpsBattery: true,
      upsLoadPercent: 45,
      batteryRuntimeSec: 510,
    });

    expect(
      parsePingOutput("3 packets transmitted, 3 received, 0% packet loss\nrtt min/avg/max/mdev = 1.2/2.8/4.1/1.0 ms"),
    ).toEqual({ packetLossPct: 0, gatewayRttMs: 2.8 });
  });

  it("defers heavy compute jobs on UPS battery, high GPU temp, degraded storage, or high packet loss", () => {
    expect(evaluateHeavyJobPolicy(healthySnapshot())).toEqual({ allowed: true, deferReasons: [] });

    const stressed = healthySnapshot();
    stressed.power.onUpsBattery = true;
    stressed.gpu.tempC = 88;
    stressed.storage.poolHealth = "degraded";
    stressed.network.packetLossPct = 10;

    const decision = evaluateHeavyJobPolicy(stressed);
    expect(decision.allowed).toBe(false);
    expect(decision.deferReasons.length).toBeGreaterThanOrEqual(4);
  });

  it("collects unified snapshot cleanly from OS tools", async () => {
    const collector = new TelemetryCollector({
      upsName: "apc",
      gatewayIp: "192.168.1.1",
      smartDevice: "/dev/nvme0",
      run: vi.fn(async (prog: string) => {
        if (prog === "nvidia-smi") return "49, 2000, 32768\n";
        if (prog === "upsc") return "ups.status: OL\nups.load: 22\nbattery.runtime: 1800\n";
        if (prog === "zpool") return "all pools are healthy\n";
        if (prog === "smartctl") return "SMART overall-health self-assessment test result: PASSED\n";
        if (prog === "ping") return "0% packet loss\nrtt min/avg/max/mdev = 1/3.5/5/1 ms\n";
        return "";
      }),
    });
    const snap = await collector.collect(true);
    expect(snap.gpu.tempC).toBe(49);
    expect(evaluateHeavyJobPolicy(snap).allowed).toBe(true);
  });
});
