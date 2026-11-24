import type { Config } from "../core/config.ts";
import type { ContradictionPrompt } from "../core/hygiene.ts";
import type { Memory, MemoryKind } from "../core/memory.ts";
import type { RuleAuditFinding, RuleAuditSeverity } from "../core/ruleAudit.ts";
import type { TellWhen } from "../core/standingOrders.ts";
import type { CallGate, CallOutcome, TurnTrace } from "../core/trace.ts";
import type { RoomCalibrationReport, WakeCalibrationSample } from "../core/voice/aec.ts";

export type { RoomCalibrationReport, WakeCalibrationSample };

export interface RoomCalibrationRequest {
  mode: "live" | "synthetic";
  sampleRate?: number;
  referenceSamples?: number[];
  recordedSamples?: number[];
  wakeTranscripts?: WakeCalibrationSample[];
}

/**
 * Shared types and pure visual/diagnostic helpers for the three standalone
 * post-v1 Studio & Diagnostics Electron windows:
 * - Avatar & Stage Studio (`avatar-studio.html`)
 * - Turn X-Ray & Provenance Inspector (`turn-xray.html`)
 * - Visual Policy & Standing-Order Composer (`policy-composer.html`)
 */

export type StudioToolWindowKind = "avatar-studio" | "turn-xray" | "policy-composer";

export interface AvatarFramingEntryView {
  modelHash: string;
  scale: number;
  offsetX: number;
  offsetY: number;
  rimLight: number;
  outlineThickness: number;
}

export interface AvatarStudioSnapshot {
  generatedAt: string;
  windowMode: Config["windowMode"];
  lowPowerStage: boolean;
  characterBundle: string | null;
  activeFramingKey: string;
  framings: AvatarFramingEntryView[];
  experimentalFlags: {
    phonemeVisemes: boolean;
    nativeMultimodal: boolean;
    fullDuplexVoice: boolean;
  };
}

export interface AvatarStudioConfigPatch {
  windowMode?: Config["windowMode"];
  lowPowerStage?: boolean;
  framing?: AvatarFramingEntryView;
}

export interface TurnWaterfallStage {
  stage: "stt" | "llm" | "tools" | "tts" | "overhead";
  label: string;
  ms: number;
  percent: number;
}

export interface TurnTokenBudget {
  contextLimit: number;
  promptTokens: number;
  completionTokens: number;
  heldTokens: number;
  remainingTokens: number;
  utilizationRatio: number;
}

export interface TurnXrayCallView {
  tool: string;
  outcome: CallOutcome;
  gate?: CallGate;
  gateReason?: string;
  asked: boolean;
  ms: number;
  inputPreview: string;
  resultPreview: string;
}

export interface TurnXrayPickedReason {
  tool: string;
  reason: string;
}

export interface TurnXrayItem {
  id: string;
  at: string;
  kind: TurnTrace["kind"];
  away: boolean;
  brain: string;
  spoken: boolean;
  withheld: boolean;
  said: string;
  replyPreview: string;
  offeredTools: string[];
  pickedReasons: TurnXrayPickedReason[];
  calls: TurnXrayCallView[];
  checks: { found: string; did: string }[];
  waterfall: TurnWaterfallStage[];
  firstWordMs: number | null;
  wholeMs: number;
  tokenBudget: TurnTokenBudget;
}

export interface MemoryProvenanceEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  points: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  hits: number;
  pinned: boolean;
  namespace?: string;
  ageDays: number;
}

export interface MemorySimilarityPair {
  aId: string;
  bId: string;
  aText: string;
  bText: string;
  jaccard: number;
}

export interface TurnXraySnapshot {
  generatedAt: string;
  contextLimit: number;
  turns: TurnXrayItem[];
  memories: MemoryProvenanceEntry[];
  contradictions: ContradictionPrompt[];
  nearDuplicates: MemorySimilarityPair[];
}

export interface ExperimentalOptionMeta {
  key: keyof Config["tier10"];
  title: string;
  summary: string;
  enabled: boolean;
  riskTier: "low" | "medium" | "high";
}

export interface StandingOrderDraft {
  title: string;
  where: string;
  command: string;
  address: string;
  tellWhen: TellWhen;
  value: string;
  everyMinutes: number;
  repeat: boolean;
}

export interface StandingOrderPreviewResult {
  valid: boolean;
  problem: string | null;
  checkSummary: string | null;
  conditionSummary: string | null;
  auditFindings: RuleAuditFinding[];
}

export interface PolicyStandingOrderRow {
  id: string;
  title: string;
  checkSummary: string;
  conditionSummary: string;
  everyMinutes: number;
  repeat: boolean;
  held: boolean | null;
  lastCheckedAt: string | null;
}

export interface PolicyMachineRow {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
}

