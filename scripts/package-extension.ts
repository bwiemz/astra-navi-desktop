#!/usr/bin/env node
/**
 * Packages `browser-bridge/` into store-ready ZIP archives for Chrome Web Store (Chromium)
 * and Firefox Add-ons (AMO), plus SHA-256 checksums.
 *
 *   npm run package:extension
 *   node scripts/package-extension.ts --dry-run
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const SRC_DIR = join(ROOT, "browser-bridge");
const DIST_DIR = join(ROOT, "dist");
const dryRun = process.argv.includes("--dry-run");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5421, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const rawManifest = JSON.parse(await readFile(join(SRC_DIR, "manifest.json"), "utf8")) as Record<
  string,
  unknown
>;
const version = typeof rawManifest["version"] === "string" ? rawManifest["version"] : "0.1.0";

const chromiumManifest: Record<string, unknown> = {
  ...rawManifest,
  background: { service_worker: "background.js" },
};
delete chromiumManifest["browser_specific_settings"];

const firefoxManifest: Record<string, unknown> = {
  ...rawManifest,
  background: { scripts: ["background.js"] },
};

const assetRelPaths = [
  "background.js",
  "content.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
] as const;

const missing = assetRelPaths.filter((rel) => !existsSync(join(SRC_DIR, rel)));
if (missing.length > 0) {
  console.error(`Missing browser-bridge files: ${missing.join(", ")}`);
  process.exit(1);
}

const chromiumOut = join(DIST_DIR, `astra-navi-browser-bridge-chromium-${version}.zip`);
const firefoxOut = join(DIST_DIR, `astra-navi-browser-bridge-firefox-${version}.zip`);

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        version,
        outputs: [chromiumOut, firefoxOut],
        files: ["manifest.json", ...assetRelPaths],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const sharedEntries = await Promise.all(
  assetRelPaths.map(async (rel) => ({
    name: rel,
    data: await readFile(join(SRC_DIR, rel)),
  })),
);

const chromiumZip = buildZip([
  { name: "manifest.json", data: Buffer.from(`${JSON.stringify(chromiumManifest, null, 2)}\n`) },
  ...sharedEntries,
]);
const firefoxZip = buildZip([
  { name: "manifest.json", data: Buffer.from(`${JSON.stringify(firefoxManifest, null, 2)}\n`) },
  ...sharedEntries,
]);

await mkdir(DIST_DIR, { recursive: true });
await writeFile(chromiumOut, chromiumZip);
await writeFile(firefoxOut, firefoxZip);

const sums = [
  `${createHash("sha256").update(chromiumZip).digest("hex")}  astra-navi-browser-bridge-chromium-${version}.zip`,
  `${createHash("sha256").update(firefoxZip).digest("hex")}  astra-navi-browser-bridge-firefox-${version}.zip`,
].join("\n");
await writeFile(join(DIST_DIR, "browser-bridge-checksums.txt"), `${sums}\n`, "utf8");
console.log(`Packaged:\n- ${chromiumOut}\n- ${firefoxOut}`);
