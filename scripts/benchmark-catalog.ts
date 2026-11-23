import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generateFuzzCases,
  runDeterministicFuzzGate,
  type FuzzGateReport,
} from "../evals/fuzz.ts";
import {
  compileJsonSchemaToGbnf,
  hardenFunctionsForGrammar,
  StreamingJsonParamGuard,
  ToolLoopGuard,
  validateToolArguments,
} from "../src/core/grammarGuard.ts";
import {
  estimateKvCacheBytes,
  ROLLING_MODEL_CATALOG,
  selectQuantizationForBudget,
} from "../src/core/models.ts";
import type { ChatSessionModelFunctions } from "node-llama-cpp";

/**
 * Rolling Catalog & Deterministic Grammar/Loop Benchmark Harness (`npm run benchmark:catalog`).
 *
 * Measures:
 * 1. Indirect-injection & taint fuzz suite (`evals/fuzz.ts`, 500 cases, seed 20261122).
 * 2. 24-case deterministic grammar-constrained JSON validation, streaming repetition abort,
 *    and tool loop-breaker stress benchmark.
 * 3. Memory/quantization verification across every entry in `ROLLING_MODEL_CATALOG`.
 *
 * With `--write-report`, updates Section 6 of `evals/results/BENCHMARKS.md` in place.
 */

