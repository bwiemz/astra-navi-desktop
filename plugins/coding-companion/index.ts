/**
 * Optional Coding Companion Creator Plugin Pack (defaultEnabled: false).
 *
 * Provides read-only git diff summarization and LSP diagnostic grouping inside the
 * approved workspace plus an approval-gated test runner trigger.
 */

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
          const targetPath = typeof args["path"] === "string" ? args["path"] : deps.workspace;
          if (!isInside(targetPath, deps.workspace)) {
            throw new Error("Refused diagnostic inspection outside the workspace.");
          }
          const items = await deps.readDiagnostics();
          const errors = items.filter((d) => d.severity === "error").length;
          const warnings = items.filter((d) => d.severity === "warning").length;
          return { total: items.length, errors, warnings, items: items.slice(0, 50), outsideText: true };
        }
        case "code.run_tests": {
          const cmd = typeof args["command"] === "string" ? args["command"].trim() : "npm test";
          if (!cmd || /[;&|`$<>]/.test(cmd)) {
            throw new Error("Refused test command containing shell metacharacters.");
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
