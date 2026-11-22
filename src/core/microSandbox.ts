import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveToolPath, type PolicyContext } from "./permissions.ts";
import { isPrivatePath } from "./riskRules.ts";
import { withoutSecrets } from "./secrets.ts";

/**
 * Ephemeral Rootless Micro-Sandboxes (Tier 10 §5.3).
 *
 * Executes autonomous Python or Node analysis scripts inside rootless bubblewrap
 * (`bwrap`) namespaces with zero network access, read-only explicitly declared inputs,
 * an ephemeral scratch directory, and hard CPU/wall/memory ceilings. Fails closed
 * whenever `bwrap` is unavailable or any input touches a private path.
 */

export const MAX_CPU_SECONDS = 15;
export const MAX_WALL_MS = 30_000;
export const MAX_MEMORY_MB = 1024;
export const MAX_SCRIPT_BYTES = 65_536;
export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_SCRATCH_FILES = 32;
export const MAX_SCRATCH_BYTES = 8 * 1024 * 1024;

export type SandboxRuntime = "python" | "node";

export interface SandboxInputFile {
  path: string;
  /** Optional basename inside `/inputs/<name>`. Directories are stripped. */
  name?: string;
}

export interface SandboxInputMount {
  hostPath: string;
  containerPath: string;
}

export interface MicroSandboxRequest {
  enabled: boolean;
  runtime: SandboxRuntime;
  code: string;
  inputFiles?: readonly SandboxInputFile[];
  cpuSeconds?: number;
  wallMs?: number;
  memoryMb?: number;
  policyContext: PolicyContext;
  signal?: AbortSignal;
}

export interface SandboxArtifact {
  name: string;
  bytes: number;
  binary: boolean;
  preview: string;
}

export interface MicroSandboxResult {
  ok: boolean;
  blocked: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  artifacts: SandboxArtifact[];
  args: string[];
  reason?: string;
}

export interface MicroSandboxExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface MicroSandboxDeps {
  probeBwrap?: () => Promise<boolean>;
  runBwrap?: (
    args: readonly string[],
    options: { scratchDir: string; wallMs: number; signal?: AbortSignal },
  ) => Promise<MicroSandboxExecResult>;
  roSystemDirs?: readonly string[];
  usePrlimit?: boolean;
}

const DEFAULT_SYSTEM_RO_DIRS = ["/usr", "/lib", "/lib64", "/bin", "/etc/alternatives"];

function clipOutput(text: string, maxChars = MAX_OUTPUT_CHARS): string {
  const scrubbed = withoutSecrets(text);
  if (scrubbed.length <= maxChars) return scrubbed;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  return `${scrubbed.slice(0, head)}\n… (${scrubbed.length - maxChars} chars truncated) …\n${scrubbed.slice(-tail)}`;
}

function clampLimits(request: Pick<MicroSandboxRequest, "cpuSeconds" | "wallMs" | "memoryMb">): {
  cpuSeconds: number;
  wallMs: number;
  memoryMb: number;
} {
  const rawCpu = request.cpuSeconds ?? MAX_CPU_SECONDS;
  const rawWall = request.wallMs ?? MAX_WALL_MS;
  const rawMem = request.memoryMb ?? MAX_MEMORY_MB;
  return {
    cpuSeconds: Math.max(1, Math.min(MAX_CPU_SECONDS, Math.trunc(rawCpu))),
    wallMs: Math.max(500, Math.min(MAX_WALL_MS, Math.trunc(rawWall))),
    memoryMb: Math.max(64, Math.min(MAX_MEMORY_MB, Math.trunc(rawMem))),
  };
}

function safeMountName(raw: string, used: Set<string>): string {
  const clean = basename(raw).replace(/[^A-Za-z0-9._-]/g, "_") || "input";
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  let idx = 2;
  while (used.has(`${idx}_${clean}`)) idx += 1;
  const unique = `${idx}_${clean}`;
  used.add(unique);
  return unique;
}

/** Builds fixed-arg `bwrap` argv without shell invocation or network access. */
export function buildBwrapArgs(options: {
  runtime: SandboxRuntime;
  scratchDir: string;
  scriptFilename: string;
  inputMounts: readonly SandboxInputMount[];
  cpuSeconds?: number;
  memoryMb?: number;
  usePrlimit?: boolean;
  roSystemDirs?: readonly string[];
}): string[] {
  const { cpuSeconds, memoryMb } = clampLimits(options);
  const roDirs =
    options.roSystemDirs ?? DEFAULT_SYSTEM_RO_DIRS.filter((dir) => existsSync(dir));
  const usePrlimit = options.usePrlimit ?? true;
  const memBytes = memoryMb * 1024 * 1024;

  const args: string[] = [
    "--unshare-all",
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];

  for (const dir of roDirs) {
    args.push("--ro-bind", dir, dir);
  }

  args.push("--dir", "/inputs");
  for (const mount of options.inputMounts) {
    args.push("--ro-bind", mount.hostPath, mount.containerPath);
  }

  args.push("--bind", options.scratchDir, "/work", "--chdir", "/work");
  args.push(
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/work",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PYTHONDONTWRITEBYTECODE",
    "1",
  );
  if (options.runtime === "node") {
    args.push("--setenv", "NODE_OPTIONS", `--max-old-space-size=${memoryMb}`);
  }
  args.push("--");
  if (usePrlimit) {
    args.push("prlimit", `--cpu=${cpuSeconds}`, `--as=${memBytes}`, "--");
  }
  if (options.runtime === "python") {
    args.push("python3", "-I", `/work/${options.scriptFilename}`);
  } else {
    args.push("node", `/work/${options.scriptFilename}`);
  }
  return args;
}

