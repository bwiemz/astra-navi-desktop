/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level L, Versions 1–10)
 * plus pairing URI helper aligned with `MainActivity.java` (`astranavi://station?...`).
 */

export interface QrMatrix {
  version: number;
  size: number;
  modules: boolean[][];
}

interface VersionSpec {
  version: number;
  totalCodewords: number;
  dataCodewords: number;
  eccPerBlock: number;
  group1Blocks: number;
  group1Data: number;
  group2Blocks: number;
  group2Data: number;
  alignmentCenters: readonly number[];
}

// ISO/IEC 18004 Table 7 & Table 9 (ECC Level L, Versions 1–10)
const VERSIONS_L: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, dataCodewords: 19, eccPerBlock: 7, group1Blocks: 1, group1Data: 19, group2Blocks: 0, group2Data: 0, alignmentCenters: [] },
  { version: 2, totalCodewords: 44, dataCodewords: 34, eccPerBlock: 10, group1Blocks: 1, group1Data: 34, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 18] },
  { version: 3, totalCodewords: 70, dataCodewords: 55, eccPerBlock: 15, group1Blocks: 1, group1Data: 55, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 22] },
  { version: 4, totalCodewords: 100, dataCodewords: 80, eccPerBlock: 20, group1Blocks: 1, group1Data: 80, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 26] },
  { version: 5, totalCodewords: 134, dataCodewords: 108, eccPerBlock: 26, group1Blocks: 1, group1Data: 108, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 30] },
  { version: 6, totalCodewords: 172, dataCodewords: 136, eccPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 34] },
  { version: 7, totalCodewords: 196, dataCodewords: 156, eccPerBlock: 20, group1Blocks: 2, group1Data: 78, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 22, 38] },
  { version: 8, totalCodewords: 242, dataCodewords: 194, eccPerBlock: 24, group1Blocks: 2, group1Data: 97, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 24, 42] },
  { version: 9, totalCodewords: 292, dataCodewords: 232, eccPerBlock: 30, group1Blocks: 2, group1Data: 116, group2Blocks: 0, group2Data: 0, alignmentCenters: [6, 26, 46] },
  { version: 10, totalCodewords: 346, dataCodewords: 274, eccPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 2, group2Data: 69, alignmentCenters: [6, 28, 50] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255] ?? 0;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[((GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)) % 255] ?? 0;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i] ?? 1;
    for (let j = 0; j < poly.length; j += 1) {
      const term = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ term;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(term, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGeneratorPoly(eccLen);
  const work = new Uint8Array(data.length + eccLen);
  work.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const coef = work[i] ?? 0;
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j += 1) {
      work[i + j] = (work[i + j] ?? 0) ^ gfMul(gen[j] ?? 0, coef);
    }
  }
  return work.slice(data.length);
}

function pushBits(bits: number[], value: number, count: number): void {
  for (let i = count - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function pickVersionSpec(byteLength: number): VersionSpec {
  for (const spec of VERSIONS_L) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= spec.dataCodewords * 8) return spec;
  }
  throw new Error(`QR payload too long (${byteLength} bytes; max 271 bytes at Version 10-L).`);
}

function buildCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // Byte mode
  pushBits(bits, bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);

  const maxBits = spec.dataCodewords * 8;
  const terminator = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let b = 0; b < 8; b += 1) v = (v << 1) | (bits[i + b] ?? 0);
    dataBytes.push(v);
  }
  const padBytes = [0xec, 0x11] as const;
  let padIdx = 0;
  while (dataBytes.length < spec.dataCodewords) {
    dataBytes.push(padBytes[padIdx % 2] ?? 0xec);
    padIdx += 1;
  }

  const blocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let cursor = 0;
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const slice = Uint8Array.from(dataBytes.slice(cursor, cursor + spec.group1Data));
    cursor += spec.group1Data;
    blocks.push(slice);
    eccBlocks.push(rsRemainder(slice, spec.eccPerBlock));
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const slice = Uint8Array.from(dataBytes.slice(cursor, cursor + spec.group2Data));
    cursor += spec.group2Data;
    blocks.push(slice);
    eccBlocks.push(rsRemainder(slice, spec.eccPerBlock));
  }

  const result = new Uint8Array(spec.totalCodewords);
  let out = 0;
  const maxDataLen = Math.max(spec.group1Data, spec.group2Data);
  for (let col = 0; col < maxDataLen; col += 1) {
    for (const blk of blocks) {
      if (col < blk.length) {
        result[out] = blk[col] ?? 0;
        out += 1;
      }
    }
  }
  for (let col = 0; col < spec.eccPerBlock; col += 1) {
    for (const ecc of eccBlocks) {
      result[out] = ecc[col] ?? 0;
      out += 1;
    }
  }
  return result;
}

function setGridCell<T>(grid: T[][], r: number, c: number, val: T): void {
  const row = grid[r];
  if (row && c >= 0 && c < row.length) row[c] = val;
}

function getGridCell<T>(grid: readonly T[][], r: number, c: number): T | undefined {
  return grid[r]?.[c];
}

function drawFinder(grid: (boolean | null)[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= grid.length || cc < 0 || cc >= grid.length) continue;
      const inOuter = r === 0 || r === 6 || c === 0 || c === 6;
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const onSeparator = r === -1 || r === 7 || c === -1 || c === 7;
      setGridCell(grid, rr, cc, !onSeparator && (inOuter || inInner));
    }
  }
}

function drawAlignment(grid: (boolean | null)[][], row: number, col: number): void {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const dark = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      setGridCell(grid, row + r, col + c, dark);
    }
  }
}

