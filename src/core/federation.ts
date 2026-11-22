import { createHash, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { canonicalJsonBytes } from "./pluginSdk.ts";
import { withoutSecrets } from "./secrets.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Station-to-Station Opt-In LAN/VPN Federation (ai_chan_plan.pdf p. 16).
 *
 * Exchanges strictly scoped availability and task handoff summaries between paired
 * household AI-chan stations over private LAN/VPN links with Ed25519 authentication
 * and anti-replay nonces. Never exchanges desktop chats, screens, or notifications.
 */

export const MAX_FEDERATION_SKEW_MS = 120_000;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export interface PeerStation {
  id: string;
  name: string;
  host: string;
  port: number;
  fingerprintSha256: string;
  publicKeyPem: string;
  enabled: boolean;
}

export type FederationPayload =
  | {
      kind: "availability";
      status: "free" | "busy" | "away";
      note?: string;
    }
  | {
      kind: "task_handoff";
      title: string;
      summary: string;
      requestedBy: string;
    };

export interface FederationEnvelope {
  senderId: string;
  peerId: string;
  issuedAtMs: number;
  nonce: string;
  payload: FederationPayload;
  signature: string;
}

function cleanText(raw: unknown, maxChars: number): string {
  if (typeof raw !== "string") return "";
  return withoutSecrets(
    raw.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[redacted-image]"),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** Strictly whitelists only `availability` or `task_handoff` fields and scrubs secrets/images. */
export function sanitizeFederationPayload(
  raw: Record<string, unknown>,
): FederationPayload | null {
  if (raw["kind"] === "availability") {
    const status = raw["status"];
    if (status !== "free" && status !== "busy" && status !== "away") return null;
    const note = cleanText(raw["note"], 240);
    return note ? { kind: "availability", status, note } : { kind: "availability", status };
  }
  if (raw["kind"] === "task_handoff") {
    const title = cleanText(raw["title"], 120);
    const summary = cleanText(raw["summary"], 600);
    const requestedBy = cleanText(raw["requestedBy"], 80);
    if (!title || !summary || !requestedBy) return null;
    return { kind: "task_handoff", title, summary, requestedBy };
  }
  return null;
}

function envelopeBodyBytes(envelope: Omit<FederationEnvelope, "signature">): Buffer {
  return canonicalJsonBytes({
    senderId: envelope.senderId,
    peerId: envelope.peerId,
    issuedAtMs: envelope.issuedAtMs,
    nonce: envelope.nonce,
    payload: envelope.payload,
  });
}

/** Signs an outgoing federation payload using an Ed25519 private key PEM. */
export function signFederationEnvelope(
  payload: FederationPayload,
  senderId: string,
  peerId: string,
  privateKeyPem: string,
  nowMs = Date.now(),
): FederationEnvelope {
  const unsigned: Omit<FederationEnvelope, "signature"> = {
    senderId,
    peerId,
    issuedAtMs: Math.trunc(nowMs),
    nonce: randomBytes(12).toString("hex"),
    payload,
  };
  const signature = sign(null, envelopeBodyBytes(unsigned), privateKeyPem).toString("base64");
  return { ...unsigned, signature };
}

/** Verifies Ed25519 signature, 120s timestamp skew, and nonce replay uniqueness. */
export function verifyFederationEnvelope(
  envelope: FederationEnvelope,
  publicKeyPem: string,
  nowMs = Date.now(),
  seenNonces?: Set<string>,
): { valid: boolean; reason?: string } {
  if (Math.abs(nowMs - envelope.issuedAtMs) > MAX_FEDERATION_SKEW_MS) {
    return { valid: false, reason: "Federation envelope timestamp outside allowed skew window." };
  }
  if (!envelope.nonce || envelope.nonce.length < 8) {
    return { valid: false, reason: "Invalid federation replay nonce." };
  }
  const nonceKey = `${envelope.senderId}:${envelope.nonce}`;
  if (seenNonces?.has(nonceKey)) {
    return { valid: false, reason: "Replayed federation nonce rejected." };
  }

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(envelope.signature, "base64");
  } catch {
    return { valid: false, reason: "Malformed federation signature encoding." };
  }
  try {
    const ok = verify(null, envelopeBodyBytes(envelope), publicKeyPem, sigBytes);
    if (!ok) return { valid: false, reason: "Federation Ed25519 signature invalid." };
  } catch {
    return { valid: false, reason: "Federation public key verification error." };
  }
  seenNonces?.add(nonceKey);
  return { valid: true };
}

export class StationFederation {
  enabled: boolean;
  private readonly peers = new Map<string, PeerStation>();
  private readonly seenNonces = new Set<string>();

  constructor(options: { enabled?: boolean } = {}) {
    this.enabled = options.enabled ?? false;
  }

  /** Registers a paired peer station after validating private LAN/VPN host and TLS pin. */
  registerPeer(peer: PeerStation): void {
    if (!isPrivateLanHost(peer.host)) {
      throw new Error(`Refused non-LAN federation peer host "${peer.host}".`);
    }
    if (!SHA256_HEX.test(peer.fingerprintSha256)) {
      throw new Error(`Peer "${peer.name}" requires a valid 64-hex SHA-256 TLS fingerprint.`);
    }
    if (!Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65535) {
      throw new Error(`Peer "${peer.name}" has an invalid port (${peer.port}).`);
    }
    this.peers.set(peer.id, { ...peer });
  }

  listPeers(): PeerStation[] {
    return [...this.peers.values()];
  }

  prepareOutgoing(
    peerId: string,
    rawPayload: Record<string, unknown>,
    senderId: string,
    privateKeyPem: string,
    nowMs = Date.now(),
  ): FederationEnvelope {
    if (!this.enabled) {
      throw new Error("Station-to-station federation is disabled in Tier 10 settings.");
    }
    const peer = this.peers.get(peerId);
    if (!peer || !peer.enabled) {
      throw new Error(`Federation peer "${peerId}" is unknown or disabled.`);
    }
    const payload = sanitizeFederationPayload(rawPayload);
    if (!payload) {
      throw new Error("Federation payload is invalid or missing required fields.");
    }
    return signFederationEnvelope(payload, senderId, peer.id, privateKeyPem, nowMs);
  }

  receiveIncoming(
    envelope: FederationEnvelope,
    nowMs = Date.now(),
  ): { accepted: boolean; payload?: FederationPayload; reason?: string } {
    if (!this.enabled) {
      return { accepted: false, reason: "Station-to-station federation is disabled." };
    }
    const peer = this.peers.get(envelope.senderId);
    if (!peer || !peer.enabled) {
      return { accepted: false, reason: `Unknown or disabled federation peer "${envelope.senderId}".` };
    }
    const sigCheck = verifyFederationEnvelope(envelope, peer.publicKeyPem, nowMs, this.seenNonces);
    if (!sigCheck.valid) {
      return { accepted: false, reason: sigCheck.reason };
    }
    const sanitized = sanitizeFederationPayload(
      envelope.payload as unknown as Record<string, unknown>,
    );
    if (!sanitized) {
      return { accepted: false, reason: "Rejected invalid federation payload content." };
    }
    return { accepted: true, payload: sanitized };
  }
}

/**
 * Sends a signed federation envelope over HTTPS to a private-LAN peer's `/api/federation`
 * endpoint while enforcing SHA-256 TLS certificate fingerprint pinning via `timingSafeEqual`.
 */
export function sendFederationEnvelope(
  peer: PeerStation,
  envelope: FederationEnvelope,
  options?: { timeoutMs?: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isPrivateLanHost(peer.host)) {
    return Promise.reject(
      new Error(`Refused non-LAN federation peer host "${peer.host}".`),
    );
  }
  if (!SHA256_HEX.test(peer.fingerprintSha256)) {
    return Promise.reject(
      new Error(`Peer "${peer.name}" requires a valid 64-hex SHA-256 TLS fingerprint.`),
    );
  }
  const expectedPin = Buffer.from(peer.fingerprintSha256.toLowerCase(), "hex");
  const payload = JSON.stringify(envelope);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = httpsRequest(
      {
        host: peer.host,
        port: peer.port,
        path: "/api/federation",
        method: "POST",
        rejectUnauthorized: false,
        agent: false,
        timeout: options?.timeoutMs ?? 8_000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload, "utf8"),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString("utf8");
          let body: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              body = parsed as Record<string, unknown>;
            }
          } catch {
            // plain/empty response body
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );

    req.on("socket", (socket) => {
      socket.on("secureConnect", () => {
        const tlsSocket = socket as TLSSocket;
        const cert = tlsSocket.getPeerCertificate(false);
        const raw = cert?.raw;
        if (!raw) {
          const err = new Error(`Peer "${peer.name}" presented no TLS certificate.`);
          socket.destroy(err);
          fail(err);
          return;
        }
        const actualPin = createHash("sha256").update(raw).digest();
        if (actualPin.length !== expectedPin.length || !timingSafeEqual(actualPin, expectedPin)) {
          const err = new Error(`TLS fingerprint mismatch for federation peer "${peer.name}".`);
          socket.destroy(err);
          fail(err);
        }
      });
    });

    req.on("timeout", () => {
      const err = new Error(`Federation request to peer "${peer.name}" timed out.`);
      req.destroy(err);
      fail(err);
    });
    req.on("error", (err) => fail(err));
    req.end(payload);
  });
}