function defaultProbeBwrap(): Promise<boolean> {
  return new Promise((resolveProbe) => {
    execFile("bwrap", ["--version"], { timeout: 2500 }, (error) => {
      resolveProbe(!error);
    });
  });
}

function defaultRunBwrap(
  args: readonly string[],
  options: { scratchDir: string; wallMs: number; signal?: AbortSignal },
): Promise<MicroSandboxExecResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "Aborted before sandbox start.",
    });
  }
  return new Promise((resolveExec) => {
    const child = spawn("bwrap", args, {
      cwd: options.scratchDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const appendBounded = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT_CHARS * 4) return current;
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.wallMs);
    options.signal?.addEventListener("abort", killGroup, { once: true });

    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", killGroup);
      resolveExec({
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: error.message,
      });
    });

    child.once("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", killGroup);
      resolveExec({
        exitCode,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

async function inspectScratchArtifacts(
  scratchDir: string,
  scriptFilename: string,
): Promise<SandboxArtifact[]> {
  const entries = await readdir(scratchDir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const artifacts: SandboxArtifact[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (artifacts.length >= MAX_SCRATCH_FILES) break;
    if (entry.name === scriptFilename) continue;
    if (!entry.isFile()) continue;
    const full = join(scratchDir, entry.name);
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) continue;
    totalBytes += info.size;
    if (totalBytes > MAX_SCRATCH_BYTES) break;

    const bytes = await readFile(full).catch(() => Buffer.alloc(0));
    const sample = bytes.subarray(0, 8192);
    const binary = sample.includes(0);
    const preview = binary
      ? `(binary ${info.size} bytes)`
      : clipOutput(bytes.toString("utf8"), 2000);
    artifacts.push({
      name: entry.name,
      bytes: info.size,
      binary,
      preview,
    });
  }
  return artifacts;
}

function failBlocked(reason: string, args: string[] = []): MicroSandboxResult {
  return {
    ok: false,
    blocked: true,
    exitCode: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: [],
    args,
    reason,
  };
}

/**
 * Executes a Python or Node script inside an isolated, network-free rootless `bwrap`
 * micro-sandbox. Always fails closed when disabled, misconfigured, or lacking `bwrap`.
 */
export async function runMicroSandbox(
  request: MicroSandboxRequest,
  deps: MicroSandboxDeps = {},
): Promise<MicroSandboxResult> {
  if (!request.enabled) {
    return failBlocked("Micro-sandbox is disabled in Tier 10 settings.");
  }
  if (!request.code.trim()) {
    return failBlocked("Micro-sandbox script cannot be empty.");
  }
  if (request.code.includes("\0")) {
    return failBlocked("Micro-sandbox script contains forbidden NUL bytes.");
  }
  const scriptBytes = Buffer.byteLength(request.code, "utf8");
  if (scriptBytes > MAX_SCRIPT_BYTES) {
    return failBlocked(
      `Micro-sandbox script exceeds maximum size (${scriptBytes} > ${MAX_SCRIPT_BYTES} bytes).`,
    );
  }

  const usedMountNames = new Set<string>();
  const mounts: SandboxInputMount[] = [];
  for (const input of request.inputFiles ?? []) {
    const resolved = await resolveToolPath(input.path, request.policyContext);
    if (isPrivatePath(resolved, request.policyContext)) {
      return failBlocked(`Refused mounting private file inside micro-sandbox: "${input.path}".`);
    }
    const info = await stat(resolved).catch(() => null);
    if (!info || !info.isFile()) {
      return failBlocked(`Input path must be an existing regular file: "${input.path}".`);
    }
    const mountName = safeMountName(input.name ?? resolved, usedMountNames);
    mounts.push({
      hostPath: resolved,
      containerPath: `/inputs/${mountName}`,
    });
  }

  const probe = deps.probeBwrap ?? defaultProbeBwrap;
  if (!(await probe())) {
    return failBlocked(
      "Rootless bubblewrap (`bwrap`) is unavailable; refusing unsandboxed execution.",
    );
  }

  const { cpuSeconds, wallMs, memoryMb } = clampLimits(request);
  const scriptFilename = request.runtime === "python" ? "__script__.py" : "__script__.mjs";
  const scratchDir = await mkdtemp(join(tmpdir(), "ai-chan-usbx-"));

  try {
    await writeFile(join(scratchDir, scriptFilename), request.code, {
      encoding: "utf8",
      mode: 0o600,
    });
    const args = buildBwrapArgs({
      runtime: request.runtime,
      scratchDir,
      scriptFilename,
      inputMounts: mounts,
      cpuSeconds,
      memoryMb,
      usePrlimit: deps.usePrlimit,
      roSystemDirs: deps.roSystemDirs,
    });
    const execRunner = deps.runBwrap ?? defaultRunBwrap;
    const outcome = await execRunner(args, {
      scratchDir,
      wallMs,
      signal: request.signal,
    });
    const artifacts = await inspectScratchArtifacts(scratchDir, scriptFilename);
    return {
      ok: outcome.exitCode === 0 && !outcome.timedOut,
      blocked: false,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      stdout: clipOutput(outcome.stdout),
      stderr: clipOutput(outcome.stderr),
      artifacts,
      args,
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
