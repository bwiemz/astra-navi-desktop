import type { ChatSessionModelFunctions } from "node-llama-cpp";

/**
 * Grammar-Constrained Tool Decoding & Deterministic Loop Guards.
 *
 * Ensures small/medium local models (4B–9B) cannot drift into malformed nested JSON
 * arguments, degenerate repetition streams, or infinite retry / oscillation loops:
 * 1. `hardenFunctionsForGrammar` enforces recursive `additionalProperties: false`
 *    and normalized JSON Schema nodes on routed tools passed to `node-llama-cpp`.
 * 2. `compileJsonSchemaToGbnf` / `compileToolsToGbnf` produce explicit llama.cpp GBNF
 *    grammars for constrained decoding engines.
 * 3. `validateToolArguments` validates incoming nested arguments deterministically.
 * 4. `StreamingJsonParamGuard` aborts runaway/degenerate JSON parameter token loops mid-stream.
 * 5. `ToolLoopGuard` halts exact repeats, alternating `A -> B -> A -> B` cycles,
 *    consecutive failures, and repeated malformed-argument attempts.
 */

export type JsonSchemaLike = Record<string, unknown>;

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** Canonicalizes arbitrary JSON values with sorted object keys for deterministic loop detection. */
export function canonicalizeArgs(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeArgs).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const entries = Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalizeArgs(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

/**
 * Recursively hardens a JSON Schema object for strict GBNF grammar compilation:
 * sets `additionalProperties: false` on every object declaring `properties` unless
 * `allowDynamicProperties` is explicitly flagged.
 */
export function hardenJsonSchema(schema: unknown): JsonSchemaLike {
  if (!isPlainRecord(schema)) return { type: "object", additionalProperties: false };

  const out: JsonSchemaLike = { ...schema };
  if (isPlainRecord(schema["properties"])) {
    const nextProps: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(schema["properties"])) {
      nextProps[key] = hardenJsonSchema(propSchema);
    }
    out["properties"] = nextProps;
    if (out["type"] === undefined) out["type"] = "object";
    if (out["additionalProperties"] === undefined && out["allowDynamicProperties"] !== true) {
      out["additionalProperties"] = false;
    }
    if (Array.isArray(out["required"])) {
      out["required"] = out["required"].filter(
        (r): r is string => typeof r === "string" && r in nextProps,
      );
    }
  } else if (schema["type"] === "array" && schema["items"] !== undefined) {
    out["items"] = hardenJsonSchema(schema["items"]);
  }

  for (const unionKey of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[unionKey])) {
      out[unionKey] = schema[unionKey].map((branch) => hardenJsonSchema(branch));
    }
  }
  return out;
}

