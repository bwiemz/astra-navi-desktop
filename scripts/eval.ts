/**
 * Her test suite: puts a fixed set of requests to the real brain in a pretend world and
 * marks what she does by plain rules. Made to judge a change to her model or settings
 * (a different quantization, a tuned small model, a smaller context) before it ships.
 *
 *   npm run eval                              every case, once, against the brain in use
 *   AI_CHAN_BRAIN=small npm run eval -- --label small-q4
 *   npm run eval -- --only tools --limit 5    a quick look at one category
 *   npm run eval -- --compare baseline-small baseline-standard
 *   npm run eval -- --rescore baseline-small     mark a finished run again after a rule changed
 *
 * A report is never written over: give another --label, or --overwrite to replace it.
 * A run of only part of the suite (--only, --limit) is named "<label>-subset".
 *
 * See evals/README.md for what is measured and what the numbers mean.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { StandingOrder } from "../src/core/standingOrders.ts";

if (process.argv.includes("--idle-eval")) {
  const forwarded = process.argv.slice(2).filter((arg) => arg !== "--idle-eval");
  if (!forwarded.includes("--label")) forwarded.push("--label", "idle");
  const code = await new Promise<number>((done) => {
    const child = spawn(
      process.execPath,
      [join(resolve(import.meta.dirname, ".."), "scripts", "idle-eval.ts"), ...forwarded],
      { stdio: "inherit" },
    );
    child.on("close", (status) => done(status ?? 1));
    child.on("error", () => done(1));
  });
  process.exit(code);
}
if (process.argv.includes("--fuzz")) {
  const { generateFuzzCases, runDeterministicFuzzGate } = await import("../evals/fuzz.ts");
  const countIdx = process.argv.indexOf("--count");
  const seedIdx = process.argv.indexOf("--seed");
  const parsedCount =
    countIdx !== -1 ? Number.parseInt(process.argv[countIdx + 1] ?? "", 10) : 500;
  const parsedSeed =
    seedIdx !== -1 ? Number.parseInt(process.argv[seedIdx + 1] ?? "", 10) : 20261122;
  const count = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 500;
  const seed = Number.isFinite(parsedSeed) ? parsedSeed : 20261122;
  const fuzzCases = generateFuzzCases({ count, seed });
  const report = await runDeterministicFuzzGate(fuzzCases);
  console.log(
    `Fuzz gate (${report.total} cases, seed ${seed}): ${report.passed}/${report.total} passed, ${report.unauthorizedAllows} unauthorized allows, ${report.unseenLeaks} unseen leaks.`,
  );
  for (const [channel, stats] of Object.entries(report.byChannel)) {
    console.log(`  - ${channel}: ${stats.passed}/${stats.total} passed`);
  }
  for (const failure of report.failures.slice(0, 10)) {
    console.error(`  FAIL ${failure.id}: ${failure.reason}`);
  }
  process.exit(
    report.failed === 0 && report.unauthorizedAllows === 0 && report.unseenLeaks === 0 ? 0 : 1,
  );
}
if (process.argv.includes("--replay")) {
  const idx = process.argv.indexOf("--replay");
  const bundlePath = process.argv[idx + 1];
  if (!bundlePath || bundlePath.startsWith("--")) {
    console.error("Usage: npm run eval -- --replay <bundle.json.gz>");
    process.exit(2);
  }
  const { loadReplayBundle, replaySession } = await import("../src/core/replay.ts");
  const snapshots = await loadReplayBundle(bundlePath);
  const report = await replaySession(snapshots, {
    workspace: process.cwd(),
    home: process.env["HOME"] ?? "/home/user",
  });
  console.log(
    `Deterministic Replay (${report.totalTurns} turns, ${report.totalCalls} calls): ${report.matched} matched, ${report.drifted} drifted.`,
  );
  for (const diff of report.diffs) {
    console.error(
      `  DRIFT [${diff.snapshotId}#${diff.callIndex}] ${diff.tool}: expected "${diff.expectedDecision}", got "${diff.actualDecision}".`,
    );
  }
  process.exit(report.drifted === 0 ? 0 : 1);
}
if (process.argv.includes("--plugin")) {
  const idx = process.argv.indexOf("--plugin");
  const pluginDir = process.argv[idx + 1];
  if (!pluginDir || pluginDir.startsWith("--")) {
    console.error("Usage: npm run eval -- --plugin <plugin-dir>");
    process.exit(2);
  }
  const { PluginManifestSchema, runPluginBundledEvals } = await import("../src/core/pluginSdk.ts");
  const raw = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8")) as unknown;
  const manifest = PluginManifestSchema.parse(raw);
  const res = await runPluginBundledEvals(manifest, {
    workspace: process.cwd(),
    home: process.env["HOME"] ?? "/home/user",
  });
  console.log(`Plugin evals (${manifest.id}): ${res.passed}/${res.total} passed.`);
  for (const failure of res.failures) {
    console.error(`  FAIL ${failure}`);
  }
  process.exit(res.ok ? 0 : 1);
}
if (process.argv.includes("--audit")) {
  const { ConfigStore } = await import("../src/core/config.ts");
  const { configFile, ordersFile } = await import("../src/core/paths.ts");
  const { auditSecurityRules } = await import("../src/core/ruleAudit.ts");
  const cfgStore = new ConfigStore(configFile());
  const config = await cfgStore.load();
  let standingOrders: StandingOrder[] = [];
  try {
    const rawOrders = JSON.parse(await readFile(ordersFile(), "utf8")) as {
      orders?: StandingOrder[];
    };
    if (Array.isArray(rawOrders.orders)) standingOrders = rawOrders.orders;
  } catch {
    // Missing or unreadable orders file is treated as empty during baseline audit.
  }
  const report = auditSecurityRules({ config, standingOrders });
  console.log(
    `Static Policy Audit: ${report.ok ? "PASS" : "FAIL"} (critical=${report.counts.critical}, warning=${report.counts.warning}, info=${report.counts.info})`,
  );
  for (const finding of report.findings) {
    console.log(`  [${finding.severity.toUpperCase()}] ${finding.code} (${finding.subject}): ${finding.message}`);
  }
  process.exit(report.ok ? 0 : 1);
}
import { ALL_CASES } from "../evals/cases/index.ts";
import { cardHolders, gameNow, runningCommands, whyNotNow } from "../evals/guard.ts";
import { gameOnCard } from "../src/core/cardWatch.ts";
import { compareReports, describeReport, rescore, scoreCase, summarise } from "../evals/scoring.ts";
import {
  DEFAULT_CHARACTER_GATE_MAX_DROP,
  DEFAULT_CHARACTER_GATE_MIN_PASS_RATE,
  evaluateCharacterGate,
  formatCharacterGateReport,
} from "../evals/characterGate.ts";
import {
  keepBeforeRescore,
  loadReport as loadReportFile,
  reportFile,
  writeReport,
} from "../evals/files.ts";
import { suiteStamp } from "../evals/stamp.ts";
import { TOOLS } from "../src/core/permissions.ts";
import type { ChatSessionModelFunctions } from "node-llama-cpp";
import {
  CATEGORIES,
  type Category,
  type CaseResult,
  type EvalCase,
  type Report,
  type Score,
  type Seen,
  type SeenCall,
} from "../evals/types.ts";
import { makeWorld, PRETEND_MACHINES, pretendWeb } from "../evals/world.ts";
import { Brain } from "../src/core/brain.ts";
import { daysAboard } from "../src/core/clock.ts";
import { ConfigStore } from "../src/core/config.ts";
import { LocalEmbedder } from "../src/core/embedder.ts";
import { Agenda } from "../src/core/agenda.ts";
import { LocalEngine } from "../src/core/engine.ts";
import { MissionBoard } from "../src/core/missionPlan.ts";
import { detectEnvironment } from "../src/core/environment.ts";
import { Fleet } from "../src/core/fleet.ts";
import { Hands } from "../src/core/hands.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { MissionControl } from "../src/core/missions.ts";
import { isDownloaded, resolveBrain } from "../src/core/models.ts";
import {
  agendaFile,
  configFile,
  dataDir,
  deckLogFile,
  fleetDir,
  historyFile,
  memoryFile,
  modelsDir,
  ordersFile,
  remindersFile,
  scratchDir,
  workspaceDir,
} from "../src/core/paths.ts";
import { buildSystemPrompt } from "../src/core/persona.ts";
import { StandingOrders } from "../src/core/standingOrders.ts";
import { Recall, type Recalled, type RelevantOptions } from "../src/core/recall.ts";
import { ReminderStore } from "../src/core/reminders.ts";
import { ResearchDesk } from "../src/core/research.ts";
import { ShipEars } from "../src/core/shipEars.ts";
import { SemanticCommandCache } from "../src/core/semanticCache.ts";
import { Sight } from "../src/core/sight.ts";
import { extractReportTrainingData, isTeacherBrain } from "../src/core/trainingExport.ts";
import {
  createPlanConsensusHook,
  createSemanticCacheHook,
  TurnHookPipeline,
} from "../src/core/turnHooks.ts";
import type { BrainEvent } from "../src/shared/ipc.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const RESULTS = join(ROOT, "evals", "results");
/** Longest one message may take before it is cut off and counted as an error. */
const TURN_LIMIT_MS = 180_000;
/** How the run ends when it stops itself because a game was started. */
const STOPPED_FOR_GAME = 3;

