import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSessionModelFunctions } from "node-llama-cpp";
import { describe, expect, it, vi } from "vitest";
import type { EngineWorker } from "../src/core/engine.ts";
import {
  LoraAdapterRegistry,
  parseSubAgentSummary,
  scopeTools,
  SPECIALIST_SPECS,
} from "../src/core/loraAgents.ts";
import { TOOLS } from "../src/core/permissions.ts";

describe("Hot-swappable specialist LoRA sub-agents", () => {
  it("enforces strict least-privilege tool scoping per specialist domain", () => {
    const fakeFn = {} as ChatSessionModelFunctions[string];
    const allTools: ChatSessionModelFunctions = {
      [TOOLS.remote]: fakeFn,
      [TOOLS.runCommand]: fakeFn,
      [TOOLS.readFile]: fakeFn,
      [TOOLS.shipStatus]: fakeFn,
      [TOOLS.operate]: fakeFn,
      [TOOLS.clipboard]: fakeFn,
      [TOOLS.agenda]: fakeFn,
    };

    const fleetScoped = scopeTools("fleet-systems", allTools);
    expect(Object.keys(fleetScoped)).toEqual([
      TOOLS.remote,
      TOOLS.runCommand,
      TOOLS.readFile,
      TOOLS.shipStatus,
    ]);
    expect(fleetScoped[TOOLS.operate]).toBeUndefined();
    expect(fleetScoped[TOOLS.agenda]).toBeUndefined();
  });

  it("sanitizes structured JSON and plain-text outputs via parseSubAgentSummary", () => {
    const fenced = parseSubAgentSummary(
      'Here is the output:\n```json\n{"status":"needs_input","summary":"  Need SSH passphrase  ","artifacts":["/tmp/diff.patch"],"warnings":["dry-run only"],"extraEvil":"ignored"}\n```',
      "fleet-systems",
    );
    expect(fenced).toEqual({
      domain: "fleet-systems",
      status: "needs_input",
      summary: "Need SSH passphrase",
      artifacts: ["/tmp/diff.patch"],
      warnings: ["dry-run only"],
    });

    const plain = parseSubAgentSummary("All 3 tests passed cleanly.", "automation-code");
    expect(plain.status).toBe("ok");
    expect(plain.summary).toBe("All 3 tests passed cleanly.");
  });

  it("resolves on-disk LoRA weights, mounts them in openWorker, and closes worker reliably", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aichan-lora-"));
    try {
      const adaptersDir = join(dir, "adapters");
      await mkdir(adaptersDir, { recursive: true });
      const fleetLora = join(adaptersDir, SPECIALIST_SPECS["fleet-systems"].adapterFile);
      await writeFile(fleetLora, "dummy-lora");

      const registry = new LoraAdapterRegistry(dir);
      expect(registry.availableAdapters()).toEqual(["fleet-systems"]);
      expect(registry.adapterPath("research-synthesis")).toBeNull();

      const close = vi.fn(async () => undefined);
      const prompt = vi.fn(
        async () =>
          '{"status":"ok","summary":"Service nginx healthy","artifacts":[],"warnings":[]}',
      );
      const openWorker = vi.fn(async (): Promise<EngineWorker | null> => ({
        session: { prompt } as unknown as EngineWorker["session"],
        signal: new AbortController().signal,
        close,
      }));

      const fakeFn = {} as ChatSessionModelFunctions[string];
      const summary = await registry.runSubAgent({
        domain: "fleet-systems",
        task: "Check nginx health on proxmox",
        allTools: { [TOOLS.remote]: fakeFn, [TOOLS.operate]: fakeFn },
        engine: { openWorker: openWorker as never },
      });

      expect(openWorker).toHaveBeenCalledWith(
        expect.stringContaining("Fleet & Systems"),
        expect.objectContaining({ adapterPath: fleetLora, contextMax: 8192 }),
      );
      expect(prompt).toHaveBeenCalledWith(
        "Check nginx health on proxmox",
        expect.objectContaining({ functions: { [TOOLS.remote]: fakeFn } }),
      );
      expect(close).toHaveBeenCalledTimes(1);
      expect(summary).toEqual({
        domain: "fleet-systems",
        status: "ok",
        summary: "Service nginx healthy",
        artifacts: [],
        warnings: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
