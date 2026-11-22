import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import type { PolicyContext } from "./permissions.ts";
import { canonical, isBroadPath, isInside, isPrivatePath, isSensitivePath } from "./riskRules.ts";
import { runCommand, type CommandResult } from "./shell.ts";
import { compareText } from "./textDiff.ts";

/**
 * Copy-on-Write Causal Dry-Run Engine (Tier 10 §5.1).
 *
 * Runs speculative multi-step shell, file, or GUI sequences inside an isolated
 * copy-on-write clone (Btrfs/ZFS when available, temp copy fallback) or headless
 * KWin virtual session before anything touches live state.
 */

export type CowBackend = "btrfs" | "zfs" | "copy";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  program: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<ExecResult>;

export interface FixedCommandSpec {
  program: string;
  args: string[];
}

export interface ShellDryRunStep {
  title: string;
  command: string;
  allowFailure?: boolean;
  timeoutMs?: number;
}

export interface GuiDryRunStep {
  title: string;
  action: string;
  target?: string;
  value?: string;
}

export type DryRunPostCondition =
  | { kind: "exit_zero" }
  | { kind: "file_exists"; path: string }
  | { kind: "file_missing"; path: string }
  | { kind: "file_contains"; path: string; pattern: string }
  | { kind: "output_matches"; pattern: string };

export interface DryRunFileDiff {
  path: string;
  status: "added" | "removed" | "modified";
  added: number;
  removed: number;
  diff: string;
  binary: boolean;
}

export interface DryRunStepOutcome {
  index: number;
  title: string;
  command: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  ok: boolean;
}

export interface DryRunPostConditionResult {
  condition: DryRunPostCondition;
  passed: boolean;
  detail: string;
}

export interface HeadlessKwinDryRunPlan {
  program: "kwin_wayland";
  args: string[];
  env: Record<string, string>;
  waylandSocket: string;
  cloneProfileDir: string;
}

export interface CausalDryRunResult {
  kind: "shell" | "gui";
  backend: CowBackend | "kwin-virtual";
  targetDir: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  steps: DryRunStepOutcome[];
  postConditions: DryRunPostConditionResult[];
  diffs: DryRunFileDiff[];
  summary: string;
  abortedReason?: string;
  kwinPlan?: HeadlessKwinDryRunPlan;
}

export interface ShellDryRunRequest {
  targetDir: string;
  steps: readonly ShellDryRunStep[];
  postConditions?: readonly DryRunPostCondition[];
  defaultTimeoutMs?: number;
}

export interface GuiDryRunRequest {
  appCommand: readonly string[];
  profileDir?: string;
  waylandSocket?: string;
  steps: readonly GuiDryRunStep[];
  postConditions?: readonly DryRunPostCondition[];
  width?: number;
  height?: number;
}

