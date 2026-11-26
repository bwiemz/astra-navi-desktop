import type { MemoryKind, MemorySource } from "../core/memory.ts";
import type { DurableMission, MissionStep, MissionThreadEntry } from "../core/missionPlan.ts";
import type { ReplayReport } from "../core/replay.ts";
import type { RuleAuditFinding, RuleAuditSeverity } from "../core/ruleAudit.ts";
import type { CompiledSkillStatus } from "../core/skillCompiler.ts";

/**
 * Shared types and pure graph builders for the standalone Mission Control & Memory
 * Inspector secondary Electron window (`mission-control.html`).
 */

export interface MissionStepNodeView {
  index: number;
  title: string;
  where: string;
  whereName: string;
  command: string;
  state: MissionStep["state"];
  retries: number;
  tried: number;
  outputPreview: string;
  finishedAt: string | null;
  approvedSummary: string | null;
  diffPreview: string | null;
}

export interface MissionDagEdge {
  fromStep: number;
  toStep: number;
  relation: "depends" | "retry-gate" | "wake-gate";
}

export interface MissionDagView {
  id: string;
  title: string;
  goal: string;
  state: DurableMission["state"];
  createdAt: string;
  finishedAt: string | null;
  note: string | null;
  yieldToGames: boolean;
  pinnedToDevices: boolean;
  wakeDescription: string | null;
  nodes: MissionStepNodeView[];
  edges: MissionDagEdge[];
  thread: MissionThreadEntry[];
  pendingApprovalId: string | null;
  canApprove: boolean;
  canPauseOrCancel: boolean;
  canResume: boolean;
  canRollback: boolean;
}

export interface MemoryInspectorItem {
  id: string;
  kind: MemoryKind;
  text: string;
  points: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  hits: number;
  pinned: boolean;
  source?: MemorySource;
  whyRemembered?: string;
  namespace?: string;
}

export interface EpisodeInspectorItem {
  id: number;
  at: string;
  kind: string;
  contextBucket: string;
  activeApp: string;
  mode: string;
  summary: string;
  actionKey: string | null;
}

export interface EpisodeThresholdView {
  contextBucket: string;
  emaReward: number;
  tauAct: number;
  tauSpeak: number;
  sampleCount: number;
  updatedAt: string;
}

export interface StandingOrderInspectorItem {
  id: string;
  title: string;
  target: string;
  everyMinutes: number;
  conditionSummary: string;
  lastCheckedAt: string | null;
  held: boolean;
}

export interface CompiledSkillInspectorItem {
  id: string;
  slug: string;
  name: string;
  status: CompiledSkillStatus;
  requiredCapabilities: string[];
  stepCount: number;
  updatedAt: string;
  driftReason: string | null;
}

export interface PolicyGraphNode {
  id: string;
  label: string;
  kind: "config" | "order" | "skill" | "watch" | "finding";
  severity?: RuleAuditSeverity;
}

export interface PolicyGraphEdge {
  from: string;
  to: string;
  relation: string;
}

export interface PolicyConflictGraph {
  ok: boolean;
  counts: Record<RuleAuditSeverity, number>;
  findings: RuleAuditFinding[];
  nodes: PolicyGraphNode[];
  edges: PolicyGraphEdge[];
}

export interface ReplayTurnView {
  id: string;
  at: string;
  said: string;
  brain: string;
  offered: string[];
  calls: { tool: string; outcome: string; gate?: string; asked: boolean; ms: number }[];
  replyPreview: string;
  checks: number;
}

export interface MissionControlSnapshot {
  generatedAt: string;
  missions: MissionDagView[];
  memories: MemoryInspectorItem[];
  episodes: EpisodeInspectorItem[];
  thresholds: EpisodeThresholdView[];
  standingOrders: StandingOrderInspectorItem[];
  compiledSkills: CompiledSkillInspectorItem[];
  policyGraph: PolicyConflictGraph;
  recentTurns: ReplayTurnView[];
}