interface StressCaseResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function runGrammarAndLoopStressSuite(): Promise<{
  passed: number;
  total: number;
  cases: StressCaseResult[];
}> {
  const results: StressCaseResult[] = [];
  const nestedSchema = {
    type: "object",
    required: ["target", "steps"],
    properties: {
      target: {
        type: "object",
        required: ["host", "port"],
        properties: {
          host: { type: "string", minLength: 1 },
          port: { type: "integer", minimum: 1, maximum: 65535 },
          mode: { enum: ["read", "write"] },
        },
      },
      steps: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["action"],
          properties: {
            action: { enum: ["inspect", "restart"] },
            dryRun: { type: "boolean" },
          },
        },
      },
    },
  };

  // 1-4: Hardening + GBNF compilation
  const mockFns = {
    deploy_step: {
      description: "Nested deploy tool",
      params: nestedSchema,
      handler: async () => "ok",
    },
    echo: {
      description: "Echo tool",
      params: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      handler: async () => "echoed",
    },
  } as unknown as ChatSessionModelFunctions;

  const hardened = hardenFunctionsForGrammar(mockFns);
  const gbnf = compileJsonSchemaToGbnf(hardened["deploy_step"]?.params);
  results.push({
    name: "gbnf-compilation-nonempty",
    passed: gbnf.includes("root ::=") && gbnf.includes('\\"inspect\\"') && gbnf.includes('\\"restart\\"'),
    detail: "Generated nested object/enum/array GBNF rules",
  });

  // 5-12: Nested schema validation accept vs reject cases
  const validPayload = {
    target: { host: "nas.local", port: 22, mode: "read" },
    steps: [{ action: "inspect", dryRun: true }],
  };
  results.push({
    name: "valid-nested-json-accepted",
    passed: validateToolArguments(hardened["deploy_step"]?.params, validPayload).ok,
    detail: "Accepted valid nested payload",
  });

  const invalidCases: readonly [string, unknown][] = [
    ["reject-extra-top-level-key", { ...validPayload, sneaky: true }],
    ["reject-extra-nested-key", { target: { host: "nas", port: 22, root: true }, steps: validPayload.steps }],
    ["reject-missing-required-nested", { target: { host: "nas" }, steps: validPayload.steps }],
    ["reject-wrong-int-type", { target: { host: "nas", port: 22.5 }, steps: validPayload.steps }],
    ["reject-out-of-range-port", { target: { host: "nas", port: 70000 }, steps: validPayload.steps }],
    ["reject-invalid-enum", { target: { host: "nas", port: 22, mode: "sudo" }, steps: validPayload.steps }],
    ["reject-empty-array", { target: validPayload.target, steps: [] }],
    ["reject-nested-array-bad-item", { target: validPayload.target, steps: [{ action: "nuke" }] }],
    ["reject-non-object-root", "not-an-object"],
    ["reject-array-wrong-type", { target: validPayload.target, steps: "inspect" }],
  ];
  for (const [name, payload] of invalidCases) {
    const check = validateToolArguments(hardened["deploy_step"]?.params, payload);
    results.push({
      name,
      passed: !check.ok && check.errors.length > 0,
      detail: check.errors[0] ?? "accepted",
    });
  }

  // 13-16: Streaming parameter degeneration guard
  const repGuard = new StreamingJsonParamGuard({ maxParamBytes: 1024, maxBraceDepth: 4 });
  results.push({
    name: "stream-guard-accepts-normal",
    passed: repGuard.pushChunk({ callIndex: 0, functionName: "echo", paramsChunk: '{"text":"hi"}', done: true }).ok,
    detail: "Accepted clean parameter stream",
  });
  results.push({
    name: "stream-guard-blocks-char-repeat",
    passed: !repGuard.pushChunk({ callIndex: 1, functionName: "echo", paramsChunk: `{"text":"${"a".repeat(60)}`, done: false }).ok,
    detail: "Halted repeated character token loop",
  });
  results.push({
    name: "stream-guard-blocks-pattern-repeat",
    passed: !repGuard.pushChunk({ callIndex: 2, functionName: "echo", paramsChunk: '{"x":[' + '1,'.repeat(34), done: false }).ok,
    detail: "Halted repeating tuple token loop",
  });
  results.push({
    name: "stream-guard-blocks-deep-braces",
    passed: !repGuard.pushChunk({ callIndex: 3, functionName: "echo", paramsChunk: "{{{{{{", done: false }).ok,
    detail: "Halted runaway object nesting",
  });

  // 17-24: ToolLoopGuard exact duplicate, failed retry, oscillation, schema spam, and ceiling breakers
  const exactGuard = new ToolLoopGuard({ maxExactRepeats: 3 });
  for (let i = 0; i < 3; i += 1) {
    exactGuard.recordOutcome("search", { q: "weather" }, { ok: true });
  }
  results.push({
    name: "loop-guard-exact-repeat",
    passed: !exactGuard.checkBeforeCall("search", { q: "weather" }).allowed,
    detail: exactGuard.stats().lastBreakReason ?? "",
  });

  const failSameGuard = new ToolLoopGuard();
  failSameGuard.recordOutcome("read", { p: "/x" }, { ok: false });
  failSameGuard.recordOutcome("read", { p: "/x" }, { ok: false });
  results.push({
    name: "loop-guard-consecutive-same-failure",
    passed: !failSameGuard.checkBeforeCall("read", { p: "/x" }).allowed,
    detail: failSameGuard.stats().lastBreakReason ?? "",
  });

  const oscGuard = new ToolLoopGuard();
  oscGuard.recordOutcome("win", { a: 1 }, { ok: true });
  oscGuard.recordOutcome("list", { b: 2 }, { ok: true });
  oscGuard.recordOutcome("win", { a: 1 }, { ok: true });
  results.push({
    name: "loop-guard-alternating-ABAB",
    passed: !oscGuard.checkBeforeCall("list", { b: 2 }).allowed,
    detail: oscGuard.stats().lastBreakReason ?? "",
  });

  const errGuard = new ToolLoopGuard({ maxConsecutiveFailures: 3 });
  errGuard.recordOutcome("cmd", { c: "1" }, { ok: false });
  errGuard.recordOutcome("cmd", { c: "2" }, { ok: false });
  errGuard.recordOutcome("cmd", { c: "3" }, { ok: false });
  results.push({
    name: "loop-guard-consecutive-tool-errors",
    passed: !errGuard.checkBeforeCall("cmd", { c: "4" }).allowed,
    detail: errGuard.stats().lastBreakReason ?? "",
  });

  const schemaGuard = new ToolLoopGuard({ maxSchemaFailures: 2 });
  schemaGuard.recordOutcome("echo", { bad: 1 }, { ok: false, schemaInvalid: true });
  schemaGuard.recordOutcome("echo", { bad: 2 }, { ok: false, schemaInvalid: true });
  results.push({
    name: "loop-guard-schema-spam",
    passed: !schemaGuard.checkBeforeCall("echo", { text: "ok" }).allowed,
    detail: schemaGuard.stats().lastBreakReason ?? "",
  });

  const capGuard = new ToolLoopGuard({ maxCallsPerTurn: 4 });
  for (let i = 0; i < 4; i += 1) capGuard.recordOutcome(`t${i}`, { i }, { ok: true });
  results.push({
    name: "loop-guard-turn-ceiling",
    passed: !capGuard.checkBeforeCall("t4", { i: 4 }).allowed,
    detail: capGuard.stats().lastBreakReason ?? "",
  });

  const handlerGuard = new ToolLoopGuard();
  const wrapped = hardenFunctionsForGrammar(mockFns, handlerGuard);
  const badRes = await wrapped["echo"]?.handler({ nope: 123 } as never);
  results.push({
    name: "handler-rejects-malformed-json-args",
    passed: typeof badRes === "string" && badRes.includes("Schema validation rejected"),
    detail: String(badRes).slice(0, 90),
  });

  const goodRes = await wrapped["echo"]?.handler({ text: "hello" } as never);
  results.push({
    name: "handler-executes-valid-json-args",
    passed: goodRes === "echoed" && handlerGuard.stats().totalCalls === 2,
    detail: `result=${String(goodRes)}, schemaRejections=${handlerGuard.stats().schemaRejections}`,
  });

  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    cases: results,
  };
}

