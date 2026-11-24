import { createHmac, timingSafeEqual } from "node:crypto";
import {
  changedBlockIndices,
  computeBlockGridLuma,
  SENSITIVE_WINDOW_RE,
  type VideoFrameInput,
} from "./multimodal.ts";
import { isPrivateLanHost, type WorkerNode } from "./workerMesh.ts";

/**
 * LAN-Offloaded Live Game & Workspace Vision Co-Pilot (`experimental`).
 *
 * Offloads visual reasoning from the gaming PC to a trusted secondary home server/laptop:
 * - Zero local GPU VRAM used (`0 MB` touched on the local gaming card).
 * - Samples frames at `0.5–1 FPS` and sends compact HMAC-SHA256-signed 8x8 dirty-tile
 *   luma deltas rather than full-rate raw video streams.
 * - Strictly refuses public hosts (`isPrivateLanHost`), untrusted peers (`fullMirrorTrusted: true`
 *   required), sensitive windows (password managers/banking/private flags), and `handsOff`/`away`.
 * - Server forwards summaries to a secondary-LAN OpenAI-compatible VLM endpoint and marks
 *   all resulting coaching cues unconditionally with `outsideText: true`.
 */

export interface LanVisionDeltaPacket {
  version: 1;
  nodeId: string;
  seq: number;
  sentAtMs: number;
  app: string;
  title: string;
  gridCols: 8;
  gridRows: 8;
  changedIndices: number[];
  /** Paired `[index, lumaValue]` pairs for dirty tiles only (<= 64 pairs). */
  dirtyTiles: Array<[number, number]>;
  keyframe: boolean;
  hmacHex: string;
}

export interface LanVisionCoachingResponse {
  accepted: boolean;
  reason?: string;
  cue?: {
    atMs: number;
    app: string;
    title: string;
    summary: string;
    changedRegions: number[];
    outsideText: true;
  };
}

function canonicalPayloadForHmac(p: Omit<LanVisionDeltaPacket, "hmacHex">): string {
  return JSON.stringify({
    v: p.version,
    n: p.nodeId,
    s: p.seq,
    t: p.sentAtMs,
    a: p.app,
    ti: p.title,
    c: p.changedIndices,
    d: p.dirtyTiles,
    k: p.keyframe,
  });
}

export function signLanVisionPacket(
  unsigned: Omit<LanVisionDeltaPacket, "hmacHex">,
  sharedSecret: string,
): LanVisionDeltaPacket {
  if (!sharedSecret || sharedSecret.length < 16) {
    throw new Error("LAN vision HMAC secret must be at least 16 characters.");
  }
  const hmacHex = createHmac("sha256", sharedSecret)
    .update(canonicalPayloadForHmac(unsigned))
    .digest("hex");
  return { ...unsigned, hmacHex };
}