export type MissionControlAction = "approve" | "pause" | "resume" | "cancel" | "rollback";

export interface MissionControlActionResult {
  ok: boolean;
  message: string;
}

export interface ReplayInspectResult {
  ok: boolean;
  report: ReplayReport | null;
  message: string;
}

export interface MissionControlBridge {
  getSnapshot(): Promise<MissionControlSnapshot>;
  actMission(id: string, action: MissionControlAction): Promise<MissionControlActionResult>;
  upsertMemory(input: {
    id?: string;
    kind: MemoryKind;
    text: string;
  }): Promise<{ ok: boolean; message: string }>;
  pinMemory(id: string, pinned: boolean): Promise<{ ok: boolean; message: string }>;
  deleteMemory(id: string): Promise<{ ok: boolean; message: string }>;
  deleteEpisode(id: number): Promise<{ ok: boolean; message: string }>;
  cancelStandingOrder(id: string): Promise<{ ok: boolean; message: string }>;
  setSkillStatus(id: string, action: "ratify" | "revoke"): Promise<{ ok: boolean; message: string }>;
  verifyPolicies(): Promise<PolicyConflictGraph>;
  inspectReplay(bundlePath?: string): Promise<ReplayInspectResult>;
}

/** Builds sequential + retry/gate DAG edges for a mission's ordered steps. */
export function buildMissionDagEdges(steps: readonly Pick<MissionStep, "retries">[]): MissionDagEdge[] {
  const edges: MissionDagEdge[] = [];
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const step = steps[i];
    edges.push({
      fromStep: i,
      toStep: i + 1,
      relation: step && step.retries > 0 ? "retry-gate" : "depends",
    });
  }
  return edges;
}

/** Builds an inspectable policy conflict graph from `auditSecurityRules()` findings. */
export function buildPolicyConflictGraph(input: {
  ok: boolean;
  counts: Record<RuleAuditSeverity, number>;
  findings: readonly RuleAuditFinding[];
  orderIds?: readonly string[];
  skillSlugs?: readonly string[];
}): PolicyConflictGraph {
  const nodes: PolicyGraphNode[] = [
    { id: "policy:runtime", label: "Runtime Policy & Controls", kind: "config" },
  ];
  const edges: PolicyGraphEdge[] = [];
  const seen = new Set<string>(["policy:runtime"]);

  const ensureNode = (node: PolicyGraphNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };

  for (const id of input.orderIds ?? []) {
    const nid = `order:${id}`;
    ensureNode({ id: nid, label: `Order ${id}`, kind: "order" });
    edges.push({ from: "policy:runtime", to: nid, relation: "governs" });
  }
  for (const slug of input.skillSlugs ?? []) {
    const nid = `skill:${slug}`;
    ensureNode({ id: nid, label: `Skill ${slug}`, kind: "skill" });
    edges.push({ from: "policy:runtime", to: nid, relation: "gates" });
  }

  input.findings.forEach((finding, idx) => {
    const fid = `finding:${idx}:${finding.code}`;
    ensureNode({
      id: fid,
      label: `${finding.code} (${finding.subject})`,
      kind: "finding",
      severity: finding.severity,
    });
    const subjectLower = finding.subject.toLowerCase();
    const matchedOrder = (input.orderIds ?? []).find((id) => subjectLower.includes(id.toLowerCase()));
    const matchedSkill = (input.skillSlugs ?? []).find((s) => subjectLower.includes(s.toLowerCase()));
    const sourceId = matchedOrder
      ? `order:${matchedOrder}`
      : matchedSkill
        ? `skill:${matchedSkill}`
        : "policy:runtime";
    edges.push({ from: sourceId, to: fid, relation: finding.severity });
  });

  return {
    ok: input.ok,
    counts: { ...input.counts },
    findings: [...input.findings],
    nodes,
    edges,
  };
}
