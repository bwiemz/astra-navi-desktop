import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkBootstrapStatus, runBootstrapTask } from "../src/core/bootstrap.ts";
import { resolveNativeLinuxHandsBinary } from "../src/core/hands.ts";
import { OnnxVoice, resolveOnnxVoicePreset } from "../src/core/voice/onnxVoice.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix = "astranavi-nopy-"): Promise<string> {
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

describe("Pillar 7: Zero-Python runtime (ONNX voice, Rust linux-hands, Python-free bootstrap)", () => {
  it("synthesizes speech through OnnxVoice without spawning Python processes", async () => {
    expect(resolveOnnxVoicePreset("astra", "ja").kokoroVoice).toBe("jf_alpha");
    expect(resolveOnnxVoicePreset("bright", "en").speedMultiplier).toBeGreaterThan(1);

    const calls: { text: string; voice: string; speed?: number }[] = [];
    const voice = new OnnxVoice({
      cacheDir: "/tmp/speech",
      voice: "astra",
      speed: 1.0,
      loadEngine: async () => ({
        generate: async (text, opts) => {
          calls.push({ text, voice: opts.voice, speed: opts.speed });
          return { audio: new Float32Array([0.1, -0.2, 0.05]), sampling_rate: 24_000 };
        },
      }),
    });

    expect(voice.supports("en")).toBe(true);
    expect(voice.supports("ja")).toBe(true);
    await voice.warm();
    const out = await voice.synthesize("Ready for takeoff.", "en");
    expect(out.sampleRate).toBe(24_000);
    expect(out.samples.length).toBe(3);
    expect(calls[0]?.voice).toBe("af_heart");

    await voice.restIfIdle();
    await voice.dispose();
  });

  it("compiles/runs native Rust linux-hands binary over stdio JSON-RPC on Linux", async () => {
    const bin = resolveNativeLinuxHandsBinary(process.cwd());
    if (process.platform !== "linux" || !bin || !existsSync(bin)) {
      return;
    }

    const ping = await execFileAsync(bin, ["ping"], { encoding: "utf8" });
    expect(ping.stdout.trim()).toBe("pong");

    const ver = await execFileAsync(bin, ["version"], { encoding: "utf8" });
    expect(ver.stdout.trim()).toContain("linux-hands");

    const responses = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("error", reject);
      child.on("exit", () => {
        const lines = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        resolve(lines);
      });
      child.stdin.write(
        JSON.stringify({ id: 1, op: "hello", rehearse: true }) +
          "\n" +
          JSON.stringify({ id: 2, op: "pointer", x: 0.5, y: 0.5, rehearse: true }) +
          "\n" +
          JSON.stringify({ id: 3, op: "rest" }) +
          "\n",
      );
      child.stdin.end();
    });

    expect(responses).toHaveLength(3);
    expect(responses[0]?.["ok"]).toBe(true);
    expect(responses[0]?.["backend"]).toBe("linux-hands-native");
    expect(responses[1]?.["ok"]).toBe(true);
    expect(responses[2]?.["ok"]).toBe(true);
  });

  it("completes runBootstrapTask('all') with zero Python or uv calls", async () => {
    const dir = await makeTempDir();
    const runCommand = vi.fn(async () => ({ stdout: "ok", stderr: "" }));
    const fetchBytes = vi.fn(async (url: string) => Buffer.from(`onnx:${url}`));

    const opts = {
      platform: "linux" as const,
      home: join(dir, "home"),
      xdgDataHome: join(dir, "home", ".local", "share"),
      xdgConfigHome: join(dir, "home", ".config"),
      dataRoot: join(dir, "data"),
      modelsRoot: join(dir, "models"),
      appRoot: process.cwd(),
      fetchBytes,
      runCommand,
    };

    const res = await runBootstrapTask("all", opts);
    expect(res.ok).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();

    const status = await checkBootstrapStatus(opts);
    expect(status.voiceOnnx.ready).toBe(true);
    expect(status.ocr.ready).toBe(true);
    expect(status.launcher.ready).toBe(true);
    expect(status.browserBridge.ready).toBe(true);
  });
});
