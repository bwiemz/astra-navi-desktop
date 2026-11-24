import { ipcMain } from "electron";
import type { Config, ConfigStore } from "../core/config.ts";
import { detectFactContradictions } from "../core/hygiene.ts";
import type { MemoryStore } from "../core/memory.ts";
import { auditSecurityRules } from "../core/ruleAudit.ts";
import type { CompiledSkillStore } from "../core/skillCompiler.ts";
import {
  describeCheck,
  describeCondition,
  makeOrder,
  type StandingOrders,
} from "../core/standingOrders.ts";
import type { TraceKeeper } from "../core/trace.ts";
import {
  buildTurnTokenBudget,
  buildTurnWaterfall,
  EXPERIMENTAL_OPTION_DESCRIPTIONS,
  findNearDuplicateMemories,
  type AvatarFramingEntryView,
  type AvatarStudioConfigPatch,
  type AvatarStudioSnapshot,
  type PolicyComposerSnapshot,
  type StandingOrderDraft,
  type StandingOrderPreviewResult,
  type TurnXraySnapshot,
} from "../shared/studioTools.ts";

/**
 * Backend IPC handlers and snapshot builders for the Turn X-Ray, Policy Composer,
 * and Avatar Studio tabs inside the consolidated Workbench window (`workbench.html`).
 */

export interface StudioToolsSnapshotDeps {
  config: ConfigStore;
  memoryStore(): MemoryStore | null;
  orders(): StandingOrders | null;
  skills(): CompiledSkillStore | null;
  traces: TraceKeeper;
}

