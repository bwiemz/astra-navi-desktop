import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { sanitizeHandoff } from "./continuity.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Encrypted Peer-to-Peer LAN State Sync Engine (Tier 10 §5).
 *
 * Synchronizes sanitized session handoffs, user preferences, and pinned state records
 * across paired LAN/Tailscale Astra Navi nodes using:
 * - Deterministic Last-Write-Wins (LWW) CRDT merge (timestamp + originNodeId tiebreak)
 * - Encrypt-then-sign envelopes (AES-256-GCM confidentiality + Ed25519 authenticity)
 * - Strict loopback/RFC1918/CGNAT LAN host gating (`isPrivateLanHost`)
 * - Secret & raw-dump scrubbing (`sanitizeHandoff` + secret redaction)
 */

export interface SyncRecord {
  key: string;
  namespace: string;
  value: unknown;
  updatedAtMs: number;
  originNodeId: string;
  deleted: boolean;
}

export interface EncryptedSyncEnvelope {
  version: 1;
  senderNodeId: string;
  sentAtMs: number;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
  sigB64: string;
}

export interface PeerNodeKeypair {
  nodeId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface PeerSyncOptions {
  nodeId: string;
  sharedSecret: Uint8Array;
  privateKeyPem: string;
  publicKeyPem: string;
  trustedPeers?: Record<string, string>;
  now?: () => number;
  maxClockSkewMs?: number;
}

const DEFAULT_MAX_SKEW_MS = 5 * 60_000;
const MAX_HTTP_BODY_BYTES = 512 * 1024;

/** Redacts common API tokens, bearer credentials, and private key markers before peer sync. */
export function scrubSecretsForSync(text: string): string {
  return text
    .replace(/\bsk-(?:live-|proj-)?[A-Za-z0-9_-]{12,}\b/g, "[redacted-secret]")
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[redacted-secret]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [redacted-token]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-key]");
}

/** Generates an Ed25519 node signing identity for encrypted LAN P2P sync. */
export function generatePeerKeypair(nodeId: string): PeerNodeKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    nodeId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function envelopeAad(envelope: Pick<EncryptedSyncEnvelope, "version" | "senderNodeId" | "sentAtMs">): Buffer {
  return Buffer.from(`astranavi-sync:${envelope.version}:${envelope.senderNodeId}:${envelope.sentAtMs}`, "utf8");
}

function canonicalSignPayload(
  envelope: Omit<EncryptedSyncEnvelope, "sigB64">,
): Buffer {
  return Buffer.from(
    [
      String(envelope.version),
      envelope.senderNodeId,
      String(envelope.sentAtMs),
      envelope.ivB64,
      envelope.tagB64,
      envelope.ciphertextB64,
    ].join("|"),
    "utf8",
  );
}

