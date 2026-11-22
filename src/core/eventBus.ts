import { watch, type FSWatcher } from "node:fs";

/** Push event sources replacing interval polling in standingOrders/watch (Spec §4.2). */
export type PushEventSource = "inotify" | "ssh-journal" | "dbus" | "webhook" | "mqtt";

export interface PushEvent {
  source: PushEventSource;
  topic: string;
  payload: Record<string, unknown>;
  at: number;
  coalescedCount?: number;
}

export interface EventRule {
  id: string;
  source?: PushEventSource;
  /** Exact topic or prefix wildcard (`build/*`). Omit to match any topic for the source. */
  topicPattern?: string;
  debounceMs?: number;
  maxPerMinute?: number;
  handler(event: PushEvent): void;
}

function topicMatches(pattern: string | undefined, topic: string): boolean {
  if (!pattern || pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return pattern === topic;
}

/**
 * Push-driven local event bus with per-rule sliding-window debouncing and rate limiting so
 * burst filesystem, systemd journal, D-Bus, MQTT, or webhook events coalesce cleanly.
 */
export class LocalEventBus {
  private readonly now: () => number;
  private enabled: boolean;
  private readonly rules = new Map<
    string,
    {
      rule: EventRule;
      timer: NodeJS.Timeout | null;
      pending: PushEvent | null;
      hits: number[];
    }
  >();

  constructor(options?: { enabled?: boolean; now?: () => number }) {
    this.enabled = options?.enabled ?? false;
    this.now = options?.now ?? (() => Date.now());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      for (const state of this.rules.values()) {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.pending = null;
      }
    }
  }

  subscribe(rule: EventRule): () => void {
    this.unsubscribe(rule.id);
    this.rules.set(rule.id, { rule, timer: null, pending: null, hits: [] });
    return () => this.unsubscribe(rule.id);
  }

  unsubscribe(id: string): void {
    const state = this.rules.get(id);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.rules.delete(id);
  }

  emit(input: Omit<PushEvent, "at"> & { at?: number }): boolean {
    if (!this.enabled) return false;
    const at = input.at ?? this.now();
    const baseEvent: PushEvent = { ...input, at };
    let matchedAny = false;

    for (const state of this.rules.values()) {
      const { rule } = state;
      if (rule.source && rule.source !== baseEvent.source) continue;
      if (!topicMatches(rule.topicPattern, baseEvent.topic)) continue;
      matchedAny = true;

      const maxPerMin = rule.maxPerMinute ?? 60;
      const cutoff = at - 60_000;
      state.hits = state.hits.filter((t) => t > cutoff);
      if (state.hits.length >= maxPerMin) continue;

      const debounceMs = rule.debounceMs ?? 0;
      if (debounceMs <= 0) {
        state.hits.push(at);
        rule.handler({ ...baseEvent, coalescedCount: 1 });
        continue;
      }

      const prevCount = state.pending?.coalescedCount ?? 0;
      state.pending = { ...baseEvent, coalescedCount: prevCount + 1 };
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          const ready = state.pending;
          state.pending = null;
          if (!ready || !this.enabled) return;
          const fireAt = this.now();
          state.hits = state.hits.filter((t) => t > fireAt - 60_000);
          if (state.hits.length >= maxPerMin) return;
          state.hits.push(fireAt);
          rule.handler(ready);
        }, debounceMs);
        state.timer.unref?.();
      }
    }
    return matchedAny;
  }

  dispose(): void {
    for (const state of this.rules.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.rules.clear();
  }
}

/** Wraps Node `fs.watch` (inotify) into normalized `inotify` events on `LocalEventBus`. */
export class FsPushWatcher {
  private readonly watcher: FSWatcher;

  constructor(
    targetPath: string,
    bus: LocalEventBus,
    options?: { topicPrefix?: string; recursive?: boolean },
  ) {
    const prefix = options?.topicPrefix ?? "fs";
    this.watcher = watch(
      targetPath,
      { recursive: options?.recursive ?? false },
      (eventType, filename) => {
        bus.emit({
          source: "inotify",
          topic: `${prefix}/${eventType}`,
          payload: { path: targetPath, file: filename ?? "" },
        });
      },
    );
  }

  close(): void {
    this.watcher.close();
  }
}

/** Parses one `journalctl --output=json` line filtered by max syslog priority (`0..7`). */
export function parseJournalLine(
  line: string,
  host: string,
  maxPriority = 4,
): { unit: string; priority: number; message: string; host: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const priority = Number(obj["PRIORITY"] ?? 6);
    if (!Number.isFinite(priority) || priority > maxPriority) return null;
    const message = typeof obj["MESSAGE"] === "string" ? obj["MESSAGE"].trim() : "";
    if (!message) return null;
    const unit = String(obj["_SYSTEMD_UNIT"] ?? obj["SYSLOG_IDENTIFIER"] ?? "system");
    return { unit, priority, message: message.slice(0, 500), host };
  } catch {
    return null;
  }
}

/** Parses one `dbus-monitor --session` signal header line into interface & member. */
export function parseDbusSignalLine(
  line: string,
): { sender: string; path: string; iface: string; member: string } | null {
  if (!line.startsWith("signal ")) return null;
  const sender = /sender=([^\s;]+)/.exec(line)?.[1] ?? "";
  const path = /path=([^\s;]+)/.exec(line)?.[1] ?? "";
  const iface = /interface=([^\s;]+)/.exec(line)?.[1] ?? "";
  const member = /member=([^\s;]+)/.exec(line)?.[1] ?? "";
  if (!iface || !member) return null;
  return { sender, path, iface, member };
}

/**
 * Decodes an MQTT v3.1.1 PUBLISH packet (fixed header + variable remaining length + UTF-8
 * topic + optional packet id when QoS > 0 + UTF-8 payload). Zero external dependencies.
 */
export function parseMqttPublishPacket(
  packet: Buffer,
): { topic: string; payload: string; qos: number } | null {
  if (packet.length < 4) return null;
  const first = packet.readUInt8(0);
  const packetType = first >> 4;
  if (packetType !== 3) return null; // PUBLISH only
  const qos = (first >> 1) & 0x03;
  if (qos > 2) return null;

  let multiplier = 1;
  let remaining = 0;
  let offset = 1;
  let encoded: number;
  do {
    if (offset >= packet.length || offset > 4) return null;
    encoded = packet.readUInt8(offset);
    offset += 1;
    remaining += (encoded & 127) * multiplier;
    multiplier *= 128;
  } while ((encoded & 128) !== 0);

  if (offset + remaining > packet.length) return null;
  const end = offset + remaining;
  if (offset + 2 > end) return null;
  const topicLen = packet.readUInt16BE(offset);
  offset += 2;
  if (offset + topicLen > end) return null;
  const topic = packet.subarray(offset, offset + topicLen).toString("utf8");
  offset += topicLen;
  if (qos > 0) {
    if (offset + 2 > end) return null;
    offset += 2; // packet identifier
  }
  const payload = packet.subarray(offset, end).toString("utf8");
  if (!topic) return null;
  return { topic, payload, qos };
}