/** Validates runtime arguments against a tool's hardened JSON Schema before executing side effects. */
export function validateToolArguments(
  schema: unknown,
  args: unknown,
  path = "params",
): SchemaValidationResult {
  if (!isPlainRecord(schema)) return { ok: true, errors: [] };
  const errors: string[] = [];

  if (Array.isArray(schema["oneOf"]) || Array.isArray(schema["anyOf"])) {
    const branches = (Array.isArray(schema["oneOf"]) ? schema["oneOf"] : schema["anyOf"]) as unknown[];
    const matches = branches.filter((b) => validateToolArguments(b, args, path).ok);
    if (matches.length === 0) {
      errors.push(`${path}: value does not match any allowed union schema branch.`);
    }
    return { ok: errors.length === 0, errors };
  }

  if ("const" in schema && schema["const"] !== args) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema["const"])}.`);
    return { ok: false, errors };
  }

  if (Array.isArray(schema["enum"])) {
    if (!schema["enum"].includes(args)) {
      errors.push(
        `${path}: value ${JSON.stringify(args)} must be one of ${JSON.stringify(schema["enum"])}.`,
      );
    }
    return { ok: errors.length === 0, errors };
  }

  const schemaType = schema["type"];
  const allowedTypes = Array.isArray(schemaType)
    ? schemaType
    : typeof schemaType === "string"
      ? [schemaType]
      : [];

  if (allowedTypes.length > 0) {
    const matchesAny = allowedTypes.some((t) => {
      if (t === "null") return args === null;
      if (t === "boolean") return typeof args === "boolean";
      if (t === "string") return typeof args === "string";
      if (t === "integer") return typeof args === "number" && Number.isInteger(args);
      if (t === "number") return typeof args === "number" && Number.isFinite(args);
      if (t === "array") return Array.isArray(args);
      if (t === "object") return isPlainRecord(args);
      return true;
    });
    if (!matchesAny) {
      errors.push(`${path}: expected ${allowedTypes.join("|")}, got ${args === null ? "null" : Array.isArray(args) ? "array" : typeof args}.`);
      return { ok: false, errors };
    }
  }

  if (typeof args === "string") {
    if (typeof schema["minLength"] === "number" && args.length < schema["minLength"]) {
      errors.push(`${path}: string length ${args.length} < minLength ${schema["minLength"]}.`);
    }
    if (typeof schema["maxLength"] === "number" && args.length > schema["maxLength"]) {
      errors.push(`${path}: string length ${args.length} > maxLength ${schema["maxLength"]}.`);
    }
  }

  if (typeof args === "number") {
    if (typeof schema["minimum"] === "number" && args < schema["minimum"]) {
      errors.push(`${path}: ${args} < minimum ${schema["minimum"]}.`);
    }
    if (typeof schema["maximum"] === "number" && args > schema["maximum"]) {
      errors.push(`${path}: ${args} > maximum ${schema["maximum"]}.`);
    }
  }

  if (Array.isArray(args)) {
    if (typeof schema["minItems"] === "number" && args.length < schema["minItems"]) {
      errors.push(`${path}: array length ${args.length} < minItems ${schema["minItems"]}.`);
    }
    if (typeof schema["maxItems"] === "number" && args.length > schema["maxItems"]) {
      errors.push(`${path}: array length ${args.length} > maxItems ${schema["maxItems"]}.`);
    }
    if (isPlainRecord(schema["items"])) {
      for (let i = 0; i < args.length; i += 1) {
        const sub = validateToolArguments(schema["items"], args[i], `${path}[${i}]`);
        errors.push(...sub.errors);
      }
    }
  }

  if (isPlainRecord(args) && isPlainRecord(schema["properties"])) {
    const props = schema["properties"];
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter((r): r is string => typeof r === "string")
      : [];
    for (const reqKey of required) {
      if (args[reqKey] === undefined) {
        errors.push(`${path}.${reqKey}: required parameter is missing.`);
      }
    }
    const rejectExtra = schema["additionalProperties"] === false;
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined) continue;
      if (!(k in props)) {
        if (rejectExtra) {
          errors.push(`${path}.${k}: unknown parameter is disallowed by strict schema.`);
        }
        continue;
      }
      const sub = validateToolArguments(props[k], v, `${path}.${k}`);
      errors.push(...sub.errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

// --- Deterministic JSON Schema -> GBNF Grammar Compiler -------------------

function sanitizeRuleName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}

function gbnfLiteral(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Compiles a JSON Schema object into a llama.cpp GBNF grammar string for constrained
 * token generation of valid nested JSON payloads.
 */
export function compileJsonSchemaToGbnf(schema: unknown, rootRule = "root"): string {
  const rules = new Map<string, string>();
  let seq = 0;

  rules.set(
    "ws",
    `[ \\t\\n\\r]*`,
  );
  rules.set(
    "json-string",
    `"\\"" ([^"\\\\\\x00-\\x1f] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4}))* "\\"" ws`,
  );
  rules.set(
    "json-number",
    `"-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)? ws`,
  );
  rules.set("json-integer", `"-"? ("0" | [1-9] [0-9]*) ws`);
  rules.set("json-boolean", `("true" | "false") ws`);
  rules.set("json-null", `"null" ws`);
  rules.set(
    "json-value",
    `json-string | json-number | json-boolean | json-null | json-object | json-array`,
  );
  rules.set(
    "json-array",
    `"[" ws (json-value ("," ws json-value)*)? "]" ws`,
  );
  rules.set(
    "json-object",
    `"{" ws (json-string ":" ws json-value ("," ws json-string ":" ws json-value)*)? "}" ws`,
  );

  const emitRule = (node: unknown, hint: string): string => {
    const clean = hardenJsonSchema(node);
    const id = `${sanitizeRuleName(hint)}-${(seq += 1)}`;

    if (Array.isArray(clean["enum"]) && clean["enum"].length > 0) {
      const alts = clean["enum"].map((v) => `${gbnfLiteral(JSON.stringify(v))} ws`);
      rules.set(id, alts.join(" | "));
      return id;
    }
    if ("const" in clean) {
      rules.set(id, `${gbnfLiteral(JSON.stringify(clean["const"]))} ws`);
      return id;
    }

    const union = Array.isArray(clean["oneOf"])
      ? clean["oneOf"]
      : Array.isArray(clean["anyOf"])
        ? clean["anyOf"]
        : null;
    if (union && union.length > 0) {
      const alts = union.map((branch, idx) => emitRule(branch, `${hint}-alt${idx}`));
      rules.set(id, alts.join(" | "));
      return id;
    }

    const typ = clean["type"];
    if (Array.isArray(typ) && typ.length > 0) {
      const alts: string[] = [];
      for (const t of typ) {
        if (t === "string") alts.push("json-string");
        else if (t === "integer") alts.push("json-integer");
        else if (t === "number") alts.push("json-number");
        else if (t === "boolean") alts.push("json-boolean");
        else if (t === "null") alts.push("json-null");
        else if (t === "array") alts.push("json-array");
        else if (t === "object") alts.push("json-object");
      }
      if (alts.length > 0) {
        rules.set(id, [...new Set(alts)].join(" | "));
        return id;
      }
    }
    if (typ === "string") return "json-string";
    if (typ === "integer") return "json-integer";
    if (typ === "number") return "json-number";
    if (typ === "boolean") return "json-boolean";
    if (typ === "null") return "json-null";
    if (typ === "array") {
      const itemRule = clean["items"] ? emitRule(clean["items"], `${hint}-item`) : "json-value";
      rules.set(id, `"[" ws (${itemRule} ("," ws ${itemRule})*)? "]" ws`);
      return id;
    }

    if (typ === "object" && isPlainRecord(clean["properties"])) {
      const entries = Object.entries(clean["properties"]);
      if (entries.length === 0) {
        rules.set(id, `"{" ws "}" ws`);
        return id;
      }
      const required = new Set(
        Array.isArray(clean["required"])
          ? clean["required"].filter((r): r is string => typeof r === "string")
          : entries.map(([k]) => k),
      );
      const kvRules: { key: string; req: boolean; ruleName: string }[] = [];
      for (const [propKey, propSchema] of entries) {
        const valRule = emitRule(propSchema, `${hint}-${propKey}`);
        const kvRuleName = `${id}-${sanitizeRuleName(propKey)}-kv`;
        rules.set(kvRuleName, `${gbnfLiteral(JSON.stringify(propKey))} ws ":" ws ${valRule}`);
        kvRules.push({ key: propKey, req: required.has(propKey), ruleName: kvRuleName });
      }
      const requiredParts = kvRules.filter((k) => k.req).map((k) => k.ruleName);
      const optionalParts = kvRules.filter((k) => !k.req).map((k) => k.ruleName);

      if (requiredParts.length === entries.length) {
        rules.set(id, `"{" ws ${requiredParts.join(' "," ws ')} "}" ws`);
      } else {
        const ordered = [...requiredParts, ...optionalParts];
        if (requiredParts.length === 0) {
          rules.set(id, `"{" ws (${ordered.join(' ("," ws ')})? ${ordered.length > 1 ? ")".repeat(ordered.length - 1) : ""} "}" ws`);
          // Simpler unambiguous comma-separated optional sequence:
          const altZeroOrAny = ordered
            .map((_, startIdx) =>
              ordered
                .slice(startIdx)
                .map((r, offset) => (offset === 0 ? r : `("," ws ${r})?`))
                .join(" "),
            )
            .join(" | ");
          rules.set(id, `"{" ws (${altZeroOrAny})? "}" ws`);
        } else {
          const reqSeq = requiredParts.join(' "," ws ');
          const optSeq = optionalParts.map((r) => `("," ws ${r})?`).join(" ");
          rules.set(id, `"{" ws ${reqSeq} ${optSeq} "}" ws`);
        }
      }
      return id;
    }

    return "json-object";
  };

  const entryRule = emitRule(schema, rootRule);
  const outLines: string[] = [`${rootRule} ::= ${entryRule}`];
  for (const [name, expr] of rules) {
    if (name !== rootRule) outLines.push(`${name} ::= ${expr}`);
  }
  return outLines.join("\n");
}

