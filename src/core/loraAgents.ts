import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatSessionModelFunctions } from "node-llama-cpp";
import type { LocalEngine } from "./engine.ts";
import { TOOLS } from "./permissions.ts";

/** Specialist domains supported by hot-swappable LoRA adapters over a frozen base brain. */
export type SpecialistDomain =
  | "fleet-systems"
  | "research-synthesis"
  | "automation-code"
  | "logistics-scheduling";

export interface SpecialistSpec {
  domain: SpecialistDomain;
  label: string;
  adapterFile: string;
  allowedTools: readonly string[];
  maxSteps: number;
  instructions: string;
}

export interface SubAgentSummary {
  domain: SpecialistDomain;
  status: "ok" | "blocked" | "needs_input";
  summary: string;
  artifacts: string[];
  warnings: string[];
}

export const SPECIALIST_SPECS: Record<SpecialistDomain, SpecialistSpec> = {
  "fleet-systems": {
    domain: "fleet-systems",
    label: "Fleet & Systems",
    adapterFile: "fleet-systems.lora.gguf",
    allowedTools: [TOOLS.remote, TOOLS.runCommand, TOOLS.readFile, TOOLS.shipStatus],
    maxSteps: 6,
    instructions:
      'You are the Fleet & Systems specialist sub-agent. Focus strictly on POSIX/fish shell safety, systemd diagnostics, and configuration diffs. Never invent host output. End with a JSON object: {"status":"ok"|"blocked"|"needs_input","summary":string,"artifacts":string[],"warnings":string[]}.',
  },
  "research-synthesis": {
    domain: "research-synthesis",
    label: "Research & Synthesis",
    adapterFile: "research-synthesis.lora.gguf",
    allowedTools: [
      TOOLS.webSearch,
      TOOLS.readWebPage,
      TOOLS.recall,
      TOOLS.findFiles,
      TOOLS.readFile,
    ],
    maxSteps: 8,
    instructions:
      'You are the Research & Synthesis specialist sub-agent. Reconcile multiple sources, cite concrete facts, and list uncertainties explicitly. End with a JSON object: {"status":"ok"|"blocked"|"needs_input","summary":string,"artifacts":string[],"warnings":string[]}.',
  },
  "automation-code": {
    domain: "automation-code",
    label: "Automation & Code",
    adapterFile: "automation-code.lora.gguf",
    allowedTools: [
      TOOLS.readFile,
      TOOLS.writeFile,
      TOOLS.findFiles,
      TOOLS.calculate,
      TOOLS.runCommand,
    ],
    maxSteps: 6,
    instructions:
      'You are the Automation & Code specialist sub-agent. Produce deterministic scripts and structured extractions within least-privilege boundaries. End with a JSON object: {"status":"ok"|"blocked"|"needs_input","summary":string,"artifacts":string[],"warnings":string[]}.',
  },
  "logistics-scheduling": {
    domain: "logistics-scheduling",
    label: "Logistics & Scheduling",
    adapterFile: "logistics-scheduling.lora.gguf",
    allowedTools: [
      TOOLS.agenda,
      TOOLS.setReminder,
      TOOLS.reminders,
      TOOLS.planMission,
      TOOLS.missions,
      TOOLS.recall,
    ],
    maxSteps: 6,
    instructions:
      'You are the Logistics & Scheduling specialist sub-agent. Resolve calendar recurrences, conflicts, and multi-day mission steps accurately. End with a JSON object: {"status":"ok"|"blocked"|"needs_input","summary":string,"artifacts":string[],"warnings":string[]}.',
  },
};

/** Returns a filtered copy of `allTools` containing ONLY the domain's allowed least-privilege tools. */
export function scopeTools(
  domain: SpecialistDomain,
  allTools: ChatSessionModelFunctions,
): ChatSessionModelFunctions {
  const allowed = new Set(SPECIALIST_SPECS[domain].allowedTools);
  const scoped: Record<string, ChatSessionModelFunctions[string]> = {};
  for (const [name, fn] of Object.entries(allTools)) {
    if (allowed.has(name)) scoped[name] = fn;
  }
  return scoped;
}

function cleanStringList(raw: unknown, maxItems = 10, maxChars = 200): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Parses and validates a sub-agent's structured response so untrusted noise stays out of `persona.ts`. */
export function parseSubAgentSummary(raw: string, domain: SpecialistDomain): SubAgentSummary {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim();
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const statusRaw = parsed["status"];
      const status: SubAgentSummary["status"] =
        statusRaw === "blocked" || statusRaw === "needs_input" || statusRaw === "ok"
          ? statusRaw
          : "ok";
      const summary =
        typeof parsed["summary"] === "string" && parsed["summary"].trim()
          ? parsed["summary"].trim().slice(0, 800)
          : text.slice(0, 800);
      return {
        domain,
        status,
        summary,
        artifacts: cleanStringList(parsed["artifacts"]),
        warnings: cleanStringList(parsed["warnings"]),
      };
    } catch {
      // Fall through to plain-text summary wrapper
    }
  }
  return {
    domain,
    status: "ok",
    summary: (text || "(no response)").slice(0, 800),
    artifacts: [],
    warnings: [],
  };
}

/** Manages hot-swappable specialist LoRA adapters stored under `<modelsDir>/adapters/`. */
export class LoraAdapterRegistry {
  private readonly adaptersDir: string;

  constructor(modelsDir: string) {
    this.adaptersDir = join(modelsDir, "adapters");
  }

  adapterPath(domain: SpecialistDomain): string | null {
    const file = join(this.adaptersDir, SPECIALIST_SPECS[domain].adapterFile);
    return existsSync(file) ? file : null;
  }

  availableAdapters(): SpecialistDomain[] {
    return (Object.keys(SPECIALIST_SPECS) as SpecialistDomain[]).filter(
      (domain) => this.adapterPath(domain) !== null,
    );
  }

  /**
   * Executes a task inside an isolated `EngineWorker` context with domain-scoped tools
   * and optional specialist LoRA weights mounted in-place.
   */
  async runSubAgent(options: {
    domain: SpecialistDomain;
    task: string;
    allTools: ChatSessionModelFunctions;
    engine: Pick<LocalEngine, "openWorker">;
  }): Promise<SubAgentSummary | null> {
    const spec = SPECIALIST_SPECS[options.domain];
    const adapterPath = this.adapterPath(options.domain);
    const worker = await options.engine.openWorker(spec.instructions, {
      adapterPath,
      contextMax: 8192,
    });
    if (!worker) return null;

    const scoped = scopeTools(options.domain, options.allTools);
    try {
      const reply = await worker.session.prompt(options.task, {
        functions: scoped,
        signal: worker.signal,
        stopOnAbortSignal: true,
        maxTokens: 768,
        temperature: 0.3,
      });
      return parseSubAgentSummary(reply, options.domain);
    } finally {
      await worker.close();
    }
  }
}
