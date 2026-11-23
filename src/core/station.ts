import { execFile } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { createServer as createDoor, isIP, type Server as Door, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import type {
  FederationEnvelope,
  FederationPayload,
  StationFederation,
} from "./federation.ts";
import type { HouseholdIsolationManager, HouseholdRole } from "./household.ts";
import { isPrivateIpv4 } from "./permissions.ts";
import type { ApprovalCard } from "./missionApproval.ts";
import type { PinnedMissionView } from "./missionPlan.ts";
import { StationAccount } from "./stationAccount.ts";
import { stationPage } from "./stationPage.ts";
import type { ShownTrace } from "./trace.ts";
import { decodeAudioTo16kMono, MAX_VOICE_BYTES } from "./voiceWav.ts";

/**
 * Her station: a small page she serves on the home network, so Captain's other devices
 * (a phone, a laptop) can talk to her while the PC sits in another room.
 *
 * It is built to be reachable by the household and by nobody else:
 * - Only addresses on this computer or the local network are answered at all.
 * - Everything travels encrypted, under a certificate made on this computer. No authority
 *   vouches for it, so a device warns the first time; the fingerprint shown on the PC is
 *   how the two are compared by eye.
 * - A device gets in by typing a six-digit code that is on the PC's screen for five
 *   minutes. In return it is given a long random token. Only a hash of that token is kept
 *   here, so reading her files does not yield a working token.
 * - Being paired is not enough to use her: whoever holds the device signs in with the
 *   name and password set at the PC, every time the page or the app is opened (see
 *   `stationAccount.ts`). Until one is set, a paired device can do nothing but say so.
 * - A device can talk to her and stop her. Questions she asks before acting in a
 *   conversation are answered at the PC and nowhere else. The one thing a device may
 *   say yes or no to is a step of a mission the user set going at the PC, and then
 *   only freshly signed in: within a few minutes of giving the password or passing
 *   the phone's own check (see `offerApproval`).
 */

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  certSha256?: string;
  role?: HouseholdRole;
  userId?: string;
}

export interface StationAlert {
  id: string;
  kind: "order";
  title: string;
  body: string;
  at: string;
}

export type StationEvent =
  /** A message from any device or the PC, shown in the thread. */
  | { type: "said"; text: string; from: string }
  | { type: "reply-start" }
  | { type: "text"; delta: string }
  | { type: "reply-end" }
  | { type: "mood"; mood: string }
  | { type: "activity"; label: string }
  | { type: "status"; state: "idle" | "thinking" }
  | { type: "caution"; message: string }
  /** An approval is waiting on the PC; it cannot be answered from here. */
  | { type: "needs-captain"; title: string }
  /** She spoke first (a reminder came due, a job finished). */
  | { type: "event"; text: string }
  /** A mission's step is waiting for a yes or no, which this device may give. */
  | { type: "approval"; card: ApprovalCard }
  /** That question has been answered or taken down. */
  | { type: "approval-gone"; id: string }
  /** The one mission thread explicitly pinned at the PC for paired devices. */
  | { type: "pinned-mission"; mission: PinnedMissionView | null }
  /** A triggered standing-order alert safe to show on paired phones. */
  | { type: "alert"; alert: StationAlert };

export interface StationDeps {
  /** A private folder for the certificate, its key and the list of paired devices. */
  dir: string;
  port: number;
  /** A message typed on another device. */
  /** Returning false means the message was not taken (she is too busy); the device is told so. */
  onSay(text: string, device: PairedDevice): boolean;
  onStop(device: PairedDevice): void;
  /** The last few exchanges, shown when a device connects. */
  recent?(): { said: string; reply: string; at: string }[];
  now?(): number;
  /**
   * The phone app, when it has been built on this computer: the file to hand to a paired
   * phone that asks for it. Null or left out: no app is offered.
   */
  phoneApp?(): { file: string; version: string } | null;
  /** A device was paired or unpaired: whatever shows how many there are is out of date. */
  onDevicesChanged?(): void;
  /**
   * The questions about mission steps that are open now and may be answered from a
   * device, and the way to answer one. Left out: devices are offered none.
   */
  approvals?: {
    cards(): ApprovalCard[];
    /** True when the answer settled the question. */
    answer(id: string, allowed: boolean, device: PairedDevice): boolean;
  };
  /**
   * The single mission explicitly pinned at the PC so paired devices can follow its
   * thread, add steering notes, or stop it. Pinning, unpinning and resuming stay at the PC.
   */
  pinnedMission?: {
    current(): PinnedMissionView | null;
    steer(missionId: string, note: string, device: PairedDevice): Promise<PinnedMissionView | null>;
    stop(missionId: string, device: PairedDevice): Promise<boolean>;
  };
  /** Per-turn traces for messages sent from paired devices (never desktop PC chat or notifications). */
  traces?(): ShownTrace[];
  /** Triggered standing-order alerts (never desktop notifications, screen captures, or local chat). */
  alerts?(sinceId?: string): StationAlert[];
  /** Transcribes a 16 kHz mono voice note from a signed-in device into text. */
  onVoice?(samples: Float32Array, device: PairedDevice): Promise<string>;
  /** Local LAN webhook push into the Tier 10 event bus (default-off when omitted). */
  onWebhook?(event: { topic: string; data: Record<string, unknown>; device: PairedDevice }): boolean;
  /** Optional multi-user household isolation manager enforcing owner-only routes & per-user roles. */
  household?: HouseholdIsolationManager;
  /** Optional station-to-station LAN/VPN federation manager (`POST /api/federation`). */
  federation?: StationFederation;
  /** Optional handler invoked after accepting a signed federation envelope. */
  onFederationPayload?(
    payload: FederationPayload,
    senderId: string,
  ): Promise<FederationPayload | undefined> | FederationPayload | undefined;
  /**
   * Whoever holds a paired device asked for the sign-in password to be reset. Nothing
   * has been changed: the person at the PC is to be told, and may set a new one there.
   */
  onResetAsked?(device: PairedDevice): void;
  /** For tests: how the certificate is made. By default openssl makes it. */
  makeCertificate?(dir: string, addresses: string[]): Promise<void>;
  /** scrypt's N for the sign-in password. For tests; left out, the account's own. */
  passwordCost?: number;
  /** For tests: the addresses to listen for. By default this machine's private IPv4 addresses. */
  localAddresses?(): string[];
}

/** What a connected device is sent besides the events themselves. */
type Wire =
  | StationEvent
  /** `app` is true when the phone app has been built on the PC and can be downloaded. */
  | { type: "hello"; device: string; app: boolean }
  /** The session this connection was opened under has ended: the page asks to sign in again. */
  | { type: "signed-out" }
  | { type: "recent"; exchanges: { said: string; reply: string; at: string }[] };

