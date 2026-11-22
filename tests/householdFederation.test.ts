import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sendFederationEnvelope,
  signFederationEnvelope,
  StationFederation,
  verifyFederationEnvelope,
  type FederationPayload,
} from "../src/core/federation.ts";
import { extractVoicePrint, HouseholdIsolationManager } from "../src/core/household.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { Station } from "../src/core/station.ts";

describe("Multi-User Household Isolation & Station-to-Station Federation", () => {
  it("isolates household profiles by voiceprint/device and locks privileged tools to owner", () => {
    const mgr = new HouseholdIsolationManager();
    const owner = {
      userId: "u-owner",
      displayName: "Brandon",
      role: "owner" as const,
      voiceEmbedding: [1, 0, 0, 0],
      deviceIds: ["dev-pixel"],
      memoryNamespace: "ns-owner",
      calendarIds: ["cal-work", "cal-home"],
    };
    const member = {
      userId: "u-guest",
      displayName: "Alex",
      role: "member" as const,
      voiceEmbedding: [0, 1, 0, 0],
      deviceIds: ["dev-alex"],
      memoryNamespace: "ns-alex",
      calendarIds: ["cal-alex"],
    };
    mgr.registerProfile(owner);
    mgr.registerProfile(member);

    // Default off -> single-owner pass-through.
    expect(mgr.authorizeAction(null, { tool: "remote" }).allowed).toBe(true);

    mgr.enabled = true;
    expect(mgr.identifySpeaker([0.98, 0.05, 0, 0])?.userId).toBe("u-owner");
    expect(mgr.identifySpeaker([0.05, 0.99, 0, 0])?.userId).toBe("u-guest");
    // Ambiguous mid-point vector between two voices fails closed.
    expect(mgr.identifySpeaker([0.7, 0.71, 0, 0])).toBeNull();
    expect(mgr.resolveDeviceUser("dev-alex")?.userId).toBe("u-guest");

    expect(mgr.authorizeAction(null, { tool: "calculate" }).allowed).toBe(false);
    expect(mgr.authorizeAction(member, { tool: "remote" }).allowed).toBe(false);
    expect(mgr.authorizeAction(member, { tool: "operate" }).allowed).toBe(false);
    expect(
      mgr.authorizeAction(member, { tool: "recall", targetNamespace: "ns-owner" }).allowed,
    ).toBe(false);
    expect(
      mgr.authorizeAction(member, { tool: "agenda", targetCalendarId: "cal-work" }).allowed,
    ).toBe(false);
    expect(
      mgr.authorizeAction(member, {
        tool: "agenda",
        targetNamespace: "ns-alex",
        targetCalendarId: "cal-alex",
      }).allowed,
    ).toBe(true);
    expect(mgr.authorizeAction(owner, { tool: "remote" }).allowed).toBe(true);
  });

  it("enforces LAN-only peers, Ed25519 anti-replay verification, and strips screen/chat leaks", () => {
    const fed = new StationFederation();
    const aliceKeys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const bobKeys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    expect(() =>
      fed.registerPeer({
        id: "public",
        name: "PublicHost",
        host: "198.51.100.5",
        port: 47821,
        fingerprintSha256: "a".repeat(64),
        publicKeyPem: aliceKeys.publicKey,
        enabled: true,
      }),
    ).toThrow(/non-LAN/);

    fed.registerPeer({
      id: "living-room",
      name: "Living Room",
      host: "192.168.50.30",
      port: 47821,
      fingerprintSha256: "b".repeat(64),
      publicKeyPem: aliceKeys.publicKey,
      enabled: true,
    });

    // Disabled fails closed.
    expect(() =>
      fed.prepareOutgoing(
        "living-room",
        { kind: "availability", status: "free" },
        "desk",
        bobKeys.privateKey,
      ),
    ).toThrow(/disabled/);

    fed.enabled = true;
    const envelope = fed.prepareOutgoing(
      "living-room",
      {
        kind: "task_handoff",
        title: "Check 3D print",
        summary: "Layer check data:image/png;base64,AAAA Bearer secret-token-123456",
        requestedBy: "Brandon",
        screenCapture: "secret pixels",
        desktopChat: "private chat",
        notifications: ["msg"],
      },
      "living-room",
      aliceKeys.privateKey,
      1_000_000,
    );
    expect(Object.keys(envelope.payload)).toEqual(["kind", "title", "summary", "requestedBy"]);
    expect((envelope.payload as { summary: string }).summary).toContain("[redacted-image]");
    expect((envelope.payload as { summary: string }).summary).toContain("Bearer [hidden]");

    const accepted = fed.receiveIncoming(envelope, 1_005_000);
    expect(accepted.accepted).toBe(true);

    // Nonce replay rejected.
    const replayed = fed.receiveIncoming(envelope, 1_006_000);
    expect(replayed.accepted).toBe(false);
    expect(replayed.reason).toContain("Replayed");

    // Stale timestamp rejected.
    const fresh = signFederationEnvelope(
      { kind: "availability", status: "busy" },
      "living-room",
      "desk",
      aliceKeys.privateKey,
      1_000_000,
    );
    expect(verifyFederationEnvelope(fresh, aliceKeys.publicKey, 1_500_000).valid).toBe(false);
  });

  it("extracts distinct acoustic voice-prints per speaker and isolates MemoryStore vaults", async () => {
    const synthVoice = (f0: number, harm2: number): Float32Array => {
      const buf = new Float32Array(8000);
      for (let i = 0; i < buf.length; i += 1) {
        const t = i / 16_000;
        buf[i] = 0.25 * Math.sin(2 * Math.PI * f0 * t) + 0.1 * Math.sin(2 * Math.PI * harm2 * t);
      }
      return buf;
    };

    const brandonRef = extractVoicePrint(synthVoice(140, 280));
    const alexRef = extractVoicePrint(synthVoice(620, 1860));
    expect(brandonRef).toHaveLength(24);
    expect(alexRef).toHaveLength(24);

    const mgr = new HouseholdIsolationManager({ enabled: true });
    mgr.registerProfile({
      userId: "brandon",
      displayName: "Brandon",
      role: "owner",
      voiceEmbedding: brandonRef,
      deviceIds: ["dev-1"],
      memoryNamespace: "brandon",
      calendarIds: [],
    });
    mgr.registerProfile({
      userId: "alex",
      displayName: "Alex",
      role: "member",
      voiceEmbedding: alexRef,
      deviceIds: ["dev-2"],
      memoryNamespace: "alex",
      calendarIds: [],
    });

    expect(mgr.identifySpeaker(extractVoicePrint(synthVoice(142, 284)))?.userId).toBe("brandon");
    expect(mgr.identifySpeaker(extractVoicePrint(synthVoice(615, 1845)))?.userId).toBe("alex");

    const dir = await mkdtemp(join(tmpdir(), "aichan-mem-vault-"));
    try {
      const store = new MemoryStore(join(dir, "memories.json"));
      await store.save({
        kind: "fact",
        text: "Brandon SSH server is 192.168.1.50",
        namespace: "brandon",
      });
      await store.save({
        kind: "fact",
        text: "Alex likes mint tea",
        namespace: "alex",
      });
      await store.save({
        kind: "fact",
        text: "Unscoped household note",
      });

      expect(store.all("alex").map((m) => m.text)).toEqual(["Alex likes mint tea"]);
      expect(store.search("server", 5, "alex")).toEqual([]);
      expect(store.search("mint tea", 5, "alex").map((m) => m.text)).toEqual(["Alex likes mint tea"]);
      expect(store.snapshot(4000, "alex")).toContain("Alex likes mint tea");
      expect(store.snapshot(4000, "alex")).not.toContain("192.168.1.50");
      // Unscoped compatibility remains intact.
      expect(store.all()).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces household roles on Station routes and handles TLS-pinned P2P federation over HTTPS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aichan-station-fed-"));
    const nowMs = Date.parse("2026-11-22T15:00:00Z");
    const aliceKeys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const received: FederationPayload[] = [];
    const household = new HouseholdIsolationManager({ enabled: true });
    const fed = new StationFederation({ enabled: true });
    fed.registerPeer({
      id: "peer-station",
      name: "Peer Station",
      host: "127.0.0.1",
      port: 47821,
      fingerprintSha256: "c".repeat(64),
      publicKeyPem: aliceKeys.publicKey,
      enabled: true,
    });

    const station = new Station({
      dir,
      port: 0,
      now: () => nowMs,
      passwordCost: 1 << 14,
      localAddresses: () => ["127.0.0.1"],
      household,
      federation: fed,
      onSay: () => true,
      onStop: () => undefined,
      approvals: {
        cards: () => [],
        answer: () => true,
      },
      pinnedMission: {
        current: () => null,
        steer: async () => null,
        stop: async () => true,
      },
      onFederationPayload: (payload) => {
        received.push(payload);
        return { kind: "availability", status: "free", note: "Acked cleanly" };
      },
    });

    const jsonReq = (
      port: number,
      method: string,
      path: string,
      opts: { token?: string; session?: string; body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<{ status: number; json: Record<string, unknown> }> =>
      new Promise((resolve, reject) => {
        const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body);
        const r = request(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            rejectUnauthorized: false,
            agent: false,
            headers: {
              ...(bodyStr ? { "Content-Type": "application/json" } : {}),
              ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
              ...(opts.session ? { "X-Session": opts.session } : {}),
              ...opts.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              let parsed: Record<string, unknown> = {};
              try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
              } catch {
                // empty
              }
              resolve({ status: res.statusCode ?? 0, json: parsed });
            });
          },
        );
        r.on("error", reject);
        r.end(bodyStr);
      });

    try {
      await station.start();
      const port = Number(new URL(station.addresses()[0] ?? "").port);
      await station.setAccount("captain", "correct horse battery");

      // Pair a household member device (not owner) + pin a device cert hash.
      const { code } = station.beginPairing();
      const paired = await jsonReq(port, "POST", "/pair", { body: { code, name: "MemberTablet" } });
      expect(paired.status).toBe(200);
      const memberToken = String(paired.json["token"]);
      const memberDeviceId = String((paired.json["device"] as { id: string }).id);
      const pinHex = "ab".repeat(32);
      await station.setDeviceIdentity(memberDeviceId, {
        role: "member",
        userId: "alex",
        certSha256: pinHex,
      });
      household.registerProfile({
        userId: "alex",
        displayName: "Alex",
        role: "member",
        deviceIds: [memberDeviceId],
        memoryNamespace: "alex",
        calendarIds: [],
      });

      const signed = await jsonReq(port, "POST", "/sign-in", {
        token: memberToken,
        headers: { "x-client-cert-sha256": pinHex },
        body: { username: "captain", password: "correct horse battery" },
      });
      expect(signed.status).toBe(200);
      const session = String(signed.json["session"]);

      // Wrong cert pin rejected with 401.
      const wrongPin = await jsonReq(port, "POST", "/approve", {
        token: memberToken,
        session,
        headers: { "x-client-cert-sha256": "cd".repeat(32) },
        body: { id: "card_1234567890123456", allow: true },
      });
      expect(wrongPin.status).toBe(401);

      // Member role rejected with 403 on owner-only approve / mission steer routes.
      const forbiddenApprove = await jsonReq(port, "POST", "/approve", {
        token: memberToken,
        session,
        headers: { "x-client-cert-sha256": pinHex },
        body: { id: "card_1234567890123456", allow: true },
      });
      expect(forbiddenApprove.status).toBe(403);

      // TLS-pinned federation POST /api/federation over loopback HTTPS.
      const stationPinHex = (station.fingerprint() ?? "").replaceAll(":", "").toLowerCase();
      expect(stationPinHex).toMatch(/^[0-9a-f]{64}$/);

      const env = signFederationEnvelope(
        { kind: "task_handoff", title: "Print Done", summary: "Unload PLA plate", requestedBy: "Peer" },
        "peer-station",
        "this-station",
        aliceKeys.privateKey,
        nowMs,
      );
      const okFed = await sendFederationEnvelope(
        {
          id: "this-station",
          name: "Local",
          host: "127.0.0.1",
          port,
          fingerprintSha256: stationPinHex,
          publicKeyPem: aliceKeys.publicKey,
          enabled: true,
        },
        env,
      );
      expect(okFed.status).toBe(200);
      expect(okFed.body["ok"]).toBe(true);
      expect(received).toHaveLength(1);

      // Mismatched TLS fingerprint rejects before accepting HTTP response.
      const env2 = signFederationEnvelope(
        { kind: "availability", status: "free" },
        "peer-station",
        "this-station",
        aliceKeys.privateKey,
        nowMs,
      );
      await expect(
        sendFederationEnvelope(
          {
            id: "this-station",
            name: "Local",
            host: "127.0.0.1",
            port,
            fingerprintSha256: "f".repeat(64),
            publicKeyPem: aliceKeys.publicKey,
            enabled: true,
          },
          env2,
        ),
      ).rejects.toThrow(/fingerprint mismatch/);
    } finally {
      await station.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