/** Compiles a multi-tool `{ tool, arguments }` call union GBNF grammar for constrained decoding. */
export function compileToolsToGbnf(functions: ChatSessionModelFunctions): string {
  const names = Object.keys(functions);
  if (names.length === 0) return `root ::= "null"`;
  const oneOf = names.map((name) => ({
    type: "object",
    additionalProperties: false,
    required: ["name", "arguments"],
    properties: {
      name: { const: name },
      arguments: hardenJsonSchema(functions[name]?.params ?? { type: "object", additionalProperties: false }),
    },
  }));
  return compileJsonSchemaToGbnf({ oneOf }, "root");
}

// --- Streaming Parameter Degeneration Guard -------------------------------

export interface StreamingParamGuardOptions {
  maxParamBytes?: number;
  maxBraceDepth?: number;
  maxRepeatedCharRun?: number;
}

/**
 * Watches `onFunctionCallParamsChunk` chunks from `node-llama-cpp` to abort runaway
 * nested JSON or token-repetition loops immediately mid-generation.
 */
export class StreamingJsonParamGuard {
  private readonly maxBytes: number;
  private readonly maxDepth: number;
  private readonly maxCharRun: number;
  private activeCallIndex = -1;
  private buffer = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  trippedReason: string | null = null;

  constructor(options: StreamingParamGuardOptions = {}) {
    this.maxBytes = Math.max(512, options.maxParamBytes ?? 16_384);
    this.maxDepth = Math.max(4, options.maxBraceDepth ?? 12);
    this.maxCharRun = Math.max(16, options.maxRepeatedCharRun ?? 48);
  }