export interface StudioToolsDeps extends StudioToolsSnapshotDeps {
  appOrigin: string;
  isAuthorizedSender?(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
}

export function buildAvatarStudioSnapshot(
  deps: Pick<StudioToolsSnapshotDeps, "config">,
  now = new Date(),
): AvatarStudioSnapshot {
  const cfg = deps.config.value;
  const framings: AvatarFramingEntryView[] = Object.entries(cfg.avatarFraming).map(
    ([modelHash, f]) => ({
      modelHash,
      scale: f.scale,
      offsetX: f.offsetX,
      offsetY: f.offsetY,
      rimLight: f.rimLight,
      outlineThickness: f.outlineThickness,
    }),
  );
  const firstKey = framings[0]?.modelHash ?? "default00";
  return {
    generatedAt: now.toISOString(),
    windowMode: cfg.windowMode,
    lowPowerStage: cfg.lowPowerStage,
    characterBundle: cfg.characterBundle,
    activeFramingKey: firstKey,
    framings,
    experimentalFlags: {
      phonemeVisemes: cfg.tier10.phonemeVisemes,
      nativeMultimodal: cfg.tier10.nativeMultimodal,
      fullDuplexVoice: cfg.tier10.fullDuplexVoice,
    },
  };
}

export function buildTurnXraySnapshot(
  deps: Pick<StudioToolsSnapshotDeps, "memoryStore" | "traces">,
  contextLimit = 8192,
  now = new Date(),
): TurnXraySnapshot {
  const safeLimit = Math.max(512, Math.floor(contextLimit));
  const nowMs = now.getTime();
  const recentTraces = deps.traces
    .list()
    .filter((t) => !t.withheld)
    .slice(-60)
    .reverse();

  const turns = recentTraces.map((trace, idx) => ({
    id: `${trace.at}#${idx}`,
    at: trace.at,
    kind: trace.kind,
    away: Boolean(trace.away),
    brain: trace.brain,
    spoken: trace.spoken,
    withheld: trace.withheld,
    said: trace.said.slice(0, 320),
    replyPreview: trace.reply.slice(0, 320),
    offeredTools: [...trace.offered],
    pickedReasons: Object.entries(trace.pickedFor ?? {}).map(([tool, reason]) => ({
      tool,
      reason,
    })),
    calls: trace.calls.map((c) => ({
      tool: c.tool,
      outcome: c.outcome,
      ...(c.gate ? { gate: c.gate } : {}),
      ...(c.gateReason ? { gateReason: c.gateReason } : {}),
      asked: c.asked,
      ms: c.ms,
      inputPreview: c.input.slice(0, 360),
      resultPreview: c.result.slice(0, 360),
    })),
    checks: trace.checks.map((ck) => ({ found: ck.found, did: ck.did })),
    waterfall: buildTurnWaterfall(trace),
    firstWordMs: trace.ms.firstWord,
    wholeMs: trace.ms.whole,
    tokenBudget: buildTurnTokenBudget(trace.tokens, safeLimit),
  }));

  const rawMemories = deps.memoryStore()?.all() ?? [];
  const memories = rawMemories.map((m) => {
    const updatedMs = Date.parse(m.updatedAt);
    const ageDays = Number.isFinite(updatedMs)
      ? Math.max(0, Math.round(((nowMs - updatedMs) / 86_400_000) * 10) / 10)
      : 0;
    return {
      id: m.id,
      kind: m.kind,
      text: m.text,
      points: [...m.points],
      tags: [...m.tags],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      hits: m.hits,
      pinned: Boolean(m.pinned),
      ...(m.namespace !== undefined ? { namespace: m.namespace } : {}),
      ageDays,
    };
  });

  const contradictions = detectFactContradictions(rawMemories);
  const nearDuplicates = findNearDuplicateMemories(rawMemories);

  return {
    generatedAt: now.toISOString(),
    contextLimit: safeLimit,
    turns,
    memories,
    contradictions,
    nearDuplicates,
  };
}

export function previewStandingOrderDraft(
  deps: Pick<StudioToolsSnapshotDeps, "config" | "orders" | "skills">,
  draft: StandingOrderDraft,
  now = new Date(),
): StandingOrderPreviewResult {
  const machines = deps.config.value.fleet.machines;
  const made = makeOrder(
    {
      title: draft.title,
      where: draft.where,
      ...(draft.command.trim() ? { command: draft.command } : {}),
      ...(draft.address.trim() ? { address: draft.address } : {}),
      tellWhen: draft.tellWhen,
      value: draft.value,
      everyMinutes: draft.everyMinutes,
      repeat: draft.repeat,
    },
    machines,
    now,
  );
  if ("problem" in made) {
    return {
      valid: false,
      problem: made.problem,
      checkSummary: null,
      conditionSummary: null,
      auditFindings: [],
    };
  }
  const audit = auditSecurityRules({
    config: deps.config.value,
    standingOrders: [...(deps.orders()?.list() ?? []), made.order],
    compiledSkills: [...(deps.skills()?.list() ?? [])],
  });
  return {
    valid: true,
    problem: null,
    checkSummary: describeCheck(made.order.check),
    conditionSummary: describeCondition(made.order),
    auditFindings: audit.findings.filter((f) => f.subject.includes(made.order.id) || f.code.startsWith("STANDING_ORDER")),
  };
}

export function buildPolicyComposerSnapshot(
  deps: Pick<StudioToolsSnapshotDeps, "config" | "orders" | "skills">,
  now = new Date(),
): PolicyComposerSnapshot {
  const cfg = deps.config.value;
  const orderList = [...(deps.orders()?.list() ?? [])];
  const skillList = [...(deps.skills()?.list() ?? [])];
  const audit = auditSecurityRules({
    config: cfg,
    standingOrders: orderList,
    compiledSkills: skillList,
  });

  const experimentalOptions = (
    Object.keys(EXPERIMENTAL_OPTION_DESCRIPTIONS) as (keyof Config["tier10"])[]
  ).map((key) => ({
    key,
    title: EXPERIMENTAL_OPTION_DESCRIPTIONS[key].title,
    summary: EXPERIMENTAL_OPTION_DESCRIPTIONS[key].summary,
    riskTier: EXPERIMENTAL_OPTION_DESCRIPTIONS[key].riskTier,
    enabled: cfg.tier10[key],
  }));

  return {
    generatedAt: now.toISOString(),
    handsOff: cfg.handsOff,
    machines: cfg.fleet.machines.map((m) => ({
      id: m.id,
      name: m.name,
      host: m.host,
      port: m.port,
      user: m.user,
    })),
    orders: orderList.map((o) => ({
      id: o.id,
      title: o.title,
      checkSummary: describeCheck(o.check),
      conditionSummary: describeCondition(o),
      everyMinutes: o.everyMinutes,
      repeat: o.repeat,
      held: o.held,
      lastCheckedAt: o.lastCheckedAt,
    })),
    experimentalOptions,
    auditOk: audit.ok,
    auditCounts: audit.counts,
    auditFindings: audit.findings,
  };
}

export interface StudioToolsIpcController {
  registerIpc(): void;
}

export function createStudioToolsIpc(deps: StudioToolsDeps): StudioToolsIpcController {
  let ipcRegistered = false;

  function fromStudioToolsWindow(
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ): boolean {
    return deps.isAuthorizedSender ? deps.isAuthorizedSender(event) : false;
  }

  function registerIpc(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle("studio:avatar-snapshot", (event): AvatarStudioSnapshot => {
      if (!fromStudioToolsWindow(event)) {
        throw new Error("Unauthorized IPC sender for Studio Tools.");
      }
      return buildAvatarStudioSnapshot(deps);
    });

    ipcMain.handle(
      "studio:avatar-update",
      async (
        event,
        patch: AvatarStudioConfigPatch,
      ): Promise<{ ok: boolean; message: string }> => {
        if (!fromStudioToolsWindow(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        try {
          const nextPatch: Partial<Config> = {};
          if (patch.windowMode === "floating" || patch.windowMode === "solid-docked") {
            nextPatch.windowMode = patch.windowMode;
          }
          if (typeof patch.lowPowerStage === "boolean") {
            nextPatch.lowPowerStage = patch.lowPowerStage;
          }
          if (patch.framing && /^[a-f0-9]{8,64}$/.test(patch.framing.modelHash)) {
            const clamp = (n: number, min: number, max: number): number =>
              Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
            nextPatch.avatarFraming = {
              ...deps.config.value.avatarFraming,
              [patch.framing.modelHash]: {
                scale: clamp(patch.framing.scale, 0.45, 2.2),
                offsetX: clamp(patch.framing.offsetX, -0.6, 0.6),
                offsetY: clamp(patch.framing.offsetY, -0.6, 0.6),
                rimLight: clamp(patch.framing.rimLight, 0.4, 1.8),
                outlineThickness: clamp(patch.framing.outlineThickness, 0, 2.5),
              },
            };
          }
          await deps.config.update(nextPatch);
          return { ok: true, message: "Saved Avatar Studio preferences." };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
    );

    ipcMain.handle(
      "studio:xray-snapshot",
      (event, contextLimit?: number): TurnXraySnapshot => {
        if (!fromStudioToolsWindow(event)) {
          throw new Error("Unauthorized IPC sender for Turn X-Ray.");
        }
        return buildTurnXraySnapshot(deps, contextLimit);
      },
    );

    ipcMain.handle(
      "studio:xray-resolve-conflict",
      async (
        event,
        keepId: string,
        dropIds: string[],
      ): Promise<{ ok: boolean; message: string }> => {
        if (!fromStudioToolsWindow(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const mem = deps.memoryStore();
        if (!mem) return { ok: false, message: "Memory store unavailable." };
        const cleanDrops = Array.isArray(dropIds)
          ? dropIds.filter((id) => typeof id === "string" && id !== keepId)
          : [];
        if (cleanDrops.length === 0) {
          return { ok: false, message: "No conflicting duplicate IDs selected to remove." };
        }
        const removed = await mem.forgetIds(cleanDrops);
        return {
          ok: removed > 0,
          message:
            removed > 0
              ? `Kept ${keepId} and removed ${removed} superseded note(s).`
              : "No matching notes were removed.",
        };
      },
    );

    ipcMain.handle("studio:policy-snapshot", (event): PolicyComposerSnapshot => {
      if (!fromStudioToolsWindow(event)) {
        throw new Error("Unauthorized IPC sender for Policy Composer.");
      }
      return buildPolicyComposerSnapshot(deps);
    });

    ipcMain.handle(
      "studio:policy-preview-order",
      (event, draft: StandingOrderDraft): StandingOrderPreviewResult => {
        if (!fromStudioToolsWindow(event)) {
          throw new Error("Unauthorized IPC sender for Policy Composer.");
        }
        return previewStandingOrderDraft(deps, draft);
      },
    );

    ipcMain.handle(
      "studio:policy-create-order",
      async (event, draft: StandingOrderDraft): Promise<{ ok: boolean; message: string }> => {
        if (!fromStudioToolsWindow(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const orderStore = deps.orders();
        if (!orderStore) return { ok: false, message: "Standing orders store unavailable." };
        const made = makeOrder(
          {
            title: draft.title,
            where: draft.where,
            ...(draft.command.trim() ? { command: draft.command } : {}),
            ...(draft.address.trim() ? { address: draft.address } : {}),
            tellWhen: draft.tellWhen,
            value: draft.value,
            everyMinutes: draft.everyMinutes,
            repeat: draft.repeat,
          },
          deps.config.value.fleet.machines,
          new Date(),
        );
        if ("problem" in made) {
          return { ok: false, message: made.problem };
        }
        try {
          await orderStore.add(made.order);
          return { ok: true, message: `Added standing order "${made.order.title}".` };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
    );

    ipcMain.handle(
      "studio:policy-cancel-order",
      async (event, id: string): Promise<{ ok: boolean; message: string }> => {
        if (!fromStudioToolsWindow(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const orderStore = deps.orders();
        if (!orderStore) return { ok: false, message: "Standing orders store unavailable." };
        const ok = await orderStore.cancel(id);
        return { ok: ok, message: ok ? "Standing order cancelled." : "Standing order not found." };
      },
    );

    ipcMain.handle(
      "studio:policy-set-flag",
      async (
        event,
        flag: keyof Config["tier10"],
        enabled: boolean,
      ): Promise<{ ok: boolean; message: string }> => {
        if (!fromStudioToolsWindow(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        if (!(flag in EXPERIMENTAL_OPTION_DESCRIPTIONS)) {
          return { ok: false, message: `Unknown experimental flag "${String(flag)}".` };
        }
        await deps.config.update({
          tier10: {
            ...deps.config.value.tier10,
            [flag]: Boolean(enabled),
          },
        });
        return {
          ok: true,
          message: `${EXPERIMENTAL_OPTION_DESCRIPTIONS[flag].title} ${enabled ? "enabled" : "disabled"}.`,
        };
      },
    );
  }

  return {
    registerIpc,
  };
}
