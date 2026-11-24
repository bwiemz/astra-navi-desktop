/**
 * VRM Animation 1.0 (`.vrma` / GLB 2.0 `VRMC_vrm_animation`) Binary Parser & Sampler.
 *
 * Pure TypeScript shared safely between Electron renderer (`avatarAnimator.ts`) and
 * Node tests with zero DOM or `node:*` dependencies. Bounds-checked against truncated,
 * oversized, non-finite, or malformed GLB payloads.
 */

export type QuatTuple = [number, number, number, number];
export type Vec3Tuple = [number, number, number];

export interface QuaternionKeyframeTrack {
  times: Float32Array;
  values: Float32Array; // length = times.length * 4
}

export interface Vec3KeyframeTrack {
  times: Float32Array;
  values: Float32Array; // length = times.length * 3
}

export interface ScalarKeyframeTrack {
  times: Float32Array;
  values: Float32Array; // length = times.length
}

export interface VrmaClip {
  name: string;
  specVersion: string;
  durationSec: number;
  humanoidRotations: Record<string, QuaternionKeyframeTrack>;
  hipsTranslation: Vec3KeyframeTrack | null;
  expressions: Record<string, ScalarKeyframeTrack>;
  lookAt: Vec3KeyframeTrack | null;
}

export interface VrmaPoseSample {
  timeSec: number;
  humanoidRotations: Record<string, QuatTuple>;
  hipsTranslation: Vec3Tuple | null;
  expressions: Record<string, number>;
  lookAt: Vec3Tuple | null;
}

const GLB_MAGIC = 0x46546c67; // "glTF" little-endian
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON"
const CHUNK_TYPE_BIN = 0x004e4942; // "BIN\0"
const MAX_VRMA_BYTES = 32 * 1024 * 1024;
const MAX_KEYFRAMES = 250_000;

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfAnimationSampler {
  input: number;
  output: number;
  interpolation?: string;
}

interface GltfAnimationChannel {
  sampler: number;
  target: { node?: number; path: string };
}

interface GltfRoot {
  extensionsUsed?: unknown;
  extensions?: {
    VRMC_vrm_animation?: {
      specVersion?: unknown;
      humanoid?: {
        humanBones?: Record<string, { node?: unknown }>;
      };
      expressions?: {
        preset?: Record<string, { node?: unknown }>;
        custom?: Record<string, { node?: unknown }>;
      };
      lookAt?: {
        node?: unknown;
      };
    };
  };
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  animations?: Array<{
    name?: string;
    samplers?: GltfAnimationSampler[];
    channels?: GltfAnimationChannel[];
  }>;
}

function componentByteSize(componentType: number): number {
  switch (componentType) {
    case 5120: // BYTE
    case 5121: // UNSIGNED_BYTE
      return 1;
    case 5122: // SHORT
    case 5123: // UNSIGNED_SHORT
      return 2;
    case 5125: // UNSIGNED_INT
    case 5126: // FLOAT
      return 4;
    default:
      throw new Error(`Unsupported glTF componentType ${componentType}.`);
  }
}

function typeComponentCount(accessorType: string): number {
  switch (accessorType) {
    case "SCALAR":
      return 1;
    case "VEC2":
      return 2;
    case "VEC3":
      return 3;
    case "VEC4":
      return 4;
    default:
      throw new Error(`Unsupported glTF accessor type "${accessorType}".`);
  }
}

function readNormalizedComponent(
  view: DataView,
  byteOffset: number,
  componentType: number,
  normalized: boolean,
): number {
  let v: number;
  switch (componentType) {
    case 5126:
      v = view.getFloat32(byteOffset, true);
      break;
    case 5120:
      v = view.getInt8(byteOffset);
      if (normalized) v = Math.max(-1, v / 127);
      break;
    case 5121:
      v = view.getUint8(byteOffset);
      if (normalized) v = v / 255;
      break;
    case 5122:
      v = view.getInt16(byteOffset, true);
      if (normalized) v = Math.max(-1, v / 32767);
      break;
    case 5123:
      v = view.getUint16(byteOffset, true);
      if (normalized) v = v / 65535;
      break;
    case 5125:
      v = view.getUint32(byteOffset, true);
      break;
    default:
      throw new Error(`Unsupported glTF componentType ${componentType}.`);
  }
  if (!Number.isFinite(v)) {
    throw new Error("Non-finite float encountered inside VRMA accessor data.");
  }
  return v;
}