export function verifyLanVisionPacket(
  packet: LanVisionDeltaPacket,
  sharedSecret: string,
  nowMs: number,
  maxSkewMs = 30_000,
): { ok: true } | { ok: false; reason: string } {
  if (packet.version !== 1 || !packet.hmacHex) {
    return { ok: false, reason: "Invalid LAN vision packet version or signature." };
  }
  if (Math.abs(nowMs - packet.sentAtMs) > maxSkewMs) {
    return { ok: false, reason: "LAN vision packet timestamp outside replay window." };
  }
  const expectedHex = createHmac("sha256", sharedSecret)
    .update(canonicalPayloadForHmac(packet))
    .digest("hex");
  const actualBuf = Buffer.from(packet.hmacHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (
    actualBuf.length !== expectedBuf.length ||
    !timingSafeEqual(actualBuf, expectedBuf)
  ) {
    return { ok: false, reason: "LAN vision HMAC authentication failed." };
  }
  return { ok: true };
}

/** Ensures target worker sits on a private LAN and is explicitly trusted for raw screen payloads. */
export function assertTrustedLanVisionPeer(node: Pick<WorkerNode, "host" | "fullMirrorTrusted">): void {
  if (!isPrivateLanHost(node.host)) {
    throw new Error(`Refusing non-LAN vision offload host "${node.host}".`);
  }
  if (!node.fullMirrorTrusted) {
    throw new Error(
      `Refusing LAN vision offload to "${node.host}": node lacks fullMirrorTrusted permission.`,
    );
  }
}

export class LanVisionOffloadClient {
  private readonly node: Pick<WorkerNode, "id" | "host" | "fullMirrorTrusted">;
  private readonly sharedSecret: string;
  private readonly fps: number;
  private readonly changeThreshold: number;
  private readonly maxPayloadBytes: number;

  private prevGrid: Uint8Array | null = null;
  private lastSentAtMs = -Infinity;
  private seq = 0;

  constructor(options: {
    node: Pick<WorkerNode, "id" | "host" | "fullMirrorTrusted">;
    sharedSecret: string;
    fps?: number;
    changeThreshold?: number;
    maxPayloadBytes?: number;
  }) {
    assertTrustedLanVisionPeer(options.node);
    if (!options.sharedSecret || options.sharedSecret.length < 16) {
      throw new Error("LAN vision shared secret must be at least 16 characters.");
    }
    this.node = options.node;
    this.sharedSecret = options.sharedSecret;
    // Clamp capture rate strictly to 0.5–1.0 FPS to preserve game frame times & LAN bandwidth.
    this.fps = Math.max(0.5, Math.min(1.0, options.fps ?? 1.0));
    this.changeThreshold = Math.max(0.01, Math.min(1.0, options.changeThreshold ?? 0.08));
    this.maxPayloadBytes = Math.max(512, options.maxPayloadBytes ?? 16_384);
  }

  /**
   * Samples a frame at <=1 FPS using 8x8 block deltas on CPU (0 MB local GPU VRAM).
   * Returns a signed delta packet ready for LAN transmission, or null when skipped/throttled.
   */
  encodeFrameIfDue(
    frame: VideoFrameInput,
    policy: { handsOff?: boolean; away?: boolean } = {},
  ): {
    packet: LanVisionDeltaPacket | null;
    reason: "hands_off" | "private" | "throttled" | "static" | "oversized" | "encoded";
  } {
    assertTrustedLanVisionPeer(this.node);
    if (policy.handsOff || policy.away) {
      return { packet: null, reason: "hands_off" };
    }
    if (
      frame.isPrivate ||
      SENSITIVE_WINDOW_RE.test(frame.app) ||
      SENSITIVE_WINDOW_RE.test(frame.title)
    ) {
      return { packet: null, reason: "private" };
    }
    const minIntervalMs = 1000 / this.fps;
    if (frame.atMs - this.lastSentAtMs < minIntervalMs) {
      return { packet: null, reason: "throttled" };
    }

    const currGrid = computeBlockGridLuma(frame.luma, frame.width, frame.height, 8, 8);
    const prevGrid = this.prevGrid;
    const isKeyframe = prevGrid === null;
    const changed = isKeyframe
      ? Array.from({ length: currGrid.length }, (_, idx) => idx)
      : changedBlockIndices(prevGrid, currGrid, this.changeThreshold);

    if (!isKeyframe && changed.length === 0) {
      this.lastSentAtMs = frame.atMs;
      return { packet: null, reason: "static" };
    }

    this.lastSentAtMs = frame.atMs;
    this.prevGrid = currGrid;
    this.seq += 1;

    const dirtyTiles: Array<[number, number]> = changed.map((idx) => [idx, currGrid[idx] ?? 0]);
    const packet = signLanVisionPacket(
      {
        version: 1,
        nodeId: this.node.id,
        seq: this.seq,
        sentAtMs: frame.atMs,
        app: frame.app.slice(0, 120),
        title: frame.title.slice(0, 180),
        gridCols: 8,
        gridRows: 8,
        changedIndices: changed,
        dirtyTiles,
        keyframe: isKeyframe,
      },
      this.sharedSecret,
    );

    if (Buffer.byteLength(JSON.stringify(packet), "utf8") > this.maxPayloadBytes) {
      return { packet: null, reason: "oversized" };
    }
    return { packet, reason: "encoded" };
  }
}

export class LanVisionOffloadServer {
  private readonly sharedSecret: string;
  private readonly vlmEndpointUrl: URL;
  private readonly vlmModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly lastSeqByNode = new Map<string, number>();
  private readonly reconstructedGridByNode = new Map<string, Uint8Array>();

  constructor(options: {
    sharedSecret: string;
    vlmEndpointUrl: string;
    vlmModel?: string;
    fetchImpl?: typeof fetch;
  }) {
    if (!options.sharedSecret || options.sharedSecret.length < 16) {
      throw new Error("LAN vision shared secret must be at least 16 characters.");
    }
    const parsed = new URL(options.vlmEndpointUrl);
    if (!isPrivateLanHost(parsed.hostname)) {
      throw new Error(
        `Refusing non-LAN VLM endpoint "${parsed.hostname}"; secondary vision server must reside on private LAN.`,
      );
    }
    this.sharedSecret = options.sharedSecret;
    this.vlmEndpointUrl = parsed;
    this.vlmModel = options.vlmModel ?? "local-vlm";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Verifies HMAC + monotonic replay protection and forwards delta summary to local LAN VLM. */
  async ingestPacket(
    packet: LanVisionDeltaPacket,
    options: { nowMs?: number } = {},
  ): Promise<LanVisionCoachingResponse> {
    const nowMs = options.nowMs ?? Date.now();
    const auth = verifyLanVisionPacket(packet, this.sharedSecret, nowMs);
    if (!auth.ok) {
      return { accepted: false, reason: auth.reason };
    }
    const prevSeq = this.lastSeqByNode.get(packet.nodeId) ?? 0;
    if (packet.seq <= prevSeq) {
      return { accepted: false, reason: `Stale replay sequence ${packet.seq} <= ${prevSeq}.` };
    }
    if (SENSITIVE_WINDOW_RE.test(packet.app) || SENSITIVE_WINDOW_RE.test(packet.title)) {
      return { accepted: false, reason: "Sensitive window refused on offload server." };
    }

    this.lastSeqByNode.set(packet.nodeId, packet.seq);
    const grid = this.reconstructedGridByNode.get(packet.nodeId) ?? new Uint8Array(64);
    for (const [idx, val] of packet.dirtyTiles) {
      if (idx >= 0 && idx < 64) {
        grid[idx] = Math.max(0, Math.min(255, Math.round(val)));
      }
    }
    this.reconstructedGridByNode.set(packet.nodeId, grid);

    let summary = `[${packet.app}] ${packet.title}: ${packet.changedIndices.length} tile(s) updated on LAN co-pilot.`;
    try {
      const chatUrl = new URL("/v1/chat/completions", this.vlmEndpointUrl);
      const res = await this.fetchImpl(chatUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.vlmModel,
          max_tokens: 96,
          messages: [
            {
              role: "system",
              content: "Summarize concise gameplay/workspace visual observation in one short sentence.",
            },
            {
              role: "user",
              content: `App=${packet.app}; Title=${packet.title}; ChangedTiles=${packet.changedIndices.join(",")}; MeanLuma=${Math.round(grid.reduce((s, v) => s + v, 0) / 64)}`,
            },
          ],
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = json.choices?.[0]?.message?.content?.trim();
        if (content) summary = content.slice(0, 300);
      }
    } catch {
      // Keep deterministic tile summary if secondary VLM is temporarily warming.
    }

    return {
      accepted: true,
      cue: {
        atMs: packet.sentAtMs,
        app: packet.app,
        title: packet.title,
        summary,
        changedRegions: [...packet.changedIndices],
        outsideText: true,
      },
    };
  }
}
