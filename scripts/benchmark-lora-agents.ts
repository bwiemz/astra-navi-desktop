/**
 * Benchmarks hot-swappable specialist LoRA adapters over a single frozen Qwen3.5-4B base model.
 *
 *   node scripts/benchmark-lora-agents.ts --adapters-dir /tmp/astra-lora-exp/adapters
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLlama, LlamaChatSession, QwenChatWrapper, type ChatSessionModelFunctions } from "node-llama-cpp";
import {
  estimateSpecialistPromptTokens,
  LoraAdapterRegistry,
  parseSubAgentSummary,
  scopeTools,
  SPECIALIST_SPECS,
  type SpecialistDomain,
} from "../src/core/loraAgents.ts";
import { BRAIN_MODELS } from "../src/core/models.ts";
import { modelsDir } from "../src/core/paths.ts";

interface DomainCase {
  domain: SpecialistDomain;
  task: string;
  expectedTool: string;
  mockResult: string;
}

const DOMAIN_CASES: readonly DomainCase[] = [
  {
    domain: "fleet-systems",
    task: "Check disk space and uptime on machine nas over SSH.",
    expectedTool: "remote",
    mockResult: "up 14 days; /dev/nvme0n1p2 48% used (412G free)",
  },
  {
    domain: "fleet-systems",
    task: "Inspect failed systemd user services on this Linux workstation.",
    expectedTool: "run_command",
    mockResult: "0 loaded units listed (all user services healthy).",
  },
  {
    domain: "logistics-scheduling",
    task: "Check what events are on the agenda today and set a reminder for 4pm.",
    expectedTool: "agenda",
    mockResult: "14:00 Design sync (60m); no conflicts.",
  },
  {
    domain: "logistics-scheduling",
    task: "List currently active multi-day missions.",
    expectedTool: "missions",
    mockResult: "No active multi-day missions right now.",
  },
];

function makeMockTools(): ChatSessionModelFunctions {
  return {};
}

function buildCallableMockTools(called: string[], mockResultFor: (name: string) => string): ChatSessionModelFunctions {
  const names = [
    "remote",
    "run_command",
    "read_file",
    "ship_status",
    "agenda",
    "set_reminder",
    "reminders",
    "plan_mission",
    "missions",
    "recall",
  ];
  const out: Record<string, ChatSessionModelFunctions[string]> = {};
  for (const name of names) {
    out[name] = {
      description: `Invoke ${name} for the current task.`,
      params: {
        type: "object",
        properties: {
          query: { type: "string" },
          command: { type: "string" },
          machine: { type: "string" },
        },
      } as never,
      handler: async () => {
        called.push(name);
        return mockResultFor(name);
      },
    };
  }
  return out;
}
void makeMockTools;

const adaptersArgIdx = process.argv.indexOf("--adapters-dir");
const adaptersArg = adaptersArgIdx !== -1 ? process.argv[adaptersArgIdx + 1] : undefined;
const adaptersRoot = adaptersArg ? adaptersArg : modelsDir();
const baseGguf = join(modelsDir(), BRAIN_MODELS.small.fileName);

if (!existsSync(baseGguf)) {
  console.error(`Small GGUF model missing at ${baseGguf}.`);
  process.exit(1);
}

const llama = await getLlama();
const tLoad = performance.now();
const model = await llama.loadModel({ modelPath: baseGguf });
const loadMs = Math.round(performance.now() - tLoad);
const registry = new LoraAdapterRegistry(adaptersRoot);

async function runMode(useAdapter: boolean): Promise<{
  passed: number;
  total: number;
  avgSwapMs: number;
  details: { domain: SpecialistDomain; expectedTool: string; called: string[]; ok: boolean; swapMs: number; status: string }[];
}> {
  const details: { domain: SpecialistDomain; expectedTool: string; called: string[]; ok: boolean; swapMs: number; status: string }[] = [];
  for (const item of DOMAIN_CASES) {
    const adapterPath = useAdapter ? registry.adapterPath(item.domain) : null;
    const spec = SPECIALIST_SPECS[item.domain];
    const tCtx = performance.now();
    const context = await model.createContext({
      contextSize: 4096,
      ...(adapterPath ? { lora: { adapters: [{ filePath: adapterPath }] } } : {}),
    });
    const swapMs = Math.round(performance.now() - tCtx);
    const called: string[] = [];
    const scoped = scopeTools(
      item.domain,
      buildCallableMockTools(called, () => item.mockResult),
    );
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: spec.instructions,
        chatWrapper: new QwenChatWrapper({ variation: "3.5", thoughts: "discourage" }),
      });
      const reply = await session.prompt(item.task, {
        functions: scoped,
        maxTokens: 256,
        temperature: 0.2,
        budgets: { thoughtTokens: 0 },
      });
      const summary = parseSubAgentSummary(reply, item.domain);
      const ok = called.includes(item.expectedTool);
      details.push({
        domain: item.domain,
        expectedTool: item.expectedTool,
        called,
        ok,
        swapMs,
        status: summary.status,
      });
    } finally {
      await context.dispose();
    }
  }
  const avgSwapMs = Math.round(details.reduce((s, d) => s + d.swapMs, 0) / details.length);
  return {
    passed: details.filter((d) => d.ok).length,
    total: details.length,
    avgSwapMs,
    details,
  };
}

try {
  const baseRes = await runMode(false);
  const loraRes = await runMode(true);
  console.log(
    JSON.stringify(
      {
        baseModel: BRAIN_MODELS.small.fileName,
        baseLoadMs: loadMs,
        availableAdapters: registry.availableAdapters(),
        promptTokenSavings: {
          "fleet-systems": estimateSpecialistPromptTokens("fleet-systems"),
          "logistics-scheduling": estimateSpecialistPromptTokens("logistics-scheduling"),
        },
        frozenBase4B: baseRes,
        hotSwappedDomainAdapters: loraRes,
      },
      null,
      2,
    ),
  );
} finally {
  await model.dispose();
}
