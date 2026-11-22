import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLoraTrainArgs,
  canStartDistillation,
  collectTeacherDistillationData,
  evaluateDistillationRegression,
  SelfDistillationOrchestrator,
} from "../src/core/distill.ts";
import { buildDistilledEmbedderAdapter, LocalEmbedder } from "../src/core/embedder.ts";
import type { TurnTrace } from "../src/core/trace.ts";
import type { SftExample } from "../src/core/trainingExport.ts";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function makeTempDir(prefix = "ai-chan-distill-"): Promise<string> {
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

function sampleExamples(n: number): SftExample[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `sft-${i}`,
    text: `<|im_start|>user\nhi ${i}<|im_end|>\n<|im_start|>assistant\n[[happy]] hello<|im_end|>`,
    spans: [[35, 51]] as [number, number][],
    meta: { source: "clean", from: "standard", brain: "Standard (9B)" },
  }));
}

describe("Production Self-Distillation Orchestrator", () => {
  it("gates overnight runs on AC/thermal/idle/night and minimum SFT example count", () => {
    const baseWindow = {
      enabled: true,
      onAcPower: true,
      gameActive: false,
      gpuTempC: 44,
      cpuThrottled: false,
      idleMinutes: 30,
      hour: 3,
      exampleCount: 60,
      minExamples: 50,
    };
    expect(canStartDistillation(baseWindow).allowed).toBe(true);
    expect(canStartDistillation({ ...baseWindow, exampleCount: 12 }).allowed).toBe(false);
    expect(canStartDistillation({ ...baseWindow, gameActive: true }).allowed).toBe(false);
    expect(canStartDistillation({ ...baseWindow, onAcPower: false }).allowed).toBe(false);

    const spec = buildLoraTrainArgs({
      pythonBin: "/opt/venv/bin/python",
      loraScript: "/repo/train/lora.py",
      baseModelDir: "/models/Qwen3.5-4B",
      datasetPath: "/tmp/lessons.jsonl",
      outputDir: "/tmp/out",
      rank: 16,
      steps: 200,
    });
    expect(spec.program).toBe("/opt/venv/bin/python");
    expect(spec.args).toEqual([
      "/repo/train/lora.py",
      "--base",
      "/models/Qwen3.5-4B",
      "--data",
      "/tmp/lessons.jsonl",
      "--out",
      "/tmp/out",
      "--rank",
      "16",
      "--steps",
      "200",
    ]);
  });

  it("blocks promotion if injection passRate < 1.0 or honesty regresses, and promotes clean gains", async () => {
    const dir = await makeTempDir();
    const baseline = { passRate: 0.85, honestyRate: 0.94, injectionPassRate: 1.0 };

    expect(
      evaluateDistillationRegression(baseline, {
        passRate: 0.95,
        honestyRate: 0.98,
        injectionPassRate: 0.99,
      }).promote,
    ).toBe(false);

    expect(
      evaluateDistillationRegression(baseline, {
        passRate: 0.9,
        honestyRate: 0.9,
        injectionPassRate: 1.0,
      }).promote,
    ).toBe(false);

    // Regression quarantined (not promoted).
    const orchestratorFail = new SelfDistillationOrchestrator({
      workDir: dir,
      pythonBin: "python3",
      loraScript: "train/lora.py",
      baseModelDir: "/models/small",
      runTrain: async () => ({ ok: true }),
      runEval: async () => ({ passRate: 0.88, honestyRate: 0.92, injectionPassRate: 1.0 }),
    });
    const blockedRes = await orchestratorFail.runOvernightPass({
      window: {
        enabled: true,
        onAcPower: true,
        gameActive: false,
        gpuTempC: 42,
        idleMinutes: 35,
        hour: 2,
        exampleCount: 5,
        minExamples: 5,
      },
      examples: sampleExamples(5),
      baseline,
    });
    expect(blockedRes.ran).toBe(true);
    expect(blockedRes.promoted).toBe(false);
    expect(blockedRes.quarantinedPath).toBe(join(dir, "candidate"));
    expect(existsSync(join(dir, "active"))).toBe(false);

    // Passing run promotes adapter & preserves 0600 dataset permissions.
    const orchestratorPass = new SelfDistillationOrchestrator({
      workDir: dir,
      pythonBin: "python3",
      loraScript: "train/lora.py",
      baseModelDir: "/models/small",
      runTrain: async () => ({ ok: true }),
      runEval: async () => ({ passRate: 0.91, honestyRate: 0.96, injectionPassRate: 1.0 }),
    });
    const okRes = await orchestratorPass.runOvernightPass({
      window: {
        enabled: true,
        onAcPower: true,
        gameActive: false,
        gpuTempC: 42,
        idleMinutes: 35,
        hour: 2,
        exampleCount: 5,
        minExamples: 5,
      },
      examples: sampleExamples(5),
      baseline,
    });
    expect(okRes.promoted).toBe(true);
    expect(okRes.adapterPath).toBe(join(dir, "active"));
    expect(existsSync(join(dir, "active"))).toBe(true);
    const dsStat = await stat(join(dir, "lessons.jsonl"));
    expect(dsStat.mode & 0o777).toBe(0o600);
    const lines = (await readFile(join(dir, "lessons.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(5);
  });

  it("harvests 27B/XL teacher trajectories, converts QLoRA/GGUF + embedder adapters, and passes py_compile", async () => {
    const dir = await makeTempDir();
    const traces: TurnTrace[] = [
      {
        at: "2026-11-22T02:00:00Z",
        kind: "user",
        said: "Check the storage service status on aw-runner",
        spoken: false,
        brain: "Large (Qwen3.8 27B)",
        offered: ["remote"],
        calls: [
          {
            tool: "remote",
            input: '{"machine":"aw-runner","command":"systemctl status storage"}',
            result: "active (running)",
            outcome: "done",
            asked: false,
            ms: 82,
          },
        ],
        reply: "The storage service on aw-runner is active.",
        checks: [],
        withheld: false,
        ms: { whole: 420, firstWord: 140 },
        tokens: { read: 420, written: 24, held: 0 },
      },
      {
        at: "2026-11-22T02:01:00Z",
        kind: "user",
        said: "secret notification",
        spoken: false,
        brain: "Extra Large (Qwen3.5 72B Workstation)",
        offered: [],
        calls: [],
        reply: "hidden",
        checks: [],
        withheld: true,
        ms: { whole: 100, firstWord: 50 },
        tokens: { read: 100, written: 5, held: 0 },
      },
    ];

    const harvested = collectTeacherDistillationData({
      traces,
      actions: [
        {
          at: "2026-11-22T02:00:00Z",
          tool: "remote",
          detail: "aw-runner systemctl status storage",
          outcome: "done",
          asked: false,
          by: "her",
        },
      ],
    });
    expect(harvested.sftExamples).toHaveLength(1);
    expect(harvested.routerSamples).toEqual([
      { query: "Check the storage service status on aw-runner", domain: "fleet" },
    ]);
    expect(harvested.vocabulary).toContain("aw-runner");
    expect(harvested.skippedUnverified).toBe(0);

    const qloraSpec = buildLoraTrainArgs({
      pythonBin: "python3",
      loraScript: "train/lora.py",
      baseModelDir: "/models/small",
      datasetPath: "/tmp/d.jsonl",
      outputDir: "/tmp/out",
      qlora: true,
      converterScript: "/llama/convert_lora_to_gguf.py",
    });
    expect(qloraSpec.args).toContain("--qlora");
    expect(qloraSpec.args).toContain("--convert-gguf");

    const orchestrator = new SelfDistillationOrchestrator({
      workDir: dir,
      pythonBin: "python3",
      loraScript: "train/lora.py",
      baseModelDir: "/models/small",
      qlora: true,
      runTrain: async () => ({ ok: true }),
      runEval: async () => ({ passRate: 0.94, honestyRate: 0.98, injectionPassRate: 1.0 }),
      convertToGguf: async (_cand, outFile) => {
        await writeFile(outFile, "GGUF");
        return { ok: true };
      },
      distillEmbedder: async (_samples, outFile) => {
        const adapter = buildDistilledEmbedderAdapter([
          { domain: "fleet", vector: [1, 0, 0] },
          { domain: "agenda", vector: [0, 1, 0] },
        ]);
        await writeFile(outFile, JSON.stringify(adapter));
        return { ok: true };
      },
    });

    const pass = await orchestrator.runOvernightPass({
      window: {
        enabled: true,
        onAcPower: true,
        gameActive: false,
        gpuTempC: 41,
        idleMinutes: 40,
        hour: 3,
        exampleCount: 5,
        minExamples: 1,
      },
      examples: harvested.sftExamples,
      routerSamples: harvested.routerSamples,
      baseline: { passRate: 0.88, honestyRate: 0.95, injectionPassRate: 1.0 },
    });
    expect(pass.promoted).toBe(true);
    expect(pass.ggufAdapterPath).toBe(join(dir, "active", "small-lora.gguf"));
    expect(pass.embedderAdapterPath).toBe(join(dir, "active", "router_adapter.json"));

    const embedder = new LocalEmbedder(dir);
    expect(await embedder.loadDistilledAdapter(pass.embedderAdapterPath ?? "")).toBe(true);
    const domainScores = embedder.scoreDomains(Float32Array.from([0.99, 0.05, 0]));
    expect((domainScores["fleet"] ?? 0) > (domainScores["agenda"] ?? 0)).toBe(true);

    await execFileAsync("python3", ["-m", "py_compile", "train/lora.py"]);
  });
});
