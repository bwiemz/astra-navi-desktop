import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractReportTrainingData,
  extractTrainingData,
  formatQwenSft,
  isTeacherBrain,
  TrainingSink,
  type PreferencePair,
  type ReportLikeForTraining,
  type SftExample,
} from "../src/core/trainingExport.ts";
import type { TracedCall, TurnTrace } from "../src/core/trace.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aichan-train-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeCall(overrides: Partial<TracedCall> = {}): TracedCall {
  return {
    tool: "check_notes",
    input: JSON.stringify({ query: "groceries" }),
    outcome: "done",
    result: "milk and eggs",
    asked: false,
    ms: 12,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<TurnTrace> = {}): TurnTrace {
  return {
    at: "2026-11-22T12:00:00.000Z",
    kind: "user",
    said: "What is on my grocery list?",
    spoken: false,
    brain: "Standard (9B)",
    offered: ["check_notes"],
    calls: [makeCall()],
    reply: "You have milk and eggs on your grocery list.",
    checks: [],
    withheld: false,
    ms: { whole: 55, firstWord: 20, llm: 45, tools: 10 },
    tokens: { read: 120, written: 18, held: 138, prompt: 120 },
    ...overrides,
  };
}

describe("isTeacherBrain", () => {
  it("recognizes Standard/Large/9B+ models and excludes Small 4B models", () => {
    expect(isTeacherBrain("Standard (9B)")).toBe(true);
    expect(isTeacherBrain("Qwen3.5-9B")).toBe(true);
    expect(isTeacherBrain("Large (27B)")).toBe(true);
    expect(isTeacherBrain("Small (4B)")).toBe(false);
    expect(isTeacherBrain("qwen-4b-small")).toBe(false);
    expect(isTeacherBrain("3B")).toBe(false);
  });
});

describe("formatQwenSft", () => {
  it("builds Qwen ChatML with valid Unicode code-point assistant spans covering tool calls and final reply", () => {
    const example = formatQwenSft({
      id: "sft-1",
      system: "Be concise.",
      prompt: "Check status 👍",
      offered: ["check_notes", "set_alarm"],
      calls: [
        makeCall({
          tool: "check_notes",
          input: JSON.stringify({ query: "status" }),
          outcome: "done",
          result: "All green 🚀",
        }),
        makeCall({
          tool: "set_alarm",
          input: JSON.stringify({ in: "5m" }),
          outcome: "refused",
          result: "Blocked",
        }),
      ],
      reply: "Everything is green! 🎉",
      meta: { source: "clean", from: "eval:status", brain: "Standard (9B)" },
    });

    expect(example).not.toBeNull();
    if (!example) return;

    expect(example.id).toBe("sft-1");
    expect(example.meta).toEqual({
      source: "clean",
      from: "eval:status",
      brain: "Standard (9B)",
    });
    expect(example.text).toContain("Available tools: check_notes, set_alarm.");
    expect(example.text).toContain("<tool_call>");
    expect(example.text).toContain("<tool_response>\nAll green 🚀\n</tool_response>");
    expect(example.text).not.toContain('set_alarm"');

    // Spans are indexed in Unicode code points to match Python len(text) & tokenizer offset_mapping.
    const chars = Array.from(example.text);
    expect(example.spans).toHaveLength(2);
    for (const [start, end] of example.spans) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(chars.length);
    }

    const [toolSpan, replySpan] = example.spans;
    if (!toolSpan || !replySpan) throw new Error("expected 2 spans");
    const toolSlice = chars.slice(toolSpan[0], toolSpan[1]).join("");
    expect(toolSlice).toBe(
      '<tool_call>\n{"name":"check_notes","arguments":{"query":"status"}}\n</tool_call><|im_end|>',
    );

    const replySlice = chars.slice(replySpan[0], replySpan[1]).join("");
    expect(replySlice).toBe("Everything is green! 🎉<|im_end|>");
  });

  it("returns null when prompt or reply is blank", () => {
    expect(
      formatQwenSft({
        id: "empty-reply",
        prompt: "hi",
        offered: [],
        calls: [],
        reply: "   ",
      }),
    ).toBeNull();
    expect(
      formatQwenSft({
        id: "empty-prompt",
        prompt: "",
        offered: [],
        calls: [],
        reply: "hello",
      }),
    ).toBeNull();
  });
});

