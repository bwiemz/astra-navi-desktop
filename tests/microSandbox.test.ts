import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBwrapArgs,
  MAX_CPU_SECONDS,
  MAX_MEMORY_MB,
  MAX_SCRIPT_BYTES,
  runMicroSandbox,
} from "../src/core/microSandbox.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "ai-chan-usbx-test-"): Promise<string> {
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

describe("Ephemeral Rootless Micro-Sandboxes (Tier 10 §5.3)", () => {
  it("builds bwrap argv with network unsharing, read-only input mounts, single /work bind, and clamped prlimit ceilings", () => {
    const args = buildBwrapArgs({
      runtime: "python",
      scratchDir: "/tmp/scratch-1",
      scriptFilename: "__script__.py",
      inputMounts: [{ hostPath: "/ws/data.csv", containerPath: "/inputs/data.csv" }],
      cpuSeconds: 999,
      memoryMb: 99_999,
      roSystemDirs: ["/usr", "/lib"],
    });

    expect(args).toContain("--unshare-all");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain(`--cpu=${MAX_CPU_SECONDS}`);
    expect(args).toContain(`--as=${MAX_MEMORY_MB * 1024 * 1024}`);
    expect(args.join(" ")).toContain("--ro-bind /ws/data.csv /inputs/data.csv");
    expect(args.join(" ")).toContain("--bind /tmp/scratch-1 /work");
    expect(args.slice(-3)).toEqual(["python3", "-I", "/work/__script__.py"]);
  });

  it("fails closed when disabled, when bwrap is absent, on oversized/NUL scripts, or on private input files", async () => {
    const ws = await makeTempDir();
    const fakeHome = await makeTempDir("ai-chan-home-");
    const sshDir = join(fakeHome, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const privateKey = join(sshDir, "id_ed25519");
    await writeFile(privateKey, "PRIVATE", "utf8");

    const safeFile = join(ws, "data.csv");
    await writeFile(safeFile, "a,b\n1,2\n", "utf8");

    const disabled = await runMicroSandbox({
      enabled: false,
      runtime: "python",
      code: "print(1)",
      policyContext: { workspace: ws, home: fakeHome },
    });
    expect(disabled.blocked).toBe(true);
    expect(disabled.ok).toBe(false);

    const noBwrap = await runMicroSandbox(
      {
        enabled: true,
        runtime: "python",
        code: "print(1)",
        policyContext: { workspace: ws, home: fakeHome },
      },
      { probeBwrap: async () => false },
    );
    expect(noBwrap.blocked).toBe(true);
    expect(noBwrap.reason).toContain("refusing unsandboxed execution");

    const privateMount = await runMicroSandbox(
      {
        enabled: true,
        runtime: "python",
        code: "print(open('/inputs/id_ed25519').read())",
        inputFiles: [{ path: privateKey }],
        policyContext: { workspace: ws, home: fakeHome },
      },
      { probeBwrap: async () => true },
    );
    expect(privateMount.blocked).toBe(true);
    expect(privateMount.reason).toContain("private");

    const oversized = await runMicroSandbox(
      {
        enabled: true,
        runtime: "node",
        code: "x".repeat(MAX_SCRIPT_BYTES + 10),
        policyContext: { workspace: ws, home: fakeHome },
      },
      { probeBwrap: async () => true },
    );
    expect(oversized.blocked).toBe(true);

    const nulByte = await runMicroSandbox(
      {
        enabled: true,
        runtime: "node",
        code: "console.log('a\0b')",
        policyContext: { workspace: ws, home: fakeHome },
      },
      { probeBwrap: async () => true },
    );
    expect(nulByte.blocked).toBe(true);
  });

  it("runs scripts safely through bwrap runner, scrubs secrets from outputs/artifacts, and deletes scratch dir", async () => {
    const ws = await makeTempDir();
    const csvFile = join(ws, "sales.csv");
    await writeFile(csvFile, "item,price\na,10\n", "utf8");

    const beforeTmp = await readdir(tmpdir());
    let seenScratch = "";

    const res = await runMicroSandbox(
      {
        enabled: true,
        runtime: "node",
        code: "console.log('Bearer sk-abcdefghijklmnopqrstuvwxyz123456 total=10');",
        inputFiles: [{ path: csvFile }],
        policyContext: { workspace: ws, home: ws },
      },
      {
        probeBwrap: async () => true,
        runBwrap: async (_args, opts) => {
          seenScratch = opts.scratchDir;
          await writeFile(join(opts.scratchDir, "summary.txt"), "api_key=supersecret12345\n", "utf8");
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "Bearer abcdefghijklmnop12345 total=10",
            stderr: "",
          };
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.stdout).toContain("Bearer [hidden]");
    expect(res.artifacts).toEqual([
      { name: "summary.txt", bytes: 25, binary: false, preview: "api_key=[hidden]\n" },
    ]);
    expect(seenScratch).toBeTruthy();

    const afterTmp = await readdir(tmpdir());
    const leftover = afterTmp.filter((name) => name.startsWith("ai-chan-usbx-") && !beforeTmp.includes(name));
    expect(leftover).toEqual([]);
  });

  it("smoke-tests real bubblewrap execution when host user namespaces allow it", async () => {
    const ws = await makeTempDir();
    const canRealBwrap = await new Promise<boolean>((resolve) => {
      execFile(
        "bwrap",
        ["--unshare-net", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--", "python3", "-I", "-c", "print(42)"],
        { timeout: 3000 },
        (err, stdout) => resolve(!err && stdout.trim() === "42"),
      );
    });
    if (!canRealBwrap) return;

    const live = await runMicroSandbox({
      enabled: true,
      runtime: "python",
      code: "print(21 * 2)",
      policyContext: { workspace: ws, home: ws },
    });
    expect(live.ok).toBe(true);
    expect(live.stdout.trim()).toBe("42");
  });
});
