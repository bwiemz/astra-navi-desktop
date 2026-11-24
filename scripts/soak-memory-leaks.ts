/**
 * Runtime Memory & Leak Soak Test (`scripts/soak-memory-leaks.ts`):
 * Exercises four sustained allocation & lifecycle workloads under `node --expose-gc`
 * to verify bounded heap / RSS growth and proper session/timer disposal:
 *   1. `TurnHookPipeline` (100 turns: cache hits, numeric slot misses, taint bypass, consensus)
 *   2. `OnnxVoice` real Kokoro-82M preset switching (20 switches + 4 sleep/wake `disposeSharedEngines()` cycles)
 *   3. Workbench snapshots & Room Calibration cycling (20 cycles across Mission, Policy, X-Ray, Avatar, AEC)
 *   4. `StageLayerManager` mount/update/dispose cycling (50 cycles x 10 frames across all 4 layers)
 *
 * Usage:
 *   node --expose-gc scripts/soak-memory-leaks.ts [--json] [--cache-dir PATH]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConfigStore } from "../src/core/config.ts";
import { EpisodicGraph } from "../src/core/episodic.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { ApprovalDesk } from "../src/core/missionApproval.ts";
import { MissionBoard } from "../src/core/missionPlan.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { SemanticCommandCache } from "../src/core/semanticCache.ts";
import { CompiledSkillStore } from "../src/core/skillCompiler.ts";
import { makeOrder, StandingOrders } from "../src/core/standingOrders.ts";
import { HerStore } from "../src/core/store.ts";
import { TraceKeeper } from "../src/core/trace.ts";
import {
  createPlanConsensusHook,
  createSemanticCacheHook,
  TurnHookPipeline,
  type TurnHookContext,
} from "../src/core/turnHooks.ts";
import { evaluateRoomCalibration, generateCalibrationTone } from "../src/core/voice/aec.ts";
import { OnnxVoice } from "../src/core/voice/onnxVoice.ts";
import { ProceduralAvatarController } from "../src/renderer/src/avatarAnimator.ts";
import { Canvas2DAvatarRenderer, type Canvas2DContextLike } from "../src/renderer/src/canvas2dStage.ts";
import {
  createAvatarAnimatorLayer,
  createCanvas2DLayer,
  createStageLightingLayer,
  createVrmaBridgeLayer,
  StageLayerManager,
} from "../src/renderer/src/stageLayers.ts";
import { StageLightingController } from "../src/renderer/src/stageLighting.ts";
import { VrmaStageBridge } from "../src/renderer/src/vrmaStageBridge.ts";

// Provide minimal Electron stubs so IPC snapshot builders import cleanly under plain Node CLI.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") {
      return { url: "electron-soak-stub:", shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "electron-soak-stub:") {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export const ipcMain = { handle() {}, on() {} }; export const app = { getAppPath: () => process.cwd(), isPackaged: false };",
      };
    }
    return next(url, context);
  },
});

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
let cacheDir = join(homedir(), ".local/share/ai-chan/models/speech");
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--cache-dir") cacheDir = args[(i += 1)] ?? cacheDir;
}

const toMB = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 100) / 100;

function forceGc(): void {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
}

interface SoakResult {
  workload: string;
  passed: boolean;
  durationMs: number;
  metrics: Record<string, number | boolean | string>;
  failure?: string;
}

async function runTurnHooksSoak(): Promise<SoakResult> {
  const start = performance.now();
  const cache = new SemanticCommandCache();
  await cache.record("set volume to 25", TOOLS.sound, { action: "set_volume", level: 25 });
  await cache.record("check disk space", TOOLS.shipStatus, { action: "status" });

  const pipeline = new TurnHookPipeline();
  pipeline.register(
    createSemanticCacheHook(cache, () => true, (hit) => `Cached ${hit.tool ?? "ok"}`),
  );
  pipeline.register(
    createPlanConsensusHook(
      () => true,
      () => [
        { commands: ["sound set_volume 25"], targetControls: ["sound"] },
        { commands: ["sound set_volume 25"], targetControls: ["sound"] },
        { commands: ["sound set_volume 25"], targetControls: ["sound"] },
      ],
    ),
  );

  forceGc();
  const heapBefore = process.memoryUsage().heapUsed;

  let shortCircuits = 0;
  let misses = 0;
  for (let i = 0; i < 100; i += 1) {
    const mode = i % 4;
    const ctx: TurnHookContext = {
      userText:
        mode === 0
          ? "set volume to 25"
          : mode === 1
            ? `set volume to ${30 + (i % 60)}`
            : mode === 2
              ? "check disk space"
              : "delete logs on server",
      spoken: false,
      isEvent: false,
      away: false,
      readOutsideText: mode === 2,
      handsOff: mode === 3,
      offeredTools: [TOOLS.sound, TOOLS.shipStatus],
      usedTools: [],
      replyText: "",
      falseClaim: false,
      flags: {},
    };
    const pre = await pipeline.runBeforeRoute(ctx);
    if (pre.shortCircuitReply) shortCircuits += 1;
    else misses += 1;
    await pipeline.runAfterPlan(ctx);
    pipeline.runBeforeCommit(ctx);
  }

  forceGc();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMB = toMB(heapAfter - heapBefore);
  const passed = heapDeltaMB < 32 && shortCircuits === 25 && misses === 75;

  return {
    workload: "TurnHookPipeline (100 turns)",
    passed,
    durationMs: Math.round(performance.now() - start),
    metrics: {
      turns: 100,
      shortCircuits,
      misses,
      heapBeforeMB: toMB(heapBefore),
      heapAfterMB: toMB(heapAfter),
      heapDeltaMB,
    },
    ...(passed ? {} : { failure: `heapDeltaMB=${heapDeltaMB}, shortCircuits=${shortCircuits}` }),
  };
}

async function runOnnxVoiceSoak(): Promise<SoakResult> {
  const start = performance.now();
  await OnnxVoice.disposeSharedEngines();
  forceGc();

  const presets = ["astra", "bright", "calm", "warm", "crisp"] as const;
  let warmedRssBytes = 0;
  let peakRssBytes = process.memoryUsage().rss;
  let cacheSizeViolations = 0;
  let disposeCycles = 0;
  let samplesGenerated = 0;

  for (let i = 0; i < 20; i += 1) {
    const preset = presets[i % presets.length] ?? "astra";
    const voice = new OnnxVoice({
      cacheDir,
      voice: preset,
      speed: 1.0,
      quantization: "q8",
    });
    for await (const chunk of voice.synthesizeStream("System nominal.", "en")) {
      samplesGenerated += chunk.samples.length;
    }
    if (OnnxVoice.sharedCacheSize() !== 1) cacheSizeViolations += 1;
    await voice.dispose();

    const rssNow = process.memoryUsage().rss;
    if (i === 0) warmedRssBytes = rssNow;
    if (rssNow > peakRssBytes) peakRssBytes = rssNow;

    if ((i + 1) % 5 === 0) {
      await OnnxVoice.disposeSharedEngines();
      if (OnnxVoice.sharedCacheSize() !== 0) cacheSizeViolations += 1;
      disposeCycles += 1;
      forceGc();
    }
  }

  forceGc();
  const finalRssBytes = process.memoryUsage().rss;
  const rssGrowthAboveWarmedMB = toMB(peakRssBytes - warmedRssBytes);
  const passed =
    cacheSizeViolations === 0 &&
    disposeCycles === 4 &&
    OnnxVoice.sharedCacheSize() === 0 &&
    samplesGenerated > 0 &&
    rssGrowthAboveWarmedMB < 150;

  return {
    workload: "OnnxVoice Preset Switches (20 switches / 4 dispose cycles)",
    passed,
    durationMs: Math.round(performance.now() - start),
    metrics: {
      switches: 20,
      disposeCycles,
      samplesGenerated,
      cacheSizeViolations,
      warmedRssMB: toMB(warmedRssBytes),
      peakRssMB: toMB(peakRssBytes),
      finalRssMB: toMB(finalRssBytes),
      rssGrowthAboveWarmedMB,
    },
    ...(passed
      ? {}
      : {
          failure: `rssGrowthAboveWarmedMB=${rssGrowthAboveWarmedMB}, cacheSizeViolations=${cacheSizeViolations}`,
        }),
  };
}

async function runWorkbenchSnapshotSoak(): Promise<SoakResult> {
  const start = performance.now();
  const { buildMissionControlSnapshot } = await import("../src/main/missionControlIpc.ts");
  const {
    buildAvatarStudioSnapshot,
    buildPolicyComposerSnapshot,
    buildTurnXraySnapshot,
  } = await import("../src/main/studioToolsIpc.ts");

  const dir = mkdtempSync(join(tmpdir(), "astra-soak-wb-"));
  const store = new HerStore(join(dir, "her.db"));
  const config = new ConfigStore(join(dir, "config.json"));
  const memory = new MemoryStore(join(dir, "memory.json"));
  const episodic = new EpisodicGraph(store);
  const skills = new CompiledSkillStore(join(dir, "skills.json"));
  const traces = new TraceKeeper(40);
  const orders = new StandingOrders(join(dir, "orders.json"), {
    store,
    read: async () => ({ ok: true, text: "ok" }),
    onNews: () => undefined,
  });
  const desk = new ApprovalDesk({ showAtPc: async () => true });
  const board = new MissionBoard({
    file: join(dir, "missions.json"),
    judge: async () => ({ decision: "allow" }),
    fingerprint: (s) => `${s.where}:${s.command}`,
    run: async () => ({ ok: true, output: "ok" }),
    ask: (q, sig) => desk.ask(q, sig),
    tell: () => undefined,
  });

  await config.load();
  await memory.load();
  await skills.load();
  await orders.start();
  await board.load();

  try {
    await memory.save({ kind: "fact", text: "NAS runs on 192.168.50.14" });
    episodic.recordEpisode({
      kind: "proactive_alert",
      contextBucket: "focus:terminal:12",
      activeApp: "terminal",
      mode: "focus",
      summary: "Checked storage pool",
    });
    const orderDraft = makeOrder(
      {
        title: "Soak disk watch",
        where: "here",
        command: "df -h",
        tellWhen: "contains",
        value: "95%",
        everyMinutes: 15,
        repeat: false,
      },
      config.value.fleet.machines,
      new Date(),
    );
    if ("order" in orderDraft) {
      await orders.add(orderDraft.order);
    }
    traces.add({
      at: new Date().toISOString(),
      kind: "user",
      brain: "small",
      said: "Check the disk",
      offered: [TOOLS.shipStatus],
      pickedFor: { [TOOLS.shipStatus]: "word" },
      calls: [
        {
          tool: TOOLS.shipStatus,
          input: "{}",
          outcome: "done",
          asked: false,
          gate: "allow",
          result: "ok",
          ms: 12,
        },
      ],
      checks: [],
      reply: "Disk looks healthy.",
      spoken: false,
      tokens: { read: 380, written: 18, held: 0, prompt: 420 },
      ms: { firstWord: 25, whole: 80 },
      withheld: false,
    });

    const mcDeps = {
      config,
      board: () => board,
      approvalDesk: () => desk,
      memoryStore: () => memory,
      episodic: () => episodic,
      orders: () => orders,
      skills: () => skills,
      traces,
    };
    const stDeps = {
      config,
      memoryStore: () => memory,
      orders: () => orders,
      skills: () => skills,
      traces,
    };
    const refTone = generateCalibrationTone(16_000, 0.5);

    // Warm one cycle first before measuring steady-state delta.
    buildMissionControlSnapshot(mcDeps);
    buildPolicyComposerSnapshot(stDeps);
    buildTurnXraySnapshot(stDeps);
    buildAvatarStudioSnapshot(stDeps);
    evaluateRoomCalibration({ reference: refTone, recorded: refTone, sampleRate: 16_000 });

    forceGc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 20; i += 1) {
      const mc = buildMissionControlSnapshot(mcDeps);
      const pc = buildPolicyComposerSnapshot(stDeps);
      const tx = buildTurnXraySnapshot(stDeps);
      const av = buildAvatarStudioSnapshot(stDeps);
      const aec = evaluateRoomCalibration({ reference: refTone, recorded: refTone, sampleRate: 16_000 });
      if (mc.memories.length === 0 || pc.orders.length === 0 || tx.turns.length === 0 || !av.windowMode || aec.erleDb < 0) {
        throw new Error(`Unexpected empty snapshot at iteration ${i}`);
      }
    }

    forceGc();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMB = toMB(heapAfter - heapBefore);
    const passed = heapDeltaMB < 32;

    return {
      workload: "Workbench Snapshots & AEC Cycling (20 cycles)",
      passed,
      durationMs: Math.round(performance.now() - start),
      metrics: {
        cycles: 20,
        heapBeforeMB: toMB(heapBefore),
        heapAfterMB: toMB(heapAfter),
        heapDeltaMB,
      },
      ...(passed ? {} : { failure: `heapDeltaMB=${heapDeltaMB}` }),
    };
  } finally {
    orders.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runStageLayersSoak(): Promise<SoakResult> {
  const start = performance.now();
  const mockCtx: Canvas2DContextLike = {
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    drawImage() {},
    globalAlpha: 1,
  };
  const mockHost = {
    canvas: {} as HTMLCanvasElement,
    scene: {},
    camera: {},
    skyLight: {},
    sunLight: {},
  };

  forceGc();
  const heapBefore = process.memoryUsage().heapUsed;

  for (let c = 0; c < 50; c += 1) {
    const manager = new StageLayerManager();
    manager.attachHost(mockHost);
    const animator = new ProceduralAvatarController();
    const vrma = new VrmaStageBridge(animator);
    const lighting = new StageLightingController();
    const canvas2d = new Canvas2DAvatarRenderer({ ctx: mockCtx });

    manager.register(createAvatarAnimatorLayer(animator));
    manager.register(createVrmaBridgeLayer(vrma));
    manager.register(createStageLightingLayer(lighting));
    manager.register(createCanvas2DLayer(canvas2d));

    for (let f = 0; f < 10; f += 1) {
      manager.update({
        dtSec: 1 / 60,
        elapsedSec: (c * 10 + f) / 60,
        mood: "neutral",
        thinking: f % 2 === 0,
        listening: false,
        asleep: false,
        voiceLevel: 0.25,
        mouthOpen: 0.3,
        hasModel: true,
        setBoneRotation() {},
        setMorphWeight() {},
        applyLighting() {},
      });
    }
    manager.dispose();
  }

  forceGc();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMB = toMB(heapAfter - heapBefore);
  const passed = heapDeltaMB < 16;

  return {
    workload: "StageLayerManager Mount/Update/Dispose (50 cycles)",
    passed,
    durationMs: Math.round(performance.now() - start),
    metrics: {
      cycles: 50,
      framesTotal: 500,
      heapBeforeMB: toMB(heapBefore),
      heapAfterMB: toMB(heapAfter),
      heapDeltaMB,
    },
    ...(passed ? {} : { failure: `heapDeltaMB=${heapDeltaMB}` }),
  };
}

async function main(): Promise<void> {
  if (typeof globalThis.gc !== "function") {
    console.error("[soak] Warning: run with `node --expose-gc` for deterministic GC baselines.");
  }

  const results: SoakResult[] = [
    await runTurnHooksSoak(),
    await runOnnxVoiceSoak(),
    await runWorkbenchSnapshotSoak(),
    await runStageLayersSoak(),
  ];

  const allPassed = results.every((r) => r.passed);
  const payload = {
    exposeGc: typeof globalThis.gc === "function",
    allPassed,
    results,
  };

  if (jsonOut) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Memory & Leak Soak Suite (--expose-gc=${payload.exposeGc}):`);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"} [${r.workload}] (${r.durationMs} ms) ${JSON.stringify(r.metrics)}`);
      if (r.failure) console.log(`    Failure: ${r.failure}`);
    }
  }

  if (!allPassed) process.exitCode = 1;
}

await main();