describe("extractTrainingData", () => {
  it("extracts preference pairs and SFT from corrected claim trajectories and excludes withheld turns", () => {
    const hallucinated = makeTrace({
      kind: "user",
      brain: "Small (4B)",
      said: "Check my notifications.",
      reply: "You have no new notifications.",
      offered: ["check_notices"],
      calls: [],
      checks: [{ found: "claimed", did: "again" }],
    });
    const corrected = makeTrace({
      kind: "again",
      brain: "Small (4B)",
      said: "Check my notifications.",
      reply: "I checked and found 2 unread messages.",
      offered: ["check_notices"],
      calls: [
        makeCall({
          tool: "check_notices",
          input: "{}",
          outcome: "done",
          result: "2 unread messages",
        }),
      ],
      checks: [],
    });
    const withheldTurn = makeTrace({
      kind: "user",
      brain: "Standard (9B)",
      said: "Notification summary",
      reply: "",
      withheld: true,
      calls: [],
      checks: [],
    });
    const cleanTeacher = makeTrace({
      kind: "user",
      brain: "Standard (9B)",
      said: "What time is it?",
      reply: "It is 3 PM.",
      offered: ["clock"],
      calls: [makeCall({ tool: "clock", input: "{}", outcome: "done", result: "15:00" })],
      checks: [],
    });
    const cleanSmall = makeTrace({
      kind: "user",
      brain: "Small (4B)",
      said: "Hi",
      reply: "Hello!",
      offered: [],
      calls: [],
      checks: [],
    });

    const result = extractTrainingData(
      [hallucinated, corrected, withheldTurn, cleanTeacher, cleanSmall],
      { from: "unit:test", teacherOnlyForClean: true },
    );

    expect(result.pairs).toHaveLength(1);
    const [pair] = result.pairs;
    if (!pair) throw new Error("expected 1 preference pair");
    expect(pair.kind).toBe("preference");
    expect(pair.from).toBe("unit:test");
    expect(pair.prompt).toBe("Check my notifications.");
    expect(pair.rejected_hallucinated_reply).toBe("You have no new notifications.");
    expect(pair.verified_tool_trajectory.reply).toBe("I checked and found 2 unread messages.");
    expect(pair.verified_tool_trajectory.calls).toHaveLength(1);

    // 1 corrected SFT + 1 clean teacher SFT; withheld + cleanSmall excluded
    expect(result.sft).toHaveLength(2);
    expect(result.sft.map((ex) => ex.meta?.source)).toEqual(["corrected", "clean"]);
    expect(result.sft.every((ex) => !ex.text.includes("Notification summary"))).toBe(true);
    expect(result.sft.every((ex) => !ex.text.includes("Hello!"))).toBe(true);
  });
});

describe("extractReportTrainingData", () => {
  it("extracts report trajectories, counts runs without traces, and excludes non-follow-through failures", () => {
    const hallucinated = makeTrace({
      kind: "user",
      brain: "Small (4B)",
      said: "Ring my phone.",
      reply: "I rang your phone.",
      offered: ["ring_phone"],
      calls: [],
      checks: [{ found: "claimed", did: "again" }],
    });
    const corrected = makeTrace({
      kind: "again",
      brain: "Small (4B)",
      said: "Ring my phone.",
      reply: "Ringing your phone now.",
      offered: ["ring_phone"],
      calls: [makeCall({ tool: "ring_phone", input: "{}", outcome: "done", result: "ringing" })],
      checks: [],
    });
    const cleanTeacher = makeTrace({
      kind: "user",
      brain: "Standard (9B)",
      said: "Check weather",
      reply: "Sunny 72F.",
      offered: ["weather"],
      calls: [makeCall({ tool: "weather", input: "{}", outcome: "done", result: "Sunny 72F" })],
      checks: [],
    });

    const report: ReportLikeForTraining = {
      label: "9b-eval",
      cases: [
        {
          id: "case-missing-traces",
          runs: [{ pass: true, failures: [] }],
        },
        {
          id: "case-follow-through",
          runs: [
            {
              pass: false,
              failures: ["follow-through check caught ungrounded claim"],
              traces: [hallucinated, corrected],
            },
          ],
        },
        {
          id: "case-other-failure",
          runs: [
            {
              pass: false,
              failures: ["wrong answer"],
              traces: [hallucinated, corrected],
            },
          ],
        },
        {
          id: "case-clean-pass",
          runs: [
            {
              pass: true,
              failures: [],
              traces: [cleanTeacher],
            },
          ],
        },
      ],
    };

    const out = extractReportTrainingData(report, { teacherOnlyForClean: true });
    expect(out.runsWithoutTraces).toBe(1);
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]?.from).toBe("9b-eval:case-follow-through");
    expect(out.sft).toHaveLength(2);
    expect(out.sft.map((s) => s.meta?.from)).toEqual([
      "9b-eval:case-follow-through",
      "9b-eval:case-clean-pass",
    ]);
  });
});

