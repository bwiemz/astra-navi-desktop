import { createSocket } from "node:dgram";
import { hostname } from "node:os";

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE_TYPE = "_astranavi._tcp.local";
const MAX_MDNS_PACKET_BYTES = 1500;
const MAX_DNS_LABELS = 128;
const MAX_DNS_NAME_BYTES = 255;
const MULTICAST_MIN_INTERVAL_MS = 500;
const UNICAST_WINDOW_MS = 5_000;
const UNICAST_MAX_PER_WINDOW = 4;

export interface MdnsQueryQuestion {
  name: string;
  qtype: number;
  qclass: number;
}

export interface MdnsAdvertiserOptions {
  instanceName: string;
  port: number;
  addresses: readonly string[];
  fingerprintTail?: string;
}

export interface MdnsAdvertiserHandle {
  close(): Promise<void>;
}

function sanitizeInstanceName(raw: string): string {
  let clean = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    clean += raw[i] ?? "";
  }
  const noDots = clean.replaceAll(".", " ").trim() || "Astra Navi Desktop";
  const encoded = Buffer.from(noDots, "utf8");
  if (encoded.length <= 48) return noDots;
  return encoded.subarray(0, 48).toString("utf8").replace(/\uFFFD+$/g, "").trim() || "Astra Navi";
}

function encodeDnsName(name: string): Buffer {
  const labels = name
    .replace(/\.$/, "")
    .split(".")
    .filter((label) => label.length > 0);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const utf = Buffer.from(label, "utf8");
    if (utf.length > 63) throw new Error(`DNS label too long: ${label}`);
    parts.push(Buffer.from([utf.length]), utf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeDnsName(packet: Buffer, startOffset: number): { name: string; nextOffset: number } | null {
  const labels: string[] = [];
  let offset = startOffset;
  let nextOffset = -1;
  let totalNameBytes = 0;
  const visited = new Set<number>();

  while (offset < packet.length) {
    if (labels.length > MAX_DNS_LABELS) return null;
    if (visited.has(offset)) return null;
    visited.add(offset);
    const len = packet[offset] ?? 0;
    if (len === 0) {
      if (nextOffset === -1) nextOffset = offset + 1;
      return { name: labels.join(".").toLowerCase(), nextOffset };
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) return null;
      const ptr = ((len & 0x3f) << 8) | (packet[offset + 1] ?? 0);
      if (ptr >= packet.length || ptr < 12) return null;
      if (nextOffset === -1) nextOffset = offset + 2;
      offset = ptr;
      continue;
    }
    if (len > 63) return null;
    offset += 1;
    if (offset + len > packet.length) return null;
    totalNameBytes += len + 1;
    if (totalNameBytes > MAX_DNS_NAME_BYTES) return null;
    labels.push(packet.subarray(offset, offset + len).toString("utf8"));
    offset += len;
  }
  return null;
}

/** Parses DNS query question records from a raw UDP packet. */
export function parseMdnsQuery(packet: Buffer): MdnsQueryQuestion[] {
  if (packet.length < 12 || packet.length > MAX_MDNS_PACKET_BYTES) return [];
  const flags = packet.readUInt16BE(2);
  // Ignore responses (QR bit set)
  if ((flags & 0x8000) !== 0) return [];
  const qdcount = packet.readUInt16BE(4);
  if (qdcount === 0 || qdcount > 32) return [];

  const questions: MdnsQueryQuestion[] = [];
  let offset = 12;
  for (let i = 0; i < qdcount; i += 1) {
    const decoded = decodeDnsName(packet, offset);
    if (!decoded || decoded.nextOffset + 4 > packet.length) break;
    const qtype = packet.readUInt16BE(decoded.nextOffset);
    const qclass = packet.readUInt16BE(decoded.nextOffset + 2) & 0x7fff;
    questions.push({ name: decoded.name, qtype, qclass });
    offset = decoded.nextOffset + 4;
  }
  return questions;
}

function encodeRecord(name: string, type: number, ttl: number, rdata: Buffer): Buffer {
  const head = encodeDnsName(name);
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(0x0001, 2); // CLASS IN
  meta.writeUInt32BE(ttl, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([head, meta, rdata]);
}

function ipv4Bytes(ip: string): Buffer | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Buffer.from(nums);
}

/** True strictly for private LAN / loopback / link-local / CGNAT IPv4 addresses. */
export function isPrivateLanIpv4(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/i, "").trim();
  const bytes = ipv4Bytes(clean);
  if (!bytes) return false;
  const a = bytes[0] ?? -1;
  const b = bytes[1] ?? -1;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127
  );
}

