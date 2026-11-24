import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { ipcMain } from "electron";
import { resolve } from "node:path";
import type { Brain } from "../core/brain.ts";
import type { ConfigStore } from "../core/config.ts";
import type { EpisodicGraph } from "../core/episodic.ts";
import type { MemoryKind, MemoryStore } from "../core/memory.ts";
import type { ApprovalDesk } from "../core/missionApproval.ts";
import { describeWake, type MissionBoard } from "../core/missionPlan.ts";
import type { PolicyContext } from "../core/permissions.ts";
import type { Recall } from "../core/recall.ts";
import {
  loadReplayBundle,
  replaySession,
  type ReplayDecision,
  type ReplaySnapshot,
} from "../core/replay.ts";
import { isInside } from "../core/riskRules.ts";
import { auditSecurityRules } from "../core/ruleAudit.ts";
import type { CompiledSkillStore } from "../core/skillCompiler.ts";
import {
  describeCheck,
  describeCondition,
  type StandingOrder,
  type StandingOrders,
} from "../core/standingOrders.ts";
import { compareText } from "../core/textDiff.ts";
import type { CallGate, TraceKeeper, TurnTrace } from "../core/trace.ts";
import {
  buildMissionDagEdges,
  buildPolicyConflictGraph,
  type CompiledSkillInspectorItem,
  type EpisodeInspectorItem,
  type MemoryInspectorItem,
  type MissionControlAction,
  type MissionControlActionResult,
  type MissionControlSnapshot,
  type MissionDagView,
  type MissionStepNodeView,
  type PolicyConflictGraph,
  type ReplayInspectResult,
  type ReplayTurnView,
  type StandingOrderInspectorItem,
} from "../shared/missionControl.ts";

/**
 * Backend IPC controller and hardened BrowserWindow lifecycle for the standalone
 * Mission Control & Memory Inspector window (`mission-control.html`).
 */

export interface MissionControlSnapshotDeps {
  config: ConfigStore;
  board(): MissionBoard | null;
  approvalDesk(): ApprovalDesk | null;
  memoryStore(): MemoryStore | null;
  episodic(): EpisodicGraph | null;
  orders(): StandingOrders | null;
  skills(): CompiledSkillStore | null;
  traces: TraceKeeper;
}

export interface MissionControlDeps extends MissionControlSnapshotDeps {
  appOrigin: string;
  dataDir(): string;
  workspaceDir: string;
  recall(): Recall | null;
  brain(): Brain | null;
  /** External sender-authorization guard provided by the single Workbench window controller. */
  isAuthorizedSender?(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
}

function summarizeOrderTarget(order: StandingOrder): string {
  return describeCheck(order.check);
}

function gateToReplayDecision(gate: CallGate | undefined, asked: boolean): ReplayDecision {
  if (gate === "refused") return "blocked";
  if (gate === "ask-allowed" || gate === "ask-declined") return "ask";
  if (gate === "allow") return "allow";
  return asked ? "ask" : "allow";
}

function safeParseArgs(rawJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON or truncated trace inputs are treated as empty args.
  }
  return {};
}

function stableTurnId(trace: TurnTrace, index: number): string {
  const hash = createHash("sha1")
    .update(`${trace.at}\n${index}\n${trace.said.slice(0, 120)}`)
    .digest("hex")
    .slice(0, 10);
  return `turn-${index + 1}-${hash}`;
}

export function tracesToReplaySnapshots(traces: readonly TurnTrace[]): ReplaySnapshot[] {
  const snapshots: ReplaySnapshot[] = [];
  for (let i = 0; i < traces.length; i += 1) {
    const trace = traces[i];
    if (!trace || trace.withheld) continue;
    snapshots.push({
      version: 1,
      id: stableTurnId(trace, i),
      recordedAt: trace.at,
      prompt: trace.said,
      offeredTools: [...trace.offered],
      trace: {
        ...trace,
        offered: [...trace.offered],
        calls: trace.calls.map((c) => ({ ...c })),
        checks: trace.checks.map((ck) => ({ ...ck })),
      },
      verdicts: trace.calls.map((call) => ({
        tool: call.tool,
        args: safeParseArgs(call.input),
        expectedDecision: gateToReplayDecision(call.gate, call.asked),
      })),
    });
  }
  return snapshots;
}

function buildStepDiffPreview(command: string, output: string, prevOutput: string): string | null {
  const cleanOut = output.trim();
  if (!cleanOut && !prevOutput.trim()) return null;
  if (prevOutput.trim()) {
    const diff = compareText(prevOutput.trim(), cleanOut, { context: 2, maxLines: 24 });
    if (!diff.same && diff.text) return diff.text;
  }
  if (!cleanOut) return null;
  const cmdDiff = compareText(`$ ${command}`, `$ ${command}\n${cleanOut}`, {
    context: 1,
    maxLines: 20,
  });
  return cmdDiff.text || cleanOut.slice(0, 500);
}

