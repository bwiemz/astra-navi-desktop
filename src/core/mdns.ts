import { createSocket } from "node:dgram";
import { hostname } from "node:os";

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE_TYPE = "_astranavi._tcp.local";

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
  const visited = new Set<number>();

  while (offset < packet.length) {
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
      if (nextOffset === -1) nextOffset = offset + 2;
      offset = ptr;
      continue;
    }
    offset += 1;
    if (offset + len > packet.length) return null;
    labels.push(packet.subarray(offset, offset + len).toString("utf8"));
    offset += len;
  }
  return null;
}

/** Parses DNS query question records from a raw UDP packet. */
export function parseMdnsQuery(packet: Buffer): MdnsQueryQuestion[] {
  if (packet.length < 12) return [];
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

/** Builds a valid mDNS DNS-SD response packet advertising `_astranavi._tcp.local`. */
export function encodeMdnsResponse(options: {
  instanceName: string;
  hostName: string;
  port: number;
  addresses: readonly string[];
  fingerprintTail?: string;
  ttlSeconds?: number;
}): Buffer {
  const ttl = options.ttlSeconds ?? 120;
  const cleanHost = options.hostName.replace(/\.local$/i, "").replace(/[^a-zA-Z0-9-]/g, "-") || "astranavi";
  const hostFqdn = `${cleanHost}.local`;
  const cleanInstance = options.instanceName.replace(/\./g, " ").trim() || "Astra Navi Desktop";
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

  // TXT record: txtvers=1 + short fingerprint tail for user sanity
  const txtStrings = ["txtvers=1", "proto=https"];
  if (options.fingerprintTail) txtStrings.push(`fp=${options.fingerprintTail}`);
  const txtBuf = Buffer.concat(
    txtStrings.map((s) => {
      const b = Buffer.from(s, "utf8");
      return Buffer.concat([Buffer.from([b.length]), b]);
    }),
  );
  records.push(encodeRecord(instanceFqdn, 16, ttl, txtBuf));

  // A records for LAN IPv4 addresses
  for (const addr of options.addresses) {
    const bytes = ipv4Bytes(addr);
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
 * can discover the desktop station without typing IPs manually. Never throws if UDP 5353
 * is blocked by sandbox or firewall rules.
 */
export async function startMdnsAdvertiser(
  options: MdnsAdvertiserOptions,
): Promise<MdnsAdvertiserHandle> {
  if (options.addresses.length === 0) {
    return { close: async () => undefined };
  }
  const hostName = hostname().split(".")[0] || "astranavi";
  const packet = encodeMdnsResponse({
    instanceName: options.instanceName,
    hostName,
    port: options.port,
    addresses: options.addresses,
    fingerprintTail: options.fingerprintTail,
  });

  const socket = createSocket({ type: "udp4", reuseAddr: true });
  let closed = false;

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
          for (const addr of options.addresses) {
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
    const questions = parseMdnsQuery(msg);
    const wantsUs = questions.some(
      (q) =>
        q.name === SERVICE_TYPE ||
        q.name === "_services._dns-sd._udp.local" ||
        q.name === `${hostName.toLowerCase()}.local`,
    );
    if (!wantsUs) return;
    socket.send(packet, MDNS_PORT, MDNS_ADDR, () => undefined);
    if (rinfo.address && rinfo.port) {
      socket.send(packet, rinfo.port, rinfo.address, () => undefined);
    }
  });

  const bound = await ready;
  if (bound) {
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