export interface PolicyComposerSnapshot {
  generatedAt: string;
  handsOff: boolean;
  machines: PolicyMachineRow[];
  orders: PolicyStandingOrderRow[];
  experimentalOptions: ExperimentalOptionMeta[];
  auditOk: boolean;
  auditCounts: Record<RuleAuditSeverity, number>;
  auditFindings: RuleAuditFinding[];
}

export interface StudioToolsBridge {
  getAvatarStudioSnapshot(): Promise<AvatarStudioSnapshot>;
  updateAvatarStudioConfig(
    patch: AvatarStudioConfigPatch,
  ): Promise<{ ok: boolean; message: string }>;
  getTurnXraySnapshot(contextLimit?: number): Promise<TurnXraySnapshot>;
  resolveMemoryConflict(
    keepId: string,
    dropIds: string[],
  ): Promise<{ ok: boolean; message: string }>;
  getPolicyComposerSnapshot(): Promise<PolicyComposerSnapshot>;
  previewStandingOrder(draft: StandingOrderDraft): Promise<StandingOrderPreviewResult>;
  createStandingOrder(draft: StandingOrderDraft): Promise<{ ok: boolean; message: string }>;
  cancelStandingOrder(id: string): Promise<{ ok: boolean; message: string }>;
  setExperimentalFlag(
    flag: keyof Config["tier10"],
    enabled: boolean,
  ): Promise<{ ok: boolean; message: string }>;
  runRoomCalibration(request: RoomCalibrationRequest): Promise<RoomCalibrationReport>;
}

/** Human-friendly descriptions for experimental toggles so non-technical users understand each one. */
export const EXPERIMENTAL_OPTION_DESCRIPTIONS: Record<
  keyof Config["tier10"],
  { title: string; summary: string; riskTier: "low" | "medium" | "high" }
> = {
  workerMesh: {
    title: "Home Worker Mesh",
    summary: "Lets paired LAN computers share heavy file and build tasks.",
    riskTier: "medium",
  },
  modelCascade: {
    title: "Small-to-Large Brain Cascade",
    summary: "Starts replies on the fast small model and escalates to the big model only when needed.",
    riskTier: "low",
  },
  loraSubAgents: {
    title: "Specialist Skill Adapters",
    summary: "Swaps tiny fine-tuned helper weights for Linux admin, coding, or scheduling.",
    riskTier: "low",
  },
  predictivePrewarm: {
    title: "Predictive Model Pre-Warm",
    summary: "Keeps your preferred local model warm before you finish typing.",
    riskTier: "low",
  },
  semanticBridges: {
    title: "Cross-Source Memory Bridges",
    summary: "Links related notes between calendar events, reminders, and project facts.",
    riskTier: "low",
  },
  pushEvents: {
    title: "Instant Push Event Bus",
    summary: "Reacts immediately to local file changes, Home Assistant MQTT alerts, or webhooks.",
    riskTier: "medium",
  },
  hardwareTelemetry: {
    title: "Hardware Health Telemetry",
    summary: "Watches GPU heat, UPS battery, and disk health before running heavy jobs.",
    riskTier: "low",
  },
  sessionContinuity: {
    title: "Phone-to-Desktop Handoff",
    summary: "Lets you pick up your current conversation cleanly when moving between PC and phone.",
    riskTier: "medium",
  },
  causalDryRun: {
    title: "Dry-Run Consensus Check",
    summary: "Simulates file/command previews and double-checks risky plans before asking you.",
    riskTier: "low",
  },
  skillCompiler: {
    title: "Repeatable Skill Compiler",
    summary: "Turns multi-step fixes you approved into reusable, verifiable checklists.",
    riskTier: "medium",
  },
  microSandbox: {
    title: "Micro-Sandbox Execution",
    summary: "Isolates temporary scripts and builds in restricted local workspaces.",
    riskTier: "medium",
  },
  episodicCalibration: {
    title: "Quiet-Interruption Learning",
    summary: "Notices when you dismiss proactive alerts and speaks up less at bad times.",
    riskTier: "low",
  },
  attentionArbiter: {
    title: "Quiet Notification Gate",
    summary: "Holds non-urgent popups when you appear stepped away or deep in focus.",
    riskTier: "low",
  },
  nightlyHygiene: {
    title: "Nightly Memory Cleanup",
    summary: "Merges duplicate notes and checks storage while plugged in and idle overnight.",
    riskTier: "low",
  },
  fullDuplexVoice: {
    title: "Full-Duplex Barge-In Voice",
    summary: "Lets you naturally interrupt while she is speaking without pressing a key.",
    riskTier: "low",
  },
  phonemeVisemes: {
    title: "Phoneme Lip-Sync",
    summary: "Drives tighter A/I/U/E/O mouth shapes from speech audio and prosody tags.",
    riskTier: "low",
  },
  selfDistillation: {
    title: "Local Training Pair Export",
    summary: "Saves verified local trajectories for optional router fine-tuning on your GPU.",
    riskTier: "medium",
  },
  signedPlugins: {
    title: "Signed Community Plugins",
    summary: "Allows enabling opt-in sandboxed plugins whose SHA-256 signature matches their code.",
    riskTier: "high",
  },
  nativeMultimodal: {
    title: "Direct Audio & Vision Input",
    summary: "Sends camera/mic frames straight to multimodal local engines instead of separate transcribers.",
    riskTier: "medium",
  },
  householdIsolation: {
    title: "Separate Household Profiles",
    summary: "Keeps memories and notes separated per household speaker namespace.",
    riskTier: "low",
  },
  stationFederation: {
    title: "LAN Station Federation",
    summary: "Discovers and syncs read-only status across other Astra Navi stations on your LAN.",
    riskTier: "high",
  },
};