  pushChunk(chunk: {
    callIndex: number;
    functionName: string;
    paramsChunk: string;
    done: boolean;
  }): { ok: true } | { ok: false; reason: string } {
    if (chunk.callIndex !== this.activeCallIndex) {
      this.activeCallIndex = chunk.callIndex;
      this.buffer = "";
      this.depth = 0;
      this.inString = false;
      this.escaped = false;
    }

    this.buffer += chunk.paramsChunk;
    if (this.buffer.length > this.maxBytes) {
      this.trippedReason = `Tool "${chunk.functionName}" parameter JSON exceeded ${this.maxBytes} bytes.`;
      return { ok: false, reason: this.trippedReason };
    }

    for (let i = 0; i < chunk.paramsChunk.length; i += 1) {
      const ch = chunk.paramsChunk[i] ?? "";
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === "{" || ch === "[") {
        this.depth += 1;
        if (this.depth > this.maxDepth) {
          this.trippedReason = `Tool "${chunk.functionName}" JSON nesting exceeded depth ${this.maxDepth}.`;
          return { ok: false, reason: this.trippedReason };
        }
      } else if (ch === "}" || ch === "]") {
        this.depth = Math.max(0, this.depth - 1);
      }
    }

    // Detect single-char degeneration (`aaaaaaaa...`) or short repeating tail (`",",","...`).
    const tail = this.buffer.slice(-this.maxCharRun);
    if (tail.length >= this.maxCharRun && /^(.)\1+$/.test(tail)) {
      this.trippedReason = `Detected degenerate character repetition in "${chunk.functionName}" parameters.`;
      return { ok: false, reason: this.trippedReason };
    }
    const patternTail = this.buffer.slice(-64);
    if (patternTail.length === 64 && /^(.{2,6})\1{7,}/.test(patternTail)) {
      this.trippedReason = `Detected repetitive token loop in "${chunk.functionName}" parameters.`;
      return { ok: false, reason: this.trippedReason };
    }

