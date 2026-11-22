/**
 * Cross-Device Attention & Interruption Arbiter (Tier 10 §6.2).
 *
 * Unifies desktop activity, full-screen games, live voice sessions, and mobile
 * LAN presence into one attention state machine and routes outbound notifications
 * by urgency tier without waking the GPU unnecessarily.
 */

export type AttentionState =
  | "deep_focus"
  | "gaming"
  | "conversational"
  | "idle_at_desk"
  | "away_from_desk";

export type UrgencyTier = "critical" | "timely" | "digestible";

export interface AttentionSignals {
  gameActive: boolean;
  voiceActive: boolean;
  screenLocked: boolean;
  idleSeconds: number;
  phoneOnLan: boolean;
  activeApp?: string;
  deepFocusApps?: readonly string[];
  focusMinutes?: number;
}

export interface AttentionItem {
  id: string;
  kind: string;
  urgency: UrgencyTier;
  text: string;
  plain?: string;
  at?: string;
}

export interface DigestItem {
  id: string;
  kind: string;
  urgency: UrgencyTier;
  text: string;
  plain: string;
  queuedAt: string;
}

export type RouteAction =
  | "deliver_desktop"
  | "overlay_non_intrusive"
  | "route_mobile"
  | "queue_digest";

export interface AttentionRouteDecision {
  state: AttentionState;
  action: RouteAction;
  wakeGpu: boolean;
  notifyMobile: boolean;
  queuedDigestSize: number;
  item: AttentionItem;
}

const MAX_DIGEST_ITEMS = 40;
const AWAY_IDLE_SECONDS = 300;
const DEFAULT_FOCUS_APPS =
  /(?:code|vscode|codium|zed|jetbrains|idea|pycharm|clion|rustrover|webstorm|goland|blender|kdenlive|krita|gimp|inkscape|obsidian|emacs|nvim|vim|latex|texstudio|kicad|freecad)/i;

/** Classifies the user's current attention state from local + mobile presence signals. */
export function deriveAttentionState(signals: AttentionSignals): AttentionState {
  if (signals.gameActive) return "gaming";
  if (signals.screenLocked || signals.idleSeconds >= AWAY_IDLE_SECONDS) return "away_from_desk";
  if (signals.voiceActive) return "conversational";
  const app = signals.activeApp?.trim() ?? "";
  const extraFocusMatch =
    app.length > 0 &&
    (signals.deepFocusApps ?? []).some((name) => app.toLowerCase().includes(name.trim().toLowerCase()));
  if ((signals.focusMinutes ?? 0) >= 10 || (app.length > 0 && (DEFAULT_FOCUS_APPS.test(app) || extraFocusMatch))) {
    return "deep_focus";
  }
  return "idle_at_desk";
}

export class AttentionArbiter {
  private readonly digest: DigestItem[] = [];
  private readonly maxDigest: number;
  private readonly now: () => Date;

  constructor(options: { maxDigest?: number; now?: () => Date } = {}) {
    this.maxDigest = Math.max(1, options.maxDigest ?? MAX_DIGEST_ITEMS);
    this.now = options.now ?? (() => new Date());
  }

  get queuedCount(): number {
    return this.digest.length;
  }

  queuedDigest(): readonly DigestItem[] {
    return [...this.digest];
  }

  private pushDigest(item: AttentionItem): void {
    this.digest.push({
      id: item.id,
      kind: item.kind,
      urgency: item.urgency,
      text: item.text,
      plain: item.plain ?? item.text,
      queuedAt: item.at ?? this.now().toISOString(),
    });
    if (this.digest.length > this.maxDigest) {
      this.digest.shift();
    }
  }

  /** Deterministically decides delivery channel and GPU wake policy for an outbound item. */
  route(item: AttentionItem, signals: AttentionSignals): AttentionRouteDecision {
    const state = deriveAttentionState(signals);

    if (state === "gaming" || state === "deep_focus") {
      if (item.urgency === "critical") {
        return {
          state,
          action: "overlay_non_intrusive",
          wakeGpu: false,
          notifyMobile: signals.phoneOnLan,
          queuedDigestSize: this.digest.length,
          item,
        };
      }
      this.pushDigest(item);
      return {
        state,
        action: "queue_digest",
        wakeGpu: false,
        notifyMobile: false,
        queuedDigestSize: this.digest.length,
        item,
      };
    }

    if (state === "away_from_desk") {
      if (item.urgency === "critical" || item.urgency === "timely") {
        return {
          state,
          action: "route_mobile",
          wakeGpu: false,
          notifyMobile: true,
          queuedDigestSize: this.digest.length,
          item,
        };
      }
      this.pushDigest(item);
      return {
        state,
        action: "queue_digest",
        wakeGpu: false,
        notifyMobile: false,
        queuedDigestSize: this.digest.length,
        item,
      };
    }

    if (state === "conversational") {
      if (item.urgency === "digestible") {
        this.pushDigest(item);
        return {
          state,
          action: "queue_digest",
          wakeGpu: false,
          notifyMobile: false,
          queuedDigestSize: this.digest.length,
          item,
        };
      }
      return {
        state,
        action: "deliver_desktop",
        wakeGpu: true,
        notifyMobile: false,
        queuedDigestSize: this.digest.length,
        item,
      };
    }

    // idle_at_desk
    return {
      state,
      action: "deliver_desktop",
      wakeGpu: true,
      notifyMobile: false,
      queuedDigestSize: this.digest.length,
      item,
    };
  }

  /** Flushes all queued digest items into a concise post-session summary. */
  flushDigest(lead?: string): { count: number; summary: string; items: DigestItem[] } {
    const items = this.digest.splice(0);
    if (items.length === 0) {
      return { count: 0, summary: "", items: [] };
    }
    const header = lead ? `${lead} ` : "";
    const lines = items.map((entry) => `- ${entry.plain}`);
    return {
      count: items.length,
      summary: `${header}${items.length} queued update${items.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
      items,
    };
  }
}