/** Builds a serializable Mission Control snapshot from live core stores without side effects. */
export function buildMissionControlSnapshot(
  deps: MissionControlSnapshotDeps,
  now = new Date(),
): MissionControlSnapshot {
  const pendingCards = deps.approvalDesk()?.allCards() ?? [];
  const cardByMissionId = new Map<string, string>();
  for (const card of pendingCards) {
    if (!cardByMissionId.has(card.missionId)) {
      cardByMissionId.set(card.missionId, card.id);
    }
  }

  const missions: MissionDagView[] = (deps.board()?.list() ?? []).map((mission) => {
    const nodes: MissionStepNodeView[] = mission.steps.map((step, idx) => {
      const prevOutput = idx > 0 ? (mission.steps[idx - 1]?.output ?? "") : "";
      const approvedSummary = step.approved
        ? `Approved ${step.approved.by.from === "pc" ? "at PC" : `on ${step.approved.by.name}`} (${step.approved.at.slice(0, 19).replace("T", " ")})`
        : null;
      return {
        index: idx,
        title: step.title,
        where: step.where,
        whereName: step.whereName,
        command: step.command,
        state: step.state,
        retries: step.retries,
        tried: step.tried,
        outputPreview: step.output.slice(-600),
        finishedAt: step.finishedAt,
        approvedSummary,
        diffPreview: buildStepDiffPreview(step.command, step.output, prevOutput),
      };
    });

    const pendingApprovalId = cardByMissionId.get(mission.id) ?? null;
    const isTerminal = mission.state === "completed" || mission.state === "cancelled";
    const canPauseOrCancel = !isTerminal;
    const canResume = mission.state === "blocked";
    const canRollback =
      mission.steps.length > 0 &&
      mission.steps.some((step) => step.state !== "waiting");

    return {
      id: mission.id,
      title: mission.title,
      goal: mission.goal,
      state: mission.state,
      createdAt: mission.createdAt,
      finishedAt: mission.finishedAt,
      note: mission.note,
      yieldToGames: mission.yieldToGames,
      pinnedToDevices: Boolean(mission.pinnedToDevices),
      wakeDescription: mission.wake ? describeWake(mission.wake) : null,
      nodes,
      edges: buildMissionDagEdges(mission.steps),
      thread: [...(mission.thread ?? [])].slice(-25),
      pendingApprovalId,
      canApprove: pendingApprovalId !== null && mission.state === "awaiting_approval",
      canPauseOrCancel,
      canResume,
      canRollback,
    };
  });

  const memories: MemoryInspectorItem[] = (deps.memoryStore()?.all() ?? []).map((mem) => ({
    id: mem.id,
    kind: mem.kind,
    text: mem.text,
    points: [...mem.points],
    tags: [...mem.tags],
    createdAt: mem.createdAt,
    updatedAt: mem.updatedAt,
    hits: mem.hits,
    pinned: Boolean(mem.pinned),
    ...(mem.namespace ? { namespace: mem.namespace } : {}),
  }));

  const episodic = deps.episodic();
  const episodes: EpisodeInspectorItem[] = (episodic?.listRecent(60) ?? []).map((ep) => ({
    id: ep.id,
    at: ep.at,
    kind: ep.kind,
    contextBucket: ep.contextBucket,
    activeApp: ep.activeApp,
    mode: ep.mode,
    summary: ep.summary,
    actionKey: ep.actionKey,
  }));
  const thresholds = episodic?.listThresholds() ?? [];

  const orderList = deps.orders()?.list() ?? [];
  const standingOrders: StandingOrderInspectorItem[] = orderList.map((order) => ({
    id: order.id,
    title: order.title,
    target: summarizeOrderTarget(order),
    everyMinutes: order.everyMinutes,
    conditionSummary: describeCondition(order),
    lastCheckedAt: order.lastCheckedAt,
    held: Boolean(order.held),
  }));

  const skillList = deps.skills()?.list() ?? [];
  const compiledSkills: CompiledSkillInspectorItem[] = skillList.map((skill) => ({
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    status: skill.status,
    requiredCapabilities: [...skill.requiredCapabilities],
    stepCount: skill.steps.length,
    updatedAt: skill.updatedAt,
    driftReason: skill.driftReason,
  }));

  const auditReport = auditSecurityRules({
    config: deps.config.value,
    standingOrders: orderList,
    compiledSkills: skillList,
  });
  const policyGraph = buildPolicyConflictGraph({
    ok: auditReport.ok,
    counts: auditReport.counts,
    findings: auditReport.findings,
    orderIds: orderList.map((o) => o.id),
    skillSlugs: skillList.map((s) => s.slug),
  });

  const recentTraces = deps.traces.list().filter((t) => !t.withheld);
  const recentTurns: ReplayTurnView[] = recentTraces.map((trace, idx) => ({
    id: stableTurnId(trace, idx),
    at: trace.at,
    said: trace.said.slice(0, 240),
    brain: trace.brain,
    offered: [...trace.offered],
    calls: trace.calls.map((c) => ({
      tool: c.tool,
      outcome: c.outcome,
      ...(c.gate ? { gate: c.gate } : {}),
      asked: c.asked,
      ms: c.ms,
    })),
    replyPreview: trace.reply.slice(0, 240),
    checks: trace.checks.length,
  }));

  return {
    generatedAt: now.toISOString(),
    missions,
    memories,
    episodes,
    thresholds,
    standingOrders,
    compiledSkills,
    policyGraph,
    recentTurns,
  };
}