/** Builds a valid mDNS DNS-SD response packet advertising `_astranavi._tcp.local`. */
export function encodeMdnsResponse(options: {
  instanceName: string;
  hostName: string;
  port: number;
  addresses: readonly string[];
  fingerprintTail?: string;
  ttlSeconds?: number;
}): Buffer {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new RangeError(`Invalid mDNS service port: ${options.port}`);
  }
  const cleanAddresses = options.addresses.filter((addr) => isPrivateLanIpv4(addr));
  const ttl = options.ttlSeconds ?? 120;
  const cleanHost = options.hostName.replace(/\.local$/i, "").replace(/[^a-zA-Z0-9-]/g, "-") || "astranavi";
  const hostFqdn = `${cleanHost.slice(0, 48)}.local`;
  const cleanInstance = sanitizeInstanceName(options.instanceName);
  const instanceFqdn = `${cleanInstance}.${SERVICE_TYPE}`;

  const records: Buffer[] = [];

  // PTR record: _astranavi._tcp.local -> <instance>._astranavi._tcp.local
  records.push(encodeRecord(SERVICE_TYPE, 12, ttl, encodeDnsName(instanceFqdn)));

  // SRV record: <instance>._astranavi._tcp.local -> port + hostFqdn
  const srvHead = Buffer.alloc(6);
  srvHead.writeUInt16BE(0, 0);
  srvHead.writeUInt16BE(0, 2);
  srvHead.writeUInt16BE(options.port, 4);
  records.push(
    encodeRecord(instanceFqdn, 33, ttl, Buffer.concat([srvHead, encodeDnsName(hostFqdn)])),
  );

  // TXT record: txtvers=1 + proto=https + optional validated short fingerprint tail
  const txtStrings = ["txtvers=1", "proto=https"];
  if (options.fingerprintTail && /^[0-9A-Fa-f]{8,16}$/.test(options.fingerprintTail)) {
    txtStrings.push(`fp=${options.fingerprintTail.toUpperCase()}`);
  }
  const txtBuf = Buffer.concat(
    txtStrings.map((s) => {
      const b = Buffer.from(s, "utf8");
      return Buffer.concat([Buffer.from([b.length]), b]);
    }),
  );
  records.push(encodeRecord(instanceFqdn, 16, ttl, txtBuf));

  // A records strictly for private LAN IPv4 addresses
  for (const addr of cleanAddresses) {
    const bytes = ipv4Bytes(addr.replace(/^::ffff:/i, "").trim());
    if (bytes) records.push(encodeRecord(hostFqdn, 1, ttl, bytes));
  }

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2); // QR=1, AA=1
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(records.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([header, ...records]);
}

/**
 * Starts a non-fatal local IPv4 mDNS responder advertising `_astranavi._tcp.local` so phones
 * can discover the desktop station without typing IPs manually. Filters non-LAN senders,
 * drops oversized datagrams, and rate-limits replies against amplification floods.
 */
export async function startMdnsAdvertiser(
  options: MdnsAdvertiserOptions,
): Promise<MdnsAdvertiserHandle> {
  const lanAddresses = options.addresses.filter((addr) => isPrivateLanIpv4(addr));
  if (lanAddresses.length === 0) {
    return { close: async () => undefined };
  }
  const hostName = hostname().split(".")[0] || "astranavi";
  const packet = encodeMdnsResponse({
    instanceName: options.instanceName,
    hostName,
    port: options.port,
    addresses: lanAddresses,
    fingerprintTail: options.fingerprintTail,
  });

  const socket = createSocket({ type: "udp4", reuseAddr: true });
  let closed = false;
  let lastMulticastAt = 0;
  const unicastHits = new Map<string, number[]>();

  const ready = new Promise<boolean>((resolve) => {
    const onError = () => {
      resolve(false);
    };
    socket.once("error", onError);
    try {
      socket.bind(MDNS_PORT, () => {
        socket.off("error", onError);
        try {
          socket.setMulticastTTL(255);
          socket.setMulticastLoopback(true);
          for (const addr of lanAddresses) {
            try {
              socket.addMembership(MDNS_ADDR, addr);
            } catch {
              // interface may disallow multicast membership
            }
          }
        } catch {
          // best effort
        }
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

  socket.on("error", () => undefined);
  socket.on("message", (msg, rinfo) => {
    if (msg.length > MAX_MDNS_PACKET_BYTES) return;
    if (!rinfo.address || !isPrivateLanIpv4(rinfo.address)) return;
    const questions = parseMdnsQuery(msg);
    const wantsUs = questions.some(
      (q) =>
        q.name === SERVICE_TYPE ||
        q.name === "_services._dns-sd._udp.local" ||
        q.name === `${hostName.toLowerCase()}.local`,
    );
    if (!wantsUs) return;

    const now = Date.now();
    if (now - lastMulticastAt >= MULTICAST_MIN_INTERVAL_MS) {
      lastMulticastAt = now;
      socket.send(packet, MDNS_PORT, MDNS_ADDR, () => undefined);
    }

    if (rinfo.port >= 1 && rinfo.port <= 65535) {
      const prior = (unicastHits.get(rinfo.address) ?? []).filter(
        (ts) => now - ts < UNICAST_WINDOW_MS,
      );
      if (prior.length < UNICAST_MAX_PER_WINDOW) {
        prior.push(now);
        unicastHits.set(rinfo.address, prior);
        socket.send(packet, rinfo.port, rinfo.address, () => undefined);
      }
      if (unicastHits.size > 128) {
        unicastHits.clear();
      }
    }
  });

  const bound = await ready;
  if (bound) {
    lastMulticastAt = Date.now();
    socket.send(packet, MDNS_PORT, MDNS_ADDR, () => undefined);
  } else {
    try {
      socket.close();
    } catch {
      // ignore
    }
    closed = true;
  }

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