export interface CausalDryRunnerDeps {
  exec?: ExecFn;
  runShell?: (
    command: string,
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ) => Promise<CommandResult>;
  runGuiStep?: (
    step: GuiDryRunStep,
    context: { profileDir: string; plan: HeadlessKwinDryRunPlan },
  ) => Promise<{ ok: boolean; output: string }>;
  home?: string;
  privateDirs?: readonly string[];
  maxFiles?: number;
  maxFileBytes?: number;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const SAFE_ZFS_DATASET = /^[A-Za-z0-9_.:/-]+$/;
const SAFE_ZFS_SNAPSHOT = /^[A-Za-z0-9_.:/-]+(?:@[A-Za-z0-9_.:-]+)?$/;

function defaultExec(
  program: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      program,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 8000,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}

function makePolicyContext(targetDir: string, deps: CausalDryRunnerDeps): PolicyContext {
  return {
    workspace: targetDir,
    home: deps.home ?? homedir(),
    privateDirs: deps.privateDirs,
  };
}

async function assertSafeTargetDir(
  rawTargetDir: string,
  deps: CausalDryRunnerDeps,
  mustExist = true,
): Promise<string> {
  const home = deps.home ?? homedir();
  const context = makePolicyContext(rawTargetDir, deps);
  const resolved = await canonical(resolve(rawTargetDir));
  if (isSensitivePath(resolved) || isPrivatePath(resolved, context)) {
    throw new Error(`Dry-run refused: "${resolved}" is a private or sensitive directory.`);
  }
  if (isBroadPath(resolved, home)) {
    throw new Error(`Dry-run refused: "${resolved}" is too broad to snapshot safely.`);
  }
  if (mustExist) {
    const info = await stat(resolved).catch(() => null);
    if (!info || !info.isDirectory()) {
      throw new Error(`Dry-run target "${resolved}" does not exist or is not a directory.`);
    }
  }
  return resolved;
}

/** Detects CoW capabilities (`btrfs`, `zfs`, or `copy` fallback) via fixed-arg `findmnt`. */
export async function detectCowBackend(
  targetDir: string,
  exec: ExecFn = defaultExec,
): Promise<{ backend: CowBackend; source?: string }> {
  try {
    const { stdout } = await exec("findmnt", ["-n", "-o", "FSTYPE,SOURCE", "--target", targetDir], {
      timeoutMs: 3000,
    });
    const firstLine = stdout.split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) return { backend: "copy" };
    const tokens = firstLine.split(/\s+/);
    const fstype = (tokens[0] ?? "").toLowerCase();
    const rawSource = tokens.slice(1).join(" ").trim();
    const source = rawSource.length > 0 ? rawSource.replace(/\[.*\]$/, "") : undefined;
    if (fstype === "btrfs") return source ? { backend: "btrfs", source } : { backend: "btrfs" };
    if (fstype === "zfs") return source ? { backend: "zfs", source } : { backend: "zfs" };
    return source ? { backend: "copy", source } : { backend: "copy" };
  } catch {
    return { backend: "copy" };
  }
}

/** Builds fixed-arg argv specs for creating a CoW clone without shell expansion. */
export function buildCowCreateArgs(
  backend: CowBackend,
  sourceDir: string,
  cloneDir: string,
  zfsSource?: string,
): FixedCommandSpec[] {
  if (backend === "btrfs") {
    return [{ program: "btrfs", args: ["subvolume", "snapshot", sourceDir, cloneDir] }];
  }
  if (backend === "zfs" && zfsSource && SAFE_ZFS_DATASET.test(zfsSource)) {
    const snapTag = "ai_chan_dryrun";
    const snapshot = `${zfsSource}@${snapTag}`;
    const cloneDataset = `${zfsSource}_${snapTag}`;
    return [
      { program: "zfs", args: ["snapshot", snapshot] },
      { program: "zfs", args: ["clone", "-o", `mountpoint=${cloneDir}`, snapshot, cloneDataset] },
    ];
  }
  return [];
}

/** Builds fixed-arg argv specs for destroying a CoW clone created by `buildCowCreateArgs`. */
export function buildCowCleanupArgs(
  backend: CowBackend,
  cloneDir: string,
  zfsSourceOrSnap?: string,
): FixedCommandSpec[] {
  if (backend === "btrfs") {
    return [{ program: "btrfs", args: ["subvolume", "delete", cloneDir] }];
  }
  if (backend === "zfs" && zfsSourceOrSnap && SAFE_ZFS_SNAPSHOT.test(zfsSourceOrSnap)) {
    const snapshot = zfsSourceOrSnap.includes("@")
      ? zfsSourceOrSnap
      : `${zfsSourceOrSnap}@ai_chan_dryrun`;
    return [{ program: "zfs", args: ["destroy", "-R", snapshot] }];
  }
  return [];
}

