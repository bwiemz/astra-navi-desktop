import { connectionProblem, type Fleet, type Machine } from "./fleet.ts";
import {
  unseenInCommand,
  type MissionStep,
  type StepResult,
  type StepVerdict,
} from "./missionPlan.ts";
import { changesSomething, TOOLS, toolVerdict, type PolicyContext } from "./permissions.ts";
import { runCommand } from "./shell.ts";

/**
 * How a mission's step is judged and run: by the very rules that hold when she asks
 * for the same command in conversation. A step on this PC is a `run_command`; a step
 * on one of the user's machines is a `remote` run. What those rules would ask the user
 * about, the mission asks about; what they refuse, it does not do.
 */

/** A step on this PC may run for this long. */
const LOCAL_LIMIT_MS = 6 * 60 * 60_000;
/** A step on another machine may run for this long: the same as a command there in conversation. */
const REMOTE_LIMIT_MS = 10 * 60_000;

/** The tool call a step amounts to. */
function asCall(step: MissionStep): { tool: string; input: Record<string, unknown> } {
  return step.where === "here"
    ? { tool: TOOLS.runCommand, input: { command: step.command, why: step.title } }
    : {
        tool: TOOLS.remote,
        input: { action: "run", machine: step.whereName, command: step.command, why: step.title },
      };
}

/**
 * What the rules say about a step, now. Nothing is run. `context` is the same kind of
 * thing a reply is judged in, as it stands at this moment; a mission counts as having
 * read outside text (its earlier steps printed whatever they printed), which only ever
 * makes the rules ask more.
 */
export async function judgeStep(step: MissionStep, context: PolicyContext): Promise<StepVerdict> {
  const { tool, input } = asCall(step);
  // A plan refuses these when it is made; one read back from a file is held to the same.
  if (unseenInCommand(step.command)) {
    return { decision: "refuse", reason: "Its command holds characters that cannot be seen." };
  }
  let judged = context;
  if (step.where !== "here") {
    // By id, and only while it is still the machine the plan named.
    const machine = context.machines?.().find((entry) => entry.id === step.where);
    if (!machine) return { decision: "refuse", reason: "That machine is no longer on the list." };
    if (machine.name !== step.whereName) {
      return {
        decision: "refuse",
        reason: `The machine the plan called "${step.whereName}" is now called "${machine.name}". Plan the mission again.`,
      };
    }
    // The rules look a machine up by its name, and two machines can share one. The
    // step runs on the machine with this id, so that is the one the rules are shown.
    if (context.findMachine) judged = { ...context, findMachine: () => machine };
  }
  if (context.handsOff && changesSomething(tool, input)) {
    return {
      decision: "refuse",
      reason: '"Hands off the controls" is switched on, so nothing that changes anything is done.',
    };
  }
  try {
    const verdict = await toolVerdict(tool, input, { ...judged, readOutsideText: true });
    // What the rules will not have at all, they say by throwing.
    return verdict.decision === "allow"
      ? { decision: "allow" }
      : { decision: "ask", sensitive: verdict.sensitive, reason: verdict.reason };
  } catch (error) {
    return { decision: "refuse", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What a yes to a step is a yes to: its command and where it runs, and for another
 * machine the address, port and account behind the name. If any of it has changed
 * since the user said yes (a machine pointed somewhere else, say), the yes is for
 * something else and the step is asked about again.
 */
export function stepFingerprint(step: MissionStep, machines: readonly Machine[]): string {
  const machine = step.where === "here" ? null : machines.find((entry) => entry.id === step.where);
  return JSON.stringify([
    step.command,
    step.where,
    step.whereName,
    machine ? [machine.id, machine.name, machine.host, machine.port, machine.user] : null,
  ]);
}

export const NOT_AS_APPROVED = "Not run: the machine was changed after this step was approved.";

/** Runs a step's command where it belongs. A failure of any kind is a result, never a throw. */
export async function runStep(
  step: MissionStep,
  deps: { workspace: string; fleet?: Fleet | null; machines(): readonly Machine[] },
  signal: AbortSignal,
): Promise<StepResult> {
  try {
    // Looked at once more at the last moment: a machine edited since the yes was given
    // (between the question and now, however short that is) is not the machine the yes
    // was for. The step fails, and is asked about anew if it is tried again.
    if (step.approved && step.approved.print !== stepFingerprint(step, deps.machines())) {
      return { ok: false, output: NOT_AS_APPROVED };
    }
    if (step.where === "here") {
      const result = await runCommand(step.command, {
        cwd: deps.workspace,
        timeoutMs: LOCAL_LIMIT_MS,
        signal,
      });
      return { ok: result.exitCode === 0 && !result.timedOut, output: result.output };
    }
    const machine = deps.machines().find((entry) => entry.id === step.where);
    if (!machine || !deps.fleet) return { ok: false, output: "That machine is not available." };
    const result = await deps.fleet.run(machine, step.command, {
      timeoutMs: REMOTE_LIMIT_MS,
      signal,
    });
    const unreached = connectionProblem(result);
    if (unreached !== null) return { ok: false, output: unreached };
    if (result.timedOut) {
      return {
        ok: false,
        output:
          "It was stopped after running too long: the connection was closed, and the command may still be running there.",
      };
    }
    return { ok: result.code === 0, output: result.output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
