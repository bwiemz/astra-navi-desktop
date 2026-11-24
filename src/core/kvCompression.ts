/**
 * Extreme KV-Cache Compression for Long-Horizon Missions (TurboQuant-style 3/4-bit).
 *
 * Applies an orthogonal Fast Walsh-Hadamard Transform (`fwhtInPlace`) to decorrelate
 * attention key/value outliers across dimensions into an approximately isotropic Gaussian
 * distribution, then quantizes coordinates with optimal Lloyd-Max 3-bit (8-level) or
 * 4-bit (16-level) scalar codebooks.
 */

export type KvQuantBits = 3 | 4;

// Standard-normal N(0, 1) Lloyd-Max reconstruction centroids (Max 1960 / TurboQuant reference).
const LLOYD_MAX_3BIT: readonly number[] = [
  -2.152, -1.344, -0.756, -0.2451, 0.2451, 0.756, 1.344, 2.152,
];

const LLOYD_MAX_4BIT: readonly number[] = [
  -2.733, -2.069, -1.618, -1.256, -0.9423, -0.6568, -0.388, -0.1284,
  0.1284, 0.388, 0.6568, 0.9423, 1.256, 1.618, 2.069, 2.733,
];

export interface QuantizedKvVector {
  originalDim: number;
  paddedDim: number;
  bits: KvQuantBits;
  rmsScale: number;
  codes: Uint8Array;
  compressedBytes: number;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Orthogonal in-place Normalized Fast Walsh-Hadamard Transform (self-inverse). */
export function fwhtInPlace(vec: Float32Array): Float32Array {
  const n = vec.length;
  if (n <= 1 || (n & (n - 1)) !== 0) {
    throw new Error(`FWHT requires power-of-two length (got ${n}).`);
  }
  for (let len = 1; len < n; len <<= 1) {
    const step = len << 1;
    for (let i = 0; i < n; i += step) {
      for (let j = 0; j < len; j += 1) {
        const u = vec[i + j] ?? 0;
        const v = vec[i + j + len] ?? 0;
        vec[i + j] = u + v;
        vec[i + j + len] = u - v;
      }
    }
  }
  const scale = 1 / Math.sqrt(n);
  for (let i = 0; i < n; i += 1) {
    vec[i] = (vec[i] ?? 0) * scale;
  }
  return vec;
}

function nearestCentroidIndex(val: number, centroids: readonly number[]): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < centroids.length; i += 1) {
    const c = centroids[i] ?? 0;
    const d = Math.abs(val - c);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Rotates via FWHT and quantizes KV activations to 3-bit or 4-bit Lloyd-Max indices. */
export function quantizeKvVector(input: Float32Array, bits: KvQuantBits = 4): QuantizedKvVector {
  const originalDim = input.length;
  const paddedDim = Math.max(1, nextPowerOfTwo(originalDim));
  const work = new Float32Array(paddedDim);
  work.set(input);

  fwhtInPlace(work);

  let sumSq = 0;
  for (let i = 0; i < paddedDim; i += 1) {
    const v = work[i] ?? 0;
    sumSq += v * v;
  }
  const rmsScale = Math.sqrt(sumSq / paddedDim) || 1;
  const centroids = bits === 3 ? LLOYD_MAX_3BIT : LLOYD_MAX_4BIT;
  const codes = new Uint8Array(paddedDim);

  for (let i = 0; i < paddedDim; i += 1) {
    const normVal = (work[i] ?? 0) / rmsScale;
    codes[i] = nearestCentroidIndex(normVal, centroids);
  }

  return {
    originalDim,
    paddedDim,
    bits,
    rmsScale,
    codes,
    compressedBytes: Math.ceil((paddedDim * bits) / 8) + 4,
  };
}

/** Reconstructs quantized KV coordinates via Lloyd-Max lookup + inverse orthogonal FWHT. */
export function dequantizeKvVector(q: QuantizedKvVector): Float32Array {
  const centroids = q.bits === 3 ? LLOYD_MAX_3BIT : LLOYD_MAX_4BIT;
  const work = new Float32Array(q.paddedDim);
  for (let i = 0; i < q.paddedDim; i += 1) {
    const code = q.codes[i] ?? 0;
    work[i] = (centroids[code] ?? 0) * q.rmsScale;
  }
  fwhtInPlace(work);
  return work.subarray(0, q.originalDim);
}

/** Measures cosine similarity and SNR (dB) between original KV vector and reconstructed vector. */
export function measureQuantizationFidelity(
  original: Float32Array,
  reconstructed: Float32Array,
): { cosineSimilarity: number; snrDb: number } {
  const n = Math.min(original.length, reconstructed.length);
  if (n === 0) return { cosineSimilarity: 1, snrDb: 99 };
  let dot = 0;
  let sigPow = 0;
  let recPow = 0;
  let errPow = 0;
  for (let i = 0; i < n; i += 1) {
    const o = original[i] ?? 0;
    const r = reconstructed[i] ?? 0;
    const err = o - r;
    dot += o * r;
    sigPow += o * o;
    recPow += r * r;
    errPow += err * err;
  }
  const denom = Math.sqrt(sigPow) * Math.sqrt(recPow);
  const cosineSimilarity = denom > 1e-9 ? dot / denom : 1;
  const snrDb = errPow > 1e-12 ? 10 * Math.log10(Math.max(1e-12, sigPow) / errPow) : 60;
  return {
    cosineSimilarity: Number(cosineSimilarity.toFixed(5)),
    snrDb: Number(snrDb.toFixed(2)),
  };
}

/** Estimates multi-week mission KV VRAM footprint comparing FP16 baseline vs 3/4-bit TurboQuant. */
export function estimateLongHorizonMissionKv(params: {
  totalTokens: number;
  kvBytesPerToken: number;
  bits: KvQuantBits;
}): {
  fp16Mb: number;
  compressedMb: number;
  savedMb: number;
  compressionRatio: number;
} {
  const tokens = Math.max(0, Math.round(params.totalTokens));
  const fp16Bytes = tokens * Math.max(1024, params.kvBytesPerToken);
  // FP16 = 16 bits/element; compressed = bits/element + ~4% per-block RMS scale metadata
  const ratioFactor = (params.bits / 16) * 1.04;
  const compressedBytes = fp16Bytes * ratioFactor;
  const fp16Mb = Number((fp16Bytes / (1024 * 1024)).toFixed(2));
  const compressedMb = Number((compressedBytes / (1024 * 1024)).toFixed(2));
  return {
    fp16Mb,
    compressedMb,
    savedMb: Number(Math.max(0, fp16Mb - compressedMb).toFixed(2)),
    compressionRatio: Number((fp16Bytes / Math.max(1, compressedBytes)).toFixed(2)),
  };
}
