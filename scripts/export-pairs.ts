/**
 * Turns the records kept of her replies into examples for teaching the small brain:
 *
 *   npm run export-pairs -- round4-small round4-standard --out lessons.jsonl
 *   npm run export-pairs -- --format sft --teacher-only round4-standard --out sft.jsonl
 *   npm run export-pairs -- --pairs-out pairs.jsonl --sft-out sft.jsonl --traces ~/.local/share/ai-chan/traces.jsonl
 *
 * Formats:
 * - "raw" (default): corrected and clean trajectory summaries (backward compatible).
 * - "pairs": preference pairs (prompt, rejected_hallucinated_reply, verified_tool_trajectory).
 * - "sft": Qwen ChatML + character spans ready for `train/lora.py`.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ChatSessionModelFunctions } from "node-llama-cpp";
import { loadReport } from "../evals/files.ts";
import { createTools, type ToolHost } from "../src/core/agentTools.ts";
import { createDesktopTools } from "../src/core/desktopTools.ts";
import { createFleetTools } from "../src/core/fleetTools.ts";
import { createHandsTools } from "../src/core/handsTools.ts";
import { createKnowledgeTools } from "../src/core/knowledgeTools.ts";
import {
  inferSpecialistDomain,
  SPECIALIST_SPECS,
  type SpecialistDomain,
} from "../src/core/loraAgents.ts";
import { createNoticeTools } from "../src/core/noticeTools.ts";
import { createPhoneTools } from "../src/core/phoneTools.ts";
import { createShipTools } from "../src/core/shipTools.ts";
import { cleanExamples, correctedPairs, type TurnTrace } from "../src/core/trace.ts";
import {
  extractReportTrainingData,
  extractTrainingData,
  type PreferencePair,
  type SftExample,
  type SftTemplate,
  type ToolSchemaSummary,
} from "../src/core/trainingExport.ts";

function buildCatalogSchemas(): Record<string, ToolSchemaSummary> {
  const nothing = {} as never;
  const host = { policy: () => ({ workspace: "/tmp" }) } as unknown as ToolHost;
  const all: ChatSessionModelFunctions = {
    ...createTools(host),
    ...createKnowledgeTools(host),
    ...createDesktopTools(host, { sight: nothing, scriptDir: "/tmp", ears: () => nothing }),
    ...createShipTools(host, {
      reminders: nothing,
      missions: nothing,
      deckLogFile: "/tmp/deck-log.md",
      research: nothing,
      selfCheck: nothing,
      orders: nothing,
      agenda: nothing,
    }),
    ...createHandsTools(host, { hands: nothing, scriptDir: "/tmp", ownApps: [] }),
    ...createPhoneTools(host),
    ...createFleetTools(host, nothing),
    ...createNoticeTools(host, () => null),
  };
  const out: Record<string, ToolSchemaSummary> = {};
  for (const [name, fn] of Object.entries(all)) {
    const def = fn as { description?: string; params?: Record<string, unknown> };
    out[name] = {
      ...(def.description ? { description: def.description } : {}),
      ...(def.params ? { parameters: def.params } : {}),
    };
  }
  return out;
}

interface Line {
  kind: "corrected" | "clean";
  from: string;
  [key: string]: unknown;
}

const args = process.argv.slice(2);
let out: string | null = null;
let pairsOut: string | null = null;
let sftOut: string | null = null;
let format: "raw" | "pairs" | "sft" = "raw";
let chatTemplate: SftTemplate = "qwen3";
let domainFilter: "all" | SpecialistDomain = "all";
let deduplicate = false;
let teacherOnly = false;
const reports: string[] = [];
const traceFiles: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (arg === "--out") out = args[(index += 1)] ?? null;
  else if (arg === "--pairs-out") pairsOut = args[(index += 1)] ?? null;
  else if (arg === "--sft-out") sftOut = args[(index += 1)] ?? null;
  else if (arg === "--format") {
    const given = args[(index += 1)] ?? "";
    if (given !== "raw" && given !== "pairs" && given !== "sft") {
      console.error(`--format must be raw, pairs, or sft (got ${given}).`);
      process.exit(1);
    }
    format = given;
  } else if (arg === "--template") {
    const given = args[(index += 1)] ?? "";
    if (given !== "qwen3" && given !== "qwen3.5") {
      console.error(`--template must be qwen3 or qwen3.5 (got ${given}).`);
      process.exit(1);
    }
    chatTemplate = given;
    deduplicate = true;
  } else if (arg === "--domain") {
    const given = args[(index += 1)] ?? "";
    if (given !== "all" && !(given in SPECIALIST_SPECS)) {
      console.error(`--domain must be all or one of ${Object.keys(SPECIALIST_SPECS).join(", ")}.`);
      process.exit(1);
    }
    domainFilter = given as "all" | SpecialistDomain;
    deduplicate = true;
  } else if (arg === "--dedup") {
    deduplicate = true;
  } else if (arg === "--teacher-only") teacherOnly = true;
  else if (arg === "--traces") traceFiles.push(args[(index += 1)] ?? "");
  else if (arg.startsWith("--")) {
    console.error(`Unknown option ${arg}.`);
    process.exit(1);
  } else reports.push(arg);
}
if (reports.length === 0 && traceFiles.length === 0) {
  console.error("Name at least one report of her test suite, or a file of records with --traces.");
  process.exit(1);
}

const toolSchemas = chatTemplate === "qwen3.5" ? buildCatalogSchemas() : undefined;

const rawLines: Line[] = [];
const pairs: PreferencePair[] = [];
const sft: SftExample[] = [];
const takeRaw = (traces: readonly TurnTrace[], from: string, onlyPassed: boolean): void => {
  for (const pair of correctedPairs(traces)) rawLines.push({ kind: "corrected", from, ...pair });
  if (onlyPassed)
    for (const example of cleanExamples(traces)) rawLines.push({ kind: "clean", from, ...example });
};

let without = 0;
for (const name of reports) {
  const report = await loadReport(name);
  const extracted = extractReportTrainingData(report, {
    teacherOnlyForClean: teacherOnly,
    chatTemplate,
    toolSchemas,
  });
  pairs.push(...extracted.pairs);
  sft.push(...extracted.sft);
  for (const test of report.cases) {
    for (const run of test.runs) {
      if (!run.traces) {
        without += 1;
        continue;
      }
      const from = `${report.label}:${test.id}`;
      const rightInTheEnd = run.failures.every((failure) =>
        failure.includes("follow-through check"),
      );
      if (rightInTheEnd) {
        for (const pair of correctedPairs(run.traces)) {
          rawLines.push({ kind: "corrected", from, ...pair });
        }
      }
      if (run.pass) {
        for (const example of cleanExamples(run.traces)) {
          rawLines.push({ kind: "clean", from, ...example });
        }
      }
    }
  }
}
for (const file of traceFiles) {
  const traces = (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TurnTrace];
      } catch {
        return [];
      }
    });
  takeRaw(traces, file, true);
  const extracted = extractTrainingData(traces, {
    from: file,
    includeClean: true,
    teacherOnlyForClean: teacherOnly,
    chatTemplate,
    toolSchemas,
  });
  pairs.push(...extracted.pairs);
  sft.push(...extracted.sft);
}

function matchesDomain(example: SftExample, domain: SpecialistDomain): boolean {
  const allowed = SPECIALIST_SPECS[domain].allowedTools;
  const userStart = example.text.indexOf("<|im_start|>user\n");
  const dialogueText = userStart === -1 ? example.text : example.text.slice(userStart);
  for (const tool of allowed) {
    if (dialogueText.includes(`<function=${tool}>`) || dialogueText.includes(`"name":"${tool}"`)) {
      return true;
    }
  }
  if (userStart !== -1) {
    const userEnd = example.text.indexOf("<|im_end|>", userStart);
    const prompt = example.text.slice(userStart + 17, userEnd === -1 ? undefined : userEnd);
    return inferSpecialistDomain(prompt) === domain;
  }
  return false;
}

const domainFilteredSft =
  domainFilter === "all" ? sft : sft.filter((item) => matchesDomain(item, domainFilter));

const finalSft: SftExample[] = [];
if (deduplicate) {
  const seen = new Set<string>();
  for (const item of domainFilteredSft) {
    const userIdx = item.text.indexOf("<|im_start|>user\n");
    const keySource = userIdx === -1 ? item.text : item.text.slice(userIdx);
    const hash = createHash("sha256").update(keySource).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    finalSft.push(item);
  }
} else {
  finalSft.push(...domainFilteredSft);
}

const toJsonl = (rows: readonly unknown[]): string =>
  rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");

if (pairsOut) {
  await writeFile(pairsOut, toJsonl(pairs), { encoding: "utf8", mode: 0o600 });
}
if (sftOut) {
  await writeFile(sftOut, toJsonl(finalSft), { encoding: "utf8", mode: 0o600 });
}
if (!pairsOut && !sftOut) {
  const selected = format === "pairs" ? pairs : format === "sft" ? finalSft : rawLines;
  const text = toJsonl(selected);
  if (out) await writeFile(out, text, { encoding: "utf8", mode: 0o600 });
  else process.stdout.write(text);
} else if (out) {
  const selected = format === "pairs" ? pairs : format === "sft" ? finalSft : rawLines;
  await writeFile(out, toJsonl(selected), { encoding: "utf8", mode: 0o600 });
}

console.error(
  `${pairs.length} preference pairs and ${finalSft.length} SFT examples${
    pairsOut || sftOut ? ` written (${[pairsOut, sftOut].filter(Boolean).join(", ")})` : out ? ` written to ${out}` : ""
  }.` + (without > 0 ? ` ${without} runs had no records kept (made before records were kept).` : ""),
);
