import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StartupState {
  consecutiveCrashes: number;
  safeMode: boolean;
  lastStartAt: string;
  lastHealthyAt: string | null;
  manualReason?: string | null;
}

export interface BootStartStatus {
  safeMode: boolean;
  consecutiveCrashes: number;
  reason: string | null;
}

const DEFAULT_STATE: StartupState = {
  consecutiveCrashes: 0,
  safeMode: false,
  lastStartAt: "",
  lastHealthyAt: null,
};

/**
 * Startup crash-loop guard storing `startup-state.json` (`0o600`).
 * After >= 2 consecutive unrecovered crashes before reaching healthy uptime, activates
 * Safe Mode so optional background hooks (watch, hands, PC audio, notices, station) stay paused.
 */
export class StartupGuard {
  readonly file: string;
  private readonly crashThreshold: number;

  constructor(dataDirPath: string, crashThreshold = 2) {
    this.file = join(dataDirPath, "startup-state.json");
    this.crashThreshold = Math.max(2, crashThreshold);
  }

  private async readState(): Promise<StartupState> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<StartupState>;
      return {
        consecutiveCrashes:
          typeof raw.consecutiveCrashes === "number" && raw.consecutiveCrashes >= 0
            ? Math.trunc(raw.consecutiveCrashes)
            : 0,
        safeMode: raw.safeMode === true,
        lastStartAt: typeof raw.lastStartAt === "string" ? raw.lastStartAt : "",
        lastHealthyAt: typeof raw.lastHealthyAt === "string" ? raw.lastHealthyAt : null,
        manualReason: typeof raw.manualReason === "string" ? raw.manualReason : null,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private async writeState(state: StartupState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, this.file);
  }

  async recordBootStart(now = new Date()): Promise<BootStartStatus> {
    const prev = await this.readState();
    const consecutiveCrashes = prev.consecutiveCrashes + 1;
    const safeMode = prev.safeMode || consecutiveCrashes >= this.crashThreshold;
    await this.writeState({
      consecutiveCrashes,
      safeMode,
      lastStartAt: now.toISOString(),
      lastHealthyAt: prev.lastHealthyAt,
      manualReason: prev.manualReason ?? null,
    });
    return {
      safeMode,
      consecutiveCrashes,
      reason: safeMode
        ? prev.manualReason ||
          `Safe Mode active after ${consecutiveCrashes} consecutive interrupted startups. Optional background hooks (Screen Watch, Desktop Hands, PC Audio, Notification Watch, and Station auto-start) are paused until you clear Safe Mode.`
        : null,
    };
  }

  async markBootHealthy(now = new Date()): Promise<void> {
    const prev = await this.readState();
    await this.writeState({
      consecutiveCrashes: 0,
      safeMode: prev.safeMode,
      lastStartAt: prev.lastStartAt || now.toISOString(),
      lastHealthyAt: now.toISOString(),
      manualReason: prev.manualReason ?? null,
    });
  }

  async requestSafeModeNextBoot(
    reason = "Restarted in Safe Mode from the system tray. Optional background hooks are paused until you clear Safe Mode.",
    now = new Date(),
  ): Promise<void> {
    const prev = await this.readState();
    await this.writeState({
      consecutiveCrashes: 0,
      safeMode: true,
      lastStartAt: prev.lastStartAt || now.toISOString(),
      lastHealthyAt: now.toISOString(),
      manualReason: reason,
    });
  }

  async exitSafeMode(now = new Date()): Promise<void> {
    const prev = await this.readState();
    await this.writeState({
      consecutiveCrashes: 0,
      safeMode: false,
      lastStartAt: prev.lastStartAt || now.toISOString(),
      lastHealthyAt: now.toISOString(),
      manualReason: null,
    });
  }
}
