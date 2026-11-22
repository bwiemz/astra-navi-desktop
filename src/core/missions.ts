import { randomBytes } from "node:crypto";
import { runCommand, type CommandResult } from "./shell.ts";

export interface Mission {
  id: string;
  title: string;
  command: string;
  startedAt: string;
  state: "running" | "succeeded" | "failed" | "stopped";
  finishedAt: string | null;
  /** The end of what the command printed, kept for the report. */
  output: string;
}

/** A job may run this long before it is taken to be stuck. */
const MISSION_LIMIT_MS = 6 * 60 * 60 * 1000;
const MAX_RUNNING = 3;
const KEPT_FINISHED = 20;

/**
 * Long jobs that run in the background while the conversation goes on: a render, a big
 * download, an install. The assistant starts one and is told when it ends, so she can
 * report it. They live only as long as the app does; quitting stops them.
 */
export class MissionControl {
  private readonly cwd: string;
  private readonly onFinished: (mission: Mission) => void;
  private readonly missions = new Map<string, Mission>();
  private readonly stoppers = new Map<string, AbortController>();

  constructor(cwd: string, onFinished: (mission: Mission) => void) {
    this.cwd = cwd;
    this.onFinished = onFinished;
  }

  list(): Mission[] {
    return [...this.missions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get running(): number {
    return this.list().filter((mission) => mission.state === "running").length;
  }

  /** Starts a job and returns at once. */
  start(title: string, command: string): Mission {
    if (this.running >= MAX_RUNNING) {
      throw new Error(
        `${MAX_RUNNING} missions are already running. Wait for one to finish or stop one.`,
      );
    }
    const mission: Mission = {
      id: randomBytes(3).toString("hex"),
      title: title.replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled mission",
      command,
      startedAt: new Date().toISOString(),
      state: "running",
      finishedAt: null,
      output: "",
    };
    const stopper = new AbortController();
    this.missions.set(mission.id, mission);
    this.stoppers.set(mission.id, stopper);

    const finish = (state: Mission["state"], output: string): void => {
      mission.state = stopper.signal.aborted ? "stopped" : state;
      mission.finishedAt = new Date().toISOString();
      mission.output = output.slice(-1500);
      this.stoppers.delete(mission.id);
      this.trim();
      this.onFinished({ ...mission });
    };
    runCommand(command, {
      cwd: this.cwd,
      timeoutMs: MISSION_LIMIT_MS,
      signal: stopper.signal,
    }).then(
      (result: CommandResult) =>
        finish(result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed", result.output),
      (error: unknown) => finish("failed", error instanceof Error ? error.message : String(error)),
    );
    return { ...mission };
  }

  stop(id: string): boolean {
    const stopper = this.stoppers.get(id);
    if (!stopper) return false;
    stopper.abort();
    return true;
  }

  /**
   * Stops everything still running, for when the app closes, and waits until the jobs
   * are really gone (a stubborn one is killed outright after two seconds).
   */
  async stopAll(waitMs = 2600): Promise<void> {
    for (const stopper of this.stoppers.values()) stopper.abort();
    const deadline = Date.now() + waitMs;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private trim(): void {
    const finished = this.list().filter((mission) => mission.state !== "running");
    for (const old of finished.slice(KEPT_FINISHED)) this.missions.delete(old.id);
  }
}
