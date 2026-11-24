import {
  evaluateHeavyJobPolicy,
  parsePoolHealth,
  parseSmartHealth,
  parseUpscOutput,
  type TelemetrySnapshot,
} from "../../src/core/telemetry.ts";
import { isPrivateLanHost } from "../../src/core/workerMesh.ts";

/**
 * Optional Homelab Ops Plugin (`defaultEnabled: false`).
 *
 * Parses Proxmox/ZFS pool health, SMART NVMe wear, and NUT UPS status locally or from
 * paired LAN machines without executing arbitrary shell strings, while requiring explicit
 * user approval for any container/service restart action.
 */

export interface HomelabOpsDeps {
  snapshotProvider?: (host: string) => Promise<TelemetrySnapshot>;
  restartHandler?: (host: string, unit: string) => Promise<{ restarted: boolean; message: string }>;
}

const SAFE_UNIT_RE = /^[a-zA-Z0-9_.@-]{1,64}$/;

export function createHomelabOpsPlugin(deps: HomelabOpsDeps = {}) {
  function assertLanTarget(rawHost: unknown): string {
    const host = typeof rawHost === "string" && rawHost.trim() ? rawHost.trim() : "127.0.0.1";
    if (!isPrivateLanHost(host)) {
      throw new Error(`Refused non-LAN homelab host "${host}".`);
    }
    return host;
  }

  return {
    id: "homelab-ops",
    async handleTool(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const bare = toolName.replace(/^plugin:/, "");
      switch (bare) {
        case "homelab.health_summary": {
          const host = assertLanTarget(args["host"]);
          const snap: TelemetrySnapshot = deps.snapshotProvider
            ? await deps.snapshotProvider(host)
            : {
                takenAt: Date.now(),
                gpu: { tempC: null, vramUsedMb: null, vramTotalMb: null, throttled: false },
                cpu: { throttled: false },
                storage: {
                  smartHealthy:
                    typeof args["smartOutput"] === "string"
                      ? parseSmartHealth(args["smartOutput"]).healthy
                      : true,
                  wearPercent:
                    typeof args["smartOutput"] === "string"
                      ? parseSmartHealth(args["smartOutput"]).wearPercent
                      : null,
                  poolHealth:
                    typeof args["zpoolOutput"] === "string"
                      ? parsePoolHealth(args["zpoolOutput"])
                      : "online",
                },
                power:
                  typeof args["upscOutput"] === "string"
                    ? parseUpscOutput(args["upscOutput"])
                    : { onUpsBattery: false, upsLoadPercent: 18, batteryRuntimeSec: 2400 },
                network: { gatewayRttMs: 2, packetLossPct: 0, lanPresenceOnline: true },
              };
          const policy = evaluateHeavyJobPolicy(snap);
          return {
            host,
            snapshot: snap,
            heavyJobAllowed: policy.allowed,
            deferReasons: policy.deferReasons,
            outsideText: true,
          };
        }
        case "homelab.smart_parse": {
          const smartOut = typeof args["smartOutput"] === "string" ? args["smartOutput"] : "";
          const zpoolOut = typeof args["zpoolOutput"] === "string" ? args["zpoolOutput"] : "";
          const upscOut = typeof args["upscOutput"] === "string" ? args["upscOutput"] : "";
          return {
            smart: parseSmartHealth(smartOut),
            poolHealth: parsePoolHealth(zpoolOut),
            ups: parseUpscOutput(upscOut),
            outsideText: true,
          };
        }
        case "homelab.service_restart": {
          const host = assertLanTarget(args["host"]);
          const unit = typeof args["unit"] === "string" ? args["unit"].trim() : "";
          if (!SAFE_UNIT_RE.test(unit)) {
            throw new Error(`Invalid service/container unit identifier "${unit}".`);
          }
          if (!deps.restartHandler) {
            return { ok: false, host, unit, message: "No live fleet runner configured (dry check)." };
          }
          const result = await deps.restartHandler(host, unit);
          return { ok: result.restarted, host, unit, message: result.message };
        }
        default:
          throw new Error(`Unknown plugin tool "${toolName}".`);
      }
    },
  };
}
