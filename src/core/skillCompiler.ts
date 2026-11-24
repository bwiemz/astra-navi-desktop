import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Embedder } from "./embedder.ts";
import { toolVerdict, type PolicyContext, type Verdict } from "./permissions.ts";
import { withoutSecrets } from "./secrets.ts";
import { hasUnseen } from "./unseen.ts";

/**
 * Compiled Reusable Skill Synthesis (Tier 10 §5.2).
 *
 * Distills recurring verified multi-step workflows into parameterized, capability-bounded
 * local skill definitions requiring explicit user ratification before router activation
 * and automatic drift demotion when post-conditions diverge.
 */

export const SkillParamSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().min(1).max(200),
  required: z.boolean(),
  pattern: z.string().max(200).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type SkillParam = z.infer<typeof SkillParamSchema>;

export const SkillStepSchema = z.object({
  tool: z.string().min(1).max(80),
  argsTemplate: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  expectedOutputPattern: z.string().max(240).optional(),
  capability: z.string().min(1).max(80),
});
export type SkillStep = z.infer<typeof SkillStepSchema>;

export const CompiledSkillStatusSchema = z.enum([
  "proposed",
  "active",
  "needs_recalibration",
  "revoked",
]);
export type CompiledSkillStatus = z.infer<typeof CompiledSkillStatusSchema>;

export const CompiledSkillSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  description: z.string().min(1).max(400),
  params: z.array(SkillParamSchema).max(24),
  steps: z.array(SkillStepSchema).min(1).max(30),
  requiredCapabilities: z.array(z.string().min(1).max(80)).max(30),
  status: CompiledSkillStatusSchema,
  verifiedRuns: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  ratifiedAt: z.string().nullable(),
  driftReason: z.string().nullable(),
  sayings: z.array(z.string().min(1).max(200)).max(16),
  embedding: z.array(z.number()).optional(),
});
export type CompiledSkill = z.infer<typeof CompiledSkillSchema>;

const StoreFileSchema = z.object({
  version: z.literal(1),
  skills: z.array(CompiledSkillSchema),
});

export interface ObservedStep {
  tool: string;
  args: Record<string, string | number | boolean>;
  ok: boolean;
  grantedCapabilities: readonly string[];
  outputSample?: string;
}

export interface ObservedTrajectory {
  taskKey: string;
  title: string;
  steps: readonly ObservedStep[];
  at: string;
}

export type SynthesisOutcome =
  | { ok: true; skill: CompiledSkill }
  | { ok: false; reason: string };

export interface RenderedSkillStep {
  index: number;
  tool: string;
  args: Record<string, string | number | boolean>;
  capability: string;
  expectedOutputPattern?: string;
}

export interface StepPermissionCheck {
  stepIndex: number;
  tool: string;
  capability: string;
  verdict: Verdict | null;
  error?: string;
}

export interface SkillPermissionReport {
  steps: RenderedSkillStep[];
  verdicts: StepPermissionCheck[];
  requiresApproval: boolean;
  blocked: boolean;
}

export interface RouterSkillDescriptor {
  toolName: string;
  skillId: string;
  name: string;
  description: string;
  sayings: string[];
  embeddings?: Float32Array[];
}

function toSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "compiled-skill";
}

function containsSecret(text: string): boolean {
  return withoutSecrets(text) !== text;
}

