import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalEventBus,
  parseDbusSignalLine,
  parseJournalLine,
  parseMqttPublishPacket,
  type PushEvent,
} from "../src/core/eventBus.ts";

describe("LocalEventBus & push decoders", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("remains silent when disabled and coalesces burst events under debouncing", async () => {
    vi.useFakeTimers();
    let clock = 1000;
    const bus = new LocalEventBus({ now: () => clock });
    const received: PushEvent[] = [];

    bus.subscribe({
      id: "build-watch",
      source: "inotify",
      topicPattern: "fs/*",
      debounceMs: 150,
      maxPerMinute: 10,
      handler: (evt) => received.push(evt),
    });

    expect(bus.emit({ source: "inotify", topic: "fs/change", payload: { file: "a.o" } })).toBe(false);
    expect(received).toHaveLength(0);

    bus.setEnabled(true);
    bus.emit({ source: "inotify", topic: "fs/change", payload: { file: "a.o" } });
    clock += 20;
    bus.emit({ source: "inotify", topic: "fs/change", payload: { file: "b.o" } });
    clock += 20;
    bus.emit({ source: "inotify", topic: "fs/change", payload: { file: "c.o" } });

    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.coalescedCount).toBe(3);
    expect(received[0]?.payload["file"]).toBe("c.o");
    bus.dispose();
  });

  it("parses systemd journal lines, D-Bus signals, and MQTT v3.1.1 PUBLISH packets", () => {
    const warn = parseJournalLine(
      JSON.stringify({ _SYSTEMD_UNIT: "nginx.service", PRIORITY: "3", MESSAGE: "Worker exited" }),
      "proxmox",
      4,
    );
    expect(warn).toEqual({
      unit: "nginx.service",
      priority: 3,
      message: "Worker exited",
      host: "proxmox",
    });
    expect(
      parseJournalLine(JSON.stringify({ PRIORITY: "6", MESSAGE: "routine info" }), "proxmox", 4),
    ).toBeNull();

    const sig = parseDbusSignalLine(
      "signal time=1700.1 sender=:1.42 -> destination=(null destination) serial=55 path=/org/freedesktop/UPower; interface=org.freedesktop.UPower; member=DeviceChanged",
    );
    expect(sig?.iface).toBe("org.freedesktop.UPower");
    expect(sig?.member).toBe("DeviceChanged");

    // MQTT QoS 0 PUBLISH packet: topic="ups/status", payload="OB"
    const topic = Buffer.from("ups/status", "utf8");
    const payload = Buffer.from("OB", "utf8");
    const remLen = 2 + topic.length + payload.length;
    const pkt = Buffer.alloc(2 + remLen);
    pkt.writeUInt8(0x30, 0); // PUBLISH QoS 0
    pkt.writeUInt8(remLen, 1);
    pkt.writeUInt16BE(topic.length, 2);
    topic.copy(pkt, 4);
    payload.copy(pkt, 4 + topic.length);

    expect(parseMqttPublishPacket(pkt)).toEqual({ topic: "ups/status", payload: "OB", qos: 0 });
    expect(parseMqttPublishPacket(Buffer.from([0x30, 0x05, 0x00]))).toBeNull();
  });
});