function readAccessorFloats(
  gltf: GltfRoot,
  binBytes: Uint8Array,
  accessorIndex: number,
  expectedComponents: number,
): Float32Array {
  const accessors = gltf.accessors ?? [];
  const bufferViews = gltf.bufferViews ?? [];
  const acc = accessors[accessorIndex];
  if (!acc || typeof acc.count !== "number" || acc.count < 0 || acc.count > MAX_KEYFRAMES) {
    throw new Error(`Invalid or out-of-range glTF accessor index ${accessorIndex}.`);
  }
  const actualComponents = typeComponentCount(acc.type);
  if (actualComponents !== expectedComponents) {
    throw new Error(
      `Accessor ${accessorIndex} has type "${acc.type}" (${actualComponents}), expected ${expectedComponents}.`,
    );
  }
  if (acc.bufferView === undefined) {
    throw new Error(`Accessor ${accessorIndex} references missing bufferView.`);
  }
  const bv = bufferViews[acc.bufferView];
  if (!bv) {
    throw new Error(`Accessor ${accessorIndex} references missing bufferView.`);
  }
  if (bv.buffer !== 0) {
    throw new Error(`VRMA bufferView must reference embedded GLB buffer 0 (got ${bv.buffer}).`);
  }
  const compSize = componentByteSize(acc.componentType);
  const elemSize = compSize * actualComponents;
  const bvOffset = bv.byteOffset ?? 0;
  const accOffset = acc.byteOffset ?? 0;
  const stride = bv.byteStride ?? elemSize;
  if (bvOffset < 0 || accOffset < 0 || stride < elemSize) {
    throw new Error(`Invalid negative or overlapping byte layout in accessor ${accessorIndex}.`);
  }
  if (bvOffset + bv.byteLength > binBytes.byteLength) {
    throw new Error(`bufferView ${acc.bufferView} exceeds GLB BIN chunk length.`);
  }
  if (acc.count > 0) {
    const lastByteEnd = accOffset + (acc.count - 1) * stride + elemSize;
    if (lastByteEnd > bv.byteLength || bvOffset + lastByteEnd > binBytes.byteLength) {
      throw new Error(`Accessor ${accessorIndex} overruns bufferView bounds.`);
    }
  }

  const out = new Float32Array(acc.count * actualComponents);
  const dv = new DataView(binBytes.buffer, binBytes.byteOffset, binBytes.byteLength);
  const normalized = Boolean(acc.normalized);
  for (let i = 0; i < acc.count; i += 1) {
    const itemStart = bvOffset + accOffset + i * stride;
    for (let c = 0; c < actualComponents; c += 1) {
      out[i * actualComponents + c] = readNormalizedComponent(
        dv,
        itemStart + c * compSize,
        acc.componentType,
        normalized,
      );
    }
  }
  return out;
}

function validateTimes(times: Float32Array): void {
  let prev = -Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i] ?? -1;
    if (t < 0 || t < prev) {
      throw new Error(`VRMA keyframe timestamps must be non-negative and non-decreasing (at ${i}).`);
    }
    prev = t;
  }
}