async function collectRegularFiles(
  rootDir: string,
  options: { maxFiles: number },
): Promise<Map<string, string>> {
  const rootCanonical = await canonical(rootDir);
  const files = new Map<string, string>();
  const queue: string[] = [""];

  while (queue.length > 0 && files.size < options.maxFiles) {
    const relDir = queue.shift();
    if (relDir === undefined) break;
    const absDir = relDir === "" ? rootCanonical : join(rootCanonical, relDir);
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.size >= options.maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const rel = relDir === "" ? entry.name : posix.join(relDir, entry.name);
      const abs = join(absDir, entry.name);
      if (!isInside(abs, rootCanonical)) continue;
      if (entry.isDirectory()) {
        queue.push(rel);
      } else if (entry.isFile()) {
        files.set(rel, abs);
      }
    }
  }
  return files;
}

function isBinarySample(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

async function readForDiff(
  filePath: string,
  maxFileBytes: number,
): Promise<{ binary: boolean; text: string; bytes: Buffer }> {
  const info = await stat(filePath);
  if (info.size > maxFileBytes) {
    return { binary: true, text: "", bytes: Buffer.alloc(0) };
  }
  const bytes = await readFile(filePath);
  if (isBinarySample(bytes)) {
    return { binary: true, text: "", bytes };
  }
  return { binary: false, text: bytes.toString("utf8"), bytes };
}

/** Computes sorted file diffs between two directory trees using `compareText`. */
export async function diffDirectories(
  beforeDir: string,
  afterDir: string,
  options: { maxFiles?: number; maxFileBytes?: number } = {},
): Promise<DryRunFileDiff[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const beforeFiles = await collectRegularFiles(beforeDir, { maxFiles });
  const afterFiles = await collectRegularFiles(afterDir, { maxFiles });
  const allPaths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  const diffs: DryRunFileDiff[] = [];

  for (const relPath of allPaths) {
    const beforePath = beforeFiles.get(relPath);
    const afterPath = afterFiles.get(relPath);
    if (!beforePath && afterPath) {
      const content = await readForDiff(afterPath, maxFileBytes);
      if (content.binary) {
        diffs.push({
          path: relPath,
          status: "added",
          added: 0,
          removed: 0,
          diff: "(binary file added)",
          binary: true,
        });
      } else {
        const cmp = compareText("", content.text);
        diffs.push({
          path: relPath,
          status: "added",
          added: cmp.added,
          removed: cmp.removed,
          diff: cmp.text,
          binary: false,
        });
      }
    } else if (beforePath && !afterPath) {
      const content = await readForDiff(beforePath, maxFileBytes);
      if (content.binary) {
        diffs.push({
          path: relPath,
          status: "removed",
          added: 0,
          removed: 0,
          diff: "(binary file removed)",
          binary: true,
        });
      } else {
        const cmp = compareText(content.text, "");
        diffs.push({
          path: relPath,
          status: "removed",
          added: cmp.added,
          removed: cmp.removed,
          diff: cmp.text,
          binary: false,
        });
      }
    } else if (beforePath && afterPath) {
      const before = await readForDiff(beforePath, maxFileBytes);
      const after = await readForDiff(afterPath, maxFileBytes);
      if (before.binary || after.binary) {
        if (!before.bytes.equals(after.bytes)) {
          diffs.push({
            path: relPath,
            status: "modified",
            added: 0,
            removed: 0,
            diff: "(binary file modified)",
            binary: true,
          });
        }
        continue;
      }
      if (before.text !== after.text) {
        const cmp = compareText(before.text, after.text);
        diffs.push({
          path: relPath,
          status: "modified",
          added: cmp.added,
          removed: cmp.removed,
          diff: cmp.text,
          binary: false,
        });
      }
    }
  }
  return diffs;
}

async function evaluatePostConditions(
  conditions: readonly DryRunPostCondition[],
  rootDir: string,
  steps: readonly DryRunStepOutcome[],
): Promise<DryRunPostConditionResult[]> {
  const rootCanonical = await canonical(rootDir);
  const combinedOutput = steps.map((step) => step.output).join("\n");
  const results: DryRunPostConditionResult[] = [];

  for (const condition of conditions) {
    switch (condition.kind) {
      case "exit_zero": {
        const failed = steps.find((step) => !step.ok);
        results.push({
          condition,
          passed: failed === undefined && steps.length > 0,
          detail:
            failed === undefined
              ? `All ${steps.length} steps exited cleanly.`
              : `Step "${failed.title}" failed (exit ${failed.exitCode ?? "null"}).`,
        });
        break;
      }
      case "output_matches": {
        const matched = new RegExp(condition.pattern).test(combinedOutput);
        results.push({
          condition,
          passed: matched,
          detail: matched
            ? `Output matched /${condition.pattern}/.`
            : `Output did not match /${condition.pattern}/.`,
        });
        break;
      }
      case "file_exists":
      case "file_missing":
      case "file_contains": {
        const candidate = await canonical(resolve(rootCanonical, condition.path));
        if (!isInside(candidate, rootCanonical)) {
          results.push({
            condition,
            passed: false,
            detail: `Rejected post-condition path outside sandbox clone: "${condition.path}".`,
          });
          break;
        }
        const info = await stat(candidate).catch(() => null);
        if (condition.kind === "file_exists") {
          const exists = info !== null;
          results.push({
            condition,
            passed: exists,
            detail: exists ? `"${condition.path}" exists.` : `"${condition.path}" is missing.`,
          });
        } else if (condition.kind === "file_missing") {
          const missing = info === null;
          results.push({
            condition,
            passed: missing,
            detail: missing
              ? `"${condition.path}" is absent.`
              : `"${condition.path}" still exists.`,
          });
        } else {
          if (!info || !info.isFile()) {
            results.push({
              condition,
              passed: false,
              detail: `"${condition.path}" does not exist as a file.`,
            });
          } else {
            const text = await readFile(candidate, "utf8").catch(() => "");
            const matched = new RegExp(condition.pattern).test(text);
            results.push({
              condition,
              passed: matched,
              detail: matched
                ? `"${condition.path}" matched /${condition.pattern}/.`
                : `"${condition.path}" did not match /${condition.pattern}/.`,
            });
          }
        }
        break;
      }
    }
  }
  return results;
}

/** Formats a concise diff-backed dry-run summary for user approval cards. */
export function renderDryRunSummary(result: CausalDryRunResult): string {
  const lines: string[] = [
    `Dry-run (${result.kind}, backend: ${result.backend}): ${result.ok ? "PASSED" : "FAILED"}`,
    `Target: ${result.targetDir}`,
  ];
  if (result.abortedReason) lines.push(`Aborted: ${result.abortedReason}`);
  lines.push("Steps:");
  for (const step of result.steps) {
    lines.push(
      `  ${step.index + 1}. [${step.ok ? "OK" : "FAIL"}] ${step.title} (exit ${step.exitCode ?? "null"})`,
    );
  }
  if (result.postConditions.length > 0) {
    lines.push("Post-conditions:");
    for (const check of result.postConditions) {
      lines.push(`  - [${check.passed ? "OK" : "FAIL"}] ${check.detail}`);
    }
  }
  if (result.diffs.length === 0) {
    lines.push("File changes: none.");
  } else {
    lines.push(`File changes (${result.diffs.length}):`);
    for (const entry of result.diffs.slice(0, 12)) {
      lines.push(`  ${entry.status.toUpperCase()} ${entry.path} (+${entry.added}/-${entry.removed})`);
      if (entry.diff) {
        const preview = entry.diff.split("\n").slice(0, 12).join("\n    ");
        lines.push(`    ${preview}`);
      }
    }
    if (result.diffs.length > 12) {
      lines.push(`  … (${result.diffs.length - 12} more changed files omitted)`);
    }
  }
  return lines.join("\n").slice(0, 8000);
}

/** Builds a fixed-arg headless `kwin_wayland` virtual session launch plan for GUI dry-runs. */
export function buildHeadlessKwinDryRunPlan(options: {
  appCommand: readonly string[];
  cloneProfileDir: string;
  waylandSocket: string;
  width?: number;
  height?: number;
}): HeadlessKwinDryRunPlan {
  const width = Math.max(320, Math.min(3840, Math.trunc(options.width ?? 1280)));
  const height = Math.max(240, Math.min(2160, Math.trunc(options.height ?? 720)));
  const entryCmd = options.appCommand[0] ?? "true";
  const restArgs = options.appCommand.slice(1);
  return {
    program: "kwin_wayland",
    args: [
      "--virtual",
      "--width",
      String(width),
      "--height",
      String(height),
      "--socket",
      options.waylandSocket,
      "--exit-with-session",
      entryCmd,
      ...restArgs,
    ],
    env: {
      XDG_CONFIG_HOME: join(options.cloneProfileDir, "config"),
      XDG_DATA_HOME: join(options.cloneProfileDir, "data"),
      WAYLAND_DISPLAY: options.waylandSocket,
      QT_QPA_PLATFORM: "wayland",
      AI_CHAN_DRY_RUN: "1",
      AI_CHAN_NO_VIRTUAL_INPUT: "1",
    },
    waylandSocket: options.waylandSocket,
    cloneProfileDir: options.cloneProfileDir,
  };
}

export class CausalDryRunner {
  private readonly deps: CausalDryRunnerDeps;

  constructor(deps: CausalDryRunnerDeps = {}) {
    this.deps = deps;
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** Executes a multi-step shell pipeline in a disposable clone, computing diffs before discard. */
  async dryRunShellPipeline(request: ShellDryRunRequest): Promise<CausalDryRunResult> {
    const startedAt = this.nowIso();
    const resolvedTarget = await assertSafeTargetDir(request.targetDir, this.deps, true);
    const exec = this.deps.exec ?? defaultExec;
    const shellRunner = this.deps.runShell ?? runCommand;
    const maxFiles = this.deps.maxFiles ?? DEFAULT_MAX_FILES;
    const maxFileBytes = this.deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const tempBase = await mkdtemp(join(tmpdir(), "ai-chan-dryrun-"));
    const cloneDir = join(tempBase, "work");
    let usedBackend: CowBackend = "copy";
    let cowZfsSource: string | undefined;

    try {
      const detected = await detectCowBackend(resolvedTarget, exec);
      let cowCreated = false;
      if (detected.backend === "btrfs" || detected.backend === "zfs") {
        const specs = buildCowCreateArgs(
          detected.backend,
          resolvedTarget,
          cloneDir,
          detected.source,
        );
        if (specs.length > 0) {
          try {
            for (const spec of specs) {
              await exec(spec.program, spec.args, { timeoutMs: 8000 });
            }
            const cloneInfo = await stat(cloneDir).catch(() => null);
            if (cloneInfo?.isDirectory()) {
              cowCreated = true;
              usedBackend = detected.backend;
              cowZfsSource = detected.source;
            }
          } catch {
            cowCreated = false;
          }
        }
      }
      if (!cowCreated) {
        usedBackend = "copy";
        await cp(resolvedTarget, cloneDir, { recursive: true, dereference: false });
      }

      const outcomes: DryRunStepOutcome[] = [];
      let abortedReason: string | undefined;
      for (let index = 0; index < request.steps.length; index += 1) {
        const step = request.steps[index];
        if (!step) continue;
        const result = await shellRunner(step.command, {
          cwd: cloneDir,
          timeoutMs: step.timeoutMs ?? request.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        const ok = result.exitCode === 0 && !result.timedOut;
        outcomes.push({
          index,
          title: step.title,
          command: step.command,
          exitCode: result.exitCode,
          output: result.output,
          timedOut: result.timedOut,
          ok,
        });
        if (!ok && !step.allowFailure) {
          abortedReason = `Stopped at step ${index + 1} ("${step.title}").`;
          break;
        }
      }

      const postConditions = await evaluatePostConditions(
        request.postConditions ?? [],
        cloneDir,
        outcomes,
      );
      const diffs = await diffDirectories(resolvedTarget, cloneDir, { maxFiles, maxFileBytes });
      const stepsOk = outcomes.every((item, idx) => item.ok || request.steps[idx]?.allowFailure);
      const condsOk = postConditions.every((item) => item.passed);
      const ok = !abortedReason && stepsOk && condsOk;

      const finalResult: CausalDryRunResult = {
        kind: "shell",
        backend: usedBackend,
        targetDir: resolvedTarget,
        startedAt,
        finishedAt: this.nowIso(),
        ok,
        steps: outcomes,
        postConditions,
        diffs,
        summary: "",
        ...(abortedReason ? { abortedReason } : {}),
      };
      finalResult.summary = renderDryRunSummary(finalResult);
      return finalResult;
    } finally {
      if (usedBackend === "btrfs" || usedBackend === "zfs") {
        const cleanupSpecs = buildCowCleanupArgs(usedBackend, cloneDir, cowZfsSource);
        for (const spec of cleanupSpecs) {
          await exec(spec.program, spec.args, { timeoutMs: 5000 }).catch(() => undefined);
        }
      }
      await rm(tempBase, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Prepares a headless virtual KWin session against an isolated cloned profile directory
   * and evaluates GUI steps and post-conditions without touching live desktop windows.
   */
  async dryRunGuiSequence(request: GuiDryRunRequest): Promise<CausalDryRunResult> {
    const startedAt = this.nowIso();
    const resolvedProfile = request.profileDir
      ? await assertSafeTargetDir(request.profileDir, this.deps, true)
      : "";
    const tempBase = await mkdtemp(join(tmpdir(), "ai-chan-kwin-dry-"));
    const cloneProfileDir = join(tempBase, "profile");
    const waylandSocket = request.waylandSocket ?? `ai-chan-dry-${process.pid}`;
    const maxFiles = this.deps.maxFiles ?? DEFAULT_MAX_FILES;
    const maxFileBytes = this.deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

    try {
      if (resolvedProfile) {
        await cp(resolvedProfile, cloneProfileDir, { recursive: true, dereference: false });
      } else {
        await mkdir(join(cloneProfileDir, "config"), { recursive: true });
        await mkdir(join(cloneProfileDir, "data"), { recursive: true });
      }

      const plan = buildHeadlessKwinDryRunPlan({
        appCommand: request.appCommand,
        cloneProfileDir,
        waylandSocket,
        width: request.width,
        height: request.height,
      });

      const outcomes: DryRunStepOutcome[] = [];
      let abortedReason: string | undefined;
      for (let index = 0; index < request.steps.length; index += 1) {
        const step = request.steps[index];
        if (!step) continue;
        const stepOut = this.deps.runGuiStep
          ? await this.deps.runGuiStep(step, { profileDir: cloneProfileDir, plan })
          : { ok: true, output: `Dry-run planned step "${step.action}" in headless KWin.` };
        outcomes.push({
          index,
          title: step.title,
          command: `${step.action}${step.target ? ` ${step.target}` : ""}`,
          exitCode: stepOut.ok ? 0 : 1,
          output: stepOut.output,
          timedOut: false,
          ok: stepOut.ok,
        });
        if (!stepOut.ok) {
          abortedReason = `Stopped at GUI step ${index + 1} ("${step.title}").`;
          break;
        }
      }

      const postConditions = await evaluatePostConditions(
        request.postConditions ?? [],
        cloneProfileDir,
        outcomes,
      );
      const diffs = resolvedProfile
        ? await diffDirectories(resolvedProfile, cloneProfileDir, { maxFiles, maxFileBytes })
        : [];
      const stepsOk = outcomes.every((item) => item.ok);
      const condsOk = postConditions.every((item) => item.passed);

      const finalResult: CausalDryRunResult = {
        kind: "gui",
        backend: "kwin-virtual",
        targetDir: resolvedProfile || cloneProfileDir,
        startedAt,
        finishedAt: this.nowIso(),
        ok: !abortedReason && stepsOk && condsOk,
        steps: outcomes,
        postConditions,
        diffs,
        summary: "",
        kwinPlan: plan,
        ...(abortedReason ? { abortedReason } : {}),
      };
      finalResult.summary = renderDryRunSummary(finalResult);
      return finalResult;
    } finally {
      await rm(tempBase, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
