import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCreativePipelinePlugin } from "../plugins/creative-pipeline/index.ts";
import { createHomeAssistantMqttPlugin } from "../plugins/home-assistant-mqtt/index.ts";
import { createHomelabOpsPlugin } from "../plugins/homelab-ops/index.ts";
import { createLanGameCopilotPlugin } from "../plugins/lan-game-copilot/index.ts";
import { PluginManifestSchema, runPluginBundledEvals } from "../src/core/pluginSdk.ts";

const PLUGIN_IDS = [
  "lan-game-copilot",
  "homelab-ops",
  "home-assistant-mqtt",
  "creative-pipeline",
] as const;

describe("Post-v1 Signed Opt-In Plugin Ecosystem Pack (Track 4)", () => {
  it.each(PLUGIN_IDS)(
    "validates manifest.json == plugin.json, exact SHA-256 of index.ts, and 5/5 evals for %s",
    async (id) => {
      const dir = join(process.cwd(), "plugins", id);
      const manifestRaw = readFileSync(join(dir, "manifest.json"), "utf8");
      const pluginJsonRaw = readFileSync(join(dir, "plugin.json"), "utf8");
      expect(pluginJsonRaw).toBe(manifestRaw);

      const manifest = PluginManifestSchema.parse(JSON.parse(manifestRaw));
      expect(manifest.defaultEnabled).toBe(false);

      const indexBytes = readFileSync(join(dir, manifest.entry));
      const actualSha = createHash("sha256").update(indexBytes).digest("hex");
      expect(manifest.sha256).toBe(actualSha);

      const evalRes = await runPluginBundledEvals(manifest, {
        workspace: process.cwd(),
        home: "/home/tester",
      });
      expect(evalRes.ok).toBe(true);
      expect(evalRes.passed).toBe(evalRes.total);
    },
  );

  it("enforces LAN-host, sensitive-path, and MQTT/telemetry handlers across all 4 plugins", async () => {
    // 1. lan-game-copilot
    const game = createLanGameCopilotPlugin();
    await expect(
      game.handleTool("plugin:game.telemetry_snapshot", { host: "8.8.8.8" }),
    ).rejects.toThrow(/non-LAN/i);
    const snap = await game.handleTool("plugin:game.telemetry_snapshot", {
      host: "127.0.0.1",
      game: "factorio",
    });
    expect(snap["outsideText"]).toBe(true);

    // 2. homelab-ops
    const homelab = createHomelabOpsPlugin();
    const parsed = await homelab.handleTool("plugin:homelab.smart_parse", {
      zpoolOutput: "all pools are healthy",
      smartOutput: "SMART overall-health self-assessment test result: PASSED\nPercentage Used: 4%",
      upscOutput: "ups.status: OL\nups.load: 22\nbattery.runtime: 1800",
    });
    expect(parsed["poolHealth"]).toBe("online");
    expect((parsed["smart"] as { healthy: boolean }).healthy).toBe(true);

    // 3. home-assistant-mqtt
    const ha = createHomeAssistantMqttPlugin({ brokerHost: "192.168.50.10" });
    const received: unknown[] = [];
    ha.bus.subscribe({
      id: "test-ha",
      source: "mqtt",
      topicPattern: "home/*",
      handler: (ev) => received.push(ev),
    });
    const topic = Buffer.from("home/studio/temp", "utf8");
    const payload = Buffer.from("22.4", "utf8");
    const remLen = 2 + topic.length + payload.length;
    const pkt = Buffer.concat([
      Buffer.from([0x30, remLen, 0x00, topic.length]),
      topic,
      payload,
    ]);
    expect(ha.ingestMqttPacket(pkt, "192.168.50.10")).toBe(true);
    expect(received).toHaveLength(1);
    const list = await ha.handleTool("plugin:ha.list_entities", {});
    expect(list["count"]).toBe(1);
    expect(() => ha.ingestMqttPacket(pkt, "1.1.1.1")).toThrow(/non-LAN/);

    // 4. creative-pipeline
    const tempDir = mkdtempSync(join(tmpdir(), "astra-creative-"));
    try {
      const creative = createCreativePipelinePlugin({ approvedRenderRoots: [tempDir] });
      const badPath = await creative.handleTool("plugin:creative.validate_output_path", {
        outputDir: "/home/user/.ssh/renders",
      });
      expect(badPath["ok"]).toBe(false);

      const queued = await creative.handleTool("plugin:creative.queue_render", {
        jobId: "shot01",
        tool: "blender",
        outputDir: join(tempDir, "shot01"),
        totalFrames: 120,
      });
      expect(queued["ok"]).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