export function normalizeQuat(q: QuatTuple): QuatTuple {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(len) || len <= 1e-8) return [0, 0, 0, 1];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** Shortest-arc unit quaternion spherical linear interpolation. */
export function slerpQuat(aRaw: QuatTuple, bRaw: QuatTuple, t: number): QuatTuple {
  const a = normalizeQuat(aRaw);
  let bx = bRaw[0];
  let by = bRaw[1];
  let bz = bRaw[2];
  let bw = bRaw[3];
  const bNorm = Math.hypot(bx, by, bz, bw) || 1;
  bx /= bNorm;
  by /= bNorm;
  bz /= bNorm;
  bw /= bNorm;

  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  const clampedT = Math.max(0, Math.min(1, t));
  if (dot > 0.9995) {
    return normalizeQuat([
      a[0] + clampedT * (bx - a[0]),
      a[1] + clampedT * (by - a[1]),
      a[2] + clampedT * (bz - a[2]),
      a[3] + clampedT * (bw - a[3]),
    ]);
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.sin((1 - clampedT) * theta0) / sinTheta0;
  const s1 = Math.sin(clampedT * theta0) / sinTheta0;
  return normalizeQuat([
    s0 * a[0] + s1 * bx,
    s0 * a[1] + s1 * by,
    s0 * a[2] + s1 * bz,
    s0 * a[3] + s1 * bw,
  ]);
}

/** Parses and validates a binary `.vrma` (glTF 2.0 GLB + `VRMC_vrm_animation`) buffer. */
export function parseVrmaBinary(bytes: Uint8Array): VrmaClip {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("VRMA payload must be a Uint8Array.");
  }
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_VRMA_BYTES) {
    throw new Error(
      `VRMA buffer length ${bytes.byteLength} is outside valid bounds (20..${MAX_VRMA_BYTES}).`,
    );
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const declaredLen = dv.getUint32(8, true);
  if (magic !== GLB_MAGIC || version !== GLB_VERSION) {
    throw new Error("Invalid GLB/VRMA header magic or version.");
  }
  if (declaredLen !== bytes.byteLength) {
    throw new Error(`GLB declared byteLength ${declaredLen} does not match buffer (${bytes.byteLength}).`);
  }

  let cursor = 12;
  let jsonBytes: Uint8Array | null = null;
  let binBytes: Uint8Array | null = null;

  while (cursor + 8 <= bytes.byteLength) {
    const chunkLength = dv.getUint32(cursor, true);
    const chunkType = dv.getUint32(cursor + 4, true);
    cursor += 8;
    if (cursor + chunkLength > bytes.byteLength) {
      throw new Error("Truncated GLB chunk exceeds buffer bounds.");
    }
    const slice = bytes.subarray(cursor, cursor + chunkLength);
    if (chunkType === CHUNK_TYPE_JSON && !jsonBytes) {
      jsonBytes = slice;
    } else if (chunkType === CHUNK_TYPE_BIN && !binBytes) {
      binBytes = slice;
    }
    cursor += chunkLength;
  }

  if (!jsonBytes) {
    throw new Error("VRMA GLB missing JSON chunk.");
  }
  const safeBin = binBytes ?? new Uint8Array(0);
  const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  const gltf = JSON.parse(jsonText) as GltfRoot;

  const vrmaExt = gltf.extensions?.VRMC_vrm_animation;
  if (!vrmaExt || typeof vrmaExt !== "object") {
    throw new Error("Missing extensions.VRMC_vrm_animation in VRMA asset.");
  }
  const specVersion = typeof vrmaExt.specVersion === "string" ? vrmaExt.specVersion : "1.0";

  const nodeToBone = new Map<number, string>();
  const humanBones = vrmaExt.humanoid?.humanBones ?? {};
  for (const [boneName, ref] of Object.entries(humanBones)) {
    if (typeof ref?.node === "number" && Number.isInteger(ref.node)) {
      nodeToBone.set(ref.node, boneName);
    }
  }

  const nodeToExpression = new Map<number, string>();
  const presets = vrmaExt.expressions?.preset ?? {};
  const customs = vrmaExt.expressions?.custom ?? {};
  for (const [exprName, ref] of [...Object.entries(presets), ...Object.entries(customs)]) {
    if (typeof ref?.node === "number" && Number.isInteger(ref.node)) {
      nodeToExpression.set(ref.node, exprName);
    }
  }
  const lookAtNode =
    typeof vrmaExt.lookAt?.node === "number" && Number.isInteger(vrmaExt.lookAt.node)
      ? vrmaExt.lookAt.node
      : null;

  const anim = gltf.animations?.[0];
  if (!anim) {
    throw new Error("VRMA file contains no glTF animation channels.");
  }
  const samplers = anim.samplers ?? [];
  const channels = anim.channels ?? [];

  const humanoidRotations: Record<string, QuaternionKeyframeTrack> = {};
  const expressions: Record<string, ScalarKeyframeTrack> = {};
  let hipsTranslation: Vec3KeyframeTrack | null = null;
  let lookAt: Vec3KeyframeTrack | null = null;
  let maxTime = 0;

  for (const ch of channels) {
    const sampler = samplers[ch.sampler];
    if (!sampler) throw new Error(`Missing glTF sampler ${ch.sampler}.`);
    const nodeIdx = ch.target?.node;
    if (typeof nodeIdx !== "number") continue;

    const times = readAccessorFloats(gltf, safeBin, sampler.input, 1);
    validateTimes(times);
    if (times.length > 0) {
      maxTime = Math.max(maxTime, times[times.length - 1] ?? 0);
    }

    const boneName = nodeToBone.get(nodeIdx);
    if (boneName && ch.target.path === "rotation") {
      const values = readAccessorFloats(gltf, safeBin, sampler.output, 4);
      if (values.length !== times.length * 4) {
        throw new Error(`Rotation track for "${boneName}" keyframe count mismatch.`);
      }
      humanoidRotations[boneName] = { times, values };
      continue;
    }

    if (boneName === "hips" && ch.target.path === "translation") {
      const values = readAccessorFloats(gltf, safeBin, sampler.output, 3);
      if (values.length !== times.length * 3) {
        throw new Error("Hips translation track keyframe count mismatch.");
      }
      hipsTranslation = { times, values };
      continue;
    }

    const exprName = nodeToExpression.get(nodeIdx);
    if (exprName && ch.target.path === "translation") {
      const vecValues = readAccessorFloats(gltf, safeBin, sampler.output, 3);
      if (vecValues.length !== times.length * 3) {
        throw new Error(`Expression track "${exprName}" keyframe count mismatch.`);
      }
      const scalar = new Float32Array(times.length);
      for (let i = 0; i < times.length; i += 1) {
        scalar[i] = Math.max(0, Math.min(1, vecValues[i * 3] ?? 0));
      }
      expressions[exprName] = { times, values: scalar };
      continue;
    }

    if (lookAtNode !== null && nodeIdx === lookAtNode && ch.target.path === "translation") {
      const values = readAccessorFloats(gltf, safeBin, sampler.output, 3);
      if (values.length !== times.length * 3) {
        throw new Error("lookAt track keyframe count mismatch.");
      }
      lookAt = { times, values };
    }
  }

  return {
    name: anim.name || "vrma-clip",
    specVersion,
    durationSec: maxTime,
    humanoidRotations,
    hipsTranslation,
    expressions,
    lookAt,
  };
}

