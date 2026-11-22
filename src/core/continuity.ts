import { randomBytes } from "node:crypto";
import type { ApprovalCard } from "./missionApproval.ts";

export interface PresenceSignals {
  screenLocked: boolean;
  idleSeconds: number;
  phoneOnLan: boolean;
}

export type PresenceState = "at_desk" | "away_from_desk";

export interface HandoffTicket {
  id: string;
  from: "desktop" | "mobile";
  to: "desktop" | "mobile";
  summary: string;
  missionId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface EscalationCard {
  card: ApprovalCard;
  sensitive: boolean;
  diffSummary?: string;
}

const HANDOFF_TTL_MS = 5 * 60_000;
const MAX_TICKETS = 10;

const FORBIDDEN_HANDOFF_KEYS = new Set([
  "screenCapture",
  "screenshot",
  "desktopChat",
  "notifications",
  "rawNotice",
]);

/** Derives whether the user is currently at the physical desktop or away. */
export function derivePresence(signals: PresenceSignals): PresenceState {
  if (signals.screenLocked || signals.idleSeconds >= 300) {
    return "away_from_desk";
  }
  return "at_desk";
}

/**
 * Strips any screen captures, desktop notification payloads, or local chat dumps from
 * cross-device handoff state to preserve Spec §4.4 per-device privacy boundaries.
 */
export function sanitizeHandoff(input: Record<string, unknown>): {
  summary: string;
  missionId?: string;
} {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!FORBIDDEN_HANDOFF_KEYS.has(k)) safe[k] = v;
  }
  const rawSummary = typeof safe["summary"] === "string" ? safe["summary"] : "";
  const cleanedSummary = rawSummary
    .replace(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/gi, "[redacted-image]")
    .trim()
    .slice(0, 1200);
  const rawMission = typeof safe["missionId"] === "string" ? safe["missionId"].trim() : "";
  return {
    summary: cleanedSummary,
    ...(rawMission ? { missionId: rawMission } : {}),
  };
}

/**
 * Coordinates single-use session handoffs and away-mode mission approval escalation
 * across desktop, paired Android station, and KDE Connect while keeping sensitive prompts
 * locked to the physical PC.
 */
export class SessionContinuityManager {
  enabled: boolean;
  private readonly now: () => number;
  private readonly tickets = new Map<string, HandoffTicket>();
  private readonly offerStationApproval?: (card: ApprovalCard) => void;
  private readonly pingPhone?: (text: string) => Promise<void> | void;

  constructor(options?: {
    enabled?: boolean;
    now?: () => number;
    offerStationApproval?: (card: ApprovalCard) => void;
    pingPhone?: (text: string) => Promise<void> | void;
  }) {
    this.enabled = options?.enabled ?? false;
    this.now = options?.now ?? (() => Date.now());
    this.offerStationApproval = options?.offerStationApproval;
    this.pingPhone = options?.pingPhone;
  }

  createHandoff(input: {
    from: "desktop" | "mobile";
    to: "desktop" | "mobile";
    summary: string;
    missionId?: string;
    [extra: string]: unknown;
  }): HandoffTicket {
    if (!this.enabled) {
      throw new Error("Cross-device session continuity is switched off.");
    }
    if (input.from === input.to) {
      throw new Error("Handoff source and destination endpoints must differ.");
    }
    const now = this.now();
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(id);
    }
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest) this.tickets.delete(oldest);
      else break;
    }
    const safe = sanitizeHandoff(input);
    const ticket: HandoffTicket = {
      id: randomBytes(12).toString("base64url"),
      from: input.from,
      to: input.to,
      summary: safe.summary,
      ...(safe.missionId ? { missionId: safe.missionId } : {}),
      createdAt: now,
      expiresAt: now + HANDOFF_TTL_MS,
    };
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  claimHandoff(ticketId: string, claimingEndpoint: "desktop" | "mobile"): HandoffTicket | null {
    if (!this.enabled) return null;
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return null;
    if (ticket.to !== claimingEndpoint || ticket.expiresAt <= this.now()) {
      if (ticket.expiresAt <= this.now()) this.tickets.delete(ticketId);
      return null;
    }
    // Single-use token: delete immediately on claim.
    this.tickets.delete(ticketId);
    return ticket;
  }

  activeTickets(): HandoffTicket[] {
    const now = this.now();
    return [...this.tickets.values()].filter((t) => t.expiresAt > now);
  }

  /**
   * Routes a mission approval card across endpoints. Cards flagged `sensitive: true`
   * NEVER leave the physical PC even when the user is away.
   */
  async routeApproval(
    escalation: EscalationCard,
    presence: PresenceState,
  ): Promise<{ deliveredTo: ("pc" | "phone" | "kde_connect")[] }> {
    const deliveredTo: ("pc" | "phone" | "kde_connect")[] = ["pc"];
    if (escalation.sensitive || !this.enabled || presence !== "away_from_desk") {
      return { deliveredTo };
    }

    const enriched: ApprovalCard = escalation.diffSummary
      ? {
          ...escalation.card,
          reason: `${escalation.card.reason}\n\n${escalation.diffSummary.slice(0, 600)}`,
        }
      : escalation.card;

    if (this.offerStationApproval) {
      this.offerStationApproval(enriched);
      deliveredTo.push("phone");
    }
    if (this.pingPhone) {
      await this.pingPhone(`Approval needed: ${escalation.card.title}`);
      deliveredTo.push("kde_connect");
    }
    return { deliveredTo };
  }
}
