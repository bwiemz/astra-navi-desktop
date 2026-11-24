import type { ConversationArchive } from "./archive.ts";
import type { Memory } from "./memory.ts";
import type { DurableMission } from "./missionPlan.ts";
import { gigabytes, spareStorage, type StorageItem } from "./selfCheck.ts";
import type { HerStore } from "./store.ts";

/**
 * Autonomous Nightly Memory & Storage Hygiene (Tier 10 §6.3).
 *
 * Executes during verified idle overnight AC/low-thermal windows:
 * - Semantic fact deduplication (cosine >= 0.92) preserving provenance timestamps
 * - Contradicting-fact confirmation queue
 * - Completed mission compression into archive summaries + SQLite VACUUM
 * - Unreferenced model bundle storage audit with explicit user cleanup prompt
 */

export const DEDUPE_COSINE_THRESHOLD = 0.92;
export const MAX_HYGIENE_GPU_TEMP_C = 72;
export const MIN_HYGIENE_IDLE_MINUTES = 20;

export interface HygieneWindowInput {
  enabled: boolean;
  onAcPower: boolean;
  gpuTempC?: number | null;
  cpuThrottled?: boolean;
  gameActive: boolean;
  idleMinutes: number;
  hour: number;
}

export interface MergedMemoryGroup {
  kept: Memory;
  droppedIds: string[];
  earliestCreatedAt: string;
  latestUpdatedAt: string;
  maxSimilarity: number;
}

export interface ContradictionPrompt {
  subject: string;
  kind: "ip" | "port" | "setting";
  values: string[];
  memoryIds: string[];
  prompt: string;
}

export interface MissionArchiveSummary {
  missionId: string;
  said: string;
  reply: string;
  at: string;
}

export interface ModelBundleAudit {
  spareItems: StorageItem[];
  totalSpareBytes: number;
  exceedsThreshold: boolean;
  prompt: string | null;
}

export interface HygieneRunDeps {
  window: HygieneWindowInput;
  memories?: readonly Memory[];
  vectors?: ReadonlyMap<string, Float32Array>;
  dedupeThreshold?: number;
  completedMissions?: readonly Pick<
    DurableMission,
    "id" | "title" | "goal" | "steps" | "createdAt" | "finishedAt"
  >[];
  store?: Pick<HerStore, "vacuum">;
  archive?: Pick<ConversationArchive, "add">;
  storageItems?: readonly StorageItem[];
  diskThresholdBytes?: number;
}

export interface HygieneReport {
  ran: boolean;
  reason: string;
  deduped: {
    kept: Memory[];
    mergedGroups: MergedMemoryGroup[];
    dropIds: string[];
  };
  contradictions: ContradictionPrompt[];
  archivedMissions: MissionArchiveSummary[];
  vacuumed: boolean;
  modelAudit: ModelBundleAudit;
}

/** Verifies overnight idle AC-power and cool-thermal preconditions before maintenance. */
export function canRunHygieneWindow(input: HygieneWindowInput): {
  allowed: boolean;
  reason: string;
} {
  if (!input.enabled) {
    return { allowed: false, reason: "Nightly hygiene is disabled in Experimental options." };
  }
  if (!input.onAcPower) {
    return { allowed: false, reason: "Deferred: system is on battery/UPS power." };
  }
  if (input.gameActive) {
    return { allowed: false, reason: "Deferred: a game holds the GPU." };
  }
  if (input.cpuThrottled) {
    return { allowed: false, reason: "Deferred: CPU package is thermally throttled." };
  }
  if (
    typeof input.gpuTempC === "number" &&
    Number.isFinite(input.gpuTempC) &&
    input.gpuTempC >= MAX_HYGIENE_GPU_TEMP_C
  ) {
    return {
      allowed: false,
      reason: `Deferred: GPU temperature (${input.gpuTempC}°C) is at or above ${MAX_HYGIENE_GPU_TEMP_C}°C.`,
    };
  }
  if (input.idleMinutes < MIN_HYGIENE_IDLE_MINUTES) {
    return {
      allowed: false,
      reason: `Deferred: idle time (${input.idleMinutes} min) is below ${MIN_HYGIENE_IDLE_MINUTES} min.`,
    };
  }
  const hour = ((Math.trunc(input.hour) % 24) + 24) % 24;
  if (!(hour >= 23 || hour < 6)) {
    return { allowed: false, reason: "Deferred: outside overnight maintenance window (23:00–06:00)." };
  }
  return { allowed: true, reason: "Idle overnight AC & thermal window verified." };
}

/** Computes cosine similarity in [-1, 1] between two numeric embeddings. */
export function cosineSimilarity(
  a: Float32Array | readonly number[],
  b: Float32Array | readonly number[],
): number {
  const len = Math.min(a.length, b.length);
  if (len === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i += 1) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 1e-12 ? dot / denom : 0;
}

