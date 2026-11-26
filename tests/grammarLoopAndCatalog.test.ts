import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatSessionModelFunctions } from "node-llama-cpp";
import {
  compileJsonSchemaToGbnf,
  compileToolsToGbnf,
  hardenFunctionsForGrammar,
  StreamingJsonParamGuard,
  ToolLoopGuard,
  validateToolArguments,
} from "../src/core/grammarGuard.ts";
import {
  findCatalogEntry,
  getVettedPresets,
  resolvePresetChoice,
  ROLLING_MODEL_CATALOG,
  signRollingCatalog,
  verifyRollingCatalog,
} from "../src/core/models.ts";
import { ToolRouter } from "../src/core/toolRouter.ts";

describe("Pillar 3 & 4: Strict Grammar-Constrained Tool Decoding, Loop Guards, and Rolling Catalog", () => {
  it("hardens nested schemas, compiles GBNF grammars, and validates/rejects malformed arguments", async () => {
    const fns = {
      configure_alert: {
        description: "Configure a nested alert rule",
        params: {
          type: "object",
          required: ["name", "target"],
          properties: {
            name: { type: "string", minLength: 2 },
            severity: { enum: ["info", "warn", "critical"] },
            target: {
              type: "object",
              required: ["host", "port"],
              properties: {
                host: { type: "string" },
                port: { type: "integer", minimum: 1, maximum: 65535 },
              },
            },
          },
        },
        handler: async (args: unknown) => `ok:${JSON.stringify(args)}`,
      },
    } as unknown as ChatSessionModelFunctions;

    const router = new ToolRouter(null);
    const routed = await router.routeWithGrammar("configure alert", fns);
    expect(routed.route.offered).toContain("configure_alert");
    expect(routed.gbnfGrammar).toContain("root ::=");
    expect(routed.gbnfGrammar).toContain('\\"configure_alert\\"');

    const schemaGbnf = compileJsonSchemaToGbnf(routed.functions["configure_alert"]?.params);
    expect(schemaGbnf).toContain('\\"critical\\"');

    const loopGuard = new ToolLoopGuard({ maxExactRepeats: 2 });
    const hardened = hardenFunctionsForGrammar(fns, loopGuard);

    // Valid nested call succeeds
    const valid = await hardened["configure_alert"]?.handler({
      name: "disk-full",
      severity: "warn",
      target: { host: "nas.local", port: 9100 },
    } as never);
    expect(String(valid)).toContain("ok:");

    // Unexpected extra field rejected deterministically without executing handler
    const extraKey = await hardened["configure_alert"]?.handler({
      name: "disk-full",
      target: { host: "nas.local", port: 9100, admin: true },
    } as never);
    expect(String(extraKey)).toContain("Schema validation rejected");
    expect(loopGuard.stats().schemaRejections).toBe(1);

    // Float where integer required fails validation directly
    const badInt = validateToolArguments(routed.functions["configure_alert"]?.params, {
      name: "disk",
      target: { host: "nas", port: 80.5 },
    });
    expect(badInt.ok).toBe(false);
    expect(compileToolsToGbnf({})).toContain('"null"');
  });

  it("aborts runaway streaming JSON parameter degeneration and halts oscillating tool loops", () => {
    const streamGuard = new StreamingJsonParamGuard({ maxParamBytes: 512, maxBraceDepth: 4 });
    expect(streamGuard.pushChunk({ callIndex: 0, functionName: "t", paramsChunk: '{"a":{"b":1}}', done: true }).ok).toBe(true);
    expect(streamGuard.pushChunk({ callIndex: 1, functionName: "t", paramsChunk: "{{{{{", done: false }).ok).toBe(false);
    expect(streamGuard.pushChunk({ callIndex: 2, functionName: "t", paramsChunk: "x".repeat(52), done: false }).ok).toBe(false);

    const loop = new ToolLoopGuard({ maxExactRepeats: 3, maxConsecutiveFailures: 2 });
    // A -> B -> A -> B oscillation detected on second return to B
    loop.recordOutcome("read_file", { path: "a" }, { ok: true });
    loop.recordOutcome("find_files", { q: "b" }, { ok: true });
    loop.recordOutcome("read_file", { path: "a" }, { ok: true });
    const oscCheck = loop.checkBeforeCall("find_files", { q: "b" });
    expect(oscCheck.allowed).toBe(false);
    expect(oscCheck.reason).toContain("alternating cycle");
    expect(oscCheck.reason).not.toBe(""); // explicit diagnostic
  });

  it("provides vetted rolling model presets and Ed25519 signed catalog verification", () => {
    expect(ROLLING_MODEL_CATALOG.length).toBeGreaterThanOrEqual(6);
    const vetted = getVettedPresets();
    expect(vetted.map((v) => v.presetId)).toEqual(["qwen3.5-4b", "qwen3.5-9b", "qwen3.8-27b"]);

    const moe = findCatalogEntry("qwen3-30b-a3b-moe");
    expect(moe?.benchmarkStatus).toBe("pending_gpu");
    expect(moe?.model.architecture).toBe("moe");

    const fastMoe = findCatalogEntry("qwen3.5-35b-a3b-moe");
    expect(fastMoe?.model.fileName).toBe("Qwen3.5-35B-A3B-Q4_K_M.gguf");
    expect(fastMoe?.model.activeParamsB).toBe(3);

    const xlMoe = findCatalogEntry("qwen3.5-122b-a10b-moe");
    expect(xlMoe?.model.fileName).toBe("Qwen3.5-122B-A10B-UD-IQ3_S.gguf");
    expect(xlMoe?.model.activeParamsB).toBe(10);

    // Dead placeholder entries must not remain in the catalog
    expect(findCatalogEntry("qwen3.5-72b")).toBeNull();
    expect(findCatalogEntry("qwen3.5-120b-a16b-moe")).toBeNull();

    const resolvedPreset = resolvePresetChoice("qwen3.5-9b", "/models", null);
    expect(resolvedPreset.path.endsWith("Qwen3.5-9B-Q4_K_M.gguf")).toBe(true);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const unsigned = {
      catalogVersion: 1 as const,
      updatedAt: "2026-11-23T00:00:00Z",
      entries: [
        {
          presetId: "qwen3.5-9b",
          tier: "standard" as const,
          benchmarkStatus: "verified" as const,
          fileName: "Qwen3.5-9B-Q4_K_M.gguf",
          url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
          sizeBytes: 5_680_000_000,
          vramGb: 7,
          architecture: "dense" as const,
          overallScorePercent: 83.3,
        },
      ],
    };
    const signature = signRollingCatalog(unsigned, privateKey);
    expect(verifyRollingCatalog({ ...unsigned, signature }, [publicKey]).ok).toBe(true);
    expect(
      verifyRollingCatalog({ ...unsigned, updatedAt: "2099-01-01", signature }, [publicKey]).ok,
    ).toBe(false);
  });
});
