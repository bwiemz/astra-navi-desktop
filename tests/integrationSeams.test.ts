import { describe, expect, it, vi } from "vitest";
import { TOOLS } from "../src/core/permissions.ts";
import { SemanticCommandCache } from "../src/core/semanticCache.ts";
import {
  createPlanConsensusHook,
  createSemanticCacheHook,
  TurnHookPipeline,
  type TurnHookContext,
} from "../src/core/turnHooks.ts";
import { ProceduralAvatarController } from "../src/renderer/src/avatarAnimator.ts";
import { Canvas2DAvatarRenderer, type Canvas2DContextLike } from "../src/renderer/src/canvas2dStage.ts";
import {
  createAvatarAnimatorLayer,
  createCanvas2DLayer,
  createStageLightingLayer,
  createVrmaBridgeLayer,
  StageLayerManager,
  type StageLayerFrameContext,
  type StageLayerHost,
} from "../src/renderer/src/stageLayers.ts";
import { StageLightingController } from "../src/renderer/src/stageLighting.ts";
import { VrmaStageBridge } from "../src/renderer/src/vrmaStageBridge.ts";
import type { StageLightingState } from "../src/shared/spatialStage.ts";

function makeTurnContext(overrides: Partial<TurnHookContext> = {}): TurnHookContext {
  return {
    userText: "Check the weather today",
    spoken: false,
    isEvent: false,
    away: false,
    readOutsideText: false,
    handsOff: false,
    offeredTools: [TOOLS.weather, TOOLS.runCommand],
    usedTools: [],
    replyText: "",
    falseClaim: false,
    flags: {},
    ...overrides,
  };
}