function valueType(value: string | number | boolean): "string" | "number" | "boolean" {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function validateSafeLiteral(label: string, value: string | number | boolean): string | null {
  if (typeof value !== "string") return null;
  if (hasUnseen(value)) return `${label} contains hidden or control characters.`;
  if (containsSecret(value)) return `${label} contains secret-like credentials.`;
  return null;
}

/**
 * Compiles verified recurring trajectories into a `proposed` parameterized `CompiledSkill`.
 * Rejects secrets, invisible characters, mismatched step sequences, or capability escalation
 * beyond the intersection of capabilities granted across training runs.
 */
export function synthesizeSkillFromTrajectories(
  trajectories: readonly ObservedTrajectory[],
  options: { minRuns?: number; stepCapabilities?: readonly string[]; now?: () => Date } = {},
): SynthesisOutcome {
  const minRuns = Math.max(2, options.minRuns ?? 3);
  if (trajectories.length < minRuns) {
    return {
      ok: false,
      reason: `Need at least ${minRuns} verified runs to synthesize a skill (got ${trajectories.length}).`,
    };
  }
  const first = trajectories[0];
  if (!first || first.steps.length === 0) {
    return { ok: false, reason: "Trajectories must contain at least one tool step." };
  }
  const titleError =
    validateSafeLiteral("Task key", first.taskKey) ?? validateSafeLiteral("Title", first.title);
  if (titleError) return { ok: false, reason: titleError };

  const stepCount = first.steps.length;
  const expectedTools = first.steps.map((s) => s.tool);

  for (let runIdx = 0; runIdx < trajectories.length; runIdx += 1) {
    const traj = trajectories[runIdx];
    if (!traj) continue;
    const runTextErr =
      validateSafeLiteral("Task key", traj.taskKey) ?? validateSafeLiteral("Title", traj.title);
    if (runTextErr) return { ok: false, reason: runTextErr };
    if (traj.steps.length !== stepCount) {
      return { ok: false, reason: "Trajectories do not share an identical step count." };
    }
    for (let stepIdx = 0; stepIdx < stepCount; stepIdx += 1) {
      const step = traj.steps[stepIdx];
      if (!step) {
        return { ok: false, reason: `Missing step ${stepIdx} in trajectory ${runIdx}.` };
      }
      if (!step.ok) {
        return {
          ok: false,
          reason: `Trajectory step ${stepIdx + 1} (${step.tool}) was not successful.`,
        };
      }
      if (step.tool !== expectedTools[stepIdx]) {
        return {
          ok: false,
          reason: `Tool sequence mismatch at step ${stepIdx + 1}: expected ${expectedTools[stepIdx]}, saw ${step.tool}.`,
        };
      }
      for (const [k, v] of Object.entries(step.args)) {
        if (typeof v === "string" && hasUnseen(v)) {
          return {
            ok: false,
            reason: `Argument "${k}" on step ${stepIdx + 1} contains hidden characters.`,
          };
        }
      }
    }
  }

  const params: SkillParam[] = [];
  const usedParamNames = new Set<string>();
  const compiledSteps: SkillStep[] = [];
  const capabilitySet = new Set<string>();

  const nextParamName = (baseKey: string): string => {
    const cleanBase = baseKey.replace(/[^a-zA-Z0-9_]/g, "_") || "param";
    const safeStart = /^[a-zA-Z_]/.test(cleanBase) ? cleanBase : `p_${cleanBase}`;
    if (!usedParamNames.has(safeStart)) {
      usedParamNames.add(safeStart);
      return safeStart;
    }
    let counter = 2;
    while (usedParamNames.has(`${safeStart}_${counter}`)) counter += 1;
    const candidate = `${safeStart}_${counter}`;
    usedParamNames.add(candidate);
    return candidate;
  };

  for (let stepIdx = 0; stepIdx < stepCount; stepIdx += 1) {
    const stepsAtIndex = trajectories.map((traj) => traj.steps[stepIdx] as ObservedStep);
    const firstStep = stepsAtIndex[0];
    if (!firstStep) {
      return { ok: false, reason: `Missing step ${stepIdx + 1}.` };
    }
    // Intersection of grantedCapabilities across every training run for this step.
    const capIntersection = [...firstStep.grantedCapabilities].filter((cap) =>
      stepsAtIndex.every((s) => s.grantedCapabilities.includes(cap)),
    );
    if (capIntersection.length === 0) {
      return {
        ok: false,
        reason: `Step ${stepIdx + 1} (${firstStep.tool}) has no common granted capability across runs.`,
      };
    }
    const requestedCap = options.stepCapabilities?.[stepIdx];
    const chosenCap = requestedCap ?? capIntersection[0];
    if (!chosenCap || !capIntersection.includes(chosenCap)) {
      return {
        ok: false,
        reason: `Capability "${chosenCap ?? "unknown"}" exceeds the permissions granted across training runs.`,
      };
    }
    capabilitySet.add(chosenCap);

    const allArgKeys = [
      ...new Set(stepsAtIndex.flatMap((s) => Object.keys(s.args))),
    ].sort((a, b) => a.localeCompare(b));
    for (const step of stepsAtIndex) {
      if (Object.keys(step.args).length !== allArgKeys.length) {
        return {
          ok: false,
          reason: `Step ${stepIdx + 1} argument keys differ across runs.`,
        };
      }
    }

    const argsTemplate: Record<string, string | number | boolean> = {};
    for (const key of allArgKeys) {
      const values = stepsAtIndex.map((s) => s.args[key] as string | number | boolean);
      const firstVal = values[0] as string | number | boolean;
      const allIdentical = values.every((v) => v === firstVal);
      if (allIdentical) {
        const literalErr = validateSafeLiteral(`Step ${stepIdx + 1} arg "${key}"`, firstVal);
        if (literalErr) return { ok: false, reason: literalErr };
        argsTemplate[key] = firstVal;
      } else {
        const firstType = valueType(firstVal);
        const uniformType = values.every((v) => valueType(v) === firstType) ? firstType : "string";
        const paramName = nextParamName(key);
        params.push({
          name: paramName,
          type: uniformType,
          description: `Parameter "${key}" for ${firstStep.tool} (step ${stepIdx + 1})`,
          required: true,
        });
        argsTemplate[key] = `{{${paramName}}}`;
      }
    }

    compiledSteps.push({
      tool: firstStep.tool,
      argsTemplate,
      capability: chosenCap,
    });
  }

  const slug = toSlug(first.taskKey || first.title);
  const hash8 = createHash("sha256")
    .update(`${slug}:${expectedTools.join(">")}:${params.map((p) => p.name).join(",")}`)
    .digest("hex")
    .slice(0, 8);
  const nowIso = (options.now?.() ?? new Date()).toISOString();
  const sayings = [...new Set(trajectories.map((t) => t.title.trim()).filter(Boolean))].slice(0, 8);

  return {
    ok: true,
    skill: {
      id: `sk-${slug.slice(0, 32)}-${hash8}`,
      name: first.title.trim().slice(0, 120),
      slug,
      description: `Compiled workflow for ${first.title.trim()} (${compiledSteps.length} steps).`,
      params,
      steps: compiledSteps,
      requiredCapabilities: [...capabilitySet].sort((a, b) => a.localeCompare(b)),
      status: "proposed",
      verifiedRuns: trajectories.length,
      createdAt: nowIso,
      updatedAt: nowIso,
      ratifiedAt: null,
      driftReason: null,
      sayings: sayings.length > 0 ? sayings : [first.title.trim()],
    },
  };
}

/** Validates and renders concrete tool steps from a `CompiledSkill` and runtime parameters. */
export function renderSkillSteps(
  skill: CompiledSkill,
  inputParams: Readonly<Record<string, string | number | boolean>>,
): RenderedSkillStep[] {
  const bound = new Map<string, string | number | boolean>();
  for (const param of skill.params) {
    const raw = inputParams[param.name] ?? param.defaultValue;
    if (raw === undefined) {
      if (param.required) {
        throw new Error(`Compiled skill "${skill.slug}" missing required parameter "${param.name}".`);
      }
      continue;
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      throw new Error(`Parameter "${param.name}" must be a finite number.`);
    }
    if (valueType(raw) !== param.type) {
      throw new Error(
        `Parameter "${param.name}" expected ${param.type}, received ${typeof raw}.`,
      );
    }
    if (typeof raw === "string") {
      if (hasUnseen(raw)) {
        throw new Error(`Parameter "${param.name}" contains forbidden invisible characters.`);
      }
      if (param.pattern && !new RegExp(param.pattern).test(raw)) {
        throw new Error(`Parameter "${param.name}" failed format validation.`);
      }
    }
    bound.set(param.name, raw);
  }

  return skill.steps.map((step, index) => {
    const resolvedArgs: Record<string, string | number | boolean> = {};
    for (const [key, tpl] of Object.entries(step.argsTemplate)) {
      if (typeof tpl !== "string") {
        resolvedArgs[key] = tpl;
        continue;
      }
      const exactMatch = /^\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/.exec(tpl);
      if (exactMatch?.[1]) {
        const val = bound.get(exactMatch[1]);
        if (val === undefined) {
          throw new Error(`Unbound parameter "${exactMatch[1]}" on step ${index + 1}.`);
        }
        resolvedArgs[key] = val;
        continue;
      }
      resolvedArgs[key] = tpl.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_m, name: string) => {
        const val = bound.get(name);
        if (val === undefined) {
          throw new Error(`Unbound parameter "${name}" on step ${index + 1}.`);
        }
        return String(val);
      });
    }
    return {
      index,
      tool: step.tool,
      args: resolvedArgs,
      capability: step.capability,
      ...(step.expectedOutputPattern ? { expectedOutputPattern: step.expectedOutputPattern } : {}),
    };
  });
}