interface StoredDevice extends PairedDevice {
  /** SHA-256 of the device's token, in hex. The token itself is never kept. */
  tokenHash: string;
}

interface OpenStream {
  response: ServerResponse;
  deviceId: string;
  /** The session it was opened under; the connection ends when that does. */
  session: string;
  heartbeat: NodeJS.Timeout;
}

const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const DEVICES_FILE = "devices.json";

const MAX_BODY_BYTES = 8 * 1024;
export const MAX_SAY_CHARS = 2000;
export const MAX_DEVICES = 6;
const MAX_NAME_CHARS = 40;
const PAIRING_MS = 5 * 60_000;
const WRONG_CODES_ALLOWED = 5;
const MAX_STREAMS = 8;
const MAX_STREAMS_PER_DEVICE = 2;
const HEARTBEAT_MS = 25_000;
const SAYS_PER_MINUTE = 12;
const FAILED_AUTH_PER_MINUTE = 10;
const MINUTE_MS = 60_000;
const SEEN_EVERY_MS = 60_000;
const RECENT_SHOWN = 10;
/** A device that lets this much pile up unread has stopped listening; it is let go. */
const MAX_UNSENT_BYTES = 1024 * 1024;
/** How much of a reply under way is kept for a device that connects in the middle of it. */
const MAX_REPLY_KEPT_CHARS = 20_000;

const WRONG_CODE = "That code is wrong or has expired.";
const NOT_PAIRED = "This device is not paired with her.";
const TOO_MANY_TRIES = "Too many tries. Wait a minute.";
const NO_ACCOUNT =
  "No name and password have been set for her station yet. Set them on the PC, in her settings under Devices.";
const SIGN_IN_FIRST = "Sign in first.";
const WRONG_SIGN_IN = "That name or password is not right.";
const WRONG_UNLOCK = "This device has to sign in with the password.";
const KEY_NEEDS_THE_PASSWORD =
  "Sign out, sign in with the password, and switch this on within five minutes of doing so.";
const ONE_TRY_AT_A_TIME = "The last try is still being checked. Wait a moment.";

/** A refusal with the status it is answered with. Its message is shown on the device. */
class Refusal extends Error {
  readonly status: number;
  /**
   * What the device has to do first, for the page to show the right thing: set an
   * account at the PC, sign in, or (to be given a key of its own) type the password.
   */
  readonly need: "account" | "sign-in" | "password" | null;

  constructor(
    status: number,
    message: string,
    need: "account" | "sign-in" | "password" | null = null,
  ) {
    super(message);
    this.status = status;
    this.need = need;
  }
}

/** Counts how often something happened lately, per key: the basis of every limit here. */
class Tally {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length > 0) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  /** True once the limit has been reached for this key. */
  over(key: string, now: number): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  add(key: string, now: number): void {
    const kept = this.recent(key, now);
    kept.push(now);
    this.hits.set(key, kept);
    // Many different keys (addresses) must not make this grow without end.
    if (this.hits.size > 500) {
      for (const other of [...this.hits.keys()]) this.recent(other, now);
    }
  }
}

/** The plain IPv4 address inside the form a connection reports ("::ffff:192.168.1.5"), or the address as it is. */
function plainAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

/**
 * True for a caller on this computer or on the local network: the only ones she answers.
 * The ranges are the ones home networks and private VPN meshes use; anything else,
 * including every address on the public internet, is refused before it can say a word.
 */
export function isAllowedClient(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  const plain = plainAddress(address);
  if (isIP(plain) !== 4 || !isPrivateIpv4(plain)) return false;
  const [a, b] = plain.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // private VPN meshes hand out these
  );
}

/**
 * True when the request names this station by a bare address ("192.168.1.5:47821") or as
 * localhost. A page elsewhere that has pointed its own name at this computer is turned away.
 */
export function namesAnAddress(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(1, host.indexOf("]") === -1 ? undefined : host.indexOf("]"))
    : host.replace(/:\d{1,5}$/, "");
  return name === "localhost" || isIP(name) !== 0;
}

/** A device's name as it will be shown: one short line with nothing invisible in it. */
export function tidyDeviceName(raw: unknown): string {
  const name = (typeof raw === "string" ? raw : "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
  return name || "A device";
}

function hashOf(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** This machine's addresses on the local network. */
function privateAddresses(): string[] {
  const found: string[] = [];
  for (const group of Object.values(networkInterfaces())) {
    for (const entry of group ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isAllowedClient(entry.address)) {
        found.push(entry.address);
      }
    }
  }
  return found;
}

/** Makes the certificate and its key with openssl. Nothing is left behind when it fails. */
async function makeWithOpenssl(dir: string, addresses: string[]): Promise<void> {
  const names = [...new Set([...addresses, "127.0.0.1"])].filter((entry) => isIP(entry) !== 0);
  const cert = join(dir, `${CERT_FILE}.new`);
  const key = join(dir, `${KEY_FILE}.new`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "3650",
          "-subj",
          "/CN=Astra Navi station",
          "-addext",
          `subjectAltName=${names.map((entry) => `IP:${entry}`).join(",")}`,
        ],
        { timeout: 30_000 },
        (error) => {
          if (!error) return resolve();
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new Error(
              missing
                ? 'Other devices need an encrypted connection, and making one needs "openssl", which is not installed.'
                : `The certificate for other devices could not be made: ${error.message.split("\n")[0] ?? "openssl failed"}`,
            ),
          );
        },
      );
    });
    await chmod(key, 0o600);
    await rename(key, join(dir, KEY_FILE));
    await rename(cert, join(dir, CERT_FILE));
  } finally {
    await rm(key, { force: true });
    await rm(cert, { force: true });
  }
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Record<string, unknown>;
  const roleOk =
    device["role"] === undefined || device["role"] === "owner" || device["role"] === "member";
  const certOk =
    device["certSha256"] === undefined ||
    (typeof device["certSha256"] === "string" && /^[0-9a-f]{64}$/i.test(device["certSha256"]));
  const userOk = device["userId"] === undefined || typeof device["userId"] === "string";
  return (
    typeof device["id"] === "string" &&
    typeof device["name"] === "string" &&
    typeof device["pairedAt"] === "string" &&
    (device["lastSeenAt"] === null || typeof device["lastSeenAt"] === "string") &&
    typeof device["tokenHash"] === "string" &&
    /^[0-9a-f]{64}$/.test(device["tokenHash"]) &&
    roleOk &&
    certOk &&
    userOk
  );
}

function publicView(device: StoredDevice): PairedDevice {
  return {
    id: device.id,
    name: device.name,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    ...(device.certSha256 !== undefined ? { certSha256: device.certSha256 } : {}),
    ...(device.role !== undefined ? { role: device.role } : {}),
    ...(device.userId !== undefined ? { userId: device.userId } : {}),
  };
}

