import type { HerStore } from "./store.ts";

/**
 * Implicit-Feedback Episodic Graph & Threshold Calibration (Tier 10 §6.1).
 *
 * Links proactive alerts, reminders, standing orders, and desktop actions with their
 * surrounding context bucket and any implicit reaction within a 120-second observation
 * window, smoothly adapting `tauAct` and `tauSpeak` via an exponential moving average.
 */

export const OBSERVATION_WINDOW_MS = 120_000;
export const QUICK_DISMISS_MS = 3_000;
export const DEFAULT_TAU_ACT = 0.6;
export const DEFAULT_TAU_SPEAK = 0.55;
const EMA_ALPHA = 0.25;
const MIN_TAU_ACT = 0.35;
const MIN_TAU_SPEAK = 0.3;
const MAX_TAU = 0.95;

export type EpisodeKind =
  | "proactive_alert"
  | "reminder"
  | "standing_order"
  | "window_action"
  | "routine_offer";

export type FeedbackSignal =
  | "acted"
  | "followup"
  | "kept_intact"
  | "undo"
  | "quick_dismiss"
  | "cancelled"
  | "overridden";

export interface EpisodeRecord {
  id: number;
  at: string;
  kind: EpisodeKind;
  contextBucket: string;
  activeApp: string;
  mode: string;
  summary: string;
  actionKey: string | null;
}

export interface ContextThresholds {
  contextBucket: string;
  emaReward: number;
  tauAct: number;
  tauSpeak: number;
  sampleCount: number;
  updatedAt: string;
}

export interface ImplicitReactionInput {
  kind: "acted" | "followup" | "kept_intact" | "undo" | "dismissed" | "cancelled" | "overridden";
  delayMs: number;
  at?: string;
}

interface ThresholdRow {
  context_bucket: string;
  ema_reward: number;
  tau_act: number;
  tau_speak: number;
  sample_count: number;
  updated_at: string;
}

interface EpisodeRow {
  id: number;
  at: string;
  kind: string;
  context_bucket: string;
  active_app: string;
  mode: string;
  summary: string;
  action_key: string | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function timeBucket(hour: number | undefined): string {
  const h = typeof hour === "number" && Number.isFinite(hour) ? ((Math.trunc(hour) % 24) + 24) % 24 : 12;
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return cleaned || "general";
}

/** Builds a stable normalized key partitioning time-of-day, attention mode, and active app. */
export function buildContextBucket(input: {
  mode: string;
  app?: string;
  hour?: number;
}): string {
  const period = timeBucket(input.hour);
  const mode = sanitizeSegment(input.mode);
  const app = input.app ? sanitizeSegment(input.app) : "any";
  return `${period}:${mode}:${app}`;
}

/**
 * Classifies downstream user reaction within the 120s window into a signed implicit reward.
 * Returns null outside the window or for non-hasty dismissals (>3s).
 */
export function classifyImplicitReaction(
  reaction: Pick<ImplicitReactionInput, "kind" | "delayMs">,
): { signal: FeedbackSignal; reward: number } | null {
  if (!Number.isFinite(reaction.delayMs) || reaction.delayMs < 0 || reaction.delayMs > OBSERVATION_WINDOW_MS) {
    return null;
  }
  switch (reaction.kind) {
    case "acted":
      return { signal: "acted", reward: 1.0 };
    case "followup":
      return { signal: "followup", reward: 0.8 };
    case "kept_intact":
      return { signal: "kept_intact", reward: 0.6 };
    case "undo":
      return { signal: "undo", reward: -1.0 };
    case "cancelled":
      return { signal: "cancelled", reward: -0.9 };
    case "overridden":
      return { signal: "overridden", reward: -1.0 };
    case "dismissed":
      return reaction.delayMs <= QUICK_DISMISS_MS
        ? { signal: "quick_dismiss", reward: -0.8 }
        : null;
  }
}

export class EpisodicGraph {
  private readonly store: HerStore;
  private readonly now: () => Date;

  constructor(store: HerStore, options: { now?: () => Date } = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
  }