function bchVersion(version: number): number {
  let d = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((d >>> i) & 1) d ^= 0x1f25 << (i - 12);
  }
  return d;
}

function bchFormat(data5: number): number {
  let d = data5 << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
  }
  return ((data5 << 10) | d) ^ 0x5412;
}

function buildFunctionGrid(spec: VersionSpec): {
  modules: boolean[][];
  reserved: boolean[][];
  size: number;
} {
  const size = 17 + 4 * spec.version;
  const grid: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array<boolean | null>(size).fill(null),
  );

  drawFinder(grid, 0, 0);
  drawFinder(grid, 0, size - 7);
  drawFinder(grid, size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    if (getGridCell(grid, 6, i) === null) setGridCell(grid, 6, i, dark);
    if (getGridCell(grid, i, 6) === null) setGridCell(grid, i, 6, dark);
  }

  for (const r of spec.alignmentCenters) {
    for (const c of spec.alignmentCenters) {
      if (getGridCell(grid, r, c) !== null) continue;
      drawAlignment(grid, r, c);
    }
  }

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      if (getGridCell(grid, 8, i) === null) setGridCell(grid, 8, i, false);
      if (getGridCell(grid, i, 8) === null) setGridCell(grid, i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i += 1) {
    if (getGridCell(grid, 8, i) === null) setGridCell(grid, 8, i, false);
    if (getGridCell(grid, i, 8) === null) setGridCell(grid, i, 8, false);
  }
  setGridCell(grid, 4 * spec.version + 9, 8, true);

  if (spec.version >= 7) {
    const versionBits = (spec.version << 12) | (bchVersion(spec.version) & 0xfff);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((versionBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setGridCell(grid, a, b, bit);
      setGridCell(grid, b, a, bit);
    }
  }

  const reserved = grid.map((row) => row.map((cell) => cell !== null));
  const modules = grid.map((row) => row.map((cell) => cell === true));
  return { modules, reserved, size };
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function writeFormatBits(modules: boolean[][], mask: number): void {
  const size = modules.length;
  // ECC Level L indicator = 0b01
  const bits = bchFormat((0b01 << 3) | mask);
  for (let i = 0; i <= 5; i += 1) setGridCell(modules, 8, i, ((bits >>> i) & 1) === 1);
  setGridCell(modules, 8, 7, ((bits >>> 6) & 1) === 1);
  setGridCell(modules, 8, 8, ((bits >>> 7) & 1) === 1);
  setGridCell(modules, 7, 8, ((bits >>> 8) & 1) === 1);
  for (let i = 9; i < 15; i += 1) setGridCell(modules, 14 - i, 8, ((bits >>> i) & 1) === 1);

  for (let i = 0; i < 8; i += 1) setGridCell(modules, size - 1 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 8; i < 15; i += 1) setGridCell(modules, 8, size - 15 + i, ((bits >>> i) & 1) === 1);
}

function penaltyScore(modules: boolean[][]): number {
  const n = modules.length;
  let score = 0;
  let darkCount = 0;
  for (let r = 0; r < n; r += 1) {
    let runH = 1;
    let runV = 1;
    for (let c = 0; c < n; c += 1) {
      if (getGridCell(modules, r, c)) darkCount += 1;
      if (c > 0) {
        if (getGridCell(modules, r, c) === getGridCell(modules, r, c - 1)) runH += 1;
        else {
          if (runH >= 5) score += runH - 2;
          runH = 1;
        }
        if (getGridCell(modules, c, r) === getGridCell(modules, c - 1, r)) runV += 1;
        else {
          if (runV >= 5) score += runV - 2;
          runV = 1;
        }
      }
      if (r < n - 1 && c < n - 1) {
        const b = getGridCell(modules, r, c);
        if (
          b === getGridCell(modules, r, c + 1) &&
          b === getGridCell(modules, r + 1, c) &&
          b === getGridCell(modules, r + 1, c + 1)
        ) {
          score += 3;
        }
      }
    }
    if (runH >= 5) score += runH - 2;
    if (runV >= 5) score += runV - 2;
  }
  const pct = Math.abs((darkCount * 100) / (n * n) - 50);
  score += Math.floor(pct / 5) * 10;
  return score;
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = pickVersionSpec(bytes.length);
  const codewords = buildCodewords(bytes, spec);
  const { modules: baseModules, reserved, size } = buildFunctionGrid(spec);

  // Place data bits zig-zag right-to-left
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((size - 1 - right) >> 1) % 2 === 0;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (getGridCell(reserved, r, c)) continue;
        let bit = false;
        if (bitIdx < totalBits) {
          bit = (((codewords[bitIdx >> 3] ?? 0) >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx += 1;
        }
        setGridCell(baseModules, r, c, bit);
      }
    }
  }

  let bestScore = Number.POSITIVE_INFINITY;
  let bestModules = baseModules;
  for (let mask = 0; mask < 8; mask += 1) {
    const cand = baseModules.map((row, r) =>
      row.map((val, c) => (getGridCell(reserved, r, c) ? val : maskBit(mask, r, c) ? !val : val)),
    );
    writeFormatBits(cand, mask);
    const s = penaltyScore(cand);
    if (s < bestScore) {
      bestScore = s;
      bestModules = cand;
    }
  }

  return { version: spec.version, size, modules: bestModules };
}

export function buildPairingUri(options: {
  address: string;
  fingerprint: string;
  code: string;
}): string {
  const cleanFp = options.fingerprint.replaceAll(":", "").toUpperCase();
  return `astranavi://station?at=${encodeURIComponent(options.address)}&fp=${encodeURIComponent(cleanFp)}&code=${encodeURIComponent(options.code)}`;
}
