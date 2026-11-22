import { describe, expect, it, vi } from "vitest";
import {
  isPrivateLanHost,
  parseWorkerProbeOutput,
  WorkerMesh,
  type WorkerNode,
} from "../src/core/workerMesh.ts";

function sampleNode(over: Partial<WorkerNode> = {}): WorkerNode {
  return {
    id: "n1",
    name: "homelab-gpu",
    host: "192.168.1.40",
    transport: "ssh",
    accelerators: [{ name: "RTX 4090", backend: "cuda", vramTotalMb: 24_576, vramFreeMb: 20_000, tempC: 52 }],
    cpuCores: 16,
    load1m: 1.2,
    loadedModels: ["standard"],
    onBattery: false,
    thermalThrottled: false,
    fullMirrorTrusted: false,
    lastHeartbeatAt: 100_000,
    healthy: true,
    ...over,
  };
}

describe("WorkerMesh & LAN sovereignty", () => {
  it("allows private LAN/loopback hosts and refuses public IP addresses", () => {
    expect(isPrivateLanHost("192.168.1.50")).toBe(true);
    expect(isPrivateLanHost("10.0.0.8")).toBe(true);
    expect(isPrivateLanHost("100.88.12.4")).toBe(true); // Tailscale CGNAT private range in isPrivateIpv4
    expect(isPrivateLanHost("127.0.0.1")).toBe(true);
    expect(isPrivateLanHost("server.local")).toBe(true);
    expect(isPrivateLanHost("8.8.8.8")).toBe(false);
    expect(isPrivateLanHost("example.com")).toBe(false);

    const mesh = new WorkerMesh({ enabled: true, now: () => 100_000 });
    expect(() => mesh.register(sampleNode({ host: "8.8.8.8" }))).toThrow(/non-LAN/);
  });

  it("offloads work to idle LAN GPUs during gaming while enforcing fullMirrorTrusted privacy", () => {
    const mesh = new WorkerMesh({ enabled: true, now: () => 100_000 });
    mesh.register(sampleNode({ id: "untrusted", name: "gpu-worker", fullMirrorTrusted: false }));
    mesh.register(
      sampleNode({
        id: "battery-node",
        name: "laptop",
        host: "192.168.1.55",
        onBattery: true,
        fullMirrorTrusted: true,
      }),
    );

    // Non-sensitive background research during active workstation game -> offloaded to gpu-worker
    const offloaded = mesh.route(
      {
        kind: "research",
        latency: "background_mission",
        minVramMb: 6000,
        preferredModel: "standard",
      },
      { gpuBusyByGame: true, localFreeVramMb: 1200 },
    );
    expect(offloaded.target).toBe("lan-worker");
    if (offloaded.target === "lan-worker") {
      expect(offloaded.node.id).toBe("untrusted");
    }

    // Raw screen/notification/private payload cannot go to non-fullMirrorTrusted node
    const blockedSensitive = mesh.route(
      {
        kind: "llm_standard",
        latency: "background_mission",
        minVramMb: 6000,
        privacy: { containsScreenCapture: true },
      },
      { gpuBusyByGame: true, localFreeVramMb: 1200 },
    );
    expect(blockedSensitive.target).toBe("local-cpu-small");

    // Once node is explicitly fullMirrorTrusted, sensitive task may use it while workstation games
    mesh.register(sampleNode({ id: "trusted", name: "mirror-box", host: "192.168.1.41", fullMirrorTrusted: true }));
    const allowedSensitive = mesh.route(
      {
        kind: "llm_standard",
        latency: "background_mission",
        minVramMb: 6000,
        privacy: { containsNotifications: true },
      },
      { gpuBusyByGame: true, localFreeVramMb: 1200 },
    );
    expect(allowedSensitive.target).toBe("lan-worker");
    if (allowedSensitive.target === "lan-worker") {
      expect(allowedSensitive.node.id).toBe("trusted");
    }
  });

  it("stays default-off until enabled, parses probe output, and prunes stale heartbeats", async () => {
    let clock = 100_000;
    const mesh = new WorkerMesh({ now: () => clock, staleAfterMs: 30_000 });
    expect(mesh.enabled).toBe(false);

    const fleet = {
      run: vi.fn(async () => ({
        code: 0,
        timedOut: false,
        output: "12\n0.45 0.30 0.20 1/200 1234\n24576, 22100, 48\n",
      })),
    };
    const parsed = parseWorkerProbeOutput("12\n0.45 0.30 0.20 1/200\n24576, 22100, 48");
    expect(parsed.cpuCores).toBe(12);
    expect(parsed.accelerators[0]?.vramFreeMb).toBe(22_100);

    const node = await mesh.probeOverFleet(fleet, {
      id: "m1",
      name: "lab",
      host: "10.0.0.12",
      port: 22,
      user: "brandon",
      lookWithoutAsking: true,
    });
    expect(node?.accelerators[0]?.vramTotalMb).toBe(24_576);

    // Disabled by default -> never routes to LAN worker until enabled
    const whileDisabled = mesh.route(
      { kind: "eval", latency: "batch_maintenance", minVramMb: 4000 },
      { gpuBusyByGame: true, localFreeVramMb: 500 },
    );
    expect(whileDisabled.target).toBe("local-cpu-small");

    clock += 40_000;
    expect(mesh.pruneStale()).toBe(1);
    expect(mesh.nodes()).toHaveLength(0);
  });
});