describe("TrainingSink", () => {
  it("writes pairs and teacher SFT with 0o600 permissions, skips withheld turns, and clears files", async () => {
    const dir = await makeTempDir();
    const pairsFile = join(dir, "pairs.jsonl");
    const sftFile = join(dir, "distill.jsonl");
    const sink = new TrainingSink({
      pairsFile,
      sftFile,
      systemPrompt: () => "Custom system prompt.",
    });

    const userHallucination = makeTrace({
      kind: "user",
      brain: "Small (4B)",
      said: "Did I get mail?",
      reply: "Yes, 1 email.",
      offered: ["check_mail"],
      calls: [],
      checks: [{ found: "claimed", did: "again" }],
    });
    const againFix = makeTrace({
      kind: "again",
      brain: "Small (4B)",
      said: "Did I get mail?",
      reply: "You actually have 0 emails.",
      offered: ["check_mail"],
      calls: [makeCall({ tool: "check_mail", input: "{}", outcome: "done", result: "0 emails" })],
      checks: [],
    });

    // Intervening withheld turn must not pair with a subsequent "again" turn.
    const withheldTurn = makeTrace({
      kind: "user",
      brain: "Standard (9B)",
      said: "Private notice body",
      reply: "Secret notice",
      withheld: true,
      calls: [],
      checks: [],
    });

    const cleanSmall = makeTrace({
      kind: "user",
      brain: "Small (4B)",
      said: "Hello",
      reply: "Hi",
      offered: [],
      calls: [],
      checks: [],
    });
    const cleanTeacher = makeTrace({
      kind: "user",
      brain: "Standard (9B)",
      said: "Check calendar",
      reply: "Meeting at 2 PM.",
      offered: ["agenda"],
      calls: [makeCall({ tool: "agenda", input: "{}", outcome: "done", result: "2 PM meeting" })],
      checks: [],
    });

    sink.record(userHallucination);
    sink.record(againFix);
    sink.record(withheldTurn);
    sink.record(againFix); // Should NOT pair because withheldTurn cleared previousUserTurn
    sink.record(cleanSmall);
    sink.record(cleanTeacher);
    await sink.whenWritten();

    const pairsMode = (await stat(pairsFile)).mode & 0o777;
    const sftMode = (await stat(sftFile)).mode & 0o777;
    expect(pairsMode).toBe(0o600);
    expect(sftMode).toBe(0o600);

    const pairLines = (await readFile(pairsFile, "utf8")).trim().split("\n");
    expect(pairLines).toHaveLength(1);
    const parsedPair = JSON.parse(pairLines[0] ?? "") as PreferencePair;
    expect(parsedPair.from).toBe("live:claims");
    expect(parsedPair.rejected_hallucinated_reply).toBe("Yes, 1 email.");

    const sftLines = (await readFile(sftFile, "utf8")).trim().split("\n");
    expect(sftLines).toHaveLength(2);
    const sftItems = sftLines.map((line) => JSON.parse(line) as SftExample);
    expect(sftItems.map((item) => item.meta?.from)).toEqual(["live:claims", "live:distill"]);
    expect(sftItems.every((item) => item.text.includes("Custom system prompt."))).toBe(true);
    expect(sftItems.every((item) => !item.text.includes("Private notice"))).toBe(true);

    await sink.clear();
    await expect(stat(pairsFile)).rejects.toThrow();
    await expect(stat(sftFile)).rejects.toThrow();
  });
});

describe("Qwen3.5 SFT template & specialist domain routing", () => {
  it("formats native Qwen3.5 tool schemas and <function=NAME><parameter=params> calls", async () => {
    const { buildQwen35ToolsSection } = await import("../src/core/trainingExport.ts");
    const { estimateSpecialistPromptTokens, inferSpecialistDomain } = await import(
      "../src/core/loraAgents.ts"
    );

    const toolsBlock = buildQwen35ToolsSection(["ship_status", "read_file"], {
      ship_status: {
        description: "Check ship vitals.",
        parameters: { type: "object", properties: { detail: { type: "string" } } },
      },
      read_file: {
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    });
    expect(toolsBlock).toContain("# Tools");
    expect(toolsBlock).toContain("<tools>");
    expect(toolsBlock).toContain('"name":"ship_status"');
    expect(toolsBlock).toContain("<function=...></function>");

    const ex = formatQwenSft({
      id: "q35-1",
      prompt: "Check ship health now.",
      offered: ["ship_status"],
      calls: [
        makeCall({
          tool: "ship_status",
          input: JSON.stringify({ detail: "full" }),
          outcome: "done",
          result: "OK",
        }),
      ],
      reply: "All systems nominal.",
      chatTemplate: "qwen3.5",
      toolSchemas: {
        ship_status: { description: "Check ship vitals.", parameters: { type: "object" } },
      },
    });
    expect(ex).not.toBeNull();
    if (!ex) throw new Error("expected Qwen3.5 SFT example");
    expect(ex.text).toContain(
      '<tool_call>\n<function=ship_status>\n<parameter=params>\n{"detail":"full"}\n</parameter>\n</function>\n</tool_call><|im_end|>',
    );
    expect(ex.text).toContain('<tool_response>\n"OK"\n</tool_response>');
    expect(ex.text).not.toContain("<think>\n\n</think>");
    expect(ex.spans).toHaveLength(2);
    for (const [start, end] of ex.spans) {
      expect(end).toBeGreaterThan(start);
      expect(Array.from(ex.text).slice(start, end).join("")).not.toContain("<think>\n\n</think>");
    }

    expect(inferSpecialistDomain("Check CPU load on proxmox node over SSH")).toBe("fleet-systems");
    expect(inferSpecialistDomain("Schedule a reminder tomorrow and check calendar")).toBe(
      "logistics-scheduling",
    );
    const tokStats = estimateSpecialistPromptTokens("fleet-systems");
    expect(tokStats.estimatedPromptTokens).toBeGreaterThan(100);
    expect(tokStats.tokensSaved).toBeGreaterThan(3000);
  });
});