function clampMs(val: number | null | undefined): number {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) return 0;
  return Math.round(val);
}

/** Breaks down a turn trace's latency into proportional waterfall stages. */
export function buildTurnWaterfall(trace: Pick<TurnTrace, "ms">): TurnWaterfallStage[] {
  const whole = Math.max(1, clampMs(trace.ms.whole));
  const stt = clampMs(trace.ms.stt);
  const llm = clampMs(trace.ms.llm);
  const tools = clampMs(trace.ms.tools);
  const tts = clampMs(trace.ms.tts);
  const accounted = stt + llm + tools + tts;
  const overhead = Math.max(0, whole - accounted);
  const total = Math.max(whole, accounted);

  const raw: { stage: TurnWaterfallStage["stage"]; label: string; ms: number }[] = [
    { stage: "stt", label: "Speech-to-Text", ms: stt },
    { stage: "llm", label: "Local LLM", ms: llm },
    { stage: "tools", label: "Tools & Sandbox", ms: tools },
    { stage: "tts", label: "Voice Synth", ms: tts },
    { stage: "overhead", label: "Routing & Checks", ms: overhead },
  ];

  return raw
    .filter((entry) => entry.ms > 0 || entry.stage === "llm")
    .map((entry) => ({
      stage: entry.stage,
      label: entry.label,
      ms: entry.ms,
      percent: Math.round((entry.ms / total) * 1000) / 10,
    }));
}

/** Computes token utilization metrics against a target context window size. */
export function buildTurnTokenBudget(
  tokens: TurnTrace["tokens"],
  contextLimit = 8192,
): TurnTokenBudget {
  const safeLimit = Math.max(512, Math.floor(contextLimit));
  const promptTokens = Math.max(0, Math.round(tokens.prompt ?? tokens.read ?? 0));
  const completionTokens = Math.max(0, Math.round(tokens.written ?? 0));
  const heldTokens = Math.max(
    promptTokens + completionTokens,
    Math.round(tokens.held ?? promptTokens + completionTokens),
  );
  const remainingTokens = Math.max(0, safeLimit - heldTokens);
  const utilizationRatio = Math.min(1, Math.round((heldTokens / safeLimit) * 1000) / 1000);
  return {
    contextLimit: safeLimit,
    promptTokens,
    completionTokens,
    heldTokens,
    remainingTokens,
    utilizationRatio,
  };
}

function tokenizeSimple(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    out.add(m[0]);
  }
  return out;
}

/** Computes symmetric Jaccard token similarity `[0, 1]` between two strings. */
export function computeTokenSimilarity(a: string, b: string): number {
  const setA = tokenizeSimple(a);
  const setB = tokenizeSimple(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? Math.round((intersection / union) * 1000) / 1000 : 0;
}

/** Finds pairs of stored memories with high token overlap so users can inspect/merge stale duplicates. */
export function findNearDuplicateMemories(
  memories: readonly Pick<Memory, "id" | "kind" | "text" | "namespace">[],
  threshold = 0.68,
): MemorySimilarityPair[] {
  const pairs: MemorySimilarityPair[] = [];
  const cap = Math.min(memories.length, 180);
  for (let i = 0; i < cap; i += 1) {
    const a = memories[i];
    if (!a) continue;
    for (let j = i + 1; j < cap; j += 1) {
      const b = memories[j];
      if (!b || a.namespace !== b.namespace) continue;
      const score = computeTokenSimilarity(a.text, b.text);
      if (score >= threshold) {
        pairs.push({
          aId: a.id,
          bId: b.id,
          aText: a.text.slice(0, 160),
          bText: b.text.slice(0, 160),
          jaccard: score,
        });
      }
    }
  }
  return pairs.sort((x, y) => y.jaccard - x.jaccard).slice(0, 40);
}
