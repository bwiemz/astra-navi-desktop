import { LocalEventBus, parseMqttPublishPacket } from "../../src/core/eventBus.ts";
import { isPrivateLanHost } from "../../src/core/workerMesh.ts";

/**
 * Optional Home Assistant & LAN MQTT Bridge Plugin (`defaultEnabled: false`).
 *
 * Connects exclusively to private LAN Home Assistant / MQTT hosts (`isPrivateLanHost`),
 * parses incoming MQTT v3.1.1 PUBLISH payloads into normalized `LocalEventBus` events,
 * and gates physical device service calls behind approval & hands-off checks.
 */

export interface HaEntityState {
  entityId: string;
  state: string;
  lastChanged: string;
}

export interface HomeAssistantPluginDeps {
  brokerHost?: string;
  bus?: LocalEventBus;
  initialEntities?: readonly HaEntityState[];
  onCallService?: (domain: string, service: string, entityId: string) => Promise<{ ok: boolean }>;
}

const DOMAIN_SERVICE_RE = /^[a-z0-9_]{1,32}\.[a-z0-9_]{1,40}$/;
const ENTITY_ID_RE = /^[a-z0-9_]{1,32}\.[a-z0-9_.-]{1,64}$/;

export function createHomeAssistantMqttPlugin(deps: HomeAssistantPluginDeps = {}) {
  const defaultHost = deps.brokerHost ?? "192.168.50.10";
  if (!isPrivateLanHost(defaultHost)) {
    throw new Error(`Refused non-LAN Home Assistant host "${defaultHost}".`);
  }

  const bus = deps.bus ?? new LocalEventBus({ enabled: true });
  const entities = new Map<string, HaEntityState>();
  for (const e of deps.initialEntities ?? []) {
    entities.set(e.entityId, { ...e });
  }

  return {
    id: "home-assistant-mqtt",
    bus,
    ingestMqttPacket(packet: Buffer, host = defaultHost): boolean {
      if (!isPrivateLanHost(host)) {
        throw new Error(`Refused MQTT packet from non-LAN host "${host}".`);
      }
      const parsed = parseMqttPublishPacket(packet);
      if (!parsed) return false;
      entities.set(parsed.topic.replace(/\//g, "."), {
        entityId: parsed.topic,
        state: parsed.payload.slice(0, 120),
        lastChanged: new Date().toISOString(),
      });
      return bus.emit({
        source: "mqtt",
        topic: parsed.topic,
        payload: { raw: parsed.payload.slice(0, 240), qos: parsed.qos, host },
      });
    },
    async handleTool(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const bare = toolName.replace(/^plugin:/, "");
      const host = typeof args["host"] === "string" && args["host"].trim() ? args["host"].trim() : defaultHost;
      if (!isPrivateLanHost(host)) {
        throw new Error(`Refused non-LAN Home Assistant host "${host}".`);
      }
      switch (bare) {
        case "ha.list_entities": {
          const domain = typeof args["domain"] === "string" ? args["domain"].trim() : "";
          const list = [...entities.values()].filter((e) => !domain || e.entityId.startsWith(`${domain}.`));
          return { host, count: list.length, entities: list, outsideText: true };
        }
        case "ha.sensor_state": {
          const entityId = typeof args["entityId"] === "string" ? args["entityId"].trim() : "";
          if (!ENTITY_ID_RE.test(entityId)) {
            throw new Error(`Invalid Home Assistant entityId "${entityId}".`);
          }
          const found = entities.get(entityId) ?? null;
          return { host, entityId, found, outsideText: true };
        }
        case "ha.call_service": {
          const targetService = typeof args["service"] === "string" ? args["service"].trim() : "";
          const entityId = typeof args["entityId"] === "string" ? args["entityId"].trim() : "";
          if (!DOMAIN_SERVICE_RE.test(targetService)) {
            throw new Error(`Invalid HA service "${targetService}" (expected domain.service).`);
          }
          if (!ENTITY_ID_RE.test(entityId)) {
            throw new Error(`Invalid Home Assistant entityId "${entityId}".`);
          }
          const parts = targetService.split(".");
          const domain = parts[0] ?? "";
          const service = parts[1] ?? "";
          const res = deps.onCallService
            ? await deps.onCallService(domain, service, entityId)
            : { ok: true };
          return { ok: res.ok, host, domain, service, entityId };
        }
        default:
          throw new Error(`Unknown plugin tool "${toolName}".`);
      }
    },
  };
}