export class CompiledSkillStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private skills: CompiledSkill[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: { now?: () => Date } = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      const parsed = StoreFileSchema.safeParse(raw);
      if (parsed.success) {
        this.skills = parsed.data.skills;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[skillCompiler] could not load compiled skills:", error);
      }
    }
  }

  list(): readonly CompiledSkill[] {
    return this.skills.map((s) => structuredClone(s));
  }

  get(id: string): CompiledSkill | undefined {
    const found = this.skills.find((s) => s.id === id);
    return found ? structuredClone(found) : undefined;
  }

  async propose(skill: CompiledSkill): Promise<CompiledSkill> {
    const parsed = CompiledSkillSchema.parse(skill);
    if (parsed.status !== "proposed" || parsed.ratifiedAt !== null) {
      throw new Error("Newly proposed skills must start unratified in state 'proposed'.");
    }
    if (this.skills.some((s) => s.slug === parsed.slug || s.id === parsed.id)) {
      throw new Error(`Skill "${parsed.slug}" already exists.`);
    }
    for (const step of parsed.steps) {
      if (!parsed.requiredCapabilities.includes(step.capability)) {
        throw new Error(`Skill "${parsed.slug}" declares undeclared capability "${step.capability}".`);
      }
    }
    const stored = structuredClone(parsed);
    this.skills.push(stored);
    await this.persist();
    return structuredClone(stored);
  }

  /** Transitions a `proposed` skill to `active` upon explicit user ratification. */
  async ratify(id: string): Promise<CompiledSkill> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`Unknown compiled skill "${id}".`);
    if (skill.status !== "proposed") {
      throw new Error(`Skill "${skill.slug}" must be in 'proposed' state to ratify (currently '${skill.status}').`);
    }
    const nowIso = this.now().toISOString();
    skill.status = "active";
    skill.ratifiedAt = nowIso;
    skill.updatedAt = nowIso;
    skill.driftReason = null;
    await this.persist();
    return structuredClone(skill);
  }

  /** Revokes a compiled skill so it cannot be executed until rebuilt. */
  async revoke(id: string): Promise<CompiledSkill> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`Unknown compiled skill "${id}".`);
    const nowIso = this.now().toISOString();
    skill.status = "revoked";
    skill.updatedAt = nowIso;
    skill.driftReason = "Revoked via Mission Control.";
    await this.persist();
    return structuredClone(skill);
  }

  /**
   * Records a skill execution outcome; automatically demotes active skills to
   * `needs_recalibration` if post-condition checks diverge.
   */
  async recordExecution(
    id: string,
    outcome: { ok: boolean; postConditionMet: boolean; reason?: string },
  ): Promise<CompiledSkill> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`Unknown compiled skill "${id}".`);
    const nowIso = this.now().toISOString();
    skill.updatedAt = nowIso;
    if (outcome.ok && outcome.postConditionMet) {
      skill.verifiedRuns += 1;
    } else {
      skill.status = "needs_recalibration";
      skill.driftReason = outcome.reason?.trim() || "Observed post-condition divergence.";
    }
    await this.persist();
    return structuredClone(skill);
  }

  /**
   * Updates steps for a drifted skill while enforcing the capability ceiling and returning it to
   * `proposed` (requiring fresh user ratification).
   */
  async recalibrate(
    id: string,
    steps: readonly SkillStep[],
    grantedCapabilities: readonly string[],
  ): Promise<CompiledSkill> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`Unknown compiled skill "${id}".`);
    const validatedSteps = z.array(SkillStepSchema).min(1).max(30).parse(steps);
    for (const [idx, step] of validatedSteps.entries()) {
      if (!grantedCapabilities.includes(step.capability)) {
        throw new Error(
          `Recalibrated step ${idx + 1} capability "${step.capability}" exceeds granted capabilities.`,
        );
      }
      for (const [k, v] of Object.entries(step.argsTemplate)) {
        const err = validateSafeLiteral(`Recalibrated step ${idx + 1} arg "${k}"`, v);
        if (err) throw new Error(err);
      }
    }
    const nowIso = this.now().toISOString();
    skill.steps = validatedSteps;
    skill.requiredCapabilities = [...new Set(validatedSteps.map((s) => s.capability))].sort((a, b) =>
      a.localeCompare(b),
    );
    skill.status = "proposed";
    skill.ratifiedAt = null;
    skill.driftReason = null;
    skill.updatedAt = nowIso;
    await this.persist();
    return structuredClone(skill);
  }

  /**
   * Resolves concrete parameters and evaluates every step through `permissions.ts` (`toolVerdict`)
   * before execution; compiled skills never bypass permission rules.
   */
  async verifyPermissions(
    id: string,
    inputParams: Readonly<Record<string, string | number | boolean>>,
    context: PolicyContext,
  ): Promise<SkillPermissionReport> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`Unknown compiled skill "${id}".`);
    if (skill.status !== "active") {
      throw new Error(
        `Compiled skill "${skill.slug}" is '${skill.status}' and cannot run until active.`,
      );
    }
    const steps = renderSkillSteps(skill, inputParams);
    const verdicts: StepPermissionCheck[] = [];
    for (const step of steps) {
      try {
        const verdict = await toolVerdict(step.tool, step.args, context);
        verdicts.push({
          stepIndex: step.index,
          tool: step.tool,
          capability: step.capability,
          verdict,
        });
      } catch (error) {
        verdicts.push({
          stepIndex: step.index,
          tool: step.tool,
          capability: step.capability,
          verdict: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      steps,
      verdicts,
      requiresApproval: verdicts.some((item) => item.verdict?.decision === "ask"),
      blocked: verdicts.some((item) => item.error !== undefined),
    };
  }

  /** Exports active ratified skills as vector-ready descriptors for `ToolRouter`. */
  async toRouterDescriptors(embedder?: Embedder | null): Promise<RouterSkillDescriptor[]> {
    const active = this.skills.filter((s) => s.status === "active");
    const descriptors: RouterSkillDescriptor[] = [];
    for (const skill of active) {
      const item: RouterSkillDescriptor = {
        toolName: `skill:${skill.slug}`,
        skillId: skill.id,
        name: skill.name,
        description: skill.description,
        sayings: [...skill.sayings],
      };
      if (embedder && skill.sayings.length > 0) {
        item.embeddings = await embedder.embed(skill.sayings, "passage");
      }
      descriptors.push(item);
    }
    return descriptors;
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify({ version: 1, skills: this.skills }, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.filePath}.tmp`;
        await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, this.filePath);
      })
      .catch((error: unknown) => {
        console.warn("[skillCompiler] failed to save skills:", error);
      });
    return this.writeChain;
  }
}