const FUZZ_SEED = 20261122;

function buildSection6Markdown(
  fuzz: FuzzGateReport,
  stress: Awaited<ReturnType<typeof runGrammarAndLoopStressSuite>>,
): string {
  const rows = ROLLING_MODEL_CATALOG.map((entry) => {
    const budgetGb = Math.max(entry.model.vramGb + 2, 6);
    const q = selectQuantizationForBudget(entry.model, budgetGb, 16_384, 500);
    const kv16kGb = (estimateKvCacheBytes(entry.model, 16_384, q.lean) / 1024 ** 3).toFixed(2);
    const status =
      entry.benchmarkStatus === "verified" && entry.benchmarks
        ? `Verified (**${entry.benchmarks.overallScorePercent}%**, \`${entry.benchmarks.tokensPerSec} tok/s\`)`
        : "`pending_gpu` (needs live GPU eval)";
    return `| \`${entry.presetId}\` | ${entry.tier} | ${entry.model.architecture ?? "dense"} (${entry.model.totalParamsB ?? "?"}B / ${entry.model.activeParamsB ?? "?"}B active) | \`${entry.model.quantization ?? "Q4_K_M"}\` (\`${entry.model.vramGb} GB\` min) | \`${kv16kGb} GB\` (${q.lean ? "lean" : "std"}) | ${status} |`;
  });

  return [
    "## 6. Rolling Model Catalog, Vetted One-Click Presets & Grammar/Loop Stress Gates",
    "",
    `_Generated locally by \`npm run benchmark:catalog -- --write-report\` (${new Date().toISOString().slice(0, 10)}). Live GPU metrics reflect real RTX PRO 4500 Blackwell runs; newer MoE/72B presets remain marked \`pending_gpu\` until measured on live GPU hardware._`,
    "",
    "### Rolling Open-Weight Catalog & Sizing Matrix",
    "",
    "| Preset ID | Tier | Architecture / Params | Default Quant & Min VRAM | 16k KV Cache | Benchmark Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "### Deterministic Grammar-Constrained Decoding & Loop-Guard Verification",
    "",
    `- **Indirect Prompt-Injection & Taint Fuzzer (\`evals/fuzz.ts\`, seed \`${FUZZ_SEED}\`):** **${fuzz.passed}/${fuzz.total} passed** (\`${fuzz.unauthorizedAllows}\` unauthorized allows, \`${fuzz.unseenLeaks}\` unseen leaks).`,
    `- **Grammar & Loop-Breaker Stress Suite (\`scripts/benchmark-catalog.ts\`):** **${stress.passed}/${stress.total} passed** (nested JSON GBNF compilation, strict \`additionalProperties: false\` enforcement, streaming repetition abort, exact repeat breaker, \`A <-> B\` oscillation detector, consecutive failure breaker, and turn cap).`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const writeReport = process.argv.includes("--write-report");
  const jsonOut = process.argv.includes("--json");

  const fuzzCases = generateFuzzCases({ count: 500, seed: FUZZ_SEED });
  const fuzz = await runDeterministicFuzzGate(fuzzCases);
  const fuzzOk = fuzz.failed === 0 && fuzz.unauthorizedAllows === 0 && fuzz.unseenLeaks === 0;
  const stress = await runGrammarAndLoopStressSuite();

  if (writeReport) {
    const reportPath = join(process.cwd(), "evals", "results", "BENCHMARKS.md");
    const existing = await readFile(reportPath, "utf8");
    const marker = "\n## 6. ";
    const idx = existing.indexOf(marker);
    const prefix = idx >= 0 ? existing.slice(0, idx).trimEnd() : existing.trimEnd();
    const section = buildSection6Markdown(fuzz, stress);
    await writeFile(reportPath, `${prefix}\n\n---\n\n${section}`, "utf8");
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          fuzz: { total: fuzz.total, passed: fuzz.passed, ok: fuzzOk },
          stress: { total: stress.total, passed: stress.passed },
          catalogCount: ROLLING_MODEL_CATALOG.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Rolling catalog (${ROLLING_MODEL_CATALOG.length} presets): fuzz=${fuzz.passed}/${fuzz.total}, grammar+loop=${stress.passed}/${stress.total}${writeReport ? " (wrote evals/results/BENCHMARKS.md)" : ""}`,
    );
  }

  if (!fuzzOk || stress.passed !== stress.total) {
    const failed = stress.cases.filter((c) => !c.passed);
    if (failed.length > 0) console.error("Failed cases:", failed);
    process.exitCode = 1;
  }
}

await main();