  recordEpisode(entry: {
    at?: string;
    kind: EpisodeKind;
    contextBucket: string;
    activeApp: string;
    mode: string;
    summary: string;
    actionKey?: string | null;
  }): number {
    const at = entry.at ?? this.now().toISOString();
    return this.store.run(
      `INSERT INTO episodes (at, kind, context_bucket, active_app, mode, summary, action_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      at,
      entry.kind,
      entry.contextBucket,
      entry.activeApp,
      entry.mode,
      entry.summary.slice(0, 300),
      entry.actionKey ?? null,
    );
  }

  getEpisode(id: number): EpisodeRecord | undefined {
    const row = this.store.one<EpisodeRow>(
      `SELECT id, at, kind, context_bucket, active_app, mode, summary, action_key
       FROM episodes WHERE id = ?`,
      id,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      at: row.at,
      kind: row.kind as EpisodeKind,
      contextBucket: row.context_bucket,
      activeApp: row.active_app,
      mode: row.mode,
      summary: row.summary,
      actionKey: row.action_key,
    };
  }

  /**
   * Records implicit user feedback inside the 120s observation window and adapts
   * per-context `tauAct` / `tauSpeak` via EMA.
   */
  recordReaction(
    episodeId: number,
    reaction: ImplicitReactionInput,
  ): ContextThresholds | null {
    const classified = classifyImplicitReaction(reaction);
    if (!classified) return null;
    const episode = this.getEpisode(episodeId);
    if (!episode) return null;
    const at = reaction.at ?? this.now().toISOString();

    return this.store.together(() => {
      this.store.run(
        `INSERT INTO episode_feedback (episode_id, at, signal, reward, delay_ms)
         VALUES (?, ?, ?, ?, ?)`,
        episodeId,
        at,
        classified.signal,
        classified.reward,
        Math.round(reaction.delayMs),
      );
      const existing = this.store.one<ThresholdRow>(
        `SELECT context_bucket, ema_reward, tau_act, tau_speak, sample_count, updated_at
         FROM episode_thresholds WHERE context_bucket = ?`,
        episode.contextBucket,
      );
      const prevEma = existing?.ema_reward ?? 0;
      const sampleCount = (existing?.sample_count ?? 0) + 1;
      const emaReward = existing
        ? (1 - EMA_ALPHA) * prevEma + EMA_ALPHA * classified.reward
        : EMA_ALPHA * classified.reward;
      const tauAct = Number(clamp(DEFAULT_TAU_ACT - emaReward * 0.25, MIN_TAU_ACT, MAX_TAU).toFixed(4));
      const tauSpeak = Number(
        clamp(DEFAULT_TAU_SPEAK - emaReward * 0.25, MIN_TAU_SPEAK, MAX_TAU).toFixed(4),
      );

      this.store.run(
        `INSERT INTO episode_thresholds (context_bucket, ema_reward, tau_act, tau_speak, sample_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(context_bucket) DO UPDATE SET
           ema_reward = excluded.ema_reward,
           tau_act = excluded.tau_act,
           tau_speak = excluded.tau_speak,
           sample_count = excluded.sample_count,
           updated_at = excluded.updated_at`,
        episode.contextBucket,
        emaReward,
        tauAct,
        tauSpeak,
        sampleCount,
        at,
      );
      return {
        contextBucket: episode.contextBucket,
        emaReward,
        tauAct,
        tauSpeak,
        sampleCount,
        updatedAt: at,
      };
    });
  }

  thresholdsFor(contextBucket: string): ContextThresholds {
    const row = this.store.one<ThresholdRow>(
      `SELECT context_bucket, ema_reward, tau_act, tau_speak, sample_count, updated_at
       FROM episode_thresholds WHERE context_bucket = ?`,
      contextBucket,
    );
    if (!row) {
      return {
        contextBucket,
        emaReward: 0,
        tauAct: DEFAULT_TAU_ACT,
        tauSpeak: DEFAULT_TAU_SPEAK,
        sampleCount: 0,
        updatedAt: "",
      };
    }
    return {
      contextBucket: row.context_bucket,
      emaReward: row.ema_reward,
      tauAct: row.tau_act,
      tauSpeak: row.tau_speak,
      sampleCount: row.sample_count,
      updatedAt: row.updated_at,
    };
  }

  shouldAct(contextBucket: string, confidence: number): boolean {
    return confidence >= this.thresholdsFor(contextBucket).tauAct;
  }

  shouldSpeak(contextBucket: string, confidence: number): boolean {
    return confidence >= this.thresholdsFor(contextBucket).tauSpeak;
  }
}
