import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionLog } from "../src/core/actionLog.ts";
import { TOOLS } from "../src/core/permissions.ts";
import {
  loadReplayBundle,
  replaySession,
  saveReplayBundle,
  type ReplaySnapshot,
} from "../src/core/replay.ts";
import type { TurnTrace } from "../src/core/trace.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-chan-replay-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function sampleTrace(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    at: "2026-11-22T12:00:00.000Z",
    kind: "user",
    said: "Read notes with Bearer abcdefghijklmnop12345",
    spoken: false,
    brain: "Standard (9B)",
    offered: ["read_file", "run_command"],
    calls: [],
    reply: "Read notes.txt",
    checks: [],
    withheld: false,
    ms: { whole: 420, firstWord: 120 },
    tokens: { read: 200, written: 40, held: 240, prompt: 180 },
    ...over,
  };
}

describe("Deterministic Time-Travel Session Replay", () => {
  it("saves gzip replay bundles with 0600 permissions, skips withheld turns, scrubs secrets, and replays permission drift", async () => {
    const dir = await makeTempDir();
    const bundleFile = join(dir, "session.replay.json.gz");

    const snapshots: ReplaySnapshot[] = [
      {
        version: 1,
        id: "turn-1",
        recordedAt: "2026-11-22T12:00:00.000Z",
        prompt: "Read notes with Bearer abcdefghijklmnop12345",
        offeredTools: [TOOLS.readFile, TOOLS.runCommand],
        controlTree: [{ name: "Save", role: "push button" }],
        trace: sampleTrace(),
        verdicts: [
          { tool: TOOLS.readFile, args: { path: "notes.txt" }, expectedDecision: "allow" },
          { tool: TOOLS.readFile, args: { path: "~/.ssh/id_ed25519" }, expectedDecision: "ask" },
          { tool: TOOLS.runCommand, args: { command: "rm -rf /" }, expectedDecision: "ask" },
        ],
      },
      {
        version: 1,
        id: "turn-withheld",
        recordedAt: "2026-11-22T12:01:00.000Z",
        prompt: "What notifications arrived?",
        offeredTools: [TOOLS.notifications],
        trace: sampleTrace({ withheld: true, said: "Secret phone code 999" }),
        verdicts: [],
      },
    ];

    const saved = await saveReplayBundle(bundleFile, snapshots);
    expect(saved).toEqual({ saved: 1, skippedWithheld: 1 });
    const info = await stat(bundleFile);
    expect(info.mode & 0o777).toBe(0o600);

    const loaded = await loadReplayBundle(bundleFile);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.prompt).toContain("Bearer [hidden]");
    expect(loaded[0]?.trace.said).toContain("Bearer [hidden]");

    const cleanReplay = await replaySession(loaded, { workspace: dir, home: dir });
    expect(cleanReplay.totalTurns).toBe(1);
    expect(cleanReplay.totalCalls).toBe(3);
    expect(cleanReplay.matched).toBe(3);
    expect(cleanReplay.drifted).toBe(0);

    // Drift detection catches when an expected "allow" turns into "ask" under stricter policy.
    const driftSnap: ReplaySnapshot[] = [
      {
        ...loaded[0] as ReplaySnapshot,
        verdicts: [{ tool: TOOLS.readFile, args: { path: "~/.ssh/id_ed25519" }, expectedDecision: "allow" }],
      },
    ];
    const driftReport = await replaySession(driftSnap, { workspace: dir, home: dir });
    expect(driftReport.drifted).toBe(1);
    expect(driftReport.diffs[0]).toMatchObject({
      tool: TOOLS.readFile,
      expectedDecision: "allow",
      actualDecision: "ask",
    });

    // ActionLog direct snapshot capture & exportReplayBundle round-trip
    const log = new ActionLog(join(dir, "actions.jsonl"));
    for (const snap of snapshots) log.recordSnapshot(snap);
    expect(log.recentSnapshots()).toHaveLength(2);
    const exportedPath = join(dir, "from-log.replay.json.gz");
    const exported = await log.exportReplayBundle(exportedPath);
    expect(exported).toEqual({ saved: 1, skippedWithheld: 1 });
    const reloaded = await loadReplayBundle(exportedPath);
    const verified = await replaySession(reloaded, { workspace: dir, home: dir });
    expect(verified.drifted).toBe(0);
    expect(verified.matched).toBe(3);
  });
});
