import { describe, expect, it } from "vitest";
import {
  auditUnreferencedModels,
  canRunHygieneWindow,
  cosineSimilarity,
  deduplicateMemories,
  detectFactContradictions,
  runNightlyHygiene,
  summarizeCompletedMission,
} from "../src/core/hygiene.ts";
import type { Memory } from "../src/core/memory.ts";
import { HerStore } from "../src/core/store.ts";

function mem(overrides: Partial<Memory>): Memory {
  return {
    id: "m1",
    kind: "fact",
    text: "Sample fact",
    points: [],
    tags: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    hits: 1,
    ...overrides,
  };
}

describe("Autonomous Nightly Memory & Storage Hygiene (Tier 10 §6.3)", () => {
  it("gates execution on enabled, AC power, cool thermals, no game, idle >= 20m, and overnight hours", () => {
    const ok = canRunHygieneWindow({
      enabled: true,
      onAcPower: true,
      gpuTempC: 42,
      cpuThrottled: false,
      gameActive: false,
      idleMinutes: 35,
      hour: 3,
    });
    expect(ok.allowed).toBe(true);

    expect(
      canRunHygieneWindow({
        enabled: true,
        onAcPower: false,
        gameActive: false,
        idleMinutes: 30,
        hour: 3,
      }).allowed,
    ).toBe(false);

    expect(
      canRunHygieneWindow({
        enabled: true,
        onAcPower: true,
        gpuTempC: 78,
        gameActive: false,
        idleMinutes: 30,
        hour: 3,
      }).allowed,
    ).toBe(false);

    expect(
      canRunHygieneWindow({
        enabled: true,
        onAcPower: true,
        gameActive: false,
        idleMinutes: 30,
        hour: 15,
      }).allowed,
    ).toBe(false);
  });

  it("deduplicates near-identical facts at cosine >= 0.92 while preserving earliest createdAt & merged tags/hits", () => {
    const a = mem({
      id: "m-old",
      text: "Proxmox hypervisor runs Debian 13",
      tags: ["infra"],
      hits: 2,
      createdAt: "2026-11-01T08:00:00.000Z",
      updatedAt: "2026-11-01T08:00:00.000Z",
    });
    const b = mem({
      id: "m-dup",
      text: "Proxmox server is on Debian 13",
      tags: ["learned"],
      hits: 3,
      createdAt: "2026-11-15T12:00:00.000Z",
      updatedAt: "2026-11-18T12:00:00.000Z",
    });
    const c = mem({
      id: "m-other",
      text: "Coffee beans stored in kitchen cabinet",
      hits: 1,
    });

    const vectors = new Map<string, Float32Array>([
      ["m-old", new Float32Array([1, 0, 0])],
      ["m-dup", new Float32Array([0.96, 0.28, 0])], // cos = 0.96 >= 0.92
      ["m-other", new Float32Array([0, 0, 1])],
    ]);
    expect(cosineSimilarity(vectors.get("m-old") as Float32Array, vectors.get("m-dup") as Float32Array)).toBeCloseTo(
      0.96,
      2,
    );

    const out = deduplicateMemories([a, b, c], vectors, 0.92);
    expect(out.dropIds).toEqual(["m-old"]);
    expect(out.kept).toHaveLength(2);
    const merged = out.mergedGroups[0];
    expect(merged?.kept.hits).toBe(5);
    expect(merged?.kept.createdAt).toBe("2026-11-01T08:00:00.000Z");
    expect(merged?.kept.updatedAt).toBe("2026-11-18T12:00:00.000Z");
    expect(merged?.kept.tags).toEqual(expect.arrayContaining(["infra", "learned"]));
  });

  it("flags conflicting server IPs, compresses missions, vacuums SQLite, and audits spare model weights without auto-deleting", async () => {
    const memories: Memory[] = [
      mem({ id: "f1", text: "proxmox ip is 192.168.50.2" }),
      mem({ id: "f2", text: "proxmox server runs at 192.168.50.99" }),
      mem({ id: "f3", text: "nas uses port 2222" }),
      mem({ id: "f4", text: "nas listening on port 22" }),
    ];
    const contradictions = detectFactContradictions(memories);
    expect(contradictions.map((c) => c.subject).sort()).toEqual(["nas", "proxmox"]);
    expect(contradictions[0]?.prompt).toContain("disagree");

    const missionSummary = summarizeCompletedMission({
      id: "mis-1",
      title: "Upgrade NAS",
      goal: "Apply security patches",
      createdAt: "2026-11-22T01:00:00.000Z",
      finishedAt: "2026-11-22T02:00:00.000Z",
      steps: [
        {
          title: "apt upgrade",
          where: "nas",
          whereName: "nas",
          command: "apt update",
          state: "done",
          retries: 0,
          tried: 1,
          output: "",
          approved: null,
          artifacts: [],
          finishedAt: "2026-11-22T02:00:00.000Z",
        },
      ],
    });
    expect(missionSummary.reply).toContain("1/1 done");

    const audit = auditUnreferencedModels(
      [
        { label: "Brain: Standard (9B)", path: "/models/std.gguf", bytes: 6e9, inUse: true },
        { label: "Brain: Large (27B)", path: "/models/large.gguf", bytes: 17e9, inUse: false },
      ],
      5e9,
    );
    expect(audit.exceedsThreshold).toBe(true);
    expect(audit.prompt).toContain("17.0 GB");

    const appended: { said: string; reply: string }[] = [];
    const store = new HerStore(":memory:");
    const report = await runNightlyHygiene({
      window: {
        enabled: true,
        onAcPower: true,
        gpuTempC: 39,
        gameActive: false,
        idleMinutes: 45,
        hour: 2,
      },
      memories,
      completedMissions: [
        {
          id: "mis-1",
          title: "Upgrade NAS",
          goal: "Patch",
          createdAt: "2026-11-22T01:00:00.000Z",
          finishedAt: "2026-11-22T02:00:00.000Z",
          steps: [],
        },
      ],
      store,
      archive: {
        add: async (turn) => {
          appended.push({ said: turn.said, reply: turn.reply });
        },
      },
      storageItems: [
        { label: "Brain: Standard", path: "/m/s.gguf", bytes: 6e9, inUse: true },
        { label: "Brain: XL", path: "/m/xl.gguf", bytes: 42e9, inUse: false },
      ],
      diskThresholdBytes: 10e9,
    });

    expect(report.ran).toBe(true);
    expect(report.vacuumed).toBe(true);
    expect(report.contradictions).toHaveLength(2);
    expect(appended).toHaveLength(1);
    expect(report.modelAudit.exceedsThreshold).toBe(true);
    store.close();
  });
});
