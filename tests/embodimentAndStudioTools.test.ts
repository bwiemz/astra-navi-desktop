import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { TraceKeeper } from "../src/core/trace.ts";
import {
  buildPolicyComposerSnapshot,
  buildTurnXraySnapshot,
  previewStandingOrderDraft,
} from "../src/main/studioToolsIpc.ts";
import {
  Canvas2DAvatarRenderer,
  type Canvas2DContextLike,
} from "../src/renderer/src/canvas2dStage.ts";
import { StageLightingController } from "../src/renderer/src/stageLighting.ts";
import {
  VrmaStageBridge,
  type VrmPoseTargetSink,
} from "../src/renderer/src/vrmaStageBridge.ts";
import {
  computeAudioVisualizerProp,
  computeThermalCrystalProp,
  computeTimerRingProp,
  computeWebcamParallaxOffset,
  sampleEdgeAmbientColor,
} from "../src/shared/spatialStage.ts";
import {
  buildTurnTokenBudget,
  buildTurnWaterfall,
  EXPERIMENTAL_OPTION_DESCRIPTIONS,
  findNearDuplicateMemories,
} from "../src/shared/studioTools.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Post-v1 Spatial Embodiment & Standalone Studio Windows (Track 3)", () => {
  it("blends circadian + screen-edge ambient lighting and evaluates webcam parallax & holographic props", () => {
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) {
      pixels[i * 4] = 40;
      pixels[i * 4 + 1] = 160;
      pixels[i * 4 + 2] = 240;
      pixels[i * 4 + 3] = 255;
    }
    const edgeRgb = sampleEdgeAmbientColor(pixels, 4, 4, 4);
    expect(edgeRgb[2]).toBeGreaterThan(edgeRgb[0]);

    const lighting = new StageLightingController({ smoothingAlpha: 0.5, screenStrength: 0.5 });
    const evening = lighting.step({
      now: new Date(2026, 10, 23, 21, 0, 0),
      edgePixels: pixels,
      width: 4,
      height: 4,
      channels: 4,
    });
    expect(evening.skyIntensity).toBeGreaterThan(0);

    const parallax = computeWebcamParallaxOffset({ x: 2, y: -0.5 }, 0.1);
    expect(parallax.offsetX).toBe(0.1);
    expect(parallax.yawDeg).toBe(8.5);

    const urgentTimer = computeTimerRingProp({ enabled: true, totalSec: 60, remainingSec: 10 });
    expect(urgentTimer.visible).toBe(true);
    expect(urgentTimer.pulse).toBe(1);

    const viz = computeAudioVisualizerProp({
      enabled: true,
      samples: new Float32Array([0.3, -0.3, 0.25, -0.25, 0.4, -0.4, 0.1, -0.1]),
      barCount: 4,
    });
    expect(viz.visible).toBe(true);
    expect(viz.bars).toHaveLength(4);

    const crystal = computeThermalCrystalProp({
      enabled: true,
      gpu: { tempC: 85, vramUsedMb: 18_000, vramTotalMb: 20_480, throttled: true },
    });
    expect(crystal.status).toBe("hot");
    expect(crystal.colorHex).toBe("#ef4444");
  });

  it("drives VRMA stage bridge gaze clamping and 2D layered sprite canvas renderer", async () => {
    const bridge = new VrmaStageBridge();
    bridge.lookAtNormalized(5, -5);
    bridge.triggerGesture("nod");
    bridge.applyExpressiveCue({
      emphasis: 0.8,
      pause: false,
      laugh: 0,
      eyebrowRaise: 0.5,
      headTiltDeg: 4,
      nodDrive: 0.6,
      postureEnergy: 1.1,
    });

    let lastYaw = 0;
    let drawCount = 0;
    const sink: VrmPoseTargetSink = {
      setBoneRotation: () => undefined,
      setHipsTranslation: () => undefined,
      setExpressionWeight: () => undefined,
      setEyeGaze: (yaw) => {
        lastYaw = yaw;
      },
    };
    const pose = bridge.step(0.05, sink);
    expect(Math.abs(lastYaw)).toBeLessThanOrEqual(36);
    expect(pose.hipsOffset).toHaveLength(3);

    const ctx: Canvas2DContextLike = {
      clearRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      rotate: () => undefined,
      scale: () => undefined,
      drawImage: () => {
        drawCount += 1;
      },
      globalAlpha: 1,
    };
    const renderer2d = new Canvas2DAvatarRenderer({ ctx });
    await renderer2d.load({
      version: 1,
      name: "Astra 2D",
      width: 256,
      height: 256,
      layers: [
        { id: "base", asset: "sprites/body.png", zIndex: 0, anchorX: 0.5, anchorY: 0.5, opacity: 1, role: "base" },
        { id: "mouth", asset: "sprites/mouth_open.png", zIndex: 5, anchorX: 0.5, anchorY: 0.5, opacity: 1, role: "mouth" },
      ],
      visemeAssets: { A: "sprites/mouth_a.png", closed: "sprites/mouth_closed.png" },
      moodOverlays: {},
    });
    renderer2d.renderFrame({
      mood: "happy",
      visemes: { A: 0.8, I: 0, U: 0, E: 0, O: 0 },
      blink: 0,
      gazeX: 0.2,
      gazeY: 0,
    });
    expect(drawCount).toBe(2);
  });

  it("computes waterfall, token budget, experimental coverage, contradictions, and safe standing-order previews", async () => {
    const waterfall = buildTurnWaterfall({
      ms: { whole: 1000, firstWord: 220, stt: 150, llm: 450, tools: 200, tts: 100 },
    });
    expect(waterfall.find((s) => s.stage === "overhead")?.ms).toBe(100);

    const budget = buildTurnTokenBudget({ read: 1800, written: 200, held: 2000, prompt: 1800 }, 8192);
    expect(budget.remainingTokens).toBe(6192);

    const dir = mkdtempSync(join(tmpdir(), "astra-studio-ipc-"));
    try {
      const cfgStore = new ConfigStore(join(dir, "config.json"));
      const tier10Keys = Object.keys(cfgStore.value.tier10);
      for (const k of tier10Keys) {
        expect(k in EXPERIMENTAL_OPTION_DESCRIPTIONS).toBe(true);
      }

      const memStore = new MemoryStore(join(dir, "mem.json"));
      await memStore.save({ kind: "fact", text: "nas server ip is 192.168.50.10" });
      await memStore.save({ kind: "fact", text: "nas server ip is 192.168.50.99" });
      await memStore.save({ kind: "note" as "fact", text: "deploy pipeline uses rust build target release" });
      await memStore.save({ kind: "fact", text: "deploy pipeline uses rust build target release now" });

      const traces = new TraceKeeper(20);
      traces.add({
        at: new Date().toISOString(),
        kind: "user",
        said: "check disk usage",
        spoken: false,
        brain: "Standard",
        offered: ["run_command"],
        pickedFor: { run_command: "words" },
        calls: [{ tool: "run_command", input: '{"command":"df -h"}', result: "50%", outcome: "done", asked: false, ms: 18 }],
        reply: "Disk is 50% full.",
        checks: [],
        withheld: false,
        ms: { whole: 420, firstWord: 140, llm: 300, tools: 18 },
        tokens: { read: 512, written: 32, held: 544 },
      });

      const xray = buildTurnXraySnapshot({ traces, memoryStore: () => memStore });
      expect(xray.turns).toHaveLength(1);
      expect(xray.contradictions).toHaveLength(1);
      expect(findNearDuplicateMemories(memStore.all()).length).toBeGreaterThanOrEqual(1);

      const safeOrder = previewStandingOrderDraft(
        { config: cfgStore, orders: () => null, skills: () => null },
        {
          title: "Disk Check",
          where: "here",
          command: "df -h",
          address: "",
          tellWhen: "contains",
          value: "95%",
          everyMinutes: 10,
          repeat: false,
        },
      );
      expect(safeOrder.valid).toBe(true);

      const unsafeOrder = previewStandingOrderDraft(
        { config: cfgStore, orders: () => null, skills: () => null },
        {
          title: "Bad Order",
          where: "here",
          command: "rm -rf /",
          address: "",
          tellWhen: "fails",
          value: "",
          everyMinutes: 5,
          repeat: false,
        },
      );
      expect(unsafeOrder.valid).toBe(false);

      const policySnap = buildPolicyComposerSnapshot({
        config: cfgStore,
        orders: () => null,
        skills: () => null,
      });
      expect(policySnap.experimentalOptions.length).toBe(tier10Keys.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
