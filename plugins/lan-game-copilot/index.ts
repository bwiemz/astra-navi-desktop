import { isPrivateLanHost } from "../../src/core/workerMesh.ts";

/**
 * Optional LAN Co-op & Game Telemetry Copilot Plugin (`defaultEnabled: false`).
 *
 * Reads local/LAN game telemetry snapshots (Minecraft RCON status, Factorio metrics,
 * OBS scene state, match timers) strictly from loopback or RFC1918 LAN hosts, marking
 * external game text/logs `outsideText: true` so prompt-injection escalations apply.
 */

export interface LanGameTelemetrySnapshot {
  game: string;
  host: string;
  playersOnline: number;
  tickRateHz: number;
  statusLine: string;
}

export interface LanGameCopilotDeps {
  allowedHosts?: readonly string[];
  fetchTelemetry?: (host: string, game: string) => Promise<LanGameTelemetrySnapshot>;
}

export function createLanGameCopilotPlugin(deps: LanGameCopilotDeps = {}) {
  const timers = new Map<string, { label: string; startedAt: number; durationSec: number }>();
  const notes: string[] = [];

  function assertLanHost(host: string): string {
    const clean = host.trim() || "127.0.0.1";
    if (!isPrivateLanHost(clean)) {
      throw new Error(`Refused non-LAN game telemetry host "${clean}". Only loopback or private LAN hosts are allowed.`);
    }
    if (deps.allowedHosts && deps.allowedHosts.length > 0 && !deps.allowedHosts.includes(clean)) {
      throw new Error(`Game host "${clean}" is not in the approved LAN host list.`);
    }
    return clean;
  }

  return {
    id: "lan-game-copilot",
    async handleTool(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const bare = toolName.replace(/^plugin:/, "");
      switch (bare) {
        case "game.telemetry_snapshot": {
          const host = assertLanHost(typeof args["host"] === "string" ? args["host"] : "127.0.0.1");
          const game = typeof args["game"] === "string" && args["game"].trim() ? args["game"].trim() : "local-game";
          const snap = deps.fetchTelemetry
            ? await deps.fetchTelemetry(host, game)
            : {
                game,
                host,
                playersOnline: 0,
                tickRateHz: 20,
                statusLine: "standby",
              };
          return { ...snap, outsideText: true };
        }
        case "game.match_timer": {
          const label = typeof args["label"] === "string" ? args["label"].trim() : "objective";
          const action = typeof args["action"] === "string" ? args["action"].trim() : "read";
          if (action === "start") {
            const secRaw = typeof args["durationSec"] === "number" ? args["durationSec"] : 180;
            const durationSec = Math.max(5, Math.min(86_400, Math.round(secRaw)));
            const startedAt = Date.now();
            timers.set(label, { label, startedAt, durationSec });
            return { label, durationSec, remainingSec: durationSec, status: "running" };
          }
          const entry = timers.get(label);
          if (!entry) return { label, status: "idle", remainingSec: 0 };
          const elapsed = (Date.now() - entry.startedAt) / 1000;
          const remainingSec = Math.max(0, Math.round(entry.durationSec - elapsed));
          return {
            label: entry.label,
            durationSec: entry.durationSec,
            remainingSec,
            status: remainingSec > 0 ? "running" : "expired",
          };
        }
        case "game.overlay_note": {
          const text = typeof args["text"] === "string" ? args["text"].replace(/\s+/g, " ").trim().slice(0, 160) : "";
          if (!text) throw new Error("game.overlay_note requires non-empty `text`.");
          notes.push(text);
          if (notes.length > 10) notes.shift();
          return { ok: true, count: notes.length, latest: text };
        }
        default:
          throw new Error(`Unknown plugin tool "${toolName}".`);
      }
    },
  };
}