/**
 * Clusters near-duplicate memories of identical `kind` at cosine >= `threshold`,
 * merging tags/hits and preserving earliest createdAt and latest updatedAt provenance.
 */
export function deduplicateMemories(
  memories: readonly Memory[],
  vectors: ReadonlyMap<string, Float32Array>,
  threshold = DEDUPE_COSINE_THRESHOLD,
): { kept: Memory[]; mergedGroups: MergedMemoryGroup[]; dropIds: string[] } {
  const ordered = [...memories].sort(
    (a, b) => b.hits - a.hits || a.createdAt.localeCompare(b.createdAt),
  );
  const consumed = new Set<string>();
  const kept: Memory[] = [];
  const mergedGroups: MergedMemoryGroup[] = [];
  const dropIds: string[] = [];

  for (const primary of ordered) {
    if (consumed.has(primary.id)) continue;
    consumed.add(primary.id);
    const vecA = vectors.get(primary.id);
    const clones: Memory[] = [];
    let maxSim = 0;

    if (vecA) {
      for (const other of ordered) {
        if (consumed.has(other.id) || other.kind !== primary.kind) continue;
        const vecB = vectors.get(other.id);
        if (!vecB) continue;
        const sim = cosineSimilarity(vecA, vecB);
        if (sim >= threshold) {
          consumed.add(other.id);
          clones.push(other);
          if (sim > maxSim) maxSim = sim;
        }
      }
    }

    if (clones.length === 0) {
      kept.push({ ...primary, points: [...primary.points], tags: [...primary.tags] });
      continue;
    }

    const groupAll = [primary, ...clones];
    const earliestCreatedAt = groupAll
      .map((m) => m.createdAt)
      .sort((a, b) => a.localeCompare(b))[0] ?? primary.createdAt;
    const latestUpdatedAt = groupAll
      .map((m) => m.updatedAt)
      .sort((a, b) => b.localeCompare(a))[0] ?? primary.updatedAt;
    const mergedTags = [...new Set(groupAll.flatMap((m) => m.tags))];
    const mergedPoints = [...new Set(groupAll.flatMap((m) => m.points))].slice(0, 12);
    const totalHits = groupAll.reduce((sum, m) => sum + m.hits, 0);
    const merged: Memory = {
      ...primary,
      tags: mergedTags,
      points: mergedPoints,
      hits: totalHits,
      createdAt: earliestCreatedAt,
      updatedAt: latestUpdatedAt,
    };
    const dropped = clones.map((c) => c.id);
    dropIds.push(...dropped);
    kept.push(merged);
    mergedGroups.push({
      kept: merged,
      droppedIds: dropped,
      earliestCreatedAt,
      latestUpdatedAt,
      maxSimilarity: Number(maxSim.toFixed(4)),
    });
  }

  return { kept, mergedGroups, dropIds };
}

interface ExtractedAssertion {
  subject: string;
  kind: ContradictionPrompt["kind"];
  value: string;
  memoryId: string;
}

const HOST_IP_RE =
  /\b([a-z][a-z0-9-]{1,24})\s+(?:server\s+)?(?:ip(?:\s+address)?|host|runs?\s+at|is(?:\s+at)?|at|:)\s+(?:is\s+|at\s+)?((?:\d{1,3}\.){3}\d{1,3})\b/i;
const SUBJECT_IP_RE =
  /\b([a-z][a-z0-9-]{1,24})\b[^.\n]{0,24}\b((?:\d{1,3}\.){3}\d{1,3})\b/i;
const PORT_RE = /\b([a-z][a-z0-9-]{1,24})\s+(?:uses\s+|on\s+|listening\s+on\s+)?port\s+(\d{2,5})\b/i;

const STOP_SUBJECTS = new Set(["the", "my", "our", "this", "that", "ip", "address", "host", "at", "is"]);

function extractAssertion(memory: Memory): ExtractedAssertion | null {
  if (memory.kind !== "fact" && memory.kind !== "project" && memory.kind !== "preference") {
    return null;
  }
  const ipMatch = HOST_IP_RE.exec(memory.text) ?? SUBJECT_IP_RE.exec(memory.text);
  if (ipMatch?.[1] && ipMatch[2]) {
    const subject = ipMatch[1].toLowerCase();
    if (!STOP_SUBJECTS.has(subject)) {
      return { subject, kind: "ip", value: ipMatch[2], memoryId: memory.id };
    }
  }
  const portMatch = PORT_RE.exec(memory.text);
  if (portMatch?.[1] && portMatch[2]) {
    const subject = portMatch[1].toLowerCase();
    if (!STOP_SUBJECTS.has(subject)) {
      return { subject, kind: "port", value: portMatch[2], memoryId: memory.id };
    }
  }
  return null;
}

