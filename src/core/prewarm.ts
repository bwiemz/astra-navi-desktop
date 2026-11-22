/** Signal events that trigger predictive context and KV-cache prefix pre-warming. */
export type PrewarmSignal =
  | { kind: "window-focus"; app: string; title: string }
  | { kind: "wake-word" }
  | { kind: "mission-upcoming"; missionId: string; title: string };

export interface PrewarmedContext {
  query: string;
  builtAt: number;
  expiresAt: number;
  notes: string[];
  missionHint: string | null;
  fleetHint: string | null;
  combined: string;
}

export interface ContextPrewarmerDeps {
  enabled(): boolean;
  gpuBusy(): boolean;
  recallNotes(query: string, signal?: AbortSignal): Promise<string[]>;
  activeMissions?(): string | null;
  fleetSummary?(): string | null;
  warmPrefix?(prefix: string, signal?: AbortSignal): Promise<void>;
  now?(): number;
  debounceMs?: number;
  ttlMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_TTL_MS = 45_000;

function queryFromSignal(signal: PrewarmSignal): string {
  switch (signal.kind) {
    case "window-focus":
      return `${signal.app} ${signal.title}`.replace(/\s+/g, " ").trim().slice(0, 160);
    case "wake-word":
      return "current status reminders active tasks";
    case "mission-upcoming":
      return signal.title.trim().slice(0, 160);
  }
}

/**
 * Listens for window-focus switches, wake-word onset, and upcoming mission triggers to
 * pre-assemble relevant memory slices and optionally warm KV-cache prefixes while idle
 * and never interfering with active full-screen games.
 */
export class ContextPrewarmer {
  private readonly deps: ContextPrewarmerDeps;
  private readonly debounceMs: number;
  private readonly ttlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private pendingSignal: PrewarmSignal | null = null;
  private inFlight: AbortController | null = null;
  private current: PrewarmedContext | null = null;
  private disposed = false;

  constructor(deps: ContextPrewarmerDeps) {
    this.deps = deps;
    this.debounceMs = Math.max(0, deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.ttlMs = Math.max(1_000, deps.ttlMs ?? DEFAULT_TTL_MS);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Schedules a debounced context pre-fetch for the latest signal (no-op when disabled or gaming). */
  notify(signal: PrewarmSignal): void {
    if (this.disposed || !this.deps.enabled() || this.deps.gpuBusy()) return;
    const query = queryFromSignal(signal);
    if (!query) return;
    this.pendingSignal = signal;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Executes any pending signal immediately, returning the refreshed context or null if skipped. */
  async flushNow(explicitSignal?: PrewarmSignal): Promise<PrewarmedContext | null> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const chosen = explicitSignal ?? this.pendingSignal;
    this.pendingSignal = null;
    if (this.disposed || !chosen || !this.deps.enabled() || this.deps.gpuBusy()) {
      return null;
    }

    const query = queryFromSignal(chosen);
    if (!query) return null;

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const notes = (await this.deps.recallNotes(query, controller.signal))
        .map((n) => n.trim())
        .filter(Boolean)
        .slice(0, 6);
      if (controller.signal.aborted || this.disposed || !this.deps.enabled() || this.deps.gpuBusy()) {
        return null;
      }

      const missionHint = this.deps.activeMissions?.()?.trim() || null;
      const fleetHint = this.deps.fleetSummary?.()?.trim() || null;
      const parts: string[] = [];
      if (notes.length > 0) parts.push(`Notes:\n${notes.map((n) => `- ${n}`).join("\n")}`);
      if (missionHint) parts.push(`Active missions: ${missionHint}`);
      if (fleetHint) parts.push(`Fleet status: ${fleetHint}`);
      const combined = parts.join("\n\n");

      const builtAt = this.now();
      const context: PrewarmedContext = {
        query,
        builtAt,
        expiresAt: builtAt + this.ttlMs,
        notes,
        missionHint,
        fleetHint,
        combined,
      };
      this.current = context;

      if (combined && this.deps.warmPrefix && !this.deps.gpuBusy()) {
        await this.deps.warmPrefix(combined, controller.signal).catch(() => undefined);
      }
      return controller.signal.aborted ? null : context;
    } catch {
      return null;
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /** Returns the current non-expired pre-warmed context without consuming it, or null. */
  peek(nowMs = this.now()): PrewarmedContext | null {
    if (!this.current) return null;
    if (nowMs > this.current.expiresAt) {
      this.current = null;
      return null;
    }
    return this.current;
  }

  /** Consumes and returns the current non-expired pre-warmed context, or null. */
  take(nowMs = this.now()): PrewarmedContext | null {
    const valid = this.peek(nowMs);
    this.current = null;
    return valid;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingSignal = null;
    this.current = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight?.abort();
    this.inFlight = null;
  }
}