describe("TurnHookPipeline integration seams", () => {
  it("populates SemanticCommandCache on clean turns and short-circuits recurring queries while bypassing taint/handsOff/events", async () => {
    const cache = new SemanticCommandCache();
    let enabled = true;
    const pipeline = new TurnHookPipeline();

    pipeline.register({
      id: "narrow-tools",
      beforeRoute(ctx) {
        if (!ctx.isEvent) return { offeredTools: [TOOLS.weather] };
      },
    });
    pipeline.register(
      createSemanticCacheHook(
        cache,
        () => enabled,
        (hit) => `Cached dispatch: ${hit.tool}(${JSON.stringify(hit.args ?? {})})`,
      ),
    );

    // 1. Clean single-tool turn populates the cache in beforeCommit
    const learnCtx = makeTurnContext({
      userText: "Check the weather today",
      usedTools: [TOOLS.weather],
      replyText: "Sunny and 72F.",
      flags: { lastToolArgs: { location: "NYC" } },
    });
    const firstRoute = await pipeline.runBeforeRoute(learnCtx);
    expect(firstRoute.offeredTools).toEqual([TOOLS.weather]);
    expect(firstRoute.shortCircuitReply).toBeUndefined();
    await pipeline.runBeforeCommit(learnCtx);
    expect(cache.size).toBe(1);

    // 2. False-claim turn must NOT populate the cache
    const fakeCtx = makeTurnContext({
      userText: "What is on my agenda today",
      usedTools: [TOOLS.agenda],
      falseClaim: true,
    });
    await pipeline.runBeforeCommit(fakeCtx);
    expect(cache.size).toBe(1);

    // 3. Matching query hits beforeRoute and returns short-circuit reply
    const hitCtx = makeTurnContext({ userText: "check the weather today?" });
    const hitRoute = await pipeline.runBeforeRoute(hitCtx);
    expect(hitCtx.cachedHit?.hit).toBe(true);
    expect(hitRoute.shortCircuitReply).toBe(`Cached dispatch: ${TOOLS.weather}({"location":"NYC"})`);

    // 4. Unconditional bypass on tainted, handsOff, or event turns
    for (const bypassCtx of [
      makeTurnContext({ readOutsideText: true }),
      makeTurnContext({ handsOff: true }),
      makeTurnContext({ isEvent: true }),
    ]) {
      const res = await pipeline.runBeforeRoute(bypassCtx);
      expect(res.shortCircuitReply).toBeUndefined();
      if (!bypassCtx.isEvent) {
        expect(bypassCtx.cachedHit?.hit).toBe(false);
      }
      await pipeline.runBeforeCommit({
        ...bypassCtx,
        usedTools: [TOOLS.agenda],
        falseClaim: false,
      });
    }
    expect(cache.size).toBe(1);

    // 5. Feature flag off stops cache lookup/recording
    enabled = false;
    const disabledCtx = makeTurnContext();
    const disabledRes = await pipeline.runBeforeRoute(disabledCtx);
    expect(disabledRes.shortCircuitReply).toBeUndefined();
    expect(disabledCtx.cachedHit).toBeUndefined();
  });

  it("evaluates plan consensus agreement/disagreement and isolates throwing hooks", async () => {
    const pipeline = new TurnHookPipeline();
    let agreeMode = true;

    pipeline.register({
      id: "faulty-hook",
      beforeRoute() {
        throw new Error("boom route");
      },
      afterPlan() {
        throw new Error("boom plan");
      },
      beforeCommit() {
        throw new Error("boom commit");
      },
    });
    pipeline.register(
      createPlanConsensusHook(
        () => true,
        () =>
          agreeMode
            ? [
                { commands: ["systemctl restart caddy"], targetPaths: ["/etc/caddy/Caddyfile"] },
                { commands: ["  systemctl  restart caddy  "], targetPaths: ["/etc/caddy/Caddyfile"] },
              ]
            : [
                { commands: ["rm -rf /tmp/a"], targetPaths: ["/tmp/a"] },
                { commands: ["rm -rf /tmp/b"], targetPaths: ["/tmp/b"] },
              ],
      ),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const ctxAgree = makeTurnContext();
      await pipeline.runBeforeRoute(ctxAgree);
      const afterAgree = await pipeline.runAfterPlan(ctxAgree);
      expect(afterAgree.requireManualReview).toBe(false);
      expect(ctxAgree.consensusVerdict?.agreed).toBe(true);
      expect(ctxAgree.flags.consensusRequireManualReview).toBe(false);

      agreeMode = false;
      const ctxDisagree = makeTurnContext();
      const afterDisagree = await pipeline.runAfterPlan(ctxDisagree);
      expect(afterDisagree.requireManualReview).toBe(true);
      expect(ctxDisagree.consensusVerdict?.agreed).toBe(false);
      expect(ctxDisagree.consensusVerdict?.disagreements.length).toBeGreaterThan(0);

      await expect(pipeline.runBeforeCommit(ctxDisagree)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("StageLayerManager integration seams", () => {
  it("runs animator, vrma-bridge, lighting, and canvas-2d layers in priority order with lifecycle and error isolation", async () => {
    const callOrder: string[] = [];
    const manager = new StageLayerManager();

    const host: StageLayerHost = {
      canvas: {} as HTMLCanvasElement,
      scene: {},
      camera: {},
      skyLight: {},
      sunLight: {},
    };
    const mountSpy = vi.fn();
    const disposeSpy = vi.fn();
    manager.attachHost(host);

    const animCtrl = new ProceduralAvatarController();
    animCtrl.setLookTarget(15, -5);
    const vrmaBridge = new VrmaStageBridge();
    vrmaBridge.controller.playClip({
      name: "wave",
      specVersion: "1.0",
      durationSec: 1,
      humanoidRotations: {
        head: {
          times: new Float32Array([0, 1]),
          values: new Float32Array([0, 0, 0, 1, 0, 0.2588, 0, 0.9659]),
        },
      },
      hipsTranslation: null,
      expressions: {},
      lookAt: null,
    });
    const lightingCtrl = new StageLightingController({ smoothingAlpha: 1, screenStrength: 0.4 });
    const ctx2d: Canvas2DContextLike = {
      globalAlpha: 1,
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
    };
    const renderer2d = new Canvas2DAvatarRenderer({ ctx: ctx2d });
    await renderer2d.load({
      version: 1,
      name: "test-sprite",
      width: 256,
      height: 256,
      layers: [{ id: "body", asset: "body.png", zIndex: 0, anchorX: 0.5, anchorY: 0.5, opacity: 1, role: "body" }],
      visemeAssets: {},
      moodOverlays: {},
    });

    manager.register(
      createCanvas2DLayer(renderer2d, undefined, { priority: 40 }),
    );
    manager.register({
      id: "faulty-layer",
      priority: 15,
      enabled: true,
      mount: mountSpy,
      update() {
        callOrder.push("faulty");
        throw new Error("layer boom");
      },
      dispose: disposeSpy,
    });
    manager.register(
      createStageLightingLayer(lightingCtrl, () => ({ now: new Date("2026-06-01T14:00:00") }), {
        priority: 30,
      }),
    );
    manager.register(createVrmaBridgeLayer(vrmaBridge, { priority: 20 }));
    manager.register(
      createAvatarAnimatorLayer(animCtrl, {
        priority: 10,
        onPose: (_pose, frame) => {
          callOrder.push("animator");
          frame.setBoneRotation("spine", [0, 0, 0, 1]);
        },
      }),
    );

    expect(mountSpy).toHaveBeenCalledWith(host);
    expect(manager.list().map((l) => l.id)).toEqual([
      "avatar-animator",
      "faulty-layer",
      "vrma-bridge",
      "stage-lighting",
      "canvas-2d",
    ]);

    const boneCalls: Array<[string, readonly number[]]> = [];
    let appliedLighting: StageLightingState | null = null;
    const frame: StageLayerFrameContext = {
      dtSec: 0.016,
      elapsedSec: 0.5,
      mood: "happy",
      thinking: false,
      listening: true,
      asleep: false,
      voiceLevel: 0.6,
      mouthOpen: 0.5,
      hasModel: true,
      setBoneRotation: (bone, quat) => boneCalls.push([bone, quat]),
      setMorphWeight: () => undefined,
      applyLighting: (state) => {
        callOrder.push("lighting");
        appliedLighting = state;
      },
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      manager.update(frame);
      expect(callOrder).toEqual(["animator", "faulty", "lighting"]);
      expect(boneCalls.some(([bone]) => bone === "head")).toBe(true);
      expect(appliedLighting).not.toBeNull();
      expect(ctx2d.drawImage).toHaveBeenCalled();

      // Disable faulty layer + verify it skips update
      callOrder.length = 0;
      expect(manager.setEnabled("faulty-layer", false)).toBe(true);
      manager.update(frame);
      expect(callOrder).toEqual(["animator", "lighting"]);

      // Unregister & dispose invoke cleanup hooks cleanly
      expect(manager.unregister("faulty-layer")).toBe(true);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      manager.dispose();
      expect(manager.list()).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
