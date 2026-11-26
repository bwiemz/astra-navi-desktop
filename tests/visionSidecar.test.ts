import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRAIN_MODELS,
  listCatalogDownloadAssets,
  MOE_WORKSTATION_MODELS,
  resolveVisionMmproj,
  resolveVisionSidecarPair,
  VISION_SIDECAR_MODELS,
} from "../src/core/models.ts";
import { checkCatalogSizes } from "../scripts/check-model-sizes.ts";
import { Sight } from "../src/core/sight.ts";
import {
  buildVisionMessages,
  LlamaVisionSidecar,
  sanitizeVisionOutput,
  validateLoopbackVisionUrl,
  type VisionDescribeOptions,
  type VisionDescriber,
} from "../src/core/visionSidecar.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeTestPng(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 24, g: 36, b: 64, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("models.ts vision mmproj resolution", () => {
  it("gives every built-in Qwen brain tier and MoE workstation entry a unique model-scoped mmproj asset", () => {
    const fileNames = new Set<string>();
    const allModels = [
      BRAIN_MODELS.small,
      BRAIN_MODELS.standard,
      BRAIN_MODELS.large,
      BRAIN_MODELS.xl,
      MOE_WORKSTATION_MODELS.largeMoe,
      MOE_WORKSTATION_MODELS.xlMoe,
    ];
    for (const model of allModels) {
      expect(model.mmproj).toBeDefined();
      expect(model.mmproj?.url).toMatch(/^https:\/\/huggingface\.co\/unsloth\/Qwen3\.(5|8)-/);
      expect(model.mmproj?.sizeBytes).toBeGreaterThan(500_000_000);
      expect(model.mmproj?.fileName).toMatch(/mmproj-F16\.gguf$/);
      if (model.mmproj) fileNames.add(model.mmproj.fileName);
    }
    // Distinct base models (4B, 9B, 27B, 35B-A3B, 122B-A10B) must never collide on disk.
    expect(fileNames.size).toBe(5);
  });

  it("detects downloaded built-in mmproj and sibling custom mmproj files", async () => {
    const dir = await makeTempDir("astra-mmproj-");
    const stdBefore = resolveVisionMmproj("standard", dir, null);
    expect(stdBefore.downloaded).toBe(false);
    expect(stdBefore.mmprojPath).toBe(join(dir, "Qwen3.5-9B-mmproj-F16.gguf"));

    await writeFile(join(dir, "Qwen3.5-9B-mmproj-F16.gguf"), "stub");
    const stdAfter = resolveVisionMmproj("standard", dir, null);
    expect(stdAfter.downloaded).toBe(true);

    const customGguf = join(dir, "custom-vl.gguf");
    const customMmproj = join(dir, "custom-mmproj-f16.gguf");
    await writeFile(customGguf, "stub");
    await writeFile(customMmproj, "stub");
    const custom = resolveVisionMmproj(customGguf, dir, null);
    expect(custom.downloaded).toBe(true);
    expect(custom.mmprojPath).toBe(customMmproj);

    // A text-only custom model sitting next to an unrelated Qwen mmproj MUST NOT pair with it!
    const textOnlyGguf = join(dir, "Llama-3-8B-Instruct.gguf");
    await writeFile(join(dir, "Qwen3.5-4B-mmproj-F16.gguf"), "stub");
    await writeFile(textOnlyGguf, "stub");
    const textOnly = resolveVisionMmproj(textOnlyGguf, dir, null);
    expect(textOnly.downloaded).toBe(false);
    expect(textOnly.mmprojPath).toBeNull();
  });

  it("prefers a dedicated compact Qwen3.5-0.8B/2B vision pair over loading a second full brain copy", async () => {
    const dir = await makeTempDir("astra-vis-ded-");
    // Uninstalled: recommends 0.8B on 8 GB VRAM and 2B on 16 GB VRAM.
    const rec8 = resolveVisionSidecarPair("standard", dir, 8 * 1024 ** 3);
    expect(rec8.source).toBe("dedicated");
    expect(rec8.ready).toBe(false);
    expect(rec8.modelPath).toBe(join(dir, VISION_SIDECAR_MODELS.compact.modelFileName));

    const rec16 = resolveVisionSidecarPair("standard", dir, 16 * 1024 ** 3);
    expect(rec16.source).toBe("dedicated");
    expect(rec16.modelPath).toBe(join(dir, VISION_SIDECAR_MODELS.standard.modelFileName));

    // When both a 9B brain + mmproj AND dedicated 0.8B vision pair exist, dedicated 0.8B wins!
    await writeFile(join(dir, "Qwen3.5-9B-Q4_K_M.gguf"), "brain");
    await writeFile(join(dir, "Qwen3.5-9B-mmproj-F16.gguf"), "brain-mmproj");
    await writeFile(join(dir, VISION_SIDECAR_MODELS.compact.modelFileName), "small-vl");
    await writeFile(join(dir, VISION_SIDECAR_MODELS.compact.mmproj.fileName), "small-mmproj");
    const chosen = resolveVisionSidecarPair("standard", dir, 8 * 1024 ** 3);
    expect(chosen.source).toBe("dedicated");
    expect(chosen.ready).toBe(true);
    expect(chosen.modelPath).toBe(join(dir, VISION_SIDECAR_MODELS.compact.modelFileName));
  });
});

