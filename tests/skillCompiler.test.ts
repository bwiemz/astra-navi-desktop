import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Embedder } from "../src/core/embedder.ts";
import { TOOLS } from "../src/core/permissions.ts";
import {
  CompiledSkillStore,
  renderSkillSteps,
  synthesizeSkillFromTrajectories,
  type ObservedTrajectory,
} from "../src/core/skillCompiler.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-chan-skills-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function sampleTrajectories(): ObservedTrajectory[] {
  return [
    {
      taskKey: "deploy_archive",
      title: "Archive folder to tar",
      at: "2026-11-20T10:00:00.000Z",
      steps: [
        {
          tool: TOOLS.readFile,
          args: { path: "notes/day1.txt" },
          ok: true,
          grantedCapabilities: ["fs.read.workspace"],
        },
        {
          tool: TOOLS.runCommand,
          args: { command: "ls -la notes" },
          ok: true,
          grantedCapabilities: ["shell.readonly"],
        },
      ],
    },
    {
      taskKey: "deploy_archive",
      title: "Archive folder to tar",
      at: "2026-11-21T10:00:00.000Z",
      steps: [
        {
          tool: TOOLS.readFile,
          args: { path: "notes/day2.txt" },
          ok: true,
          grantedCapabilities: ["fs.read.workspace"],
        },
        {
          tool: TOOLS.runCommand,
          args: { command: "ls -la notes" },
          ok: true,
          grantedCapabilities: ["shell.readonly"],
        },
      ],
    },
    {
      taskKey: "deploy_archive",
      title: "Archive folder to tar",
      at: "2026-11-22T10:00:00.000Z",
      steps: [
        {
          tool: TOOLS.readFile,
          args: { path: "notes/day3.txt" },
          ok: true,
          grantedCapabilities: ["fs.read.workspace"],
        },
        {
          tool: TOOLS.runCommand,
          args: { command: "ls -la notes" },
          ok: true,
          grantedCapabilities: ["shell.readonly"],
        },
      ],
    },
  ];
}

describe("Compiled Reusable Skill Synthesis (Tier 10 §5.2)", () => {
  it("synthesizes parameterized skill in proposed state after 3 matching verified runs", () => {
    const out = synthesizeSkillFromTrajectories(sampleTrajectories());
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.skill.status).toBe("proposed");
    expect(out.skill.ratifiedAt).toBeNull();
    expect(out.skill.verifiedRuns).toBe(3);
    expect(out.skill.params).toHaveLength(1);
    expect(out.skill.params[0]?.name).toBe("path");
    expect(out.skill.steps[0]?.argsTemplate).toEqual({ path: "{{path}}" });
    expect(out.skill.steps[1]?.argsTemplate).toEqual({ command: "ls -la notes" });
    expect(out.skill.requiredCapabilities).toEqual(["fs.read.workspace", "shell.readonly"]);

    const rendered = renderSkillSteps(out.skill, { path: "notes/day4.txt" });
    expect(rendered[0]?.args).toEqual({ path: "notes/day4.txt" });
  });

  it("refuses secrets, unseen characters, and capability escalation beyond training grants", () => {
    const withSecret = sampleTrajectories().map((traj) => ({
      ...traj,
      steps: [
        {
          tool: TOOLS.runCommand,
          args: { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456' https://ok" },
          ok: true,
          grantedCapabilities: ["shell.readonly"],
        },
      ],
    }));
    const secretRes = synthesizeSkillFromTrajectories(withSecret);
    expect(secretRes.ok).toBe(false);

    const withUnseen = sampleTrajectories();
    if (withUnseen[0]?.steps[0]) {
      withUnseen[0].steps[0].args = { path: "notes/\u200bday1.txt" };
    }
    const unseenRes = synthesizeSkillFromTrajectories(withUnseen);
    expect(unseenRes.ok).toBe(false);

    const capEscalation = synthesizeSkillFromTrajectories(sampleTrajectories(), {
      stepCapabilities: ["fs.read.workspace", "shell.admin"],
    });
    expect(capEscalation.ok).toBe(false);
    if (!capEscalation.ok) {
      expect(capEscalation.reason).toContain("exceeds");
    }
  });

  it("enforces ratification lifecycle, drift demotion, recalibration, permissions checks, and active-only router export", async () => {
    const dir = await makeTempDir();
    const storeFile = join(dir, "compiled-skills.json");
    const store = new CompiledSkillStore(storeFile, {
      now: () => new Date("2026-11-22T12:00:00.000Z"),
    });

    const out = synthesizeSkillFromTrajectories(sampleTrajectories());
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    await store.propose(out.skill);
    // File permissions restricted cleanly.
    const fileInfo = await stat(storeFile);
    expect(fileInfo.mode & 0o777).toBe(0o600);

    // Proposed skills are excluded from ToolRouter export until explicitly ratified.
    const mockEmbedder: Embedder = {
      embed: async (texts) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    };
    expect(await store.toRouterDescriptors(mockEmbedder)).toHaveLength(0);

    const active = await store.ratify(out.skill.id);
    expect(active.status).toBe("active");
    expect(active.ratifiedAt).toBe("2026-11-22T12:00:00.000Z");

    const descriptors = await store.toRouterDescriptors(mockEmbedder);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.toolName).toBe(`skill:${out.skill.slug}`);
    expect(descriptors[0]?.embeddings?.length).toBeGreaterThan(0);

    // Permissions check delegates every step through toolVerdict (safe workspace read + ls passes).
    const safeReport = await store.verifyPermissions(
      out.skill.id,
      { path: "notes/day4.txt" },
      { workspace: dir, home: dir },
    );
    expect(safeReport.requiresApproval).toBe(false);
    expect(safeReport.blocked).toBe(false);

    // Private target forces interactive approval via permissions.ts even in a compiled skill.
    const privateReport = await store.verifyPermissions(
      out.skill.id,
      { path: "~/.ssh/id_ed25519" },
      { workspace: dir, home: dir },
    );
    expect(privateReport.requiresApproval).toBe(true);

    // Post-condition failure demotes active skill automatically.
    const drifted = await store.recordExecution(out.skill.id, {
      ok: false,
      postConditionMet: false,
      reason: "Menu layout changed after app update.",
    });
    expect(drifted.status).toBe("needs_recalibration");
    expect(await store.toRouterDescriptors(mockEmbedder)).toHaveLength(0);
    await expect(
      store.verifyPermissions(out.skill.id, { path: "notes/day4.txt" }, { workspace: dir }),
    ).rejects.toThrow(/needs_recalibration/);

    // Recalibration returns skill to `proposed` and rejects ungranted capabilities.
    await expect(
      store.recalibrate(out.skill.id, active.steps, ["fs.read.workspace"]),
    ).rejects.toThrow(/exceeds granted capabilities/);

    const recalibrated = await store.recalibrate(out.skill.id, active.steps, [
      "fs.read.workspace",
      "shell.readonly",
    ]);
    expect(recalibrated.status).toBe("proposed");
    expect(recalibrated.ratifiedAt).toBeNull();

    // Persists across reload.
    const reloaded = new CompiledSkillStore(storeFile);
    await reloaded.load();
    expect(reloaded.get(out.skill.id)?.status).toBe("proposed");
  });
});