/** What a device asks about signing in. All need the device to be paired; none needs it signed in already. */
const ACCOUNT_ROUTES: ReadonlySet<string> = new Set([
  "GET /account",
  "POST /sign-in",
  "POST /unlock",
  "POST /sign-out",
  "POST /reset",
  "POST /unlock-key",
  "POST /unlock-key/forget",
]);

/** The session a request names, in a header of its own beside the device's token. */
function sessionIn(request: IncomingMessage): string | undefined {
  const given = request.headers["x-session"];
  return typeof given === "string" && /^[A-Za-z0-9_-]{40,50}$/.test(given) ? given : undefined;
}

/** A code that hands a pairing over: far longer than the six digits typed by hand. */
const HANDOVER_CODE = /^[A-Za-z0-9_-]{20,64}$/;
const HANDOVER_MS = 2 * 60_000;
/** How long a token handed to the app waits to be used before the hand-over is dropped. */
const TAKEOVER_MS = 5 * 60_000;
const DOOR_PLACES_PER_ADDRESS = 12;
const APP_PASS_MS = 2 * 60_000;

const PLAIN_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

function sendJson(response: ServerResponse, status: number, body: unknown, close = false): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    ...PLAIN_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(body));
}

/** Reads a small JSON body. Anything larger than the cap, or not JSON, is refused. */
function readJson(request: IncomingMessage): Promise<unknown> {
  const kind = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (kind !== "application/json") {
    return Promise.reject(new Refusal(415, "Send this as JSON."));
  }
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return Promise.reject(new Refusal(413, "That is too long."));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (refusal: Refusal): void => {
      if (settled) return;
      settled = true;
      reject(refusal);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.pause();
        fail(new Refusal(413, "That is too long."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Refusal(400, "That was not readable."));
      }
    });
    request.on("error", () => fail(new Refusal(400, "The message did not arrive whole.")));
    request.on("close", () => fail(new Refusal(400, "The message did not arrive whole.")));
  });
}

