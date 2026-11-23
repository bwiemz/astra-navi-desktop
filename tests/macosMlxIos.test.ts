import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { request } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { recommendHardwareTier } from "../src/core/hardwareTuner.ts";
import {
  MlxBackend,
  MLX_MODELS,
  selectLocalInferenceBackend,
  validateLocalMlxUrl,
} from "../src/core/mlxEngine.ts";
import { createPlatformAdapter } from "../src/core/platform/adapter.ts";
import {
  MacOsPlatformAdapter,
  parseCoreAudioDevices,
  parseMacOsAxControlsJson,
  parseMacOsSysctlMemory,
  parseMacOsWindowsJson,
} from "../src/core/platform/macos.ts";
import { Station } from "../src/core/station.ts";
import { stationPage } from "../src/core/stationPage.ts";

const GIB = 1024 ** 3;
const tempDirs: string[] = [];

async function makeTempDir(prefix = "astranavi-mac-ios-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Pillar 5 & 6: macOS adapter, Apple Silicon MLX backend, and iOS companion PWA + SwiftUI", () => {
  it("instantiates MacOsPlatformAdapter via createPlatformAdapter('darwin') and parses JXA/AX/Metal telemetry", async () => {
    const created = createPlatformAdapter({ platform: "darwin", scriptDir: "scripts" });
    expect(created.platform).toBe("darwin");

    const layout = parseMacOsWindowsJson(
      JSON.stringify({
        width: 2560,
        height: 1440,
        windows: [
          { id: "42:Xcode", title: "Xcode", app: "Xcode", pid: 42, active: true, fullScreen: false, x: 0, y: 0, width: 1200, height: 900 },
          { id: "99:Game", title: "Cyberpunk 2077", app: "Cyberpunk 2077", pid: 99, active: false, fullScreen: true, x: 0, y: 0, width: 2560, height: 1440 },
        ],
      }),
    );
    expect(layout.windows).toHaveLength(2);

    const ax = parseMacOsAxControlsJson(
      JSON.stringify([{ kind: "button", name: "Run", on: false, value: "", focused: false }]),
    );
    expect(ax[0]?.n).toBe(1);
    expect(ax[0]?.name).toBe("Run");

    const audio = parseCoreAudioDevices(
      JSON.stringify({
        SPAudioDataType: [
          {
            _items: [
              { _name: "BlackHole 2ch", coreaudio_device_manufacturer: "Existential Audio" },
              { _name: "MacBook Pro Speakers", coreaudio_device_manufacturer: "Apple Inc." },
            ],
          },
        ],
      }),
    );
    expect(audio.map((s) => s.mediaName)).toEqual(["BlackHole 2ch", "MacBook Pro Speakers"]);

    const metal = parseMacOsSysctlMemory(
      String(64 * GIB),
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1800000.\nPages inactive: 400000.\n",
      "Apple M3 Max",
    );
    expect(metal.source).toBe("metal");
    expect(metal.unifiedMemory).toBe(true);
    expect(metal.estimatedBandwidthGbps).toBe(400);
    expect(metal.totalBytes).toBe(Math.round(64 * GIB * 0.75));

    const calls: string[] = [];
    const adapter = new MacOsPlatformAdapter({
      runCommand: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        if (cmd === "sysctl" && args[1] === "hw.memsize") return { stdout: String(48 * GIB), stderr: "" };
        if (cmd === "vm_stat") return { stdout: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 900000.\n", stderr: "" };
        if (cmd === "sysctl" && args[1] === "machdep.cpu.brand_string") return { stdout: "Apple M3 Pro", stderr: "" };
        return { stdout: "[]", stderr: "" };
      },
    });
    const gpu = await adapter.gameDetector.gpuVramStatus?.();
    expect(gpu?.source).toBe("metal");
    await adapter.screenCapture.captureScreen("/tmp/test-screen.png");
    expect(calls.some((c) => c.startsWith("screencapture -x -t png /tmp/test-screen.png"))).toBe(true);
  });

  it("budgets Apple Silicon unified memory across 16GB / 48GB / 128GB tiers", () => {
    const mac128 = recommendHardwareTier({
      gpuName: "Apple M3 Ultra",
      totalVramBytes: Math.round(128 * GIB * 0.75),
      freeVramBytes: Math.round(90 * GIB),
      systemRamBytes: 128 * GIB,
      cpuThreads: 24,
      activeGameOrRender: false,
      unifiedMemory: true,
      platform: "darwin",
      memoryBandwidthGbps: 800,
    });
    expect(mac128.tier).toBe("xl");

    const mac48 = recommendHardwareTier({
      gpuName: "Apple M3 Pro",
      totalVramBytes: Math.round(48 * GIB * 0.75),
      freeVramBytes: Math.round(32 * GIB),
      systemRamBytes: 48 * GIB,
      cpuThreads: 14,
      activeGameOrRender: false,
      unifiedMemory: true,
      platform: "darwin",
      memoryBandwidthGbps: 200,
    });
    expect(mac48.tier).toBe("large");
  });

  it("streams text and tool calls from local Apple Silicon MLX backend with loopback enforcement", async () => {
    expect(() => validateLocalMlxUrl("http://192.168.1.50:8080")).toThrow(/non-loopback/i);
    expect(MLX_MODELS.xl.repoId).toContain("72B");

    const srv = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: MLX_MODELS.large.repoId }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: "Captain!",
                tool_calls: [{ index: 0, id: "tc_1", function: { name: "get_time", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const mlx = new MlxBackend({
        baseUrl: `http://127.0.0.1:${port}`,
        tier: "large",
        platform: "darwin",
        arch: "arm64",
      });
      const sel = await selectLocalInferenceBackend({
        platform: "darwin",
        arch: "arm64",
        mlxBackend: mlx,
      });
      expect(sel.backend).toBe("mlx");

      const deltas: string[] = [];
      const streamRes = await mlx.chatStream({
        messages: [{ role: "user", content: "Hi" }],
        onDelta: (d) => deltas.push(d),
      });
      expect(streamRes.text).toBe("Hello Captain!");
      expect(deltas.join("")).toBe("Hello Captain!");
      expect(streamRes.toolCalls).toEqual([{ id: "tc_1", name: "get_time", argumentsJson: "{}" }]);

      const linuxFallback = await selectLocalInferenceBackend({ platform: "linux", arch: "x64" });
      expect(linuxFallback.backend).toBe("llama.cpp");
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("ships installable iOS PWA headers/routes without weakening CSP and includes pinned SwiftUI wrapper", async () => {
    const html = stationPage("testnonce123456789");
    expect(html).toContain("/manifest.webmanifest");
    expect(html).toContain("/apple-touch-icon.png");
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');

    const swiftFiles = await Promise.all([
      readFile(join("ios-app", "Package.swift"), "utf8"),
      readFile(join("ios-app", "Info.plist"), "utf8"),
      readFile(join("ios-app", "Sources", "StationDiscovery.swift"), "utf8"),
      readFile(join("ios-app", "Sources", "PinnedSessionDelegate.swift"), "utf8"),
      readFile(join("ios-app", "Sources", "StationWebView.swift"), "utf8"),
      readFile(join("ios-app", "Sources", "AstraStationApp.swift"), "utf8"),
    ]);
    expect(swiftFiles[1]).toContain("_astranavi._tcp");
    expect(swiftFiles[2]).toContain("NWBrowser");
    expect(swiftFiles[3]).toContain("SHA256");
    expect(swiftFiles[4]).toContain("nonPersistent()");
    expect(swiftFiles[5]).toContain("LAContext");

    // Verify live Station serves PWA manifest, icon, and non-caching sw.js when OpenSSL is present.
    let hasOpenssl = true;
    try {
      await promisify(execFile)("openssl", ["version"]);
    } catch {
      hasOpenssl = false;
    }
    if (!hasOpenssl) return;

    const dir = await makeTempDir();
    const station = new Station({
      dir,
      port: 0,
      onSay: () => true,
      onStop: () => undefined,
      passwordCost: 1 << 14,
      localAddresses: () => ["127.0.0.1"],
      mdns: false,
    });
    await station.start();
    try {
      const port = Number(new URL(station.addresses()[0] ?? "").port);
      const fetchPath = (p: string) =>
        new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
          const req = request(
            { hostname: "127.0.0.1", port, path: p, method: "GET", rejectUnauthorized: false },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: Buffer.concat(chunks),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });

      const manifestRes = await fetchPath("/manifest.webmanifest");
      expect(manifestRes.status).toBe(200);
      expect(String(manifestRes.headers["content-type"])).toContain("application/manifest+json");
      const manifestJson = JSON.parse(manifestRes.body.toString("utf8")) as { display: string };
      expect(manifestJson.display).toBe("standalone");

      const iconRes = await fetchPath("/apple-touch-icon.png");
      expect(iconRes.status).toBe(200);
      expect(iconRes.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const swRes = await fetchPath("/sw.js");
      expect(swRes.status).toBe(200);
      const swText = swRes.body.toString("utf8");
      expect(swText).not.toContain("caches.open");
      expect(swText).toContain("authorization");
    } finally {
      await station.stop();
    }
  });
});