    return { ok: true };
  }
}

// --- Deterministic Per-Turn Tool Loop Guard -------------------------------

export interface ToolLoopGuardOptions {
  maxExactRepeats?: number;
  maxConsecutiveFailures?: number;
  maxSchemaFailures?: number;
  maxCallsPerTurn?: number;
}

export interface LoopCheckDecision {
  allowed: boolean;
  reason?: string;
}

interface RecordedCall {
  tool: string;
  key: string;
  ok: boolean;
  schemaInvalid: boolean;
}

/**
 * Deterministic loop-breaker inspecting every tool call attempt in a turn:
 * catches exact repeats, `A -> B -> A -> B` alternating ping-pong loops,
 * consecutive same-tool failures, and repeated malformed-argument loops.
 */
export class ToolLoopGuard {
  private readonly maxExactRepeats: number;
  private readonly maxConsecutiveFailures: number;
  private readonly maxSchemaFailures: number;
  private readonly maxCallsPerTurn: number;
  private readonly history: RecordedCall[] = [];
  private _schemaRejections = 0;
  private _loopBreaks = 0;
  private _lastBreakReason: string | null = null;

  constructor(options: ToolLoopGuardOptions = {}) {
    this.maxExactRepeats = Math.max(2, options.maxExactRepeats ?? 3);
    this.maxConsecutiveFailures = Math.max(2, options.maxConsecutiveFailures ?? 3);
    this.maxSchemaFailures = Math.max(1, options.maxSchemaFailures ?? 2);
    this.maxCallsPerTurn = Math.max(4, options.maxCallsPerTurn ?? 14);
  }

  private trip(reason: string): LoopCheckDecision {
    this._loopBreaks += 1;
    this._lastBreakReason = reason;
    return { allowed: false, reason };
  }

  checkBeforeCall(tool: string, args: unknown): LoopCheckDecision {
    if (this.history.length >= this.maxCallsPerTurn) {
      return this.trip(
        `Loop guard halted "${tool}": reached ${this.maxCallsPerTurn} tool calls in one turn.`,
      );
    }

    const sig = `${tool}\u0000${canonicalizeArgs(args)}`;
    const priorSame = this.history.filter((h) => h.key === sig);
    if (priorSame.length >= this.maxExactRepeats) {
      return this.trip(
        `Loop guard halted "${tool}": called with identical arguments ${priorSame.length} times already.`,
      );
    }

    // Fail-fast if the model failed twice with identical normalized arguments.
    const consecutiveSameFailed =
      this.history.length >= 2 &&
      this.history[this.history.length - 1]?.key === sig &&
      !this.history[this.history.length - 1]?.ok &&
      this.history[this.history.length - 2]?.key === sig &&
      !this.history[this.history.length - 2]?.ok;
    if (consecutiveSameFailed) {
      return this.trip(
        `Loop guard halted "${tool}": failed twice in a row with identical arguments.`,
      );
    }

    // Consecutive failure breaker for one tool (even with slightly tweaked args).
    let tailFailCount = 0;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const h = this.history[i];
      if (!h || h.tool !== tool || h.ok) break;
      tailFailCount += 1;
    }
    if (tailFailCount >= this.maxConsecutiveFailures) {
      return this.trip(
        `Loop guard halted "${tool}": failed ${tailFailCount} consecutive times without recovery.`,
      );
    }

    // Schema rejection breaker.
    const schemaFails = this.history.filter((h) => h.tool === tool && h.schemaInvalid).length;
    if (schemaFails >= this.maxSchemaFailures) {
      return this.trip(
        `Loop guard halted "${tool}": emitted ${schemaFails} schema-invalid argument payloads.`,
      );
    }

