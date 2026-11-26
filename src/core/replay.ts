import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { toolVerdict, type PolicyContext } from "./permissions.ts";
import { withoutSecrets } from "./secrets.ts";
import type { TurnTrace } from "./trace.ts";

/**
 * Deterministic Time-Travel Session Replay (ai_chan_plan.pdf p. 17).
 *
 * Captures compressed prompt, offered tools, control trees, trace telemetry, and expected
 * permission gate outcomes into `.gz` replay bundles (strictly skipping `withheld` turns),
 * enabling offline zero-LLM regression re-evaluation across permission policy updates.
 */

export type ReplayDecision = "allow" | "ask" | "blocked";

const TracedCallSchema = z.object({
  tool: z.string(),
  input: z.string(),
  result: z.string(),
  outcome: z.enum(["done", "failed", "declined", "refused"]),
  asked: z.boolean(),
  ms: z.number(),
  gate: z.enum(["allow", "ask-allowed", "ask-declined", "refused"]).optional(),
  gateReason: z.string().optional(),
});

const TracedCheckSchema = z.object({
  found: z.enum([
    "claimed",
    "looked",
    "unchecked",
    "stopped",
    "no-way",
    "sum",
    "wrong-sum",
    "check-failed",
  ]),
  did: z.enum(["again", "note", "skipped"]),
});

const TurnTraceSchema = z.object({
  at: z.string(),
  kind: z.enum(["user", "ship", "again"]),
  away: z.boolean().optional(),
  said: z.string(),
  spoken: z.boolean(),
  brain: z.string(),
  offered: z.array(z.string()),
  pickedFor: z.record(z.string(), z.string()).optional(),
  calls: z.array(TracedCallSchema),
  reply: z.string(),
  checks: z.array(TracedCheckSchema),
  withheld: z.boolean(),
  ms: z.object({
    whole: z.number(),
    firstWord: z.number().nullable(),
    stt: z.number().nullable().optional(),
    llm: z.number().nullable().optional(),
    tools: z.number().nullable().optional(),
    tts: z.number().nullable().optional(),
  }),
  tokens: z.object({
    read: z.number().nullable(),
    written: z.number().nullable(),
    held: z.number().nullable(),
    prompt: z.number().nullable().optional(),
  }),
});

export const ReplayVerdictRecordSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  expectedDecision: z.enum(["allow", "ask", "blocked"]),
});
export type ReplayVerdictRecord = z.infer<typeof ReplayVerdictRecordSchema>;

export const ReplaySnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  recordedAt: z.string(),
  prompt: z.string(),
  offeredTools: z.array(z.string()),
  controlTree: z.array(z.object({ name: z.string(), role: z.string() })).optional(),
  trace: TurnTraceSchema,
  verdicts: z.array(ReplayVerdictRecordSchema),
});
export type ReplaySnapshot = z.infer<typeof ReplaySnapshotSchema>;

const ReplayBundleFileSchema = z.object({
  version: z.literal(1),
  snapshots: z.array(ReplaySnapshotSchema),
});

export interface ReplayDrift {
  snapshotId: string;
  callIndex: number;
  tool: string;
  expectedDecision: ReplayDecision;
  actualDecision: ReplayDecision;
}

export interface ReplayReport {
  totalTurns: number;
  totalCalls: number;
  matched: number;
  drifted: number;
  diffs: ReplayDrift[];
}

function scrubTrace(trace: TurnTrace): TurnTrace {
  return {
    ...trace,
    said: withoutSecrets(trace.said),
    reply: withoutSecrets(trace.reply),
    calls: trace.calls.map((c) => ({
      ...c,
      input: withoutSecrets(c.input),
      result: withoutSecrets(c.result),
    })),
  };
}

/** Scrubs secrets, filters `withheld` turns, and writes a gzip-compressed replay bundle (`0600`). */
export async function saveReplayBundle(
  filePath: string,
  snapshots: readonly ReplaySnapshot[],
): Promise<{ saved: number; skippedWithheld: number }> {
  let skippedWithheld = 0;
  const kept: ReplaySnapshot[] = [];

  for (const snap of snapshots) {
    if (snap.trace.withheld) {
      skippedWithheld += 1;
      continue;
    }
    kept.push({
      ...snap,
      prompt: withoutSecrets(snap.prompt),
      trace: scrubTrace(snap.trace),
    });
  }

  const payload = JSON.stringify({ version: 1, snapshots: kept });
  const compressed = gzipSync(Buffer.from(payload, "utf8"));
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, compressed, { mode: 0o600 });
  await rename(tmp, filePath);

  return { saved: kept.length, skippedWithheld };
}

/** Decompresses and schema-validates a saved replay `.gz` bundle from disk. */
export async function loadReplayBundle(filePath: string): Promise<ReplaySnapshot[]> {
  const compressed = await readFile(filePath);
  const raw = gunzipSync(compressed).toString("utf8");
  const parsed = ReplayBundleFileSchema.parse(JSON.parse(raw) as unknown);
  return parsed.snapshots;
}

/** Deterministically re-evaluates recorded tool calls against live `permissions.ts` without any LLM. */
export async function replaySession(
  snapshots: readonly ReplaySnapshot[],
  context: PolicyContext,
): Promise<ReplayReport> {
  let totalCalls = 0;
  let matched = 0;
  const diffs: ReplayDrift[] = [];

  for (const snap of snapshots) {
    for (let idx = 0; idx < snap.verdicts.length; idx += 1) {
      const record = snap.verdicts[idx];
      if (!record) continue;
      totalCalls += 1;
      let actualDecision: ReplayDecision;
      try {
        const verdict = await toolVerdict(record.tool, record.args, context);
        actualDecision = verdict.decision;
      } catch {
        actualDecision = "blocked";
      }

      if (actualDecision === record.expectedDecision) {
        matched += 1;
      } else {
        diffs.push({
          snapshotId: snap.id,
          callIndex: idx,
          tool: record.tool,
          expectedDecision: record.expectedDecision,
          actualDecision,
        });
      }
    }
  }

  return {
    totalTurns: snapshots.length,
    totalCalls,
    matched,
    drifted: diffs.length,
    diffs,
  };
}