/** Reads a raw binary upload up to `maxBytes`. Refuses larger payloads with 413. */
function readBinary(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (Number(request.headers["content-length"] ?? 0) > maxBytes) {
    return Promise.reject(new Refusal(413, "That voice clip is too long."));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (refusal: Refusal): void => {
      if (settled) return;
      settled = true;
      reject(refusal);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        request.pause();
        fail(new Refusal(413, "That voice clip is too long."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", () => fail(new Refusal(400, "The voice note did not arrive whole.")));
    request.on("close", () => fail(new Refusal(400, "The voice note did not arrive whole.")));
  });
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

export class Station {
  private readonly deps: StationDeps;
  private server: Server | null = null;
  private listeningPort = 0;
  /**
   * What actually listens on the port. It looks at the first byte of each connection:
   * an encrypted hello is handed to the server proper, and a browser that came without
   * "https://" is sent to the same address with it, instead of being hung up on.
   */
  private door: Door | null = null;
  private readonly callers = new Set<Socket>();
  private certificate: string | null = null;
  private stored: StoredDevice[] = [];
  private pairing: { code: string; expiresAt: number; wrong: number } | null = null;
  private readonly streams = new Set<OpenStream>();
  /** Who may use her once a device is paired: the name and password, and who is signed in. */
  readonly account: StationAccount;
  /** Short-lived passes for downloading the phone app, each with when it runs out. */
  private readonly appPasses = new Map<string, number>();
  /** Codes that carry a device's pairing over to the phone app, by code. */
  private readonly handovers = new Map<string, { deviceId: string; expiresAt: number }>();
  /**
   * Tokens given to the app that it has not used yet, by device. Until the app's first
   * request with it, the browser's token goes on working: a hand-over whose answer got
   * lost on the way leaves the pairing where it was.
   */
  private readonly takeovers = new Map<string, { hash: Buffer; expiresAt: number }>();
  private readonly says = new Tally(SAYS_PER_MINUTE, MINUTE_MS);
  private readonly failedAuth = new Tally(FAILED_AUTH_PER_MINUTE, MINUTE_MS);
  private saveChain: Promise<void> = Promise.resolve();
  /** What a device connecting in the middle of things needs to catch up. */
  private lastStatus: "idle" | "thinking" = "idle";
  private replySoFar: string | null = null;

  constructor(deps: StationDeps) {
    this.deps = deps;
    this.account = new StationAccount({
      dir: deps.dir,
      now: () => this.now(),
      cost: deps.passwordCost,
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Sets the name and password devices sign in with. Done at the PC only. Everyone
   * signed in is signed out, and every open connection closed: they sign in again.
   */
  async setAccount(username: string, password: string): Promise<void> {
    await this.account.set(username, password);
    for (const stream of [...this.streams]) {
      this.write(stream, { type: "signed-out" });
      this.closeStream(stream);
    }
  }

  private localAddresses(): string[] {
    return this.deps.localAddresses?.() ?? privateAddresses();
  }

  get running(): boolean {
    return this.door?.listening === true;
  }

  /** Makes the certificate when there is none yet, loads the paired devices, and starts answering. */
  async start(): Promise<void> {
    if (this.server) return;
    const { dir, port } = this.deps;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const { cert, key } = await this.loadCertificate();
    await this.loadDevices();
    await this.account.load();

    const server = createServer(
      { cert, key, minVersion: "TLSv1.2", handshakeTimeout: 10_000 },
      (request, response) => {
        this.handle(request, response).catch((error: unknown) => {
          if (error instanceof Refusal) {
            // A body that was too long may still be arriving: answer, then hang up.
            sendJson(
              response,
              error.status,
              { error: error.message, ...(error.need ? { need: error.need } : {}) },
              error.status === 413,
            );
            if (error.status === 413) response.on("finish", () => request.socket.destroy());
            return;
          }
          console.warn("[station] a request failed:", error);
          sendJson(response, 500, { error: "Something went wrong on the PC." });
        });
      },
    );
    // A slow or silent caller is hung up on instead of holding a place open.
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 40;
    server.maxConnections = 48;
    // Callers from outside the local network are dropped before the encrypted hello.
    server.on("connection", (socket) => {
      if (!isAllowedClient(socket.remoteAddress)) socket.destroy();
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("tlsClientError", () => undefined);

    const door = createDoor((socket) => this.greet(socket, server));
    door.maxConnections = 48;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException): void => {
        reject(
          new Error(
            error.code === "EADDRINUSE"
              ? `Port ${port} is already in use by another program. Choose another port for other devices.`
              : `Other devices cannot be listened for: ${error.message}`,
            { cause: error },
          ),
        );
      };
      door.once("error", failed);
      door.listen(port, "0.0.0.0", () => {
        door.off("error", failed);
        door.on("error", (error) => console.warn("[station]", error));
        resolve();
      });
    });
    server.on("error", (error) => console.warn("[station]", error));
    const bound = door.address();
    this.listeningPort = typeof bound === "object" && bound !== null ? bound.port : port;
    this.certificate = cert;
    this.server = server;
    this.door = door;
  }

  /**
   * Meets one new connection. A caller from outside the local network is dropped at
   * once. The rest have a few seconds to say something: an encrypted hello goes on to
   * the server, a plain web request is pointed at the https address, and anything else
   * (or silence) is hung up on.
   */
  private greet(socket: Socket, server: Server): void {
    if (!isAllowedClient(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    // One address may hold a few connections at once, not every place there is.
    let sameCaller = 0;
    for (const other of this.callers) {
      if (other.remoteAddress === socket.remoteAddress) sameCaller += 1;
    }
    if (sameCaller >= DOOR_PLACES_PER_ADDRESS) {
      socket.destroy();
      return;
    }
    this.callers.add(socket);
    socket.once("close", () => this.callers.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    socket.once("data", (first: Buffer) => {
      socket.setTimeout(0);
      // 0x16 is how every TLS handshake begins.
      if (first[0] === 0x16) {
        socket.pause();
        socket.unshift(first);
        server.emit("connection", socket);
        process.nextTick(() => socket.resume());
        return;
      }
      if (
        !/^(?:GET|HEAD) \S+ HTTP\/1\.[01]\r?\n/.test(first.subarray(0, 2048).toString("latin1"))
      ) {
        socket.destroy();
        return;
      }
      // Sent to this computer's own address as the caller reached it, never to
      // anything the request itself names.
      const here = (socket.localAddress ?? "").replace(/^::ffff:/, "");
      if (!isIP(here)) {
        socket.destroy();
        return;
      }
      const target = `https://${here}:${this.listeningPort}/`;
      // Answered and then closed from this side too: a caller that never hangs up must
      // not be able to sit on the place.
      socket.setTimeout(3000, () => socket.destroy());
      socket.end(
        `HTTP/1.1 301 Moved Permanently\r\nLocation: ${target}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`,

        () => socket.destroy(),
      );
    });
  }

  /** Stops answering and closes every connection. Paired devices stay paired. */
  async stop(): Promise<void> {
    const { server, door } = this;
    if (!server || !door) return;
    this.server = null;
    this.door = null;
    this.pairing = null;
    this.appPasses.clear();
    this.handovers.clear();
    this.takeovers.clear();
    this.account.signEveryoneOut();
    for (const stream of [...this.streams]) this.closeStream(stream);
    await new Promise<void>((resolve) => {
      door.close(() => resolve());
      server.closeAllConnections();
      for (const caller of [...this.callers]) caller.destroy();
    });
    await this.saveChain.catch(() => undefined);
  }

  /** Where a device finds her, one address per network this computer is on. */
  addresses(): string[] {
    if (!this.running) return [];
    return this.localAddresses().map((address) => `https://${address}:${this.listeningPort}`);
  }

  /** The certificate's SHA-256 fingerprint, as a device shows it, for comparing by eye. */
  fingerprint(): string | null {
    if (!this.certificate) return null;
    try {
      return new X509Certificate(this.certificate).fingerprint256;
    } catch {
      return null;
    }
  }

  /** Opens five minutes in which one device may pair, with the code to show on the PC. */
  beginPairing(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pairing = { code, expiresAt: this.now() + PAIRING_MS, wrong: 0 };
    return { code, expiresAt: this.pairing.expiresAt };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  devices(): PairedDevice[] {
    return this.stored.map(publicView);
  }

  /** Assigns optional household role, user id, or per-device certificate pin and persists it. */
  async setDeviceIdentity(
    deviceId: string,
    identity: { role?: HouseholdRole; userId?: string; certSha256?: string },
  ): Promise<boolean> {
    const target = this.stored.find((device) => device.id === deviceId);
    if (!target) return false;
    if (identity.certSha256 !== undefined) {
      const normalized = identity.certSha256.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error("Device certificate pin must be a 64-character SHA-256 hex string.");
      }
      target.certSha256 = normalized;
    }
    if (identity.role !== undefined) target.role = identity.role;
    if (identity.userId !== undefined) target.userId = identity.userId;
    await this.saveDevices();
    this.deps.onDevicesChanged?.();
    return true;
  }

  /** Unpairs a device: its token stops working at once and its open connections are closed. */
  async forget(id: string): Promise<void> {
    const before = this.stored.length;
    this.stored = this.stored.filter((device) => device.id !== id);
    this.takeovers.delete(id);
    for (const stream of [...this.streams]) {
      if (stream.deviceId === id) this.closeStream(stream);
    }
    await this.account.forgetDevice(id);
    if (this.stored.length === before) return;
    await this.saveDevices();
    this.deps.onDevicesChanged?.();
  }

  /** Puts a mission's question before every signed-in device that is connected. */
  offerApproval(card: ApprovalCard): void {
    this.broadcast({ type: "approval", card });
  }

  /** Takes it down again: it was answered somewhere, or is no longer asked. */
  withdrawApproval(id: string): void {
    this.broadcast({ type: "approval-gone", id });
  }

  /** Sends the currently pinned mission snapshot (or null when unpinned) to connected devices. */
  updatePinnedMission(mission: PinnedMissionView | null): void {
    this.broadcast({ type: "pinned-mission", mission });
  }

  /** Pushes a triggered standing-order alert to connected signed-in devices. */
  pushAlert(alert: StationAlert): void {
    this.broadcast({ type: "alert", alert });
  }

  /** Sends something that happened to every connected device. */
  broadcast(event: StationEvent): void {
    if (event.type === "status") this.lastStatus = event.state;
    else if (event.type === "reply-start") this.replySoFar = "";
    else if (event.type === "reply-end") this.replySoFar = null;
    else if (event.type === "text" && this.replySoFar !== null) {
      this.replySoFar = (this.replySoFar + event.delta).slice(-MAX_REPLY_KEPT_CHARS);
    }
    for (const stream of [...this.streams]) {
      // Nothing more goes to a page whose session has ended, not even until its next
      // heartbeat: what is sent may be a reply, or a command waiting for a yes.
      if (!this.account.alive(stream.deviceId, stream.session)) {
        this.write(stream, { type: "signed-out" });
        this.closeStream(stream);
        continue;
      }
      this.write(stream, event);
    }
  }

  // ---------- certificate and devices on disk ----------

  private async loadCertificate(): Promise<{ cert: string; key: string }> {
    const { dir } = this.deps;
    const read = async (): Promise<{ cert: string; key: string } | null> => {
      try {
        const [cert, key] = await Promise.all([
          readFile(join(dir, CERT_FILE), "utf8"),
          readFile(join(dir, KEY_FILE), "utf8"),
        ]);
        new X509Certificate(cert); // throws when the file is not a certificate
        return { cert, key };
      } catch {
        return null;
      }
    };
    const existing = await read();
    if (existing) {
      await chmod(join(dir, KEY_FILE), 0o600).catch(() => undefined);
      return existing;
    }
    await (this.deps.makeCertificate ?? makeWithOpenssl)(dir, this.localAddresses());
    await chmod(join(dir, KEY_FILE), 0o600).catch(() => undefined);
    const made = await read();
    if (!made) throw new Error("The certificate for other devices could not be made.");
    return made;
  }

  private async loadDevices(): Promise<void> {
    const file = join(this.deps.dir, DEVICES_FILE);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      await chmod(file, 0o600).catch(() => undefined);
      const list = field(parsed, "devices");
      this.stored = Array.isArray(list) ? list.filter(isStoredDevice).slice(0, MAX_DEVICES) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[station] the list of paired devices could not be read:", error);
      }
      this.stored = [];
    }
  }

  private saveDevices(): Promise<void> {
    const file = join(this.deps.dir, DEVICES_FILE);
    const snapshot = JSON.stringify({ devices: this.stored }, null, 2);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${file}.tmp`;
        await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, file);
      });
    return this.saveChain;
  }

  // ---------- requests ----------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const caller = request.socket.remoteAddress;
    if (!isAllowedClient(caller)) {
      response.writeHead(403, { ...PLAIN_HEADERS, Connection: "close" }).end();
      request.socket.destroy();
      return;
    }
    if (!namesAnAddress(request.headers.host)) {
      throw new Refusal(421, "Reach her by the address shown on the PC.");
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.writeHead(405, { ...PLAIN_HEADERS, Allow: "GET, POST" }).end();
      return;
    }
    // Only the path matters; a query string is neither needed nor read.
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const address = plainAddress(caller ?? "");
    const route = `${request.method} ${path}`;

    if (route === "GET /") return this.sendPage(response);
    if (route === "POST /pair") return this.pair(request, response, address);
    if (route === "POST /api/federation") return this.receiveFederation(request, response);
    const pass = /^\/app\/([A-Za-z0-9_-]{20,64})\/(?:astra-navi|ai-chan)\.apk$/.exec(path)?.[1];
    if (request.method === "GET" && pass) return this.sendApp(response, pass, address);
    if (ACCOUNT_ROUTES.has(route)) {
      const device = this.authenticate(request, address);
      return this.signInRoute(route, request, response, device);
    }
    if (route === "POST /app-pass" || route === "POST /handover") {
      const device = this.authenticate(request, address);
      this.requireSession(request, device);
      await readJson(request);
      return route === "POST /app-pass"
        ? this.issueAppPass(response)
        : this.issueHandover(request, response, device);
    }
    if (route === "POST /approve") {
      const device = this.authenticate(request, address);
      this.requireSession(request, device);
      return this.approve(request, response, device);
    }
    if (route === "GET /mission") {
      const device = this.authenticate(request, address);
      this.requireSession(request, device, false);
      return sendJson(response, 200, { mission: this.deps.pinnedMission?.current() ?? null });
    }
    if (route === "POST /mission/steer") {
      const device = this.authenticate(request, address);
      this.requireSession(request, device);
      return this.steerMission(request, response, device);
    }
    if (route === "POST /mission/stop") {
      const device = this.authenticate(request, address);
      this.requireSession(request, device);
      return this.stopPinnedMission(request, response, device);
    }
    if (route === "GET /traces") {
      const device = this.authenticate(request, address);
      this.requireSession(request, device);
      return sendJson(response, 200, { traces: this.deps.traces?.() ?? [] });
    }
    if (route === "GET /alerts") {
      this.authenticate(request, address);
      const since = new URL(request.url ?? "/alerts", "https://local").searchParams.get("since") ?? undefined;
      if (since && since.length > 64) {
        throw new Refusal(400, "That alert cursor is not valid.");
      }
      return sendJson(response, 200, { alerts: this.deps.alerts?.(since) ?? [] });
    }
    if (route === "POST /voice") {
      const device = this.authenticate(request, address);
      this.requireSession(request, device);
      return this.voice(request, response, device);
    }
    if (route === "POST /webhook") {
      const device = this.authenticate(request, address);
      return this.webhook(request, response, device);
    }
    if (route === "POST /active") {
      // The page says its user is there (a tap, a key): that is use, as a request is.
      const device = this.authenticate(request, address);
      this.requireSession(request, device);
      await readJson(request);
      return sendJson(response, 200, { ok: true });
    }
    if (route === "GET /events" || route === "POST /say" || route === "POST /stop") {
      const device = this.authenticate(request, address);
      // The page opens its connection by itself, and again whenever the network drops
      // it: that is not use, or a phone asleep on a table would keep itself signed in.
      const session = this.requireSession(request, device, route !== "GET /events");
      if (route === "GET /events") return this.openStream(response, device, session);
      if (route === "POST /stop") {
        await readJson(request);
        this.deps.onStop(publicView(device));
        return sendJson(response, 202, { ok: true });
      }
      return this.say(request, response, device);
    }
    throw new Refusal(404, "There is nothing here.");
  }

  // ---------- signing in ----------

  /**
   * The session a request from a paired device was made under. Refuses it, saying what
   * is needed, when no name and password have been set or the device is not signed in.
   */
  private requireSession(request: IncomingMessage, device: StoredDevice, isUse = true): string {
    if (!this.account.exists) throw new Refusal(403, NO_ACCOUNT, "account");
    const session = sessionIn(request);
    const live = isUse
      ? this.account.check(device.id, session)
      : this.account.alive(device.id, session);
    if (!session || !live) {
      throw new Refusal(401, SIGN_IN_FIRST, "sign-in");
    }
    return session;
  }

  private requireOwnerRole(device: StoredDevice): void {
    const household = this.deps.household;
    if (!household?.enabled) return;
    const profile =
      household.resolveDeviceUser(device.id) ??
      (device.role
        ? {
            userId: device.userId ?? device.id,
            displayName: device.name,
            role: device.role,
            deviceIds: [device.id],
            memoryNamespace: device.userId ?? device.id,
            calendarIds: [],
          }
        : null);
    const decision = household.authorizeAction(profile, { tool: "start_mission" });
    if (!decision.allowed || profile?.role !== "owner") {
      throw new Refusal(403, decision.reason ?? "Only the machine owner may perform this action.");
    }
  }

  /**
   * A yes or no to a mission's step, from a device that is signed in. The owner's rule:
   * a signed-in device may answer; one left unused for half an hour, or whose page or
   * app was closed, has to sign in again first. Steps that touch where passwords or
   * keys are kept never come here (see `ApprovalDesk`).
   */
  private async approve(
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): Promise<void> {
    this.requireOwnerRole(device);
    const body = await readJson(request);
    const id = String(field(body, "id") ?? "");
    const allow = field(body, "allow");
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(id) || typeof allow !== "boolean") {
      throw new Refusal(400, "That is not an answer to a question.");
    }
    if (!this.deps.approvals?.answer(id, allow, publicView(device))) {
      throw new Refusal(409, "That question has been answered already, or is no longer asked.");
    }
    sendJson(response, 200, { ok: true });
  }

  private async steerMission(
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): Promise<void> {
    this.requireOwnerRole(device);
    const now = this.now();
    if (this.says.over(device.id, now)) {
      throw new Refusal(429, "That is a lot of messages. Give her a minute.");
    }
    this.says.add(device.id, now);
    const body = await readJson(request);
    const missionId = String(field(body, "missionId") ?? "").trim();
    const rawNote = field(body, "note");
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (!/^m-[a-f0-9]{6}$/.test(missionId) || note.length === 0 || note.length > 600) {
      throw new Refusal(400, "Give a valid mission id and a note of 1 to 600 characters.");
    }
    const updated = await this.deps.pinnedMission?.steer(missionId, note, publicView(device));
    if (!updated) {
      throw new Refusal(409, "That mission is not pinned to devices or has already ended.");
    }
    sendJson(response, 200, { mission: updated });
  }

  private async stopPinnedMission(
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): Promise<void> {
    this.requireOwnerRole(device);
    const body = await readJson(request);
    const missionId = String(field(body, "missionId") ?? "").trim();
    if (!/^m-[a-f0-9]{6}$/.test(missionId)) {
      throw new Refusal(400, "Give a valid mission id.");
    }
    const stopped = await this.deps.pinnedMission?.stop(missionId, publicView(device));
    if (!stopped) {
      throw new Refusal(409, "That mission is not pinned to devices or has already ended.");
    }
    sendJson(response, 200, { ok: true });
  }

  private async signInRoute(
    route: string,
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): Promise<void> {
    const { account } = this;
    const waitSeconds = (): number => Math.ceil(account.mustWait(device.id) / 1000);
    if (route === "GET /account") {
      // What the page needs to choose its first screen. Not the name: that is typed in.
      return sendJson(response, 200, {
        set: account.exists,
        // Asked by the page itself when it opens: not use.
        signedIn: account.alive(device.id, sessionIn(request)),
        unlock: account.hasUnlock(device.id),
        wait: waitSeconds(),
      });
    }
    const body = await readJson(request);
    if (route === "POST /sign-out") {
      account.signOut(sessionIn(request));
      for (const stream of [...this.streams]) {
        if (stream.deviceId === device.id) this.closeStream(stream);
      }
      return sendJson(response, 200, { ok: true });
    }
    if (route === "POST /reset") {
      if (!account.askForReset(device.id)) {
        throw new Refusal(
          429,
          "A reset has been asked for several times already. Change the password on the PC, in her settings under Devices.",
        );
      }
      this.deps.onResetAsked?.(publicView(device));
      return sendJson(response, 202, { ok: true });
    }
    if (!account.exists) throw new Refusal(403, NO_ACCOUNT, "account");
    if (route === "POST /sign-in" || route === "POST /unlock") {
      if (waitSeconds() > 0) {
        throw new Refusal(
          429,
          `Too many wrong tries. Wait ${Math.ceil(waitSeconds() / 60)} minutes, or ask for a reset and change the password on the PC.`,
        );
      }
      if (account.isTrying(device.id)) throw new Refusal(429, ONE_TRY_AT_A_TIME);
      const session =
        route === "POST /sign-in"
          ? await account.signIn(
              device.id,
              String(field(body, "username") ?? ""),
              String(field(body, "password") ?? ""),
            )
          : account.unlock(device.id, String(field(body, "key") ?? ""));
      if (!session) {
        throw new Refusal(401, route === "POST /sign-in" ? WRONG_SIGN_IN : WRONG_UNLOCK, "sign-in");
      }
      return sendJson(response, 200, { session, unlock: account.hasUnlock(device.id) });
    }
    // What is left changes how this device signs in: only from a signed-in session.
    const session = this.requireSession(request, device);
    if (route === "POST /unlock-key") {
      const key = await account.issueUnlock(device.id, session);
      if (!key) throw new Refusal(403, KEY_NEEDS_THE_PASSWORD, "password");
      return sendJson(response, 200, { key });
    }
    await account.dropUnlock(device.id);
    return sendJson(response, 200, { ok: true });
  }

  private sendPage(response: ServerResponse): void {
    const nonce = randomBytes(18).toString("base64");
    response.writeHead(200, {
      ...PLAIN_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    response.end(stationPage(nonce));
  }

  /** Finds the paired device a request comes from, or refuses it. */
  private authenticate(request: IncomingMessage, address: string): StoredDevice {
    const now = this.now();
    if (this.failedAuth.over(address, now)) throw new Refusal(429, TOO_MANY_TRIES);
    const token = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.authorization ?? "")?.[1];
    let found: StoredDevice | null = null;
    if (token) {
      const offered = hashOf(token);
      // Every device is compared, in time that does not depend on how close a guess was.
      for (const device of this.stored) {
        const known = Buffer.from(device.tokenHash, "hex");
        if (known.length === offered.length && timingSafeEqual(known, offered)) found = device;
        const waiting = this.takeovers.get(device.id);
        if (
          waiting &&
          waiting.expiresAt > now &&
          waiting.hash.length === offered.length &&
          timingSafeEqual(waiting.hash, offered)
        ) {
          found = device;
          this.completeTakeover(device, waiting.hash);
        }
      }
    }
    if (!found) {
      this.failedAuth.add(address, now);
      throw new Refusal(401, NOT_PAIRED);
    }
    if (found.certSha256) {
      let presentedHex = "";
      const maybeTls = request.socket as Partial<TLSSocket>;
      const peerCert =
        typeof maybeTls.getPeerCertificate === "function"
          ? maybeTls.getPeerCertificate(false)
          : undefined;
      if (peerCert?.raw) {
        presentedHex = createHash("sha256").update(peerCert.raw).digest("hex");
      } else if (typeof request.headers["x-client-cert-sha256"] === "string") {
        presentedHex = request.headers["x-client-cert-sha256"].trim().toLowerCase();
      }
      const expectedBuf = Buffer.from(found.certSha256, "hex");
      const actualBuf = /^[0-9a-f]{64}$/.test(presentedHex)
        ? Buffer.from(presentedHex, "hex")
        : Buffer.alloc(0);
      if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
        this.failedAuth.add(address, now);
        throw new Refusal(401, "Device certificate pin mismatch.");
      }
    }
    this.markSeen(found, now);
    return found;
  }

  private markSeen(device: StoredDevice, now: number): void {
    const last = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    if (now - last < SEEN_EVERY_MS) return;
    device.lastSeenAt = new Date(now).toISOString();
    this.saveDevices().catch((error: unknown) => console.warn("[station]", error));
  }

  private async pair(
    request: IncomingMessage,
    response: ServerResponse,
    address: string,
  ): Promise<void> {
    if (this.failedAuth.over(address, this.now())) throw new Refusal(429, TOO_MANY_TRIES);
    const body = await readJson(request);
    const now = this.now();
    const offered = String(field(body, "code") ?? "").replace(/\s+/g, "");
    if (HANDOVER_CODE.test(offered)) return this.takeHandover(response, offered, address, now);
    const pairing = this.pairing;
    const open = pairing !== null && now < pairing.expiresAt;
    // Compared at full length whatever was sent, so the answer's timing says nothing.
    const wanted = Buffer.from(open ? pairing.code : "------");
    const given = Buffer.from(offered.padEnd(6, " ").slice(0, 6));
    const matches =
      open && offered.length === 6 && given.length === 6 && timingSafeEqual(wanted, given);
    if (!matches) {
      this.failedAuth.add(address, now);
      if (pairing && !open) this.pairing = null;
      else if (pairing && (pairing.wrong += 1) >= WRONG_CODES_ALLOWED) this.pairing = null;
      throw new Refusal(403, WRONG_CODE);
    }
    if (this.stored.length >= MAX_DEVICES) {
      throw new Refusal(
        409,
        `${MAX_DEVICES} devices are already paired. Remove one in her settings on the PC first.`,
      );
    }
    this.pairing = null;
    const token = randomBytes(32).toString("base64url");
    const device: StoredDevice = {
      id: randomUUID(),
      name: tidyDeviceName(field(body, "name")),
      pairedAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      tokenHash: hashOf(token).toString("hex"),
    };
    this.stored.push(device);
    await this.saveDevices();
    this.deps.onDevicesChanged?.();
    sendJson(response, 200, { token, device: publicView(device) });
  }

  // ---------- the phone app ----------

  /**
   * Gives a paired device a pass to download the phone app. A download cannot carry the
   * device's token (the phone's download manager fetches it by plain address), so it
   * gets an address of its own that works for two minutes.
   */
  private issueAppPass(response: ServerResponse): void {
    const app = this.deps.phoneApp?.();
    if (!app) throw new Refusal(404, "The phone app has not been built on the PC yet.");
    const now = this.now();
    for (const [pass, until] of this.appPasses) if (until <= now) this.appPasses.delete(pass);
    if (this.appPasses.size >= 20) throw new Refusal(429, "Try again in a couple of minutes.");
    const pass = randomBytes(24).toString("base64url");
    this.appPasses.set(pass, now + APP_PASS_MS);
    sendJson(response, 200, { path: `/app/${pass}/astra-navi.apk`, version: app.version });
  }

  private async sendApp(response: ServerResponse, pass: string, address: string): Promise<void> {
    const now = this.now();
    if (this.failedAuth.over(address, now)) throw new Refusal(429, TOO_MANY_TRIES);
    const until = this.appPasses.get(pass);
    const app = this.deps.phoneApp?.();
    if (until === undefined || until <= now || !app) {
      this.failedAuth.add(address, now);
      throw new Refusal(404, "That download link has run out. Ask for the app again.");
    }
    // Opened once, so the length promised and the bytes sent are of the same file even
    // if the app is rebuilt while it is being fetched.
    const handle = await open(app.file, "r");
    const { size } = await handle.stat();
    response.writeHead(200, {
      ...PLAIN_HEADERS,
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": size,
      "Content-Disposition": 'attachment; filename="astra-navi.apk"',
    });
    await new Promise<void>((resolve) => {
      const file = handle.createReadStream({ start: 0, end: Math.max(0, size - 1) });
      file.on("error", () => {
        response.destroy();
        resolve();
      });
      response.on("close", () => {
        file.destroy();
        resolve();
      });
      file.pipe(response);
    });
  }

  /**
   * Makes a code with which the phone app can take over this device's pairing. Nothing
   * new is paired: when the code is used, the device's old token stops working and the
   * app holds the new one. So a paired device can move, but cannot multiply.
   */
  private issueHandover(
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): void {
    const now = this.now();
    for (const [code, entry] of this.handovers) {
      if (entry.expiresAt <= now || entry.deviceId === device.id) this.handovers.delete(code);
    }
    const code = randomBytes(18).toString("base64url");
    this.handovers.set(code, { deviceId: device.id, expiresAt: now + HANDOVER_MS });
    sendJson(response, 200, {
      code,
      // The address as this device reached her, which the Host check has already vetted.
      at: request.headers.host ?? "",
      fingerprint: (this.fingerprint() ?? "").replaceAll(":", ""),
    });
  }

  private takeHandover(response: ServerResponse, code: string, address: string, now: number): void {
    const entry = this.handovers.get(code);
    const device = entry ? this.stored.find((known) => known.id === entry.deviceId) : undefined;
    if (!entry || entry.expiresAt <= now || !device) {
      if (entry) this.handovers.delete(code);
      this.failedAuth.add(address, now);
      throw new Refusal(403, WRONG_CODE);
    }
    this.handovers.delete(code);
    const token = randomBytes(32).toString("base64url");
    // Not yet the device's token: it becomes that the first time the app uses it.
    this.takeovers.set(device.id, { hash: hashOf(token), expiresAt: now + TAKEOVER_MS });
    sendJson(response, 200, { token, device: publicView(device) });
  }

  /** The app has used its new token: it is now the device's only one, and the browser's is gone. */
  private completeTakeover(device: StoredDevice, hash: Buffer): void {
    this.takeovers.delete(device.id);
    device.tokenHash = hash.toString("hex");
    // Whatever was connected with the old token is the browser being left behind, and
    // so is whatever it was signed in as: the new holder signs in with the password, and
    // a key the old one was given opens nothing.
    for (const stream of [...this.streams]) {
      if (stream.deviceId === device.id) this.closeStream(stream);
    }
    this.account.endAccess(device.id).catch((error: unknown) => console.warn("[station]", error));
    this.saveDevices().catch((error: unknown) => console.warn("[station]", error));
  }

  private async say(
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): Promise<void> {
    const now = this.now();
    if (this.says.over(device.id, now)) {
      throw new Refusal(429, "That is a lot of messages. Give her a minute.");
    }
    // Counted before the body is read: many requests sent at once must not all slip past
    // the check while their bodies are still arriving.
    this.says.add(device.id, now);
    const body = await readJson(request);
    const raw = field(body, "text");
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text.length === 0 || text.length > MAX_SAY_CHARS) {
      throw new Refusal(400, `A message needs 1 to ${MAX_SAY_CHARS} characters.`);
    }
    // Still paired? It could have been removed on the PC while the message was arriving.
    if (!this.stored.includes(device)) throw new Refusal(401, NOT_PAIRED);
    if (!this.deps.onSay(text, publicView(device))) {
      throw new Refusal(429, "She already has a few messages waiting. Give her a moment.");
    }
    // Her reply arrives after this, so it lands beneath the message it answers.
    this.broadcast({ type: "said", text, from: device.name });
    sendJson(response, 202, { ok: true });
  }

  private async voice(
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): Promise<void> {
    if (!this.deps.onVoice) {
      throw new Refusal(503, "Voice notes are not available right now.");
    }
    const now = this.now();
    if (this.says.over(device.id, now)) {
      throw new Refusal(429, "That is a lot of messages. Give her a minute.");
    }
    this.says.add(device.id, now);
    const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("audio/")) {
      throw new Refusal(415, "Send voice notes as audio.");
    }
    const raw = await readBinary(request, MAX_VOICE_BYTES);
    let samples: Float32Array;
    try {
      samples = await decodeAudioTo16kMono(raw, contentType);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not decode that voice note.";
      const status = /ffmpeg|Send voice notes as WAV/i.test(message) ? 415 : 400;
      throw new Refusal(status, message);
    }
    if (!this.stored.includes(device)) throw new Refusal(401, NOT_PAIRED);
    const transcribed = (await this.deps.onVoice(samples, publicView(device)))
      .replace(/\s+/g, " ")
      .trim();
    if (!transcribed) {
      throw new Refusal(422, "I could not make out any words in that voice note.");
    }
    const text = transcribed.slice(0, MAX_SAY_CHARS);
    if (!this.deps.onSay(text, publicView(device))) {
      throw new Refusal(429, "She already has a few messages waiting. Give her a moment.");
    }
    this.broadcast({ type: "said", text, from: device.name });
    sendJson(response, 202, { ok: true, transcript: text });
  }

  private async receiveFederation(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.deps.federation?.enabled) {
      throw new Refusal(404, "Station-to-station federation is disabled.");
    }
    const body = await readJson(request);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>)["senderId"] !== "string" ||
      typeof (body as Record<string, unknown>)["peerId"] !== "string" ||
      typeof (body as Record<string, unknown>)["issuedAtMs"] !== "number" ||
      typeof (body as Record<string, unknown>)["nonce"] !== "string" ||
      typeof (body as Record<string, unknown>)["signature"] !== "string" ||
      typeof (body as Record<string, unknown>)["payload"] !== "object" ||
      (body as Record<string, unknown>)["payload"] === null
    ) {
      throw new Refusal(400, "Malformed federation envelope.");
    }
    const envelope = body as FederationEnvelope;
    const verdict = this.deps.federation.receiveIncoming(envelope, this.now());
    if (!verdict.accepted || !verdict.payload) {
      throw new Refusal(403, verdict.reason ?? "Rejected federation envelope.");
    }
    const reply = await this.deps.onFederationPayload?.(verdict.payload, envelope.senderId);
    sendJson(response, 200, {
      ok: true,
      accepted: verdict.payload.kind,
      ...(reply ? { reply } : {}),
    });
  }

  private async webhook(
    request: IncomingMessage,
    response: ServerResponse,
    device: StoredDevice,
  ): Promise<void> {
    this.requireOwnerRole(device);
    if (!this.deps.onWebhook) {
      throw new Refusal(503, "Local webhooks are switched off.");
    }
    const now = this.now();
    if (this.says.over(device.id, now)) {
      throw new Refusal(429, "Too many webhook events. Slow down.");
    }
    this.says.add(device.id, now);
    const body = await readJson(request);
    const topic = String(field(body, "topic") ?? "").trim();
    if (!/^[A-Za-z0-9._/-]{1,80}$/.test(topic)) {
      throw new Refusal(400, "Give a valid webhook topic (1-80 characters of letters, digits, ., _, /, -).");
    }
    const rawData = field(body, "data");
    const data =
      typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : {};
    if (!this.deps.onWebhook({ topic, data, device: publicView(device) })) {
      throw new Refusal(429, "Event bus is busy.");
    }
    sendJson(response, 202, { ok: true });
  }

  // ---------- the stream of events to a device ----------

  private openStream(response: ServerResponse, device: StoredDevice, session: string): void {
    const own = [...this.streams].filter((stream) => stream.deviceId === device.id);
    // The oldest gives way: a page reloaded on a phone leaves its old connection behind.
    while (own.length >= MAX_STREAMS_PER_DEVICE) {
      const oldest = own.shift();
      if (oldest) this.closeStream(oldest);
    }
    while (this.streams.size >= MAX_STREAMS) {
      const [oldest] = this.streams;
      if (!oldest) break;
      this.closeStream(oldest);
    }
    response.writeHead(200, {
      ...PLAIN_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    const stream: OpenStream = {
      response,
      deviceId: device.id,
      session,
      heartbeat: setInterval(() => {
        // An open page is not use of the session. When the session is over (unused for
        // half an hour, half a day old, the password changed), the page is told and
        // the connection ends.
        if (!this.account.alive(device.id, session)) {
          this.write(stream, { type: "signed-out" });
          this.closeStream(stream);
          return;
        }
        if (!response.writableEnded) response.write(": still here\n\n");
      }, HEARTBEAT_MS),
    };
    stream.heartbeat.unref();
    this.streams.add(stream);
    response.on("close", () => this.closeStream(stream));

    this.write(stream, {
      type: "hello",
      device: device.name,
      app: Boolean(this.deps.phoneApp?.()),
    });
    let exchanges: { said: string; reply: string; at: string }[] = [];
    try {
      exchanges = (this.deps.recent?.() ?? []).slice(-RECENT_SHOWN);
    } catch (error) {
      console.warn("[station] the recent conversation could not be read:", error);
    }
    this.write(stream, { type: "recent", exchanges });
    this.write(stream, { type: "status", state: this.lastStatus });
    // Questions that were put while this device was away are waiting for it.
    try {
      for (const card of this.deps.approvals?.cards() ?? []) {
        this.write(stream, { type: "approval", card });
      }
    } catch (error) {
      console.warn("[station] the open questions could not be read:", error);
    }
    try {
      this.write(stream, {
        type: "pinned-mission",
        mission: this.deps.pinnedMission?.current() ?? null,
      });
    } catch (error) {
      console.warn("[station] the pinned mission could not be read:", error);
    }
    if (this.replySoFar !== null) {
      this.write(stream, { type: "reply-start" });
      if (this.replySoFar) this.write(stream, { type: "text", delta: this.replySoFar });
    }
  }

  private write(stream: OpenStream, message: Wire): void {
    const { response } = stream;
    if (response.writableEnded || response.destroyed) return;
    if (response.writableLength > MAX_UNSENT_BYTES) {
      this.closeStream(stream);
      return;
    }
    response.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  private closeStream(stream: OpenStream): void {
    if (!this.streams.delete(stream)) return;
    clearInterval(stream.heartbeat);
    if (!stream.response.writableEnded) stream.response.end();
    stream.response.socket?.destroy();
  }
}