function recordStorageKey(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`;
}

function isValidSyncRecord(item: unknown): item is SyncRecord {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r["key"] === "string" &&
    r["key"].length > 0 &&
    typeof r["namespace"] === "string" &&
    typeof r["updatedAtMs"] === "number" &&
    Number.isFinite(r["updatedAtMs"]) &&
    typeof r["originNodeId"] === "string" &&
    r["originNodeId"].length > 0 &&
    typeof r["deleted"] === "boolean"
  );
}

export class PeerStateSyncEngine {
  readonly nodeId: string;
  readonly publicKeyPem: string;
  private readonly sharedKey: Buffer;
  private readonly privateKeyPem: string;
  private readonly trustedPeers = new Map<string, string>();
  private readonly records = new Map<string, SyncRecord>();
  private readonly now: () => number;
  private readonly maxClockSkewMs: number;

  constructor(options: PeerSyncOptions) {
    if (options.sharedSecret.length !== 32) {
      throw new Error("PeerStateSyncEngine requires a 32-byte (256-bit) sharedSecret.");
    }
    this.nodeId = options.nodeId;
    this.sharedKey = Buffer.from(options.sharedSecret);
    this.privateKeyPem = options.privateKeyPem;
    this.publicKeyPem = options.publicKeyPem;
    this.now = options.now ?? (() => Date.now());
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_SKEW_MS;
    this.trustedPeers.set(this.nodeId, this.publicKeyPem);
    for (const [peerId, pem] of Object.entries(options.trustedPeers ?? {})) {
      this.trustedPeers.set(peerId, pem);
    }
  }

  trustPeer(peerNodeId: string, publicKeyPem: string): void {
    this.trustedPeers.set(peerNodeId, publicKeyPem);
  }

  put(key: string, namespace: string, value: unknown, updatedAtMs = this.now()): SyncRecord {
    const rec: SyncRecord = {
      key: key.slice(0, 160),
      namespace: namespace.slice(0, 80),
      value,
      updatedAtMs,
      originNodeId: this.nodeId,
      deleted: false,
    };
    this.mergeRecords([rec]);
    return rec;
  }

  delete(key: string, namespace: string, updatedAtMs = this.now()): SyncRecord {
    const rec: SyncRecord = {
      key: key.slice(0, 160),
      namespace: namespace.slice(0, 80),
      value: null,
      updatedAtMs,
      originNodeId: this.nodeId,
      deleted: true,
    };
    this.mergeRecords([rec]);
    return rec;
  }

  get(namespace: string, key: string): SyncRecord | null {
    const rec = this.records.get(recordStorageKey(namespace, key));
    return rec && !rec.deleted ? rec : null;
  }

  allRecords(includeDeleted = true): SyncRecord[] {
    const out = [...this.records.values()];
    return includeDeleted ? out : out.filter((r) => !r.deleted);
  }

  /** Merges incoming LWW CRDT records deterministically. Returns count of newly accepted records. */
  mergeRecords(incoming: readonly SyncRecord[]): number {
    let applied = 0;
    for (const next of incoming) {
      if (!isValidSyncRecord(next)) continue;
      const sk = recordStorageKey(next.namespace, next.key);
      const current = this.records.get(sk);
      const shouldTake =
        !current ||
        next.updatedAtMs > current.updatedAtMs ||
        (next.updatedAtMs === current.updatedAtMs &&
          next.originNodeId.localeCompare(current.originNodeId) > 0);
      if (shouldTake) {
        this.records.set(sk, {
          key: next.key,
          namespace: next.namespace,
          value: next.deleted ? null : next.value,
          updatedAtMs: next.updatedAtMs,
          originNodeId: next.originNodeId,
          deleted: next.deleted,
        });
        applied += 1;
      }
    }
    return applied;
  }

  /** Exports sanitized session handoff data stripped of forbidden desktop dumps and secrets. */
  exportSanitizedHandoff(rawHandoff: Record<string, unknown>, handoffId = "latest"): SyncRecord {
    const cleaned = sanitizeHandoff(rawHandoff);
    const scrubbed = scrubSecretsForSync(cleaned.summary);
    return this.put(
      `handoff:${handoffId}`,
      "handoff",
      {
        summary: scrubbed,
        ...(cleaned.missionId ? { missionId: cleaned.missionId } : {}),
      },
      this.now(),
    );
  }

  /** Encrypts (AES-256-GCM) and signs (Ed25519) records into an authenticated LAN envelope. */
  exportEncryptedEnvelope(subset?: readonly SyncRecord[]): EncryptedSyncEnvelope {
    const payloadRecords = subset ? [...subset] : this.allRecords(true);
    const sentAtMs = this.now();
    const iv = randomBytes(12);
    const unsignedMeta = {
      version: 1 as const,
      senderNodeId: this.nodeId,
      sentAtMs,
    };
    const cipher = createCipheriv("aes-256-gcm", this.sharedKey, iv);
    cipher.setAAD(envelopeAad(unsignedMeta));
    const plaintext = Buffer.from(JSON.stringify(payloadRecords), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const bodyForSig: Omit<EncryptedSyncEnvelope, "sigB64"> = {
      ...unsignedMeta,
      ivB64: iv.toString("base64"),
      tagB64: tag.toString("base64"),
      ciphertextB64: ciphertext.toString("base64"),
    };
    const signature = sign(null, canonicalSignPayload(bodyForSig), this.privateKeyPem);
    return {
      ...bodyForSig,
      sigB64: signature.toString("base64"),
    };
  }

  /** Verifies Ed25519 signature, clock window, and AES-GCM tag, then merges LWW records. */
  importEncryptedEnvelope(envelope: EncryptedSyncEnvelope): {
    ok: boolean;
    applied: number;
    records: SyncRecord[];
    reason?: string;
  } {
    if (envelope.version !== 1) {
      return { ok: false, applied: 0, records: [], reason: "Unsupported sync envelope version." };
    }
    const peerPub = this.trustedPeers.get(envelope.senderNodeId);
    if (!peerPub) {
      return {
        ok: false,
        applied: 0,
        records: [],
        reason: `Untrusted sync sender "${envelope.senderNodeId}".`,
      };
    }
    const skew = Math.abs(this.now() - envelope.sentAtMs);
    if (!Number.isFinite(skew) || skew > this.maxClockSkewMs) {
      return {
        ok: false,
        applied: 0,
        records: [],
        reason: `Envelope timestamp outside allowed skew window (${skew}ms).`,
      };
    }

    let sigOk: boolean;
    try {
      const unsigned: Omit<EncryptedSyncEnvelope, "sigB64"> = {
        version: envelope.version,
        senderNodeId: envelope.senderNodeId,
        sentAtMs: envelope.sentAtMs,
        ivB64: envelope.ivB64,
        tagB64: envelope.tagB64,
        ciphertextB64: envelope.ciphertextB64,
      };
      sigOk = verify(
        null,
        canonicalSignPayload(unsigned),
        peerPub,
        Buffer.from(envelope.sigB64, "base64"),
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return { ok: false, applied: 0, records: [], reason: "Invalid Ed25519 envelope signature." };
    }

    try {
      const iv = Buffer.from(envelope.ivB64, "base64");
      const tag = Buffer.from(envelope.tagB64, "base64");
      const ciphertext = Buffer.from(envelope.ciphertextB64, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.sharedKey, iv);
      decipher.setAAD(envelopeAad(envelope));
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      );
      const parsed: unknown = JSON.parse(decrypted);
      if (!Array.isArray(parsed)) {
        return { ok: false, applied: 0, records: [], reason: "Decrypted sync payload is not an array." };
      }
      const valid = parsed.filter(isValidSyncRecord);
      const applied = this.mergeRecords(valid);
      return { ok: true, applied, records: valid };
    } catch {
      return {
        ok: false,
        applied: 0,
        records: [],
        reason: "AES-256-GCM authentication or decryption failed.",
      };
    }
  }

  /** Handles HTTP LAN peer sync endpoints (`/sync/state`, `/sync/merge`). */
  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sendJson = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    if (req.method === "GET" && req.url === "/sync/state") {
      sendJson(200, { ok: true, nodeId: this.nodeId, envelope: this.exportEncryptedEnvelope() });
      return;
    }

    if (req.method === "POST" && req.url === "/sync/merge") {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > MAX_HTTP_BODY_BYTES) {
          sendJson(413, { ok: false, reason: "Sync payload exceeded 512 KiB limit." });
          return;
        }
        chunks.push(buf);
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          envelope?: EncryptedSyncEnvelope;
        };
        if (!parsed.envelope) {
          sendJson(400, { ok: false, reason: "Missing `envelope` object." });
          return;
        }
        const imported = this.importEncryptedEnvelope(parsed.envelope);
        if (!imported.ok) {
          sendJson(403, { ok: false, reason: imported.reason ?? "Rejected sync envelope." });
          return;
        }
        sendJson(200, {
          ok: true,
          nodeId: this.nodeId,
          applied: imported.applied,
          count: this.records.size,
          responseEnvelope: this.exportEncryptedEnvelope(),
        });
      } catch {
        sendJson(400, { ok: false, reason: "Invalid JSON body." });
      }
      return;
    }

    sendJson(404, { ok: false, reason: "Not found." });
  }
}

/** Exchanging encrypted CRDT state strictly with a private-LAN / loopback / Tailscale peer. */
export async function syncWithLanPeer(options: {
  engine: PeerStateSyncEngine;
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; appliedFromPeer: number; totalLocal: number; statusCode?: number; reason?: string }> {
  const host = options.host.trim();
  if (!isPrivateLanHost(host)) {
    throw new Error(`Refused sync target "${host}": only private LAN / loopback / Tailscale hosts are permitted.`);
  }
  const envelope = options.engine.exportEncryptedEnvelope();
  const body = JSON.stringify({ envelope });
  const timeoutMs = options.timeoutMs ?? 6_000;

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: host,
        port: options.port,
        path: "/sync/merge",
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const data = JSON.parse(raw) as {
              ok?: boolean;
              reason?: string;
              responseEnvelope?: EncryptedSyncEnvelope;
            };
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || !data.ok) {
              resolve({
                ok: false,
                appliedFromPeer: 0,
                totalLocal: options.engine.allRecords(true).length,
                ...(res.statusCode !== undefined ? { statusCode: res.statusCode } : {}),
                reason: data.reason ?? `HTTP ${res.statusCode ?? 0}`,
              });
              return;
            }
            let appliedFromPeer = 0;
            if (data.responseEnvelope) {
              const resImport = options.engine.importEncryptedEnvelope(data.responseEnvelope);
              if (!resImport.ok) {
                resolve({
                  ok: false,
                  appliedFromPeer: 0,
                  totalLocal: options.engine.allRecords(true).length,
                  statusCode: res.statusCode,
                  reason: resImport.reason ?? "Invalid response envelope.",
                });
                return;
              }
              appliedFromPeer = resImport.applied;
            }
            resolve({
              ok: true,
              appliedFromPeer,
              totalLocal: options.engine.allRecords(true).length,
              statusCode: res.statusCode,
            });
          } catch {
            resolve({
              ok: false,
              appliedFromPeer: 0,
              totalLocal: options.engine.allRecords(true).length,
              ...(res.statusCode !== undefined ? { statusCode: res.statusCode } : {}),
              reason: "Malformed JSON response from peer.",
            });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Sync request to ${host}:${options.port} timed out.`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