    // Alternating A -> B -> A -> B oscillation check (`B -> A -> B` in history, now attempting `A` again).
    if (this.history.length >= 3) {
      const prev1 = this.history[this.history.length - 1];
      const prev2 = this.history[this.history.length - 2];
      const prev3 = this.history[this.history.length - 3];
      if (prev1 && prev2 && prev3 && sig === prev2.key && prev1.key === prev3.key && prev1.key !== sig) {
        return this.trip(
          `Loop guard halted "${tool}": detected alternating cycle (${prev2.tool} <-> ${prev1.tool}).`,
        );
      }
    }

    return { allowed: true };
  }

  recordOutcome(tool: string, args: unknown, outcome: { ok: boolean; schemaInvalid?: boolean }): void {
    const schemaInvalid = outcome.schemaInvalid === true;
    if (schemaInvalid) this._schemaRejections += 1;
    this.history.push({
      tool,
      key: `${tool}\u0000${canonicalizeArgs(args)}`,
      ok: outcome.ok,
      schemaInvalid,
    });
  }

  stats(): {
    totalCalls: number;
    schemaRejections: number;
    loopBreaks: number;
    lastBreakReason: string | null;
  } {
    return {
      totalCalls: this.history.length,
      schemaRejections: this._schemaRejections,
      loopBreaks: this._loopBreaks,
      lastBreakReason: this._lastBreakReason,
    };
  }
}

/**
 * Wraps routed `ChatSessionModelFunctions` with:
 * - recursively hardened `additionalProperties: false` parameter schemas for GBNF decoding
 * - strict pre-execution schema validation (`validateToolArguments`)
 * - deterministic per-turn `ToolLoopGuard` circuit breakers
 */
export interface RejectedToolCallTrace {
  tool: string;
  input: string;
  result: string;
  gateReason: string;
}

export function hardenFunctionsForGrammar(
  functions: ChatSessionModelFunctions,
  loopGuard?: ToolLoopGuard,
  failedPattern?: RegExp,
  onRejected?: (entry: RejectedToolCallTrace) => void,
): ChatSessionModelFunctions {
  const out: Record<string, ChatSessionModelFunctions[string]> = {};
  for (const [toolName, fn] of Object.entries(functions)) {
    if (!fn) continue;
    const hardenedParams = fn.params ? hardenJsonSchema(fn.params) : undefined;
    out[toolName] = {
      ...(fn.description !== undefined ? { description: fn.description } : {}),
      ...(hardenedParams !== undefined
        ? { params: hardenedParams as ChatSessionModelFunctions[string]["params"] }
        : {}),
      handler: async (rawInput: unknown): Promise<string> => {
        if (hardenedParams) {
          const valid = validateToolArguments(hardenedParams, rawInput);
          if (!valid.ok) {
            loopGuard?.recordOutcome(toolName, rawInput, { ok: false, schemaInvalid: true });
            const msg = `Schema validation rejected arguments for "${toolName}": ${valid.errors.join("; ")}. Fix the JSON structure cleanly or answer without calling this tool again.`;
            onRejected?.({
              tool: toolName,
              input: JSON.stringify(rawInput) ?? "",
              result: msg,
              gateReason: "schema_validation",
            });
            return msg;
          }
        }
        if (loopGuard) {
          const check = loopGuard.checkBeforeCall(toolName, rawInput);
          if (!check.allowed) {
            const msg = `${check.reason ?? "Tool loop halted."} Stop retrying tools and answer directly from what you already know.`;
            onRejected?.({
              tool: toolName,
              input: JSON.stringify(rawInput) ?? "",
              result: msg,
              gateReason: check.reason ?? "loop_guard",
            });
            return msg;
          }
        }
        const res = String(await fn.handler(rawInput as never));
        const failed = failedPattern ? failedPattern.test(res) : res.startsWith("That failed:");
        loopGuard?.recordOutcome(toolName, rawInput, { ok: !failed });
        return res;
      },
    };
  }
  return out;
}
