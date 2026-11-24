import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { cleanExamples, correctedPairs, type TracedCall, type TurnTrace } from "./trace.ts";

/**
 * Turns reply traces (and eval reports) into:
 * 1. Preference pairs `(prompt, rejected_hallucinated_reply, verified_tool_trajectory)`
 *    captured when `claims.ts` / follow-through checks catch and correct an ungrounded reply;
 * 2. Qwen ChatML SFT examples (`{ id, text, spans }`) compatible with `train/lora.py` so
 *    verified trajectories and 9B standard-brain runs distil into the small brain.
 *
 * Notifications (`withheld: true`) are strictly excluded and never written to disk.
 */

export interface PreferencePair {
  id: string;
  kind: "preference";
  from: string;
  brain: string;
  prompt: string;
  offered: string[];
  found: string;
  rejected_hallucinated_reply: string;
  verified_tool_trajectory: {
    calls: TracedCall[];
    reply: string;
  };
}

export interface ToolSchemaSummary {
  description?: string;
  parameters?: Record<string, unknown>;
}

export type SftTemplate = "qwen3" | "qwen3.5";

export interface SftExample {
  id: string;
  text: string;
  spans: [number, number][];
  meta?: {
    source: "corrected" | "clean";
    from: string;
    brain: string;
  };
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Astra Navi, a helpful local desktop companion. Speak concisely, use tools whenever checking state or acting, and never claim an action or lookup without calling a tool first.";

/** True for larger teacher brains (9B+ Standard / Large), false for the Small 4B model. */
export function isTeacherBrain(brainLabel: string): boolean {
  const lower = brainLabel.toLowerCase();
  if (lower.includes("small") || /\b[1-5]b\b/.test(lower)) return false;
  return (
    lower.includes("standard") ||
    lower.includes("large") ||
    lower.includes("workstation") ||
    lower.includes("moe") ||
    /\b(?:7|8|9|14|27|32|70|72|120)b\b/.test(lower)
  );
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function parseJsonInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

export function buildQwen35ToolsSection(
  offered: readonly string[],
  toolSchemas?: Record<string, ToolSchemaSummary>,
): string {
  if (offered.length === 0) return "";
  const schemas = offered
    .map((name) => {
      const schema = toolSchemas?.[name];
      return JSON.stringify({
        type: "function",
        function: {
          name,
          ...(schema?.description ? { description: schema.description } : { description: `Invoke ${name}.` }),
          parameters: schema?.parameters ?? { type: "object", properties: {} },
        },
      });
    })
    .join("\n");
  return (
    "\n\n# Tools\n\nYou have access to the following functions:\n\n<tools>\n" +
    `${schemas}\n</tools>\n\n` +
    "If you choose to call a function ONLY reply in the following format with NO suffix:\n\n" +
    "<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n" +
    "<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n" +
    "</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n" +
    "- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n" +
    "- Required parameters MUST be specified\n" +
    "- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n" +
    "- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n" +
    "</IMPORTANT>"
  );
}

/**
 * Formats a single request + verified tool trajectory into Qwen ChatML with Unicode code-point
 * assistant `spans` covering every assistant tool-call block and final answer for `train/lora.py`.
 * Supports both compact `qwen3` JSON calls and native `qwen3.5` (`QwenChatWrapper variation "3.5"`) format.
 */
export function formatQwenSft(params: {
  id: string;
  system?: string;
  prompt: string;
  offered: readonly string[];
  calls: readonly TracedCall[];
  reply: string;
  meta?: SftExample["meta"];
  chatTemplate?: SftTemplate;
  toolSchemas?: Record<string, ToolSchemaSummary>;
}): SftExample | null {
  const prompt = params.prompt.trim();
  const reply = params.reply.trim();
  if (!prompt || !reply) return null;

  const template: SftTemplate = params.chatTemplate ?? "qwen3";
  const baseSystem = (params.system ?? "").trim() || DEFAULT_SYSTEM_PROMPT;
  const toolsBlock =
    template === "qwen3.5"
      ? buildQwen35ToolsSection(params.offered, params.toolSchemas)
      : params.offered.length > 0
        ? `\n\nAvailable tools: ${params.offered.join(", ")}.`
        : "";
  const systemBlock = `${baseSystem}${toolsBlock}`;

  let text = "";
  let cursor = 0;
  const append = (chunk: string): void => {
    text += chunk;
    cursor += codePointLength(chunk);
  };

  append(`<|im_start|>system\n${systemBlock}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n`);
  const spans: [number, number][] = [];

  for (const call of params.calls) {
    if (call.outcome !== "done") continue;
    append("<|im_start|>assistant\n");
    const start = cursor;
    if (template === "qwen3.5") {
      const argObj = parseJsonInput(call.input);
      const entries = Object.entries(argObj).filter(([k]) => k !== "raw");
      const paramBlocks =
        entries.length > 0
          ? entries
              .map(([k, v]) => {
                const rendered = typeof v === "string" ? v : JSON.stringify(v);
                return `<parameter=${k}>\n${rendered}\n</parameter>`;
              })
              .join("\n")
          : `<parameter=params>\n${JSON.stringify(argObj)}\n</parameter>`;
      append(
        `<think>\n\n</think>\n\n<tool_call>\n<function=${call.tool}>\n${paramBlocks}\n</function>\n</tool_call><|im_end|>`,
      );
    } else {
      const payload = JSON.stringify({
        name: call.tool,
        arguments: parseJsonInput(call.input),
      });
      append(`<tool_call>\n${payload}\n</tool_call><|im_end|>`);
    }
    const end = cursor;
    spans.push([start, end]);
    append(`\n<|im_start|>user\n<tool_response>\n${call.result}\n</tool_response><|im_end|>\n`);
  }

  append("<|im_start|>assistant\n");
  const replyStart = cursor;
  if (template === "qwen3.5") {
    append(`<think>\n\n</think>\n\n${reply}<|im_end|>`);
  } else {
    append(`${reply}<|im_end|>`);
  }
  const replyEnd = cursor;
  spans.push([replyStart, replyEnd]);

  if (spans.some(([start, end]) => !(start >= 0 && start < end && end <= cursor))) {
    return null;
  }
  return {
    id: params.id,
    text,
    spans,
    ...(params.meta ? { meta: params.meta } : {}),
  };
}

export interface ExtractTrainingOptions {
  from: string;
  /** Include clean zero-check trajectories alongside corrected claim pairs. */
  includeClean?: boolean;
  /** When true, only distill clean examples from Standard/Large teacher brains. */
  teacherOnlyForClean?: boolean;
  systemPrompt?: string;
  chatTemplate?: SftTemplate;
  toolSchemas?: Record<string, ToolSchemaSummary>;
}

/**
 * Extracts structured preference pairs and Qwen SFT training traces from turn records.
 * Traces with `withheld: true` (e.g. notifications) are excluded automatically.
 */
export function extractTrainingData(
  traces: readonly TurnTrace[],
  options: ExtractTrainingOptions,
): { pairs: PreferencePair[]; sft: SftExample[] } {
  const safeTraces = traces.filter((trace) => !trace.withheld);
  const pairs: PreferencePair[] = [];
  const sft: SftExample[] = [];

  for (const pair of correctedPairs(safeTraces)) {
    const id = stableId(
      "pref",
      `${options.from}\n${pair.brain}\n${pair.said}\n${pair.rejected}\n${pair.accepted.reply}`,
    );
    pairs.push({
      id,
      kind: "preference",
      from: options.from,
      brain: pair.brain,
      prompt: pair.said,
      offered: pair.offered,
      found: pair.found,
      rejected_hallucinated_reply: pair.rejected,
      verified_tool_trajectory: pair.accepted,
    });
    const example = formatQwenSft({
      id: `${id}-sft`,
      system: options.systemPrompt,
      prompt: pair.said,
      offered: pair.offered,
      calls: pair.accepted.calls,
      reply: pair.accepted.reply,
      meta: { source: "corrected", from: options.from, brain: pair.brain },
      chatTemplate: options.chatTemplate,
      toolSchemas: options.toolSchemas,
    });
    if (example) sft.push(example);
  }

  if (options.includeClean !== false) {
    for (const clean of cleanExamples(safeTraces)) {
      if (options.teacherOnlyForClean && !isTeacherBrain(clean.brain)) continue;
      const id = stableId("sft", `${options.from}\n${clean.brain}\n${clean.said}\n${clean.reply}`);
      const example = formatQwenSft({
        id,
        system: options.systemPrompt,
        prompt: clean.said,
        offered: clean.offered,
        calls: clean.calls,
        reply: clean.reply,
        meta: { source: "clean", from: options.from, brain: clean.brain },
        chatTemplate: options.chatTemplate,
        toolSchemas: options.toolSchemas,
      });
      if (example) sft.push(example);
    }
  }

  return { pairs, sft };
}

export interface ReportLikeForTraining {
  label: string;
  cases: readonly {
    id: string;
    runs: readonly {
      pass: boolean;
      failures: readonly string[];
      traces?: readonly TurnTrace[];
    }[];
  }[];
}

/** Extracts preference pairs and distilled SFT examples from an eval report. */
export function extractReportTrainingData(
  report: ReportLikeForTraining,
  options: {
    teacherOnlyForClean?: boolean;
    systemPrompt?: string;
    chatTemplate?: SftTemplate;
    toolSchemas?: Record<string, ToolSchemaSummary>;
  } = {},
): { pairs: PreferencePair[]; sft: SftExample[]; runsWithoutTraces: number } {
  const pairs: PreferencePair[] = [];
  const sft: SftExample[] = [];
  let runsWithoutTraces = 0;

  for (const test of report.cases) {
    for (const run of test.runs) {
      if (!run.traces) {
        runsWithoutTraces += 1;
        continue;
      }
      const from = `${report.label}:${test.id}`;
      const rightInEnd = run.failures.every((failure) =>
        failure.includes("follow-through check"),
      );
      const { pairs: runPairs, sft: runSft } = extractTrainingData(run.traces, {
        from,
        includeClean: run.pass,
        teacherOnlyForClean: options.teacherOnlyForClean,
        systemPrompt: options.systemPrompt,
        chatTemplate: options.chatTemplate,
        toolSchemas: options.toolSchemas,
      });
      if (rightInEnd) pairs.push(...runPairs);
      for (const item of runSft) {
        if (item.meta?.source === "corrected" && !rightInEnd) continue;
        sft.push(item);
      }
    }
  }

  return { pairs, sft, runsWithoutTraces };
}

export interface TrainingSinkOptions {
  pairsFile: string;
  sftFile: string;
  systemPrompt?(): string;
}

/**
 * Incrementally logs live claim-corrected preference pairs and distilled teacher trajectories
 * while `keepTraces` is active, skipping any turn with `withheld: true`.
 */
export class TrainingSink {
  private readonly options: TrainingSinkOptions;
  private previousUserTurn: TurnTrace | null = null;
  private writing: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(options: TrainingSinkOptions) {
    this.options = options;
  }

  record(trace: TurnTrace): void {
    if (trace.withheld) {
      this.previousUserTurn = null;
      return;
    }
    const systemPrompt = this.options.systemPrompt?.();
    const pairsOut: PreferencePair[] = [];
    const sftOut: SftExample[] = [];

    if (this.previousUserTurn && trace.kind === "again") {
      const extracted = extractTrainingData([this.previousUserTurn, trace], {
        from: "live:claims",
        includeClean: false,
        systemPrompt,
      });
      pairsOut.push(...extracted.pairs);
      sftOut.push(...extracted.sft);
    } else if (
      trace.kind === "user" &&
      trace.checks.length === 0 &&
      isTeacherBrain(trace.brain)
    ) {
      const extracted = extractTrainingData([trace], {
        from: "live:distill",
        includeClean: true,
        teacherOnlyForClean: true,
        systemPrompt,
      });
      sftOut.push(...extracted.sft);
    }

    this.previousUserTurn = trace.kind === "user" ? trace : null;

    if (pairsOut.length > 0) this.appendLines(this.options.pairsFile, pairsOut);
    if (sftOut.length > 0) this.appendLines(this.options.sftFile, sftOut);
  }

  private appendLines(file: string, rows: readonly unknown[]): void {
    const payload = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, payload, { encoding: "utf8", mode: 0o600 });
        await chmod(file, 0o600);
      } catch (error) {
        if (!this.warned) {
          this.warned = true;
          console.warn("[training] could not save training trace:", error);
        }
      }
    });
  }

  clear(): Promise<void> {
    this.previousUserTurn = null;
    this.writing = this.writing
      .then(() =>
        Promise.all([
          rm(this.options.pairsFile, { force: true }),
          rm(this.options.sftFile, { force: true }),
        ]),
      )
      .then(() => undefined)
      .catch(() => undefined);
    return this.writing;
  }

  whenWritten(): Promise<void> {
    return this.writing;
  }
}