export interface MissionControlIpcController {
  registerIpc(): void;
}

export function createMissionControlIpc(deps: MissionControlDeps): MissionControlIpcController {
  let ipcRegistered = false;

  function fromMissionControlWindow(
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ): boolean {
    return deps.isAuthorizedSender ? deps.isAuthorizedSender(event) : false;
  }

  function defaultPolicyContext(): PolicyContext {
    return (
      deps.brain()?.standingPolicy() ?? {
        workspace: deps.workspaceDir,
        privateDirs: [deps.dataDir()],
        handsOff: deps.config.value.handsOff,
        maySeeScreen: deps.config.value.sight.withoutAsking,
        machines: () => deps.config.value.fleet.machines,
      }
    );
  }

  function runPolicyVerify(): PolicyConflictGraph {
    const orderList = deps.orders()?.list() ?? [];
    const skillList = deps.skills()?.list() ?? [];
    const audit = auditSecurityRules({
      config: deps.config.value,
      standingOrders: orderList,
      compiledSkills: skillList,
    });
    return buildPolicyConflictGraph({
      ok: audit.ok,
      counts: audit.counts,
      findings: audit.findings,
      orderIds: orderList.map((o) => o.id),
      skillSlugs: skillList.map((s) => s.slug),
    });
  }

  function registerIpc(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle("mc:snapshot", (event): MissionControlSnapshot => {
      if (!fromMissionControlWindow(event)) {
        throw new Error("Unauthorized IPC sender for Mission Control.");
      }
      return buildMissionControlSnapshot(deps);
    });

    ipcMain.handle(
      "mc:mission-action",
      async (
        event,
        id: string,
        action: MissionControlAction,
      ): Promise<MissionControlActionResult> => {
        if (!fromMissionControlWindow(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        if (typeof id !== "string" || !id.trim()) {
          return { ok: false, message: "Invalid mission ID." };
        }
        const board = deps.board();
        if (!board) return { ok: false, message: "Mission board not initialized." };

        switch (action) {
          case "approve": {
            const desk = deps.approvalDesk();
            const card = desk?.allCards().find((c) => c.missionId === id);
            if (!desk || !card) {
              return { ok: false, message: "No open approval question for this mission." };
            }
            const ok = desk.answerFromPc(card.id, true);
            return {
              ok,
              message: ok ? "Approved step from Mission Control." : "Approval card was already answered.",
            };
          }
          case "pause": {
            const ok = await board.pause(id);
            return { ok, message: ok ? "Mission paused at checkpoint." : "Mission cannot be paused." };
          }
          case "resume": {
            const ok = await board.resume(id);
            return { ok, message: ok ? "Mission resumed." : "Mission is not blocked/paused." };
          }
          case "cancel": {
            const ok = await board.cancel(id, { from: "pc" });
            return { ok, message: ok ? "Mission cancelled." : "Mission already finished." };
          }
          case "rollback": {
            const ok = await board.rollback(id);
            return { ok, message: ok ? "Rolled back to checkpoint." : "Nothing to roll back." };
          }
          default:
            return { ok: false, message: "Unknown mission action." };
        }
      },
    );

    ipcMain.handle(
      "mc:memory-upsert",
      async (
        event,
        input: { id?: string; kind: MemoryKind; text: string },
      ): Promise<{ ok: boolean; message: string }> => {
        if (!fromMissionControlWindow(event)) return { ok: false, message: "Unauthorized caller." };
        const memStore = deps.memoryStore();
        if (!memStore) return { ok: false, message: "Memory store unavailable." };
        const cleanText = typeof input?.text === "string" ? input.text.trim() : "";
        if (!cleanText) return { ok: false, message: "Memory text cannot be empty." };

        if (input.id) {
          const updated = await memStore.update(input.id, cleanText);
          if (!updated) return { ok: false, message: "Memory entry not found." };
          void deps.recall()?.warm().catch(() => undefined);
          return { ok: true, message: "Updated memory entry." };
        }
        const saved = await memStore.save({ kind: input.kind, text: cleanText });
        void deps.recall()?.warm().catch(() => undefined);
        return { ok: true, message: saved.merged ? "Merged into existing memory." : "Saved new memory." };
      },
    );

    ipcMain.handle(
      "mc:memory-pin",
      async (event, id: string, pinned: boolean): Promise<{ ok: boolean; message: string }> => {
        if (!fromMissionControlWindow(event)) return { ok: false, message: "Unauthorized caller." };
        const memStore = deps.memoryStore();
        if (!memStore) return { ok: false, message: "Memory store unavailable." };
        const updated = await memStore.pin(id, Boolean(pinned));
        if (!updated) return { ok: false, message: "Memory entry not found." };
        return { ok: true, message: updated.pinned ? "Pinned memory." : "Unpinned memory." };
      },
    );

    ipcMain.handle(
      "mc:memory-delete",
      async (event, id: string): Promise<{ ok: boolean; message: string }> => {
        if (!fromMissionControlWindow(event)) return { ok: false, message: "Unauthorized caller." };
        const memStore = deps.memoryStore();
        if (!memStore) return { ok: false, message: "Memory store unavailable." };
        const removed = await memStore.forget(id);
        if (removed) deps.recall()?.drop([id]);
        return { ok: removed, message: removed ? "Deleted memory entry." : "Memory entry not found." };
      },
    );

    ipcMain.handle(
      "mc:episode-delete",
      (event, id: number): { ok: boolean; message: string } => {
        if (!fromMissionControlWindow(event)) return { ok: false, message: "Unauthorized caller." };
        const episodic = deps.episodic();
        if (!episodic) return { ok: false, message: "Episodic graph unavailable." };
        const ok = episodic.deleteEpisode(id);
        return { ok, message: ok ? "Deleted episode." : "Episode not found." };
      },
    );

    ipcMain.handle(
      "mc:order-cancel",
      async (event, id: string): Promise<{ ok: boolean; message: string }> => {
        if (!fromMissionControlWindow(event)) return { ok: false, message: "Unauthorized caller." };
        const orderStore = deps.orders();
        if (!orderStore) return { ok: false, message: "Standing orders unavailable." };
        const ok = await orderStore.cancel(id);
        return { ok, message: ok ? "Standing order cancelled." : "Standing order not found." };
      },
    );

    ipcMain.handle(
      "mc:skill-action",
      async (event, id: string, action: "ratify" | "revoke"): Promise<{ ok: boolean; message: string }> => {
        if (!fromMissionControlWindow(event)) return { ok: false, message: "Unauthorized caller." };
        const skillStore = deps.skills();
        if (!skillStore) return { ok: false, message: "Compiled skills store unavailable." };
        try {
          if (action === "ratify") {
            const skill = await skillStore.ratify(id);
            return { ok: true, message: `Ratified skill "${skill.slug}".` };
          }
          const skill = await skillStore.revoke(id);
          return { ok: true, message: `Revoked skill "${skill.slug}".` };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
    );

    ipcMain.handle("mc:policy-verify", (event): PolicyConflictGraph => {
      if (!fromMissionControlWindow(event)) {
        throw new Error("Unauthorized caller.");
      }
      return runPolicyVerify();
    });

    ipcMain.handle(
      "mc:replay-inspect",
      async (event, bundlePath?: string): Promise<ReplayInspectResult> => {
        if (!fromMissionControlWindow(event)) {
          return { ok: false, report: null, message: "Unauthorized caller." };
        }
        const ctx = defaultPolicyContext();
        try {
          let snapshots: ReplaySnapshot[];
          if (typeof bundlePath === "string" && bundlePath.trim()) {
            const allowedRoot = resolve(deps.dataDir(), "replays");
            const target = resolve(allowedRoot, bundlePath.trim());
            const rootReal = existsSync(allowedRoot) ? realpathSync(allowedRoot) : allowedRoot;
            const targetReal = existsSync(target) ? realpathSync(target) : target;
            if (!isInside(target, allowedRoot) || !isInside(targetReal, rootReal)) {
              return {
                ok: false,
                report: null,
                message: `Refused replay path outside ${allowedRoot}.`,
              };
            }
            snapshots = await loadReplayBundle(targetReal);
          } else {
            snapshots = tracesToReplaySnapshots(deps.traces.list());
          }
          const report = await replaySession(snapshots, ctx);
          return {
            ok: true,
            report,
            message:
              report.totalTurns === 0
                ? "No non-withheld turns available to replay yet."
                : `Replayed ${report.totalTurns} turn(s), ${report.totalCalls} call(s): ${report.matched} matched, ${report.drifted} drifted.`,
          };
        } catch (error) {
          return {
            ok: false,
            report: null,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
  }

  return {
    registerIpc,
  };
}
