import { connectionProblem, type Fleet } from "./fleet.ts";
import { runsWithoutAsking, type PolicyContext } from "./permissions.ts";
import { runCommand } from "./shell.ts";
import { machineTarget, type OrderCheck, type Reading } from "./standingOrders.ts";

/** No check of a standing order may take longer than this; the next one is minutes away. */
const CHECK_TIMEOUT_MS = 20_000;

export interface OrderCheckDeps {
  /** Where a check on this PC is run from: her own folder. */
  workspace: string;
  fleet?: Fleet;
  fetch?: typeof fetch;
}

/**
 * Asks a web address whether it answers. Only the status is kept: what the page says is
 * never read, so nothing on it can reach her. The request names no one and carries
 * nothing; an address that refuses it simply counts as not answering.
 */
async function askAddress(
  address: string,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<Reading> {
  try {
    const response = await doFetch(address, {
      method: "GET",
      // Not followed: where a server sends her on to is an address nobody approved, and
      // it could be one on this network. Being sent on counts as having answered.
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]),
      headers: { accept: "*/*" },
    });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.status < 400, text: `HTTP ${response.status}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    const why =
      typeof cause === "string" ? cause : error instanceof Error ? error.name : "no connection";
    return { ok: false, text: `No answer (${why})` };
  }
}

/** Makes the function that carries out a standing order's check, wherever it is to run. */
export function orderReader(
  deps: OrderCheckDeps,
): (check: OrderCheck, signal: AbortSignal) => Promise<Reading> {
  return async (check, signal) => {
    if (check.kind === "address") return askAddress(check.address, signal, deps.fetch ?? fetch);
    if (check.where === "here") {
      const result = await runCommand(check.command, {
        cwd: deps.workspace,
        timeoutMs: CHECK_TIMEOUT_MS,
        signal,
      });
      return { ok: result.exitCode === 0 && !result.timedOut, text: result.output };
    }
    // By id, and only while it is still the same sign-in at the same address: an entry
    // renamed is the same machine, one pointed elsewhere is not the one the user agreed to.
    const machine = deps.fleet?.machines().find((entry) => entry.id === check.where);
    if (!machine) return { ok: false, text: "That machine is no longer on the list." };
    if (machineTarget(machine) !== check.target) {
      return { ok: false, text: "That machine's entry now points somewhere else." };
    }
    try {
      const result = await deps.fleet?.run(machine, check.command, {
        timeoutMs: CHECK_TIMEOUT_MS,
        signal,
      });
      if (!result) return { ok: false, text: "No answer." };
      // A connection that failed is said in plain words, not in SSH's alarm text.
      return {
        ok: result.code === 0 && !result.timedOut,
        text: connectionProblem(result) ?? result.output,
      };
    } catch (error) {
      return { ok: false, text: `No answer (${error instanceof Error ? error.message : "?"})` };
    }
  };
}

/**
 * Makes the test every check is put to before it runs: a command on this PC must be
 * one she could run directly without a question (see `runsWithoutAsking`).
 */
export function orderGuard(context: PolicyContext): (check: OrderCheck) => Promise<boolean> {
  return async (check) =>
    check.kind !== "command" || check.where !== "here" || runsWithoutAsking(check.command, context);
}
