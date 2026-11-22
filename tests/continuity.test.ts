import { describe, expect, it, vi } from "vitest";
import {
  derivePresence,
  sanitizeHandoff,
  SessionContinuityManager,
} from "../src/core/continuity.ts";
import type { ApprovalCard } from "../src/core/missionApproval.ts";

const sampleCard: ApprovalCard = {
  id: "card-1234567890abcdef",
  mission: "Deploy API",
  missionId: "m-112233",
  step: 2,
  steps: 4,
  title: "Restart api.service on proxmox?",
  where: "proxmox",
  command: "systemctl restart api.service",
  reason: "Applies updated TLS cert",
  askedAt: "2026-11-22T12:30:00.000Z",
};

describe("SessionContinuityManager & privacy isolation", () => {
  it("derives away_from_desk state and strips sensitive desktop payloads on sanitizeHandoff", () => {
    expect(derivePresence({ screenLocked: false, idleSeconds: 10, phoneOnLan: true })).toBe("at_desk");
    expect(derivePresence({ screenLocked: true, idleSeconds: 5, phoneOnLan: true })).toBe("away_from_desk");
    expect(derivePresence({ screenLocked: false, idleSeconds: 400, phoneOnLan: true })).toBe("away_from_desk");

    const sanitized = sanitizeHandoff({
      summary: "Resume check data:image/png;base64,AAAA after build",
      missionId: "m-112233",
      screenCapture: "secret-pixels",
      notifications: ["Signal from Alice"],
      desktopChat: "private chat",
    });
    expect(sanitized.summary).toBe("Resume check [redacted-image] after build");
    expect(sanitized.missionId).toBe("m-112233");
    expect(Object.keys(sanitized)).toEqual(["summary", "missionId"]);
  });

  it("issues single-use TTL-enforced handoff tickets and blocks sensitive cards from phone routing", async () => {
    let clock = 100_000;
    const offered: ApprovalCard[] = [];
    const pinged: string[] = [];

    const mgr = new SessionContinuityManager({
      now: () => clock,
      offerStationApproval: (c) => offered.push(c),
      pingPhone: (t) => {
        pinged.push(t);
      },
    });
    expect(mgr.enabled).toBe(false);
    expect(() =>
      mgr.createHandoff({ from: "desktop", to: "mobile", summary: "hi" }),
    ).toThrow(/switched off/);

    mgr.enabled = true;
    const ticket = mgr.createHandoff({
      from: "desktop",
      to: "mobile",
      summary: "Check migration status",
      missionId: "m-112233",
    });

    // Wrong destination cannot claim
    expect(mgr.claimHandoff(ticket.id, "desktop")).toBeNull();
    // Single-use claim succeeds once then invalidates
    const claimed = mgr.claimHandoff(ticket.id, "mobile");
    expect(claimed?.summary).toBe("Check migration status");
    expect(mgr.claimHandoff(ticket.id, "mobile")).toBeNull();

    // Non-sensitive approval routes to phone + KDE Connect when away_from_desk
    const awayRes = await mgr.routeApproval(
      { card: sampleCard, sensitive: false, diffSummary: "-port=80\n+port=443" },
      "away_from_desk",
    );
    expect(awayRes.deliveredTo).toEqual(["pc", "phone", "kde_connect"]);
    expect(offered[0]?.reason).toContain("+port=443");
    expect(pinged[0]).toContain("Restart api.service");

    // Sensitive approval NEVER leaves PC even when away_from_desk
    offered.length = 0;
    pinged.length = 0;
    const sensRes = await mgr.routeApproval({ card: sampleCard, sensitive: true }, "away_from_desk");
    expect(sensRes.deliveredTo).toEqual(["pc"]);
    expect(offered).toHaveLength(0);
    expect(pinged).toHaveLength(0);

    // Expired ticket rejected cleanly
    const expiring = mgr.createHandoff({ from: "mobile", to: "desktop", summary: "later" });
    clock += 6 * 60_000;
    expect(mgr.claimHandoff(expiring.id, "desktop")).toBeNull();
    vi.restoreAllMocks();
  });
});