/** Detects contradicting host IPs or port assertions in stored facts and prepares user confirmations. */
export function detectFactContradictions(memories: readonly Memory[]): ContradictionPrompt[] {
  const buckets = new Map<string, { subject: string; kind: ContradictionPrompt["kind"]; hits: ExtractedAssertion[] }>();

  for (const memory of memories) {
    const assertion = extractAssertion(memory);
    if (!assertion) continue;
    const key = `${assertion.kind}:${assertion.subject}`;
    const existing = buckets.get(key) ?? {
      subject: assertion.subject,
      kind: assertion.kind,
      hits: [],
    };
    existing.hits.push(assertion);
    buckets.set(key, existing);
  }

  const prompts: ContradictionPrompt[] = [];
  for (const group of buckets.values()) {
    const values = [...new Set(group.hits.map((h) => h.value))];
    if (values.length < 2) continue;
    const memoryIds = [...new Set(group.hits.map((h) => h.memoryId))];
    prompts.push({
      subject: group.subject,
      kind: group.kind,
      values,
      memoryIds,
      prompt: `Two saved notes disagree on ${group.subject}'s ${group.kind}: ${values.join(" vs ")}. Which one is current?`,
    });
  }
  return prompts;
}

/** Compresses a completed mission into a compact archive summary turn. */
export function summarizeCompletedMission(
  mission: Pick<DurableMission, "id" | "title" | "goal" | "steps" | "createdAt" | "finishedAt">,
): MissionArchiveSummary {
  const doneCount = mission.steps.filter((s) => s.state === "done").length;
  const failedCount = mission.steps.filter((s) => s.state === "failed" || s.state === "refused").length;
  const stepNames = mission.steps
    .map((s) => `${s.title} (${s.state})`)
    .slice(0, 6)
    .join("; ");
  const goalPart = mission.goal ? ` Goal: ${mission.goal}.` : "";
  return {
    missionId: mission.id,
    said: `[mission summary] ${mission.title}`,
    reply: `Completed mission "${mission.title}" [${doneCount}/${mission.steps.length} done, ${failedCount} failed].${goalPart} Steps: ${stepNames}.`,
    at: mission.finishedAt ?? mission.createdAt,
  };
}

/** Audits unreferenced downloaded models/tools without auto-deleting any weights. */
export function auditUnreferencedModels(
  items: readonly StorageItem[],
  diskThresholdBytes: number,
): ModelBundleAudit {
  const spareItems = spareStorage(items);
  const totalSpareBytes = spareItems.reduce((sum, item) => sum + item.bytes, 0);
  const exceedsThreshold = spareItems.length > 0 && totalSpareBytes >= diskThresholdBytes;
  const prompt = exceedsThreshold
    ? `${spareItems.length} unreferenced model/tool item${spareItems.length === 1 ? "" : "s"} take ${gigabytes(totalSpareBytes)} (${spareItems.map((i) => i.label).join(", ")}). Remove spare storage?`
    : null;
  return {
    spareItems,
    totalSpareBytes,
    exceedsThreshold,
    prompt,
  };
}

/** Executes the full nightly memory & storage maintenance pass when window guards pass. */
export async function runNightlyHygiene(deps: HygieneRunDeps): Promise<HygieneReport> {
  const gate = canRunHygieneWindow(deps.window);
  if (!gate.allowed) {
    return {
      ran: false,
      reason: gate.reason,
      deduped: { kept: [...(deps.memories ?? [])], mergedGroups: [], dropIds: [] },
      contradictions: [],
      archivedMissions: [],
      vacuumed: false,
      modelAudit: { spareItems: [], totalSpareBytes: 0, exceedsThreshold: false, prompt: null },
    };
  }

  const deduped = deduplicateMemories(
    deps.memories ?? [],
    deps.vectors ?? new Map<string, Float32Array>(),
    deps.dedupeThreshold ?? DEDUPE_COSINE_THRESHOLD,
  );
  const contradictions = detectFactContradictions(deduped.kept);
  const archivedMissions: MissionArchiveSummary[] = [];

  for (const mission of deps.completedMissions ?? []) {
    const summary = summarizeCompletedMission(mission);
    archivedMissions.push(summary);
    if (deps.archive) {
      await deps.archive.add({
        at: summary.at,
        said: summary.said,
        reply: summary.reply,
        outside: false,
      });
    }
  }

  let vacuumed = false;
  if (deps.store) {
    deps.store.vacuum();
    vacuumed = true;
  }

  const modelAudit = auditUnreferencedModels(
    deps.storageItems ?? [],
    deps.diskThresholdBytes ?? 4_000_000_000,
  );

  return {
    ran: true,
    reason: gate.reason,
    deduped,
    contradictions,
    archivedMissions,
    vacuumed,
    modelAudit,
  };
}