function findKeyframeSpan(times: Float32Array, timeSec: number): [number, number, number] {
  if (times.length === 0) return [0, 0, 0];
  const tFirst = times[0] ?? 0;
  if (times.length === 1 || timeSec <= tFirst) return [0, 0, 0];
  const lastIdx = times.length - 1;
  const tLast = times[lastIdx] ?? tFirst;
  if (timeSec >= tLast) return [lastIdx, lastIdx, 0];

  let lo = 0;
  let hi = lastIdx;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? 0) <= timeSec) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo] ?? 0;
  const t1 = times[hi] ?? t0;
  const span = t1 - t0;
  const alpha = span > 1e-6 ? Math.max(0, Math.min(1, (timeSec - t0) / span)) : 0;
  return [lo, hi, alpha];
}

function sampleVec3Track(track: Vec3KeyframeTrack, timeSec: number): Vec3Tuple {
  const [i0, i1, alpha] = findKeyframeSpan(track.times, timeSec);
  const x = (track.values[i0 * 3] ?? 0) * (1 - alpha) + (track.values[i1 * 3] ?? 0) * alpha;
  const y = (track.values[i0 * 3 + 1] ?? 0) * (1 - alpha) + (track.values[i1 * 3 + 1] ?? 0) * alpha;
  const z = (track.values[i0 * 3 + 2] ?? 0) * (1 - alpha) + (track.values[i1 * 3 + 2] ?? 0) * alpha;
  return [x, y, z];
}

/** Samples all humanoid rotations, hips offset, expressions, and lookAt at `timeSec`. */
export function sampleVrmaClip(clip: VrmaClip, rawTimeSec: number, loop = true): VrmaPoseSample {
  const dur = Math.max(0, clip.durationSec);
  let timeSec = Number.isFinite(rawTimeSec) ? Math.max(0, rawTimeSec) : 0;
  if (dur > 0) {
    timeSec = loop ? timeSec % dur : Math.min(dur, timeSec);
  } else {
    timeSec = 0;
  }

  const humanoidRotations: Record<string, QuatTuple> = {};
  for (const [bone, track] of Object.entries(clip.humanoidRotations)) {
    if (track.times.length === 0) continue;
    const [i0, i1, alpha] = findKeyframeSpan(track.times, timeSec);
    const q0: QuatTuple = [
      track.values[i0 * 4] ?? 0,
      track.values[i0 * 4 + 1] ?? 0,
      track.values[i0 * 4 + 2] ?? 0,
      track.values[i0 * 4 + 3] ?? 1,
    ];
    const q1: QuatTuple = [
      track.values[i1 * 4] ?? 0,
      track.values[i1 * 4 + 1] ?? 0,
      track.values[i1 * 4 + 2] ?? 0,
      track.values[i1 * 4 + 3] ?? 1,
    ];
    humanoidRotations[bone] = slerpQuat(q0, q1, alpha);
  }

  const expressions: Record<string, number> = {};
  for (const [name, track] of Object.entries(clip.expressions)) {
    if (track.times.length === 0) continue;
    const [i0, i1, alpha] = findKeyframeSpan(track.times, timeSec);
    expressions[name] =
      (track.values[i0] ?? 0) * (1 - alpha) + (track.values[i1] ?? 0) * alpha;
  }

  return {
    timeSec,
    humanoidRotations,
    hipsTranslation: clip.hipsTranslation ? sampleVec3Track(clip.hipsTranslation, timeSec) : null,
    expressions,
    lookAt: clip.lookAt ? sampleVec3Track(clip.lookAt, timeSec) : null,
  };
}
