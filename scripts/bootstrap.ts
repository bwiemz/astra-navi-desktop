#!/usr/bin/env node
/**
 * Cross-platform zero-terminal setup helper for Astra Navi Desktop.
 *
 *   npm run setup -- all
 *   npm run setup -- ocr
 *   npm run setup -- voice
 *   npm run setup -- launcher
 *   npm run setup -- browser-bridge
 *   npm run setup -- --status
 */
import {
  checkBootstrapStatus,
  runBootstrapTask,
  type BootstrapTask,
} from "../src/core/bootstrap.ts";

const VALID_TASKS = new Set<BootstrapTask>(["voice", "ocr", "launcher", "browser-bridge", "all"]);
const args = process.argv.slice(2);

if (args.includes("--status")) {
  const status = await checkBootstrapStatus();
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

const dryRun = args.includes("--dry-run");
const rawTask = args.find((arg) => !arg.startsWith("-")) ?? "all";
if (!VALID_TASKS.has(rawTask as BootstrapTask)) {
  console.error(
    `Unknown setup task "${rawTask}". Choose one of: voice, ocr, launcher, browser-bridge, all.`,
  );
  process.exit(2);
}

const result = await runBootstrapTask(rawTask as BootstrapTask, {
  dryRun,
  onProgress: (p) => console.log(`[${p.task}] ${p.percent}% — ${p.detail}`),
});

for (const line of result.summary) {
  console.log(line);
}
