import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCowCleanupArgs,
  buildCowCreateArgs,
  buildHeadlessKwinDryRunPlan,
  CausalDryRunner,
  detectCowBackend,
  diffDirectories,
} from "../src/core/dryRun.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("CoW Causal Dry-Run Engine (Tier 10 §5.1)", () => {
  it("detects btrfs, zfs, and copy fallback cleanly and emits fixed-arg CoW commands", async () => {
    const btrfsDetect = await detectCowBackend("/srv/data", async () => ({
      stdout: "btrfs /dev/nvme0n1p2[/@data]\n",
      stderr: "",
    }));
    expect(btrfsDetect).toEqual({ backend: "btrfs", source: "/dev/nvme0n1p2" });

    const zfsDetect = await detectCowBackend("/tank/ws", async () => ({
      stdout: "zfs tank/ws\n",
      stderr: "",
    }));
    expect(zfsDetect).toEqual({ backend: "zfs", source: "tank/ws" });

    const ext4Detect = await detectCowBackend("/home/u/ws", async () => ({
      stdout: "ext4 /dev/sda1\n",
      stderr: "",
    }));
    expect(ext4Detect).toEqual({ backend: "copy", source: "/dev/sda1" });

    const errDetect = await detectCowBackend("/missing", async () => {
      throw new Error("findmnt missing");
    });
    expect(errDetect).toEqual({ backend: "copy" });

    expect(buildCowCreateArgs("btrfs", "/src", "/tmp/clone")).toEqual([
      { program: "btrfs", args: ["subvolume", "snapshot", "/src", "/tmp/clone"] },
    ]);
    expect(buildCowCleanupArgs("btrfs", "/tmp/clone")).toEqual([
      { program: "btrfs", args: ["subvolume", "delete", "/tmp/clone"] },
    ]);
    expect(buildCowCreateArgs("zfs", "/tank/ws", "/tmp/clone", "tank/ws")).toEqual([
      { program: "zfs", args: ["snapshot", "tank/ws@ai_chan_dryrun"] },
      {
        program: "zfs",
        args: ["clone", "-o", "mountpoint=/tmp/clone", "tank/ws@ai_chan_dryrun", "tank/ws_ai_chan_dryrun"],
      },
    ]);
    expect(buildCowCleanupArgs("zfs", "/tmp/clone", "tank/ws@ai_chan_dryrun")).toEqual([
      { program: "zfs", args: ["destroy", "-R", "tank/ws@ai_chan_dryrun"] },
    ]);
  });

  it("executes multi-step shell pipelines in an isolated clone, computes diffs, leaves source untouched, and cleans temp clone", async () => {
    const src = await makeTempDir("ai-chan-dry-src-");
    await writeFile(join(src, "config.txt"), "port=8080\nmode=dev\n", "utf8");
    await writeFile(join(src, "obsolete.log"), "old log\n", "utf8");

    const beforeTmp = await readdir(tmpdir());
    const runner = new CausalDryRunner({
      exec: async () => ({ stdout: "ext4 /dev/nvme0n1p2\n", stderr: "" }),
    });

    const result = await runner.dryRunShellPipeline({
      targetDir: src,
      steps: [
        { title: "Update config", command: "sed -i 's/mode=dev/mode=prod/' config.txt" },
        { title: "Remove obsolete log & write marker", command: "rm obsolete.log && echo ready > health.txt" },
      ],
      postConditions: [
        { kind: "exit_zero" },
        { kind: "file_exists", path: "health.txt" },
        { kind: "file_missing", path: "obsolete.log" },
        { kind: "file_contains", path: "config.txt", pattern: "mode=prod" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.backend).toBe("copy");
    expect(result.postConditions.every((p) => p.passed)).toBe(true);
    expect(result.diffs.map((d) => `${d.status}:${d.path}`)).toEqual([
      "modified:config.txt",
      "added:health.txt",
      "removed:obsolete.log",
    ]);
    const configDiff = result.diffs.find((d) => d.path === "config.txt");
    expect(configDiff?.diff).toContain("-mode=dev");
    expect(configDiff?.diff).toContain("+mode=prod");
    expect(result.summary).toContain("PASSED");

    // Live source directory remains untouched.
    expect(await readFile(join(src, "config.txt"), "utf8")).toBe("port=8080\nmode=dev\n");
    expect(existsSync(join(src, "obsolete.log"))).toBe(true);
    expect(existsSync(join(src, "health.txt"))).toBe(false);

    // Ephemeral clone directories were removed.
    const afterTmp = await readdir(tmpdir());
    const leftover = afterTmp.filter((name) => name.startsWith("ai-chan-dryrun-") && !beforeTmp.includes(name));
    expect(leftover).toEqual([]);
  });

  it("stops on failed step and discards clone without touching live files", async () => {
    const src = await makeTempDir("ai-chan-dry-fail-");
    await writeFile(join(src, "app.txt"), "v1\n", "utf8");

    const runner = new CausalDryRunner({
      exec: async () => ({ stdout: "ext4 /dev/sda1\n", stderr: "" }),
    });
    const result = await runner.dryRunShellPipeline({
      targetDir: src,
      steps: [
        { title: "Write temp", command: "echo v2 > app.txt" },
        { title: "Failing check", command: "exit 2" },
        { title: "Never runs", command: "echo should_not_exist > after.txt" },
      ],
      postConditions: [{ kind: "exit_zero" }],
    });

    expect(result.ok).toBe(false);
    expect(result.abortedReason).toContain('step 2 ("Failing check")');
    expect(result.steps).toHaveLength(2);
    expect(result.postConditions[0]?.passed).toBe(false);
    expect(await readFile(join(src, "app.txt"), "utf8")).toBe("v1\n");
  });

  it("refuses sensitive and broad directories", async () => {
    const fakeHome = await makeTempDir("ai-chan-fake-home-");
    const sshDir = join(fakeHome, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const runner = new CausalDryRunner({ home: fakeHome });

    await expect(
      runner.dryRunShellPipeline({ targetDir: sshDir, steps: [{ title: "noop", command: "ls" }] }),
    ).rejects.toThrow(/private or sensitive/i);

    await expect(
      runner.dryRunShellPipeline({ targetDir: fakeHome, steps: [{ title: "noop", command: "ls" }] }),
    ).rejects.toThrow(/too broad/i);

    await expect(
      runner.dryRunShellPipeline({ targetDir: "/", steps: [{ title: "noop", command: "ls" }] }),
    ).rejects.toThrow(/too broad/i);
  });

  it("constructs headless virtual KWin GUI dry-run plans, executes injected steps on cloned profile, and cleans up", async () => {
    const profileDir = await makeTempDir("ai-chan-kwin-profile-");
    await mkdir(join(profileDir, "config"), { recursive: true });
    await writeFile(join(profileDir, "config", "settings.ini"), "theme=light\n", "utf8");

    const seenProfileDirs: string[] = [];
    const runGuiStep = vi.fn(
      async (step: { action: string }, ctx: { profileDir: string }) => {
        seenProfileDirs.push(ctx.profileDir);
        if (step.action === "save") {
          await writeFile(join(ctx.profileDir, "config", "settings.ini"), "theme=dark\n", "utf8");
        }
        return { ok: true, output: `Simulated ${step.action}` };
      },
    );

    const plan = buildHeadlessKwinDryRunPlan({
      appCommand: ["kate", "--new"],
      cloneProfileDir: "/tmp/clone-prof",
      waylandSocket: "ai-chan-dry-1",
    });
    expect(plan.program).toBe("kwin_wayland");
    expect(plan.args).toContain("--virtual");
    expect(plan.args).toContain("--exit-with-session");
    expect(plan.env["AI_CHAN_NO_VIRTUAL_INPUT"]).toBe("1");

    const runner = new CausalDryRunner({ runGuiStep });
    const guiResult = await runner.dryRunGuiSequence({
      appCommand: ["kate"],
      profileDir,
      steps: [
        { title: "Select dark theme", action: "click", target: "Dark" },
        { title: "Save preferences", action: "save" },
      ],
      postConditions: [{ kind: "file_contains", path: "config/settings.ini", pattern: "theme=dark" }],
    });

    expect(guiResult.ok).toBe(true);
    expect(guiResult.backend).toBe("kwin-virtual");
    expect(guiResult.diffs[0]?.path).toBe("config/settings.ini");
    expect(await readFile(join(profileDir, "config", "settings.ini"), "utf8")).toBe("theme=light\n");
    expect(seenProfileDirs[0]).toBeTruthy();
    expect(existsSync(seenProfileDirs[0] as string)).toBe(false);
  });

  it("diffs directories safely skipping symlinks and tagging binary files", async () => {
    const dirA = await makeTempDir("ai-chan-diff-a-");
    const dirB = await makeTempDir("ai-chan-diff-b-");
    await writeFile(join(dirA, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(dirB, "bin.dat"), Buffer.from([0, 1, 2, 4]));

    const diffs = await diffDirectories(dirA, dirB);
    expect(diffs).toEqual([
      { path: "bin.dat", status: "modified", added: 0, removed: 0, diff: "(binary file modified)", binary: true },
    ]);
  });
});