describe("validateLoopbackVisionUrl", () => {
  it("allows http loopback endpoints only", () => {
    expect(validateLoopbackVisionUrl("http://127.0.0.1:8081").ok).toBe(true);
    expect(validateLoopbackVisionUrl("http://localhost:8080/v1").ok).toBe(true);
    expect(validateLoopbackVisionUrl("http://[::1]:8082").ok).toBe(true);
  });

  it("rejects remote hosts, LAN IPs, https, and embedded credentials", () => {
    expect(validateLoopbackVisionUrl("http://192.168.1.20:8081").ok).toBe(false);
    expect(validateLoopbackVisionUrl("http://api.openai.com/v1").ok).toBe(false);
    expect(validateLoopbackVisionUrl("https://127.0.0.1:8081").ok).toBe(false);
    expect(validateLoopbackVisionUrl("http://user:pass@127.0.0.1:8081").ok).toBe(false);
    expect(validateLoopbackVisionUrl("").ok).toBe(false);
  });
});

describe("vision prompts & output sanitization", () => {
  it("builds Set-of-Mark aware messages with anti-injection instructions", () => {
    const messages = buildVisionMessages("BASE64PNG", {
      mode: "som",
      windowTitle: "Settings - Firefox",
      question: "Which numbered button saves changes?",
      marksHint: "[1] Save (button)\n[2] Cancel (button)",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(String(messages[0]?.content)).toMatch(/untrusted/i);
    const userContent = messages[1]?.content;
    expect(Array.isArray(userContent)).toBe(true);
    if (Array.isArray(userContent)) {
      const textPart = userContent.find((part) => part.type === "text");
      const imagePart = userContent.find((part) => part.type === "image_url");
      expect(textPart && "text" in textPart ? textPart.text : "").toContain("[1] Save");
      expect(textPart && "text" in textPart ? textPart.text : "").toContain(
        "Which numbered button saves changes?",
      );
      expect(imagePart && "image_url" in imagePart ? imagePart.image_url?.url : "").toBe(
        "data:image/png;base64,BASE64PNG",
      );
    }
  });

  it("strips mood tags, BiDi overrides, and control characters from vision output", () => {
    const raw = "  [[excited]] Error dialog\u202E says \u0007Port 8080 in use  ";
    const cleaned = sanitizeVisionOutput(raw);
    expect(cleaned).not.toContain("[[");
    expect(cleaned).not.toContain("\u202E");
    expect(cleaned).not.toContain("\u0007");
    expect(cleaned).toContain("Error dialog");
    expect(cleaned).toContain("Port 8080 in use");
  });
});

describe("LlamaVisionSidecar loopback endpoint & managed process", () => {
  it("sends resized PNG data URLs to a configured loopback endpoint and sanitizes the response", async () => {
    let seenPath = "";
    let seenImageUrl = "";
    let seenPromptText = "";
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seenPath = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: { role: string; content: unknown }[];
        };
        const userMsg = body.messages.find((m) => m.role === "user");
        if (userMsg && Array.isArray(userMsg.content)) {
          for (const part of userMsg.content as { type: string; text?: string; image_url?: { url: string } }[]) {
            if (part.type === "text" && part.text) seenPromptText = part.text;
            if (part.type === "image_url" && part.image_url) seenImageUrl = part.image_url.url;
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "[[happy]] Red error banner at top; click [3] Retry button.",
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const modelsDir = await makeTempDir("astra-vis-ep-");
      const sidecar = new LlamaVisionSidecar({
        modelsDir,
        brainChoice: () => "standard",
        endpoint: () => `http://127.0.0.1:${port}`,
      });
      const st = sidecar.status();
      expect(st.available).toBe(true);
      expect(st.mode).toBe("loopback-endpoint");

      const bigPng = await makeTestPng(1800, 900);
      const reply = await sidecar.describeImage(bigPng, {
        mode: "som",
        question: "What is wrong on this screen?",
        marksHint: "[3] Retry (button)",
      });

      expect(seenPath).toBe("/v1/chat/completions");
      expect(seenPromptText).toContain("What is wrong on this screen?");
      expect(seenPromptText).toContain("[3] Retry");
      expect(seenImageUrl.startsWith("data:image/png;base64,")).toBe(true);
      // Confirm sharp resized the 1800px image down to <= 1280px wide.
      const sentBuf = Buffer.from(seenImageUrl.slice("data:image/png;base64,".length), "base64");
      const sentMeta = await sharp(sentBuf).metadata();
      expect(sentMeta.width).toBeLessThanOrEqual(1280);

      expect(reply).toContain("Red error banner at top; click [3] Retry button.");
      expect(reply).not.toContain("[[happy]]");
      await sidecar.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("spawns a managed loopback llama-server stub with random bearer auth, respects gpuBusy (-ngl 0), and disposes cleanly", async () => {
    const dir = await makeTempDir("astra-vis-spawn-");
    const modelPath = join(dir, "Qwen3.5-9B-Q4_K_M.gguf");
    const mmprojPath = join(dir, "Qwen3.5-9B-mmproj-F16.gguf");
    const argsLog = join(dir, "spawn-args.json");
    const stubBin = join(dir, "llama-server");

    await writeFile(modelPath, "fake-gguf");
    await writeFile(mmprojPath, "fake-mmproj");

    const script = [
      `#!${process.execPath}`,
      `import { createServer } from "node:http";`,
      `import { writeFileSync } from "node:fs";`,
      `const args = process.argv.slice(2);`,
      `const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };`,
      `writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));`,
      `const host = arg("--host") || "127.0.0.1";`,
      `const port = Number(arg("--port") || 0);`,
      `const apiKey = arg("--api-key") || "";`,
      `const server = createServer((req, res) => {`,
      `  const auth = req.headers.authorization || "";`,
      `  if (apiKey && auth !== "Bearer " + apiKey) { res.writeHead(401); res.end("unauthorized"); return; }`,
      `  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }`,
      `  if (req.url === "/v1/chat/completions") {`,
      `    req.resume();`,
      `    req.on("end", () => {`,
      `      res.writeHead(200, { "content-type": "application/json" });`,
      `      res.end(JSON.stringify({ choices: [{ message: { content: "Managed sidecar sees dialog [1] OK." } }] }));`,
      `    });`,
      `    return;`,
      `  }`,
      `  res.writeHead(404); res.end();`,
      `});`,
      `server.listen(port, host);`,
      `process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
    ].join("\n");
    await writeFile(stubBin, script, "utf8");
    await chmod(stubBin, 0o755);

    const sidecar = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => stubBin,
      gpuBusy: () => true,
      startupTimeoutMs: 10_000,
      idleUnloadMs: 0,
    });

    const before = sidecar.status();
    expect(before.available).toBe(true);
    expect(before.mode).toBe("managed-sidecar");
    expect(before.running).toBe(false);

    const png = await makeTestPng(120, 80);
    const out = await sidecar.describeImage(png, { mode: "screen" });
    expect(out).toBe("Managed sidecar sees dialog [1] OK.");
    expect(sidecar.status().running).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const spawnedArgs = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    expect(spawnedArgs).toContain("--model");
    expect(spawnedArgs).toContain(modelPath);
    expect(spawnedArgs).toContain("--mmproj");
    expect(spawnedArgs).toContain(mmprojPath);
    expect(spawnedArgs).toContain("127.0.0.1");
    expect(spawnedArgs).toContain("--api-key");
    const nglIndex = spawnedArgs.indexOf("-ngl");
    expect(spawnedArgs[nglIndex + 1]).toBe("0");

    await sidecar.dispose();
    expect(sidecar.status().running).toBe(false);
  });

  it("reports unavailable gracefully when disabled or missing binary/mmproj", async () => {
    const dir = await makeTempDir("astra-vis-off-");
    const disabled = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      enabled: () => false,
    });
    expect(disabled.status().available).toBe(false);
    expect(await disabled.describeImage(await makeTestPng(), { mode: "screen" })).toBeNull();
  });

  it("handles non-executable llama-server paths cleanly without crashing the process", async () => {
    const dir = await makeTempDir("astra-vis-eacces-");
    const modelPath = join(dir, "Qwen3.5-9B-Q4_K_M.gguf");
    const mmprojPath = join(dir, "Qwen3.5-9B-mmproj-F16.gguf");
    const badBin = join(dir, "llama-server");
    await writeFile(modelPath, "fake-gguf");
    await writeFile(mmprojPath, "fake-mmproj");
    await writeFile(badBin, "not executable", "utf8");
    await chmod(badBin, 0o644); // intentionally non-executable -> EACCES on spawn

    const sidecar = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => badBin,
      startupTimeoutMs: 4000,
    });

    await expect(sidecar.describeImage(await makeTestPng(), { mode: "screen" })).rejects.toThrow(
      /Failed to spawn llama-server|exited/i,
    );
    await sidecar.dispose();
  });

  it("drains heavy stderr logs (>256 KiB) without stalling, resolves auto VRAM to 9B, invokes beforeSpawn, and avoids double-copy GPU OOM", async () => {
    const dir = await makeTempDir("astra-vis-stderr-");
    const modelPath = join(dir, "Qwen3.5-9B-Q4_K_M.gguf");
    const mmprojPath = join(dir, "Qwen3.5-9B-mmproj-F16.gguf");
    const argsLog = join(dir, "spawn-args.json");
    const stubBin = join(dir, "llama-server");

    await writeFile(modelPath, "fake-gguf");
    await writeFile(mmprojPath, "fake-mmproj");

    const script = [
      `#!${process.execPath}`,
      `import { createServer } from "node:http";`,
      `import { writeFileSync } from "node:fs";`,
      `const args = process.argv.slice(2);`,
      `const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };`,
      `writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));`,
      // Flood stderr with 256 KiB (4x Linux 64 KiB pipe capacity) before serving requests.
      `const chunk = "llama_log_line_" + "x".repeat(1000) + "\\n";`,
      `for (let i = 0; i < 260; i += 1) process.stderr.write(chunk);`,
      `const host = arg("--host") || "127.0.0.1";`,
      `const port = Number(arg("--port") || 0);`,
      `const apiKey = arg("--api-key") || "";`,
      `const server = createServer((req, res) => {`,
      `  const auth = req.headers.authorization || "";`,
      `  if (apiKey && auth !== "Bearer " + apiKey) { res.writeHead(401); res.end("unauthorized"); return; }`,
      `  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }`,
      `  if (req.url === "/v1/chat/completions") {`,
      `    req.resume();`,
      `    req.on("end", () => {`,
      `      res.writeHead(200, { "content-type": "application/json" });`,
      `      res.end(JSON.stringify({ choices: [{ message: { content: "Drained stderr cleanly." } }] }));`,
      `    });`,
      `    return;`,
      `  }`,
      `  res.writeHead(404); res.end();`,
      `});`,
      `server.listen(port, host);`,
      `process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
    ].join("\n");
    await writeFile(stubBin, script, "utf8");
    await chmod(stubBin, 0o755);

    let beforeSpawnCalls = 0;
    const sidecar = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "auto",
      // 8 GiB VRAM -> resolves "auto" to 9B (standard), NOT 4B (small)!
      totalVramBytes: () => 8 * 1024 ** 3,
      binaryPath: () => stubBin,
      // Simulate main local 9B model still loaded with only 1 GiB free VRAM -> MUST force -ngl 0!
      localModelLoaded: () => true,
      freeVramBytes: async () => 1 * 1024 ** 3,
      beforeSpawn: async () => {
        beforeSpawnCalls += 1;
      },
      startupTimeoutMs: 10_000,
      idleUnloadMs: 0,
    });

    const st = sidecar.status();
    expect(st.mmprojPath).toBe(mmprojPath);
    expect(st.modelPath).toBe(modelPath);
    expect(st.available).toBe(true);

    const out = await sidecar.describeImage(await makeTestPng(), { mode: "screen" });
    expect(out).toBe("Drained stderr cleanly.");
    expect(beforeSpawnCalls).toBe(1);

    const { readFile } = await import("node:fs/promises");
    const spawnedArgs = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    const nglIndex = spawnedArgs.indexOf("-ngl");
    expect(spawnedArgs[nglIndex + 1]).toBe("0");

    await sidecar.dispose();
  });

  it("backs off quickly after failure and escalates SIGTERM to SIGKILL on shutdown for stubborn processes", async () => {
    const dir = await makeTempDir("astra-vis-backoff-");
    const smallModel = join(dir, VISION_SIDECAR_MODELS.compact.modelFileName);
    const smallMmproj = join(dir, VISION_SIDECAR_MODELS.compact.mmproj.fileName);
    await writeFile(smallModel, "small-vl");
    await writeFile(smallMmproj, "small-mmproj");

    // 1. Failing binary triggers exponential failure backoff -> second call fast-returns null without respawning!
    const failBin = join(dir, "fail-llama-server");
    await writeFile(failBin, `#!${process.execPath}\nprocess.exit(1);\n`, "utf8");
    await chmod(failBin, 0o755);

    const flaky = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => failBin,
      startupTimeoutMs: 3_000,
      failureBackoffBaseMs: 2_000,
    });
    await expect(flaky.describeImage(await makeTestPng(), { mode: "screen" })).rejects.toThrow(/exited/i);
    expect(flaky.status().backoffActive).toBe(true);
    const t0 = performance.now();
    const skipped = await flaky.describeImage(await makeTestPng(), { mode: "screen" });
    expect(skipped).toBeNull();
    expect(performance.now() - t0).toBeLessThan(100);
    await flaky.dispose();

    // 2. Stubborn process that ignores SIGTERM MUST be killed via SIGKILL escalation on dispose()!
    const pidLog = join(dir, "stubborn.pid");
    const stubbornBin = join(dir, "stubborn-llama-server");
    await writeFile(
      stubbornBin,
      [
        `#!${process.execPath}`,
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const args = process.argv.slice(2);`,
        `const arg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };`,
        `writeFileSync(${JSON.stringify(pidLog)}, String(process.pid));`,
        // Intentionally swallow SIGTERM!
        `process.on("SIGTERM", () => {});`,
        `const server = createServer((req, res) => {`,
        `  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }`,
        `  req.resume();`,
        `  req.on("end", () => {`,
        `    res.writeHead(200, { "content-type": "application/json" });`,
        `    res.end(JSON.stringify({ choices: [{ message: { content: "Dedicated 0.8B ready." } }] }));`,
        `  });`,
        `});`,
        `server.listen(Number(arg("--port")), arg("--host"));`,
      ].join("\n"),
      "utf8",
    );
    await chmod(stubbornBin, 0o755);

    const stubborn = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => stubbornBin,
      localModelLoaded: () => true,
      // 1 GiB free VRAM fits the tiny stub dedicated vision files + 0.45 GiB headroom -> stays on GPU (-ngl 99)!
      freeVramBytes: async () => 1 * 1024 ** 3,
      startupTimeoutMs: 5_000,
      killTimeoutMs: 200,
      idleUnloadMs: 0,
    });
    const out = await stubborn.describeImage(await makeTestPng(), { mode: "screen" });
    expect(out).toBe("Dedicated 0.8B ready.");

    const { readFile } = await import("node:fs/promises");
    const pid = Number((await readFile(pidLog, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);

    await stubborn.dispose();
    // Confirm the process is actually gone (SIGKILL succeeded).
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

describe("Sight native vision sidecar preference", () => {
  it("prefers the local vision sidecar over Florence-2 and forwards SoM marks + question", async () => {
    const dir = await makeTempDir("astra-sight-");
    const pngPath = join(dir, "frame.png");
    await writeFile(pngPath, await makeTestPng(320, 200));

    const calls: VisionDescribeOptions[] = [];
    let disposed = false;
    const stubSidecar: VisionDescriber = {
      async describeImage(_png, options) {
        calls.push(options);
        return "Dark IDE window showing TypeScript error on line 42.";
      },
      async dispose() {
        disposed = true;
      },
    };

    const sight = new Sight(join(dir, "cache"), join(dir, "work"), {
      visionSidecar: stubSidecar,
    });

    const seen = await sight.read(pngPath, undefined, {
      question: "What error is shown?",
      windowTitle: "VS Code",
    });

    expect(seen.description).toBe("Dark IDE window showing TypeScript error on line 42.");
    expect(seen.visionEngine).toBe("llama-mmproj");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe("screen");
    expect(calls[0]?.question).toBe("What error is shown?");
    expect(calls[0]?.windowTitle).toBe("VS Code");

    await sight.rest();
    expect(disposed).toBe(true);
  });
});

describe("Round 3 vision catalog integrity, pairing precision, migration, flags, and boot disposal", () => {
  it("declares exact 0.8B projector size (204,987,232 bytes) and catches drift in checkCatalogSizes()", async () => {
    expect(VISION_SIDECAR_MODELS.compact.mmproj.sizeBytes).toBe(204_987_232);
    const allAssets = listCatalogDownloadAssets();
    expect(allAssets.length).toBeGreaterThanOrEqual(15);

    const exactCheck = await checkCatalogSizes(
      [
        {
          label: "0.8B mmproj",
          fileName: "Qwen3.5-0.8B-mmproj-F16.gguf",
          url: "https://example.test/mmproj.gguf",
          sizeBytes: 204_987_232,
        },
      ],
      {
        fetchImpl: (async () =>
          new Response(null, { status: 200, headers: { "content-length": "204987232" } })) as typeof fetch,
      },
    );
    expect(exactCheck.ok).toBe(true);

    const driftCheck = await checkCatalogSizes(
      [
        {
          label: "0.8B mmproj stale",
          fileName: "Qwen3.5-0.8B-mmproj-F16.gguf",
          url: "https://example.test/mmproj.gguf",
          sizeBytes: 620_000_000,
        },
      ],
      {
        fetchImpl: (async () =>
          new Response(null, { status: 200, headers: { "content-length": "204987232" } })) as typeof fetch,
      },
    );
    expect(driftCheck.ok).toBe(false);
    expect(driftCheck.results[0]?.error).toMatch(/drift/i);
  });

  it("refuses cross-family Qwen3-14B + Qwen3.5-4B mmproj pairing and offers compact upgrade for legacy brain-projector users", async () => {
    const dir = await makeTempDir("astra-vis-pair-");
    const qwen3TextOnly = join(dir, "Qwen3-14B-Q4_K_M.gguf");
    const qwen35Proj = join(dir, "Qwen3.5-4B-mmproj-F16.gguf");
    const qwen35Model = join(dir, "Qwen3.5-4B-Q4_K_M.gguf");
    await writeFile(qwen3TextOnly, "stub");
    await writeFile(qwen35Proj, "stub");
    await writeFile(qwen35Model, "stub");

    // Qwen3-14B MUST NOT pair with Qwen3.5-4B-mmproj-F16.gguf!
    const badPair = resolveVisionMmproj(qwen3TextOnly, dir, null);
    expect(badPair.downloaded).toBe(false);
    expect(badPair.mmprojPath).toBeNull();

    // Matching Qwen3.5-4B custom path DOES pair!
    const goodPair = resolveVisionMmproj(qwen35Model, dir, null);
    expect(goodPair.downloaded).toBe(true);
    expect(goodPair.mmprojPath).toBe(qwen35Proj);

    // Legacy user with brain 9B + 9B mmproj on disk gets working status + upgrade offer to compact 0.8B!
    const legacyDir = await makeTempDir("astra-vis-legacy-");
    await writeFile(join(legacyDir, "Qwen3.5-9B-Q4_K_M.gguf"), "brain");
    await writeFile(join(legacyDir, "Qwen3.5-9B-mmproj-F16.gguf"), "brain-mmproj");
    const pair = resolveVisionSidecarPair("standard", legacyDir, 8 * 1024 ** 3);
    expect(pair.source).toBe("brain");
    expect(pair.ready).toBe(true);
    expect(pair.recommendedUpgrade).not.toBeNull();
    expect(pair.recommendedUpgrade?.label).toBe("Qwen3.5 0.8B Vision");
    expect(pair.recommendedUpgrade?.missingBytes).toBe(
      VISION_SIDECAR_MODELS.compact.modelSizeBytes + VISION_SIDECAR_MODELS.compact.mmproj.sizeBytes,
    );

    const sidecar = new LlamaVisionSidecar({
      modelsDir: legacyDir,
      brainChoice: () => "standard",
      totalVramBytes: () => 8 * 1024 ** 3,
      binaryPath: () => process.execPath,
    });
    const st = sidecar.status();
    expect(st.upgradeAvailable).toBe(true);
    expect(st.upgradeLabel).toBe("Qwen3.5 0.8B Vision");
    expect(st.reason).toContain("switch to Qwen3.5 0.8B Vision");
  });

  it("passes --ctx-size 4096 and --no-mmproj-offload with -ngl 0, aborts spawn on dispose() during boot, and never counts deliberate dispose() as a backoff failure", async () => {
    const dir = await makeTempDir("astra-vis-flags-");
    await writeFile(join(dir, VISION_SIDECAR_MODELS.compact.modelFileName), "vl");
    await writeFile(join(dir, VISION_SIDECAR_MODELS.compact.mmproj.fileName), "mm");
    const argsLog = join(dir, "args.json");
    const slowBin = join(dir, "llama-server");

    // First verify --ctx-size 4096 + --no-mmproj-offload on dedicated model when gpuBusy=true (-ngl 0).
    await writeFile(
      slowBin,
      [
        `#!${process.execPath}`,
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const args = process.argv.slice(2);`,
        `const arg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };`,
        `writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));`,
        `const server = createServer((req, res) => {`,
        `  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }`,
        `  req.resume();`,
        `  req.on("end", () => {`,
        `    res.writeHead(200, { "content-type": "application/json" });`,
        `    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));`,
        `  });`,
        `});`,
        `server.listen(Number(arg("--port")), arg("--host"));`,
        `process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
      ].join("\n"),
      "utf8",
    );
    await chmod(slowBin, 0o755);

    const sidecar = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => slowBin,
      gpuBusy: () => true,
      startupTimeoutMs: 5_000,
      idleUnloadMs: 0,
    });
    expect(await sidecar.describeImage(await makeTestPng(), { mode: "screen" })).toBe("ok");
    const { readFile } = await import("node:fs/promises");
    const args = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    expect(args[args.indexOf("--ctx-size") + 1]).toBe("4096");
    expect(args[args.indexOf("-ngl") + 1]).toBe("0");
    expect(args).toContain("--no-mmproj-offload");
    await sidecar.dispose();

    // Now verify dispose() during boot stops spawn cleanly and does NOT activate backoff!
    const hangBin = join(dir, "llama-server-hang");
    const hangPidFile = join(dir, "hang.pid");
    await writeFile(
      hangBin,
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(hangPidFile)}, String(process.pid));`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
      "utf8",
    );
    await chmod(hangBin, 0o755);

    const bootingSidecar = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => hangBin,
      startupTimeoutMs: 10_000,
      killTimeoutMs: 200,
      failureBackoffBaseMs: 60_000,
      idleUnloadMs: 0,
    });
    const pending = bootingSidecar.describeImage(await makeTestPng(), { mode: "screen" });
    // Wait briefly for child spawn, then call deliberate dispose().
    await new Promise((r) => setTimeout(r, 150));
    await bootingSidecar.dispose();
    expect(await pending).toBeNull();
    expect(bootingSidecar.status().backoffActive).toBe(false);
    expect(bootingSidecar.status().lastError).toBeNull();
  });

  it("handles Round 4 vision edge cases: backoff after internal restart, deduplicated concurrent boot failures, dispose during restart teardown, and x-linked-size + retry in checkCatalogSizes()", async () => {
    const dir = await makeTempDir("astra-vis-r4-");
    await writeFile(join(dir, VISION_SIDECAR_MODELS.compact.modelFileName), "vl");
    await writeFile(join(dir, VISION_SIDECAR_MODELS.compact.mmproj.fileName), "mm");

    // 1. Failure right after an internal restart (gpuBusy flip) MUST activate backoff (not misclassified as dispose)!
    const runCountFile = join(dir, "runs.txt");
    const restartBin = join(dir, "llama-restart");
    await writeFile(
      restartBin,
      [
        `#!${process.execPath}`,
        `import { createServer } from "node:http";`,
        `import { appendFileSync, readFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(runCountFile)}, "1\\n");`,
        `const n = readFileSync(${JSON.stringify(runCountFile)}, "utf8").trim().split("\\n").length;`,
        `if (n >= 2) process.exit(1);`,
        `const args = process.argv.slice(2);`,
        `const arg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };`,
        `const server = createServer((req, res) => {`,
        `  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }`,
        `  req.resume();`,
        `  req.on("end", () => {`,
        `    res.writeHead(200, { "content-type": "application/json" });`,
        `    res.end(JSON.stringify({ choices: [{ message: { content: "boot-1-ok" } }] }));`,
        `  });`,
        `});`,
        `server.listen(Number(arg("--port")), arg("--host"));`,
        `process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
      ].join("\n"),
      "utf8",
    );
    await chmod(restartBin, 0o755);

    let busy = false;
    const restarting = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => restartBin,
      gpuBusy: () => busy,
      startupTimeoutMs: 5_000,
      failureBackoffBaseMs: 5_000,
      idleUnloadMs: 0,
    });
    expect(await restarting.describeImage(await makeTestPng(), { mode: "screen" })).toBe("boot-1-ok");
    // Flip gpuBusy to force internal restart (GPU -> CPU); 2nd spawn exits 1!
    busy = true;
    await expect(restarting.describeImage(await makeTestPng(), { mode: "screen" })).rejects.toThrow(/exited/i);
    expect(restarting.status().backoffActive).toBe(true);
    await restarting.dispose();

    // 2. Concurrent callers sharing one failed boot MUST increment consecutiveFailures only ONCE!
    const failSlowBin = join(dir, "llama-fail-slow");
    await writeFile(failSlowBin, `#!${process.execPath}\nsetTimeout(() => process.exit(1), 80);\n`, "utf8");
    await chmod(failSlowBin, 0o755);
    const sharedFail = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => failSlowBin,
      startupTimeoutMs: 5_000,
      failureBackoffBaseMs: 250,
      idleUnloadMs: 0,
    });
    const png = await makeTestPng();
    const results = await Promise.allSettled([
      sharedFail.describeImage(png, { mode: "screen" }),
      sharedFail.describeImage(png, { mode: "screen" }),
      sharedFail.describeImage(png, { mode: "screen" }),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(sharedFail.status().backoffActive).toBe(true);
    // With 1 counted failure, 250ms backoff expires well before 420ms;
    // with 3 counted failures it would be 250 * 4 = 1000ms and STILL active at 420ms!
    await new Promise((r) => setTimeout(r, 420));
    expect(sharedFail.status().backoffActive).toBe(false);
    await sharedFail.dispose();

    // 3. External dispose() during restart teardown MUST abort spawn without launching a new child!
    let spawnCount = 0;
    const disposeRace = new LlamaVisionSidecar({
      modelsDir: dir,
      brainChoice: () => "standard",
      binaryPath: () => {
        spawnCount += 1;
        return failSlowBin;
      },
      beforeSpawn: async () => {
        await new Promise((r) => setTimeout(r, 120));
      },
      startupTimeoutMs: 5_000,
      idleUnloadMs: 0,
    });
    const raceCall = disposeRace.describeImage(png, { mode: "screen" });
    await new Promise((r) => setTimeout(r, 30));
    await disposeRace.dispose();
    expect(await raceCall).toBeNull();
    expect(disposeRace.status().backoffActive).toBe(false);
    expect(spawnCount).toBeLessThanOrEqual(2);

    // 4. checkCatalogSizes() reads Hugging Face x-linked-size header on redirect and retries transient 503!
    let attempts = 0;
    const hfCheck = await checkCatalogSizes(
      [
        {
          label: "0.8B mmproj",
          fileName: "Qwen3.5-0.8B-mmproj-F16.gguf",
          url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf",
          sizeBytes: 204_987_232,
        },
      ],
      {
        maxAttempts: 3,
        retryBaseDelayMs: 5,
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          attempts += 1;
          if (attempts === 1) {
            return new Response(null, { status: 503 });
          }
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://cas-bridge.xethub.hf.co/blob",
              "x-linked-size": "204987232",
            },
          });
        }) as typeof fetch,
      },
    );
    expect(hfCheck.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(hfCheck.results[0]?.actualBytes).toBe(204_987_232);
  });
});
