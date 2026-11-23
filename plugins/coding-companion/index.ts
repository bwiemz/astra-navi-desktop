/**
 * Optional Coding Companion Creator Plugin Pack (defaultEnabled: false).
 *
 * Provides read-only git diff summarization and LSP diagnostic grouping inside the
 * approved workspace plus an approval-gated test runner trigger.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isInside } from "../../src/core/riskRules.ts";

export interface DiagnosticSummaryItem {
  severity: "error" | "warning" | "info";
  file: string;
  message: string;
  line: number;
}

export interface CodingCompanionDeps {
  workspace: string;
  readGitDiff(): Promise<string>;
  readDiagnostics(): Promise<readonly DiagnosticSummaryItem[]>;
  runTests(command: string): Promise<{ exitCode: number; summary: string }>;
}

const ALLOWED_TEST_COMMAND_PREFIXES = [
  "npm test",
  "npm run test",
  "pnpm test",
  "yarn test",
  "vitest",
  "npx vitest",
  "jest",
  "pytest",
  "cargo test",
  "go test",
  "dotnet test",
] as const;

function hasForbiddenCommandChars(cmd: string): boolean {
  for (let i = 0; i < cmd.length; i += 1) {
    const code = cmd.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return /[;&|`$<>(){}\\]/.test(cmd);
}

function isAllowedTestCommand(cmd: string): boolean {
  if (!cmd || cmd.length > 200 || hasForbiddenCommandChars(cmd)) return false;
  return ALLOWED_TEST_COMMAND_PREFIXES.some(
    (prefix) => cmd === prefix || cmd.startsWith(`${prefix} `),
  );
}

function isInsideRealWorkspace(targetPath: string, workspaceDir: string): boolean {
  const wsResolved = resolve(workspaceDir);
  const targetResolved = resolve(wsResolved, targetPath);
  if (!isInside(targetResolved, wsResolved)) return false;
  try {
    const wsReal = existsSync(wsResolved) ? realpathSync(wsResolved) : wsResolved;
    if (existsSync(targetResolved)) {
      const targetReal = realpathSync(targetResolved);
      return isInside(targetReal, wsReal);
    }
  } catch {
    return false;
  }
  return true;
}

export function summarizeGitDiffStat(diffText: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) filesChanged += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { filesChanged, insertions, deletions };
}

export function createCodingCompanionPlugin(deps: CodingCompanionDeps) {
  return {
    id: "coding-companion",
    async handleTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const bareName = toolName.replace(/^plugin:/, "");
      switch (bareName) {
        case "code.git_diff_summary": {
          const diff = await deps.readGitDiff();
          return { ...summarizeGitDiffStat(diff), outsideText: true };
        }
        case "code.diagnostics": {
          const rawTarget = typeof args["path"] === "string" ? args["path"] : deps.workspace;
          if (!isInsideRealWorkspace(rawTarget, deps.workspace)) {
            throw new Error("Refused diagnostic inspection outside the workspace.");
          }
          const rawItems = await deps.readDiagnostics();
          const items = rawItems.filter((d) => isInsideRealWorkspace(d.file, deps.workspace));
          const errors = items.filter((d) => d.severity === "error").length;
          const warnings = items.filter((d) => d.severity === "warning").length;
          return { total: items.length, errors, warnings, items: items.slice(0, 50), outsideText: true };
        }
        case "code.run_tests": {
          const cmd = typeof args["command"] === "string" ? args["command"].trim() : "npm test";
          if (!isAllowedTestCommand(cmd)) {
            throw new Error("Refused disallowed test runner command or shell metacharacters.");
          }
          const result = await deps.runTests(cmd);
          return { exitCode: result.exitCode, summary: result.summary };
        }
        default:
          throw new Error(`Unsupported coding companion tool "${toolName}".`);
      }
    },
  };
}