// ---------------------------------------------------------------- what was asked for

interface Options {
  only: Category[];
  /** Run only the cases whose id is one of these, or begins with one of these. */
  cases: string[];
  /** Run exactly these cases, by their whole ids (the idle-time runner hands a piece over this way). */
  exactly: string[];
  limit: number | null;
  label: string | null;
  repeat: number;
  temperature: number;
  seed: number;
  thinking: number | null;
  context: number | null;
  lean: boolean;
  /** Leave her choice of words alone (no leaning away from "I"), to measure what the leaning does. */
  plainWords: boolean;
  /** Offer her only a small core of tools and the ones each case is about; see `onlyItsTools`. */
  itsToolsOnly: boolean;
  /** Switch on the app's own choosing of tools per message (its "fitting tools" setting). */
  fittingTools: boolean;
  /** Enable experimental TurnHookPipeline (`semanticCache` + `planConsensus`) + repeat-query bench. */
  turnHooks: boolean;
  /** Run on the processor alone with this many threads; null runs on the graphics card. */
  cpu: number | null;
  lora: string | null;
  force: boolean;
  overwrite: boolean;
  compare: [string, string] | null;
  rescore: string | null;
  list: boolean;
  noExportPairs: boolean;
  /** Run only `character` cases and exit non-zero if Character & Form drifts below threshold. */
  gateCharacter: boolean;
  /** Offline check of a saved report (and optional baseline) against the Character & Form gate. */
  checkCharacterGate: { candidate: string; baseline?: string } | null;
  characterBaseline: string | null;
  minCharacterPassRate: number;
  maxCharacterDrop: number;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readOptions(args: readonly string[]): Options {
  const options: Options = {
    only: [],
    cases: [],
    exactly: [],
    limit: null,
    label: null,
    repeat: 1,
    temperature: 0.7,
    seed: 1,
    thinking: null,
    context: null,
    lean: false,
    plainWords: false,
    itsToolsOnly: false,
    fittingTools: false,
    turnHooks: false,
    cpu: null,
    lora: null,
    force: false,
    overwrite: false,
    compare: null,
    rescore: null,
    list: false,
    noExportPairs: false,
    gateCharacter: false,
    checkCharacterGate: null,
    characterBaseline: null,
    minCharacterPassRate: DEFAULT_CHARACTER_GATE_MIN_PASS_RATE,
    maxCharacterDrop: DEFAULT_CHARACTER_GATE_MAX_DROP,
  };
  const rest = [...args];
  const value = (flag: string): string => rest.shift() ?? fail(`${flag} needs a value.`);
  const count = (flag: string, least: number): number => {
    const given = Number(value(flag));
    if (!Number.isFinite(given) || given < least)
      fail(`${flag} needs a number of ${least} or more.`);
    return given;
  };
  for (let flag = rest.shift(); flag !== undefined; flag = rest.shift()) {
    if (flag === "--only") {
      for (const name of value(flag).split(",")) {
        const category = CATEGORIES.find((known) => known === name.trim());
        if (!category) fail(`--only takes one of: ${CATEGORIES.join(", ")}.`);
        options.only.push(category);
      }
    } else if (flag === "--cases") {
      options.cases.push(
        ...value(flag)
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );
    } else if (flag === "--limit") options.limit = Math.floor(count(flag, 1));
    else if (flag === "--exactly") {
      options.exactly.push(
        ...value(flag)
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );
    } else if (flag === "--label") options.label = value(flag).replace(/[^\w.-]+/g, "-");
    else if (flag === "--repeat") options.repeat = Math.floor(count(flag, 1));
    else if (flag === "--temperature") options.temperature = count(flag, 0);
    else if (flag === "--seed") options.seed = Math.floor(count(flag, 0));
    else if (flag === "--thinking") options.thinking = Math.floor(count(flag, 0));
    else if (flag === "--context") options.context = Math.floor(count(flag, 4096));
    else if (flag === "--lean") options.lean = true;
    else if (flag === "--plain-words") options.plainWords = true;
    else if (flag === "--its-tools-only") options.itsToolsOnly = true;
    else if (flag === "--fitting-tools") options.fittingTools = true;
    else if (flag === "--turn-hooks") options.turnHooks = true;
    else if (flag === "--cpu") options.cpu = Math.min(16, Math.floor(count(flag, 1)));
    else if (flag === "--lora") options.lora = value(flag);
    else if (flag === "--force") options.force = true;
    else if (flag === "--overwrite") options.overwrite = true;
    else if (flag === "--list") options.list = true;
    else if (flag === "--compare") options.compare = [value(flag), value(flag)];
    else if (flag === "--rescore") options.rescore = value(flag);
    else if (flag === "--no-export-pairs") options.noExportPairs = true;
    else if (flag === "--gate-character") {
      options.gateCharacter = true;
      if (!options.only.includes("character")) options.only.push("character");
    } else if (flag === "--check-character-gate") {
      const candidate = value(flag);
      const maybeBase = rest[0] && !rest[0].startsWith("--") ? rest.shift() : undefined;
      options.checkCharacterGate = maybeBase ? { candidate, baseline: maybeBase } : { candidate };
    } else if (flag === "--baseline") {
      options.characterBaseline = value(flag);
    } else if (flag === "--min-character") {
      const parsed = count(flag, 0);
      options.minCharacterPassRate = Math.min(1, parsed > 1 ? parsed / 100 : parsed);
    } else if (flag === "--max-drop") {
      const parsed = count(flag, 0);
      options.maxCharacterDrop = Math.min(1, parsed > 1 ? parsed / 100 : parsed);
    } else fail(`Unknown option ${flag}. See evals/README.md.`);
  }
  return options;
}

// ---------------------------------------------------------------- the graphics card

async function card(
  field: "memory.used" | "utilization.gpu" | "memory.total",
): Promise<number | null> {
  try {
    const { stdout } = await run(
      "nvidia-smi",
      [`--query-gpu=${field}`, "--format=csv,noheader,nounits"],
      { timeout: 5000 },
    );
    // With several cards, the sum for memory and the busiest for load.
    const numbers = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map(Number)
      .filter((number) => Number.isFinite(number));
    if (numbers.length === 0) return null;
    // The engine goes by the card it would load onto; with several, the largest.
    return field === "memory.used"
      ? numbers.reduce((sum, number) => sum + number, 0)
      : Math.max(...numbers);
  } catch {
    return null; // no such card, or no such program: reported as unknown
  }
}

/** Graphics memory held by this process alone, in MiB. Null where the card does not say. */
async function ownCard(): Promise<number | null> {
  try {
    const { stdout } = await run(
      "nvidia-smi",
      ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
    );
    const mine = stdout
      .split("\n")
      .map((line) => line.split(",").map((part) => Number(part.trim())))
      .filter(([pid, used]) => pid === process.pid && Number.isFinite(used))
      .map(([, used]) => used ?? 0);
    return mine.length === 0 ? null : mine.reduce((sum, used) => sum + used, 0);
  } catch {
    return null;
  }
}

function median(numbers: readonly number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- comparing two runs

/** Where a report is: a path as given, or a name looked up among the results. */
async function loadReport(name: string): Promise<Report> {
  return loadReportFile(name).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
}

/** Her notes as found by meaning, except that a case can keep them from being handed to her unasked. */
class LabRecall extends Recall {
  quiet = false;

  override relevant(query: string, options: RelevantOptions = {}): Promise<Recalled[]> {
    // The notes put beside a message are asked for without her profile; her own recall tool asks for all.
    if (this.quiet && options.skipKinds) return Promise.resolve([]);
    return super.relevant(query, options);
  }
}

// ---------------------------------------------------------------- the run

const options = readOptions(process.argv.slice(2));

/** The tools she is always offered in the "its tools only" trial, whatever the case. */
const CORE_TOOLS: ReadonlySet<string> = new Set([
  TOOLS.remember,
  TOOLS.recall,
  TOOLS.calculate,
  TOOLS.webSearch,
  TOOLS.runCommand,
  TOOLS.readFile,
]);

/**
 * With `--its-tools-only`: the core and the tools the current case names (those it
 * expects, forbids, allows or gives answers for), and no others. This is a router that
 * always guesses right, to measure the most there is to gain from offering her fewer
 * tools at a time before anyone builds a real one. Otherwise everything, as in the app.
 */
function onlyItsTools(functions: ChatSessionModelFunctions): ChatSessionModelFunctions {
  if (!options.itsToolsOnly || !current) return functions;
  const named = (rules: readonly { tool: string | string[] }[] | undefined): string[] =>
    (rules ?? []).flatMap((rule) => rule.tool);
  const wanted = new Set<string>([
    ...CORE_TOOLS,
    ...named(current.expect.calls),
    ...named(current.expect.forbidden),
    ...(current.expect.noCallsExcept ?? []),
    ...Object.keys(current.tools ?? {}),
  ]);
  return Object.fromEntries(Object.entries(functions).filter(([name]) => wanted.has(name)));
}
/**
 * What the suite and her own rules were when this run loaded them. Taken now and not
 * when the report is written: a file edited while a long run is going must not put its
 * stamp on results the old code produced (it did, on 2026-11-22).
 */
const STAMP_AT_START = suiteStamp(ALL_CASES);

if (options.checkCharacterGate) {
  const candidate = await loadReport(options.checkCharacterGate.candidate);
  const baselineName = options.checkCharacterGate.baseline ?? options.characterBaseline;
  const baseline = baselineName ? await loadReport(baselineName) : undefined;
  const result = evaluateCharacterGate(candidate, {
    ...(baseline ? { baseline } : {}),
    minPassRate: options.minCharacterPassRate,
    maxDrop: options.maxCharacterDrop,
  });
  console.log(formatCharacterGateReport(result));
  process.exit(result.passed ? 0 : 1);
}
if (options.compare) {
  const [first, second] = options.compare;
  console.log(compareReports(await loadReport(first), await loadReport(second)));
  process.exit(0);
}

if (options.rescore) {
  // Marks a finished run again by the rules and cases as they are now. No model is loaded.
  // The report is stamped with the rules used, so it can be told from one marked earlier.
  const marked = rescore(await loadReport(options.rescore), ALL_CASES, {
    marking: suiteStamp(ALL_CASES).marking,
    at: new Date().toISOString(),
  });
  const file = reportFile(options.rescore);
  // The report as the run wrote it is kept beside it the first time it is marked again.
  const kept = await keepBeforeRescore(file);
  await writeFile(file, `${JSON.stringify(marked, null, 2)}\n`, "utf8");
  console.log(
    `${describeReport(marked)}\n\nMarked again and written to ${file}${kept ? `\nThe report as it was is kept in ${kept}` : ""}`,
  );
  process.exit(0);
}

let cases = ALL_CASES.filter(
  (test) =>
    (options.only.length === 0 || options.only.includes(test.category)) &&
    (options.cases.length === 0 || options.cases.some((name) => test.id.startsWith(name))) &&
    (options.exactly.length === 0 || options.exactly.includes(test.id)),
);
if (options.limit !== null) {
  // The limit is per category, so a quick look still touches each kind of case asked for.
  const limit = options.limit;
  cases = CATEGORIES.flatMap((category) =>
    cases.filter((test) => test.category === category).slice(0, limit),
  );
}
if (options.list) {
  for (const category of CATEGORIES) {
    const mine = cases.filter((test) => test.category === category);
    console.log(`${category}: ${mine.length}`);
    for (const test of mine) console.log(`  ${test.id}`);
  }
  console.log(`${cases.length} cases`);
  process.exit(0);
}
const ids = new Set<string>();
for (const test of ALL_CASES) {
  if (ids.has(test.id)) fail(`Two cases are called ${test.id}.`);
  ids.add(test.id);
}

if (options.lora !== null && !existsSync(options.lora)) {
  fail(`LoRA adapter file not found: ${options.lora}`);
}

const choice = process.env["ASTRA_NAVI_BRAIN"] ?? process.env["AI_CHAN_BRAIN"] ?? "auto";
const subset =
  options.only.length > 0 ||
  options.cases.length > 0 ||
  options.exactly.length > 0 ||
  options.limit !== null;
// A look at part of the suite never goes by the name of a whole run.
const label = `${options.label ?? (isAbsolute(choice) ? basename(choice, ".gguf") : choice)}${subset ? "-subset" : ""}`;
// Looked at before anything is loaded, not after half an hour of running.
if (!options.overwrite && existsSync(join(RESULTS, `${label}.json`))) {
  fail(
    `There is already a report called ${label} in ${RESULTS}. Give this run another --label, or use --overwrite to replace that one.`,
  );
}

// On the processor alone the card is not touched, so a game on it is no reason to wait.
if (!options.force && options.cpu === null) {
  const samples: number[] = [];
  for (let taken = 0; taken < 3; taken += 1) {
    const busy = await card("utilization.gpu");
    if (busy !== null) samples.push(busy);
    await pause(700);
  }
  const [holders, commands] = await Promise.all([cardHolders(), runningCommands()]);
  const reason = whyNotNow({ utilisation: median(samples), holders, commands });
  if (reason) fail(reason);
  // A native game the card names only by how it was started is told another way.
  const native = await gameOnCard();
  if (native !== null) {
    fail(
      `A game is running (${native}). Not starting, so it keeps the graphics card to itself. Run this again when the game is closed, or use --force to run anyway.`,
    );
  }
}

// Her models stay where they are; everything she writes goes to a folder made for this
// run and removed after it. Nothing on the desktop is touched and no keys are pressed.
const models = modelsDir();
const scratch = await mkdtemp(join(tmpdir(), "ai-chan-eval-"));
// However the run ends, even by an error before it has properly begun, the folder goes.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.env["AI_CHAN_MODELS_DIR"] = models;
process.env["ASTRA_NAVI_MODELS_DIR"] = models;
process.env["AI_CHAN_DATA_DIR"] = join(scratch, "data");
process.env["ASTRA_NAVI_DATA_DIR"] = join(scratch, "data");
process.env["AI_CHAN_WORKSPACE"] = join(scratch, "workspace");
process.env["ASTRA_NAVI_WORKSPACE"] = join(scratch, "workspace");
process.env["AI_CHAN_REHEARSE_DESKTOP"] = "1";
process.env["AI_CHAN_NO_VIRTUAL_INPUT"] = "1";
await mkdir(dataDir(), { recursive: true });
await mkdir(workspaceDir(), { recursive: true });

const config = new ConfigStore(configFile());
await config.load();
await config.update({
  // Always "a month aboard", so her instructions read the same whatever day the run is on.
  firstMetAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  morningBriefing: false,
  noticeShown: true,
  hands: { ...config.value.hands, inPrograms: true },
  // Her instructions only describe what is switched on, and the cases ask her to hear
  // back what the PC played.
  hearing: { ...config.value.hearing, pcAudio: true },
  notices: { ...config.value.notices, read: true },
  ...(options.thinking === null ? {} : { thinkingTokens: options.thinking }),
  ...(options.context === null ? {} : { contextSize: options.context }),
});
const memory = new MemoryStore(memoryFile());
await memory.load();
const environment = await detectEnvironment(workspaceDir());

const embedder = new LocalEmbedder(join(models, "speech"));
let benchHooksEnabled = false;
const semanticCache = options.turnHooks ? new SemanticCommandCache({ embedder }) : null;
const turnHooksPipeline = options.turnHooks ? new TurnHookPipeline() : null;
const hookTelemetry = {
  beforeRouteCalls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheBypassTainted: 0,
  cacheBypassHandsOff: 0,
  cacheNumberMismatch: 0,
  cacheStoreEligible: 0,
  uniqueCachedEntries: 0,
  consensusChecks: 0,
  consensusAgreed: 0,
  consensusManualReview: 0,
  hookTimeMs: 0,
};
const HIGH_RISK_HOOK_TOOLS = new Set<string>([
  TOOLS.runCommand,
  TOOLS.writeFile,
  TOOLS.planMission,
  TOOLS.startMission,
  TOOLS.remote,
  TOOLS.operate,
]);
if (turnHooksPipeline && semanticCache) {
  let cacheSizeBefore = 0;
  turnHooksPipeline.register({
    id: "eval-telemetry-begin",
    beforeRoute(ctx) {
      ctx.flags.__hookT0 = performance.now();
      return undefined;
    },
    afterPlan(ctx) {
      ctx.flags.__hookT0 = performance.now();
      return undefined;
    },
    beforeCommit(ctx) {
      ctx.flags.__hookT0 = performance.now();
      cacheSizeBefore = semanticCache.size;
    },
  });
  turnHooksPipeline.register(
    createSemanticCacheHook(semanticCache, () => options.turnHooks && benchHooksEnabled),
  );
  turnHooksPipeline.register(
    createPlanConsensusHook(
      () => options.turnHooks && benchHooksEnabled,
      (ctx) => {
        const risky = ctx.usedTools.filter((tool) => HIGH_RISK_HOOK_TOOLS.has(tool));
        if (risky.length === 0) return null;
        let parsedInput: Record<string, unknown> = {};
        if (typeof ctx.flags.lastToolInput === "string") {
          try {
            const obj = JSON.parse(ctx.flags.lastToolInput) as unknown;
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              parsedInput = obj as Record<string, unknown>;
            }
          } catch {
            // Ignore non-JSON truncated traced input.
          }
        }
        const cmd =
          typeof parsedInput["command"] === "string"
            ? parsedInput["command"]
            : risky[risky.length - 1] ?? "";
        const targetPath = typeof parsedInput["path"] === "string" ? parsedInput["path"] : "";
        const targetCtrl = typeof parsedInput["name"] === "string" ? parsedInput["name"] : "";
        const candidate = {
          commands: [cmd],
          ...(targetCtrl ? { targetControls: [targetCtrl] } : {}),
          ...(targetPath ? { targetPaths: [targetPath] } : {}),
        };
        return [candidate, candidate];
      },
    ),
  );
  turnHooksPipeline.register({
    id: "eval-telemetry",
    beforeRoute(ctx) {
      if (!benchHooksEnabled) return undefined;
      if (typeof ctx.flags.__hookT0 === "number") {
        hookTelemetry.hookTimeMs += performance.now() - ctx.flags.__hookT0;
      }
      hookTelemetry.beforeRouteCalls += 1;
      const reason = ctx.cachedHit?.reason;
      if (ctx.cachedHit?.hit) hookTelemetry.cacheHits += 1;
      else if (reason === "bypass_tainted") hookTelemetry.cacheBypassTainted += 1;
      else if (reason === "bypass_hands_off") hookTelemetry.cacheBypassHandsOff += 1;
      else if (reason === "number_mismatch") hookTelemetry.cacheNumberMismatch += 1;
      else hookTelemetry.cacheMisses += 1;
      return undefined;
    },
    afterPlan(ctx) {
      if (!benchHooksEnabled) return undefined;
      if (typeof ctx.flags.__hookT0 === "number") {
        hookTelemetry.hookTimeMs += performance.now() - ctx.flags.__hookT0;
      }
      if (ctx.consensusVerdict) {
        hookTelemetry.consensusChecks += 1;
        if (ctx.consensusVerdict.agreed) hookTelemetry.consensusAgreed += 1;
        if (ctx.consensusVerdict.requireManualReview) hookTelemetry.consensusManualReview += 1;
      }
      return undefined;
    },
    beforeCommit(ctx) {
      if (!benchHooksEnabled) return undefined;
      if (typeof ctx.flags.__hookT0 === "number") {
        hookTelemetry.hookTimeMs += performance.now() - ctx.flags.__hookT0;
      }
      if (!ctx.isEvent && !ctx.falseClaim && !ctx.readOutsideText && !ctx.handsOff && ctx.usedTools.length === 1) {
        hookTelemetry.cacheStoreEligible += 1;
      }
      if (semanticCache.size > cacheSizeBefore) {
        hookTelemetry.uniqueCachedEntries = semanticCache.size;
      }
    },
  });
}

/** When loading began and ended, and how long it took the first time. */
const loading: { started: number; readyAt: number; seconds: number | null; label: string } = {
  started: 0,
  readyAt: 0,
  seconds: null,
  label: choice,
};
const loraPath = options.lora;
const engine = new LocalEngine({
  modelsDir: models,
  choice,
  contextSize: config.value.contextSize,
  lean: options.lean,
  ...(loraPath === null ? {} : { adapterFor: () => loraPath }),
  ...(options.cpu === null ? {} : { processorOnly: { threads: options.cpu } }),
  ...(turnHooksPipeline ? { turnHooks: turnHooksPipeline } : {}),
  idleUnloadMs: 0,
  onStatus(status): void {
    if (status.stage === "downloading") {
      // A test never fetches a model: that is tens of minutes and gigabytes nobody asked
      // for. The engine says this before it starts fetching, so refusing here stops it.
      throw new Error(
        `${status.label} is not on disk. A test run never downloads a model: put it in ${models} first.`,
      );
    } else if (status.stage === "loading") {
      loading.started = Date.now();
    } else if (status.stage === "ready") {
      loading.readyAt = Date.now();
      loading.seconds ??= (loading.readyAt - loading.started) / 1000;
      loading.label = status.label;
    }
  },
});
// Which model would really be loaded: "auto" picks by the size of the graphics card, so
// it is not enough that some model or other is on disk.
const cardMiB = await card("memory.total");
let wanted;
try {
  wanted = resolveBrain(choice, models, cardMiB === null ? null : cardMiB * 1024 * 1024);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (!(await isDownloaded(wanted))) {
  fail(
    `The brain "${choice}" would load ${wanted.label}, which is not on disk in ${models}. A test run never downloads one.`,
  );
}

const reminders = new ReminderStore(remindersFile(), () => undefined);
await reminders.start();
const missions = new MissionControl(environment.workspace, () => undefined);
const recall = new LabRecall(memory, embedder);
const sight = new Sight(join(models, "speech"), scratchDir());

// What is being looked at right now: the case, which of its messages, and what has been seen.
let current: EvalCase | null = null;
let turn = 0;
let seen: Seen = blank();
let turnStarted = 0;
let firstWordAt: number | null = null;

function blank(): Seen {
  return {
    calls: [],
    replies: [],
    moods: [],
    moodFirst: [],
    corrections: 0,
    cautions: [],
    errors: [],
    asked: [],
    ms: 0,
    firstWordMs: null,
    heldTokens: null,
    claimChecks: [],
  };
}

const web = pretendWeb(() => current);
const world = makeWorld(
  () => current,
  () => turn,
  (call: SeenCall) => seen.calls.push({ ...call, at: (seen.replies[call.turn] ?? "").length }),
  environment.workspace,
);
let runIndex = 0;

const brain: Brain = new Brain({
  config,
  memory,
  recall,
  privateDirs: [dataDir()],
  environment,
  engine,
  // Every one of these is only here so that she is offered the tool. The tools themselves
  // are stand-ins (see evals/world.ts), so her eyes, ears and hands are never started.
  desktop: {
    sight,
    scriptDir: scratchDir(),
    ears: () => ({ heard: new ShipEars(), transcribe: () => Promise.resolve("") }),
  },
  hands: {
    hands: new Hands({ script: join(ROOT, "hands", "hands.py") }),
    sight,
    scriptDir: scratchDir(),
    ownApps: ["astra-navi-desktop", "ai-chan-desktop"],
  },
  phone: true,
  fleet: new Fleet({ dir: fleetDir(), machines: () => PRETEND_MACHINES }),
  web,
  // Offered, so that asking about notifications can be tested; the answer is the world's.
  notices: () => null,
  ship: {
    reminders,
    missions,
    // Offered so that planning a mission can be tested; the world answers for it, and
    // nothing given to this one is ever run.
    board: new MissionBoard({
      file: join(scratch, "missions.json"),
      judge: () => Promise.resolve({ decision: "refuse", reason: "This is her test suite." }),
      fingerprint: (step) => step.command,
      run: () => Promise.resolve({ ok: false, output: "This is her test suite." }),
      ask: () => Promise.reject(new Error("This is her test suite.")),
      tell: () => undefined,
    }),
    // Never started and never asked to look: setting an order is a stand-in in the world.
    orders: new StandingOrders(ordersFile(), {
      read: () => Promise.resolve({ ok: true, text: "intro.mp4" }),
      onNews: () => undefined,
    }),
    deckLogFile: deckLogFile(),
    // Offered so that asking what is on can be tested; the world answers for it.
    agenda: new Agenda({ file: agendaFile(), sources: () => [] }),
    research: new ResearchDesk({
      openWorker: () => Promise.resolve(null),
      web,
      language: () => config.value.language,
      reportsDir: join(environment.workspace, "reports"),
      memory,
      workspace: environment.workspace,
      onFinished: () => undefined,
    }),
    selfCheck: () => Promise.reject(new Error("The self-check is a stand-in in the test suite.")),
  },
  historyFile: historyFile(),
  // The app's own record of each reply, kept with the case: read back to see why she
  // did what she did, and by `npm run export-pairs`.
  onTrace: (trace) => (seen.traces ??= []).push(trace),
  lab: {
    tools: (functions, host) => onlyItsTools(world.tools(functions, host)),
    seed: () => options.seed + runIndex,
    temperature: options.temperature,
    plainWords: options.plainWords,
    fittingTools: options.fittingTools,
    // Mid-afternoon of the day it is: the date is real (cases reckon with it), the hour
    // is not, so that a run at two in the morning scores like one at two in the afternoon.
    now: () => {
      const told = new Date();
      told.setHours(15, 0, 0, 0);
      return told;
    },
    onClaimCheck: (sureness, reply) =>
      (seen.claimChecks ??= []).push({
        sureness,
        reply: reply.replace(/\s+/g, " ").trim().slice(0, 160),
      }),
  },
  emit(event: BrainEvent): void {
    switch (event.type) {
      case "status":
        // Her second attempt after the follow-through check: what stands is what she says now.
        if (event.state === "thinking" && event.correction) {
          seen.corrections += 1;
          seen.replies[turn] = "";
          seen.moods[turn] = [];
          seen.moodFirst[turn] = false;
        }
        break;
      case "text":
        firstWordAt ??= Date.now();
        seen.replies[turn] = (seen.replies[turn] ?? "") + event.delta;
        break;
      case "mood": {
        const moods = (seen.moods[turn] ??= []);
        if (moods.length === 0) seen.moodFirst[turn] = (seen.replies[turn] ?? "").trim() === "";
        moods.push(event.mood);
        break;
      }
      case "permission": {
        const { request } = event;
        const rule = current?.approve;
        const allowed =
          rule === "all" ||
          (rule instanceof RegExp && rule.test(`${request.title}\n${request.detail}`));
        seen.asked.push({ title: request.title, detail: request.detail.slice(0, 200), allowed });
        brain.answerPermission(request.id, allowed ? "allow" : "deny");
        break;
      }
      case "caution":
        seen.cautions.push(event.message);
        break;
      case "error":
        seen.errors.push(event.message);
        break;
      default:
        break;
    }
  },
});

/** Puts one message to her and waits for the reply to end, or cuts it off when it takes too long. */
async function say(text: string): Promise<void> {
  if (stopping) return;
  const spoken = text.startsWith("voice:");
  turnStarted = Date.now();
  firstWordAt = null;
  seen.replies[turn] = "";
  seen.moods[turn] = [];
  seen.moodFirst[turn] = false;
  brain.send(spoken ? text.slice("voice:".length) : text, { spoken });
  let timer: NodeJS.Timeout | undefined;
  const tooLong = new Promise<"late">((done) => {
    timer = setTimeout(() => done("late"), TURN_LIMIT_MS);
  });
  const ended = await Promise.race([brain.whenIdle().then(() => "idle" as const), tooLong]);
  clearTimeout(timer);
  if (ended === "late") {
    seen.errors.push(`no answer after ${TURN_LIMIT_MS / 1000} seconds; cut off`);
    brain.interrupt();
    await brain.whenIdle();
  }
}

/** Puts everything back to the start for a case: an empty conversation, its notes, its files. */
async function prepare(test: EvalCase): Promise<void> {
  current = null;
  await brain.newConversation({ keepLoaded: true });
  await config.update({ language: test.language ?? "en", handsOff: test.handsOff === true });
  for (const note of [...memory.all()]) await memory.forget(note.id);
  for (const note of test.notes ?? []) {
    if (note.kind === "topic" || note.kind === "skill") {
      const { memory: created } = await memory.learn(note.kind, note.text, note.points ?? []);
      if (note.pinned) await memory.pin(created.id, true);
    } else {
      await memory.save({ kind: note.kind, text: note.text, pinned: note.pinned });
    }
    // Notes are ordered by when they were written; a pause keeps the order given.
    await pause(2);
  }
  recall.quiet = test.quietNotes === true;
  await recall.warm();
  for (const name of await readdir(environment.workspace)) {
    await rm(join(environment.workspace, name), { recursive: true, force: true });
  }
  for (const [name, content] of Object.entries(test.files ?? {})) {
    const file = join(environment.workspace, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  for (const reminder of reminders.list()) await reminders.cancel(reminder.id);
  await rm(deckLogFile(), { force: true });
}

async function runCase(test: EvalCase): Promise<Score & Seen> {
  await prepare(test);
  seen = blank();
  current = test;
  const started = Date.now();
  const readBefore = engine.meter()?.input ?? null;
  for (turn = 0; turn < test.turns.length && !stopping; turn += 1) {
    await say(test.turns[turn] ?? "");
    if (turn === 0 && firstWordAt !== null) seen.firstWordMs = firstWordAt - turnStarted;
  }
  turn = Math.max(0, test.turns.length - 1);
  seen.ms = Date.now() - started;
  seen.heldTokens = engine.meter()?.held ?? null;
  const readAfter = engine.meter()?.input ?? null;
  // The first case of a run has no "before": the model is loaded by its first message.
  seen.readTokens = readAfter === null ? null : readAfter - (readBefore ?? 0);
  const result = { ...scoreCase(test, seen), ...seen };
  current = null;
  return result;
}

/** How fast she writes: a plain piece of writing with nothing else going on, in tokens a second. */
async function writingSpeed(): Promise<number | null> {
  const worker = await engine.openWorker("You are a helpful writer.");
  if (!worker) return null;
  try {
    let first: number | null = null;
    const before = worker.session.sequence.tokenMeter.usedOutputTokens;
    await worker.session.prompt("Write about 200 words on why lighthouses were built.", {
      maxTokens: 320,
      temperature: 0,
      budgets: { thoughtTokens: 0 },
      signal: worker.signal,
      onTextChunk: () => {
        first ??= Date.now();
      },
    });
    const written = worker.session.sequence.tokenMeter.usedOutputTokens - before;
    const seconds = first === null ? 0 : (Date.now() - first) / 1000;
    return seconds > 0 && written > 1 ? (written - 1) / seconds : null;
  } catch {
    return null;
  } finally {
    await worker.close();
  }
}

let stopping = false;
/** The clock that samples memory; set once the run begins. */
let sampler: NodeJS.Timeout | null = null;
/** The clock that looks for a game while a case is running; set once the cases begin. */
let gameWatch: NodeJS.Timeout | null = null;
/** How often a game is looked for during a case. Between cases it is looked for anyway. */
const GAME_LOOK_EVERY_MS = 10_000;
let lookingForGame = false;
let finishing: Promise<never> | null = null;

/** Lets go of the model and removes everything the run wrote, then ends. Safe to call twice. */
function finish(code: number): Promise<never> {
  finishing ??= (async (): Promise<never> => {
    stopping = true;
    if (sampler) clearInterval(sampler);
    if (gameWatch) clearInterval(gameWatch);
    reminders.stop();
    await missions.stopAll().catch(() => undefined);
    await sight.rest().catch(() => undefined);
    await brain.dispose().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    process.exit(code);
  })();
  return finishing;
}
/** What the run ends with once it has wound down, when it was stopped part-way. */
let stopCode = 130;

/**
 * Stops the run part-way: the reply being written is cut off, and the main flow below
 * then saves what was finished and lets go of the model. Asked a second time, or if that
 * takes too long, everything is dropped at once.
 */
function stop(code: number, reason: string): void {
  if (stopping) {
    void finish(code);
    return;
  }
  stopping = true;
  stopCode = code;
  console.error(`\n${reason}`);
  brain.interrupt();
  setTimeout(() => void finish(code), 30_000).unref();
}
process.on("SIGINT", () =>
  stop(130, "Stopping: keeping what was finished and letting go of the model."),
);
process.on("SIGTERM", () =>
  stop(143, "Stopping: keeping what was finished and letting go of the model."),
);

const startedAt = new Date();
const vramBefore = await card("memory.used");
let vramPeak = vramBefore;
let ownVramPeak: number | null = null;
let residentPeak = process.memoryUsage().rss;
/** Reads the memory in use now and keeps the highest seen. */
async function sample(): Promise<void> {
  residentPeak = Math.max(residentPeak, process.memoryUsage().rss);
  const [used, own] = await Promise.all([card("memory.used"), ownCard()]);
  if (used !== null) vramPeak = Math.max(vramPeak ?? 0, used);
  if (own !== null) ownVramPeak = Math.max(ownVramPeak ?? 0, own);
}
sampler = setInterval(() => void sample(), 2000);

/**
 * Looks whether a game has been started, and if so stops the run so the game has the
 * card to itself. Also stops when the card will not say, after asking it twice: a run
 * that cannot see a game start is not one to leave going.
 */
async function yieldToGame(): Promise<void> {
  if (options.force || options.cpu !== null || stopping || lookingForGame) return;
  lookingForGame = true;
  let found: Awaited<ReturnType<typeof gameNow>>;
  try {
    found = await gameNow();
    if (found === "unknown") {
      await pause(1000);
      found = await gameNow();
    }
  } finally {
    lookingForGame = false;
  }
  if (found === null || stopping) return;
  stop(
    STOPPED_FOR_GAME,
    found === "unknown"
      ? "The graphics card no longer says what is running on it, so a game starting would go unseen. Stopping. Use --force to run without this check."
      : `A game has been started (${found.game}). Stopping so it has the graphics card to itself.`,
  );
}

try {
  console.log(`Her test suite: ${cases.length} cases against "${choice}". Loading…`);
  // A first message that is not marked: it loads the model and shows what a cold start costs.
  await prepare({ id: "warm-up", category: "character", turns: ["Hello!"], expect: {} });
  seen = blank();
  turn = 0;
  await say("Hello!");
  if (stopping) await finish(stopCode);
  if (seen.errors.length > 0) {
    console.error(`She could not answer at all: ${seen.errors.join("; ")}`);
    await finish(1);
  }
  const firstReplySeconds =
    firstWordAt !== null && loading.readyAt > 0 ? (firstWordAt - loading.readyAt) / 1000 : null;
  const meter = engine.meter();
  // Everything read for that first message: her instructions, her tools and the message.
  const firstTurnTokens = meter ? meter.held - meter.output : null;
  const instructionTokens = engine.countTokens(
    buildSystemPrompt(
      environment,
      memory.snapshot(),
      "en",
      daysAboard(config.value.firstMetAt, new Date()),
    ),
  );
  const vramLoaded = await card("memory.used");
  const ownVramLoaded = await ownCard();
  // The working memory she really got. The engine picks the most that fits on the card,
  // so with something else holding memory there it can be less than was allowed.
  const contextUsed = engine.meter()?.size ?? null;
  console.log(
    `${loading.label} loaded in ${loading.seconds?.toFixed(1) ?? "?"} s; ${firstTurnTokens ?? "?"} tokens read for a first message.\n`,
  );

  const results: CaseResult[] = [];
  // Loading and the first message took a while; a game may have been started meanwhile.
  await yieldToGame();
  // A case can run for minutes. A game started in the middle of one is seen within
  // seconds, not when the case ends: the reply being written is cut off, and what was
  // finished before it is saved as a part-report, as when stopped between cases.
  gameWatch = setInterval(() => void yieldToGame(), GAME_LOOK_EVERY_MS);
  gameWatch.unref();
  benchHooksEnabled = true;
  for (const test of cases) {
    if (stopping) break;
    const runs: (Score & Seen)[] = [];
    for (runIndex = 0; runIndex < options.repeat && !stopping; runIndex += 1) {
      // A game started part-way through gets the card back at once; see evals/guard.ts.
      await yieldToGame();
      if (stopping) break;
      const result = await runCase(test);
      // A run that was cut off by stopping says nothing about her; it is not kept.
      if (stopping) break;
      runs.push(result);
      const did = result.calls.map((call) => call.tool).join(", ") || "no tool";
      console.log(
        `${result.pass ? "pass" : "FAIL"}  ${test.id}  (${(result.ms / 1000).toFixed(1)} s; ${did})` +
          (result.pass ? "" : `\n        ${result.failures.join("\n        ")}`),
      );
    }
    if (stopping) break;
    results.push({
      id: test.id,
      category: test.category,
      language: test.language ?? "en",
      runs,
      passRate: runs.filter((result) => result.pass).length / Math.max(1, runs.length),
    });
  }

  // The highest readings are of the cases alone: the writing test below opens a second
  // working space beside the conversation, which she only has while doing side work.
  await sample();
  clearInterval(sampler);
  clearInterval(gameWatch);
  const peaks = { card: vramPeak, own: ownVramPeak };
  // Stopped part-way: the writing test would hold the card longer, so it is left out.
  const tokensPerSecond = stopping ? null : await writingSpeed();
  const plain = results
    .flatMap((result) => result.runs)
    .filter((result) => result.calls.length === 0);
  const firstWords = plain.flatMap((result) =>
    result.firstWordMs === null ? [] : [result.firstWordMs],
  );
  const firstWord = median(firstWords);
  const held = results
    .flatMap((result) => result.runs)
    .flatMap((result) => (result.heldTokens === null ? [] : [result.heldTokens]));
  const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024));
  const partial = results.length < cases.length;
  // A run that was stopped part-way never takes the place of a whole one, nor of an
  // earlier part of one.
  const stamp = startedAt.toISOString().slice(11, 19).replaceAll(":", "");
  const partialLabel =
    !options.overwrite && existsSync(join(RESULTS, `${label}-partial.json`))
      ? `${label}-partial-${stamp}`
      : `${label}-partial`;
  const report: Report = {
    label: partial ? partialLabel : label,
    brain: loading.label,
    ...(partial ? { partial: { done: results.length, of: cases.length } } : {}),
    ...(subset ? { subset: { only: options.only, limit: options.limit } } : {}),
    suite: STAMP_AT_START,
    startedAt: startedAt.toISOString(),
    minutes: (Date.now() - startedAt.getTime()) / 60_000,
    settings: {
      temperature: options.temperature,
      seed: options.seed,
      repeat: options.repeat,
      thinkingTokens: config.value.thinkingTokens,
      contextSize: config.value.contextSize,
      contextUsed,
      lean: options.lean,
      ...(options.cpu === null ? {} : { cpu: options.cpu }),
      ...(options.itsToolsOnly ? { itsToolsOnly: true } : {}),
      ...(options.fittingTools ? { fittingTools: true } : {}),
      ...(options.plainWords ? { plainWords: true } : {}),
    },
    ...summarise(results),
    speed: {
      loadSeconds: loading.seconds,
      firstReplySeconds,
      firstWordSeconds: firstWord === null ? null : firstWord / 1000,
      tokensPerSecond,
      instructionTokens,
      firstTurnTokens,
      caseTokens: median(held),
      readTokens: median(
        results
          .flatMap((result) => result.runs)
          .flatMap((result) =>
            result.readTokens === null || result.readTokens === undefined
              ? []
              : [result.readTokens],
          ),
      ),
      ownVramLoadedMiB: ownVramLoaded,
      ownVramPeakMiB: peaks.own,
      vramBeforeMiB: vramBefore,
      vramLoadedMiB: vramLoaded,
      vramPeakMiB: peaks.card,
      residentMiB: mib(Math.max(residentPeak, process.memoryUsage().rss)),
    },
    cases: results,
  };
  if (results.length === 0) {
    console.error("Stopped before any case was finished; nothing was written.");
    await finish(stopCode);
  }
  // A report that turned up under this name while the run was going is not written over.
  const written = await writeReport(RESULTS, report, { overwrite: options.overwrite, stamp });
  if (written.report.label !== report.label) {
    console.error(
      `\nA report called ${report.label} appeared while this run was going. It was left alone and this one is called ${written.report.label}.`,
    );
  }
  console.log(`\n${describeReport(written.report)}\n\nWritten to ${written.file}`);
  if (!options.noExportPairs) {
    try {
      const { pairs, sft } = extractReportTrainingData(written.report, {
        teacherOnlyForClean: isTeacherBrain(written.report.brain),
      });
      if (pairs.length > 0) {
        const pairsFile = join(RESULTS, `${written.report.label}.pairs.jsonl`);
        await writeFile(
          pairsFile,
          `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        console.log(`Exported ${pairs.length} preference pairs to ${pairsFile}`);
      }
      if (sft.length > 0) {
        const sftFile = join(RESULTS, `${written.report.label}.sft.jsonl`);
        await writeFile(
          sftFile,
          `${sft.map((row) => JSON.stringify(row)).join("\n")}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        console.log(`Exported ${sft.length} SFT examples to ${sftFile}`);
      }
    } catch (exportError) {
      console.warn("[eval] could not auto-export training pairs:", exportError);
    }
  }
  if (options.turnHooks && turnHooksPipeline && semanticCache && !partial && !stopping) {
    hookTelemetry.uniqueCachedEntries = semanticCache.size;
    const avgHookMs =
      hookTelemetry.beforeRouteCalls > 0
        ? Number((hookTelemetry.hookTimeMs / hookTelemetry.beforeRouteCalls).toFixed(3))
        : 0;
    console.log(
      `\n[turnHooks] ${JSON.stringify({
        ...hookTelemetry,
        hookTimeMs: Number(hookTelemetry.hookTimeMs.toFixed(2)),
        avgHookMsPerTurn: avgHookMs,
      })}`,
    );

    const repeatCache = new SemanticCommandCache({ embedder });
    type RepeatLookupSnap = {
      hit: boolean;
      reason: string;
      similarity: number | null;
      tool?: string;
    };
    const lookupBox: { value: RepeatLookupSnap | null } = { value: null };
    const setLookup = (next: RepeatLookupSnap | null): void => {
      lookupBox.value = next;
    };
    const getLookup = (): RepeatLookupSnap | null => lookupBox.value;
    turnHooksPipeline.register(
      createSemanticCacheHook(repeatCache, () => true, (hit) => {
        setLookup({
          hit: true,
          reason: hit.reason,
          similarity: hit.similarity ?? 1,
          tool: hit.tool,
        });
        return `[cached:${hit.reason}] ${hit.tool ?? "tool"} ${JSON.stringify(hit.args ?? {})}`;
      }),
    );
    turnHooksPipeline.register({
      id: "eval-telemetry",
      beforeRoute(ctx) {
        if (ctx.cachedHit) {
          setLookup({
            hit: ctx.cachedHit.hit,
            reason: ctx.cachedHit.reason,
            similarity: ctx.cachedHit.similarity ?? null,
            tool: ctx.cachedHit.tool,
          });
        }
        return undefined;
      },
    });

    const repeatQueries = [
      "Pause the music",
      "Set the volume to 40",
      "What is on my agenda today?",
      "Pause the music",
      "Please pause playback",
      "Set the volume to 80",
    ];
    const repeatRows: {
      index: number;
      query: string;
      ms: number;
      hit: boolean;
      reason: string;
      similarity: number | null;
      calls: string[];
      replyPreview: string;
    }[] = [];
    for (let i = 0; i < repeatQueries.length; i += 1) {
      const q = repeatQueries[i] ?? "";
      setLookup(null);
      await prepare({ id: `repeat-${i + 1}`, category: "tools", turns: [q], expect: {} });
      seen = blank();
      turn = 0;
      current = {
        id: `repeat-${i + 1}`,
        category: "tools",
        turns: [q],
        expect: { calls: [{ tool: [TOOLS.sound, TOOLS.agenda] }] },
      };
      const t0 = performance.now();
      await say(q);
      const elapsedMs = Number((performance.now() - t0).toFixed(2));
      current = null;
      const snap = getLookup();
      repeatRows.push({
        index: i + 1,
        query: q,
        ms: elapsedMs,
        hit: snap?.hit ?? false,
        reason: snap?.reason ?? "unknown",
        similarity: snap?.similarity ?? null,
        calls: seen.calls.map((c) => c.tool),
        replyPreview: (seen.replies[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      });
    }
    const coldMs = repeatRows.filter((r) => r.index <= 3).map((r) => r.ms);
    const hitMs = repeatRows.filter((r) => r.hit).map((r) => r.ms);
    const coldMed = median(coldMs);
    const hitMed = median(hitMs);
    console.log(
      `[turnHooks:repeat] ${JSON.stringify({
        queries: repeatRows,
        cacheSize: repeatCache.size,
        coldMedianMs: coldMed,
        warmHitMedianMs: hitMed,
        speedupX:
          coldMed !== null && hitMed !== null && hitMed > 0
            ? Number((coldMed / hitMed).toFixed(1))
            : null,
      })}`,
    );
  }
  let exitCode = partial ? stopCode : 0;
  if (options.gateCharacter && !partial) {
    const baseline = options.characterBaseline
      ? await loadReport(options.characterBaseline)
      : undefined;
    const gate = evaluateCharacterGate(written.report, {
      ...(baseline ? { baseline } : {}),
      minPassRate: options.minCharacterPassRate,
      maxDrop: options.maxCharacterDrop,
    });
    console.log(`\n${formatCharacterGateReport(gate)}`);
    if (!gate.passed) exitCode = 1;
  }
  await finish(exitCode);
} catch (error) {
  console.error(error);
  await finish(1);
}
