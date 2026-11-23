/**
 * Pure TypeScript VRM 1.0 (and VRM 0.x fallback) glTF 2.0 binary parser &
 * deterministic Verlet spring-bone physics solver.
 *
 * Hardened against malformed containers, integer/allocation bombs, oversized
 * textures, unsafe image MIMEs, non-finite transforms, and invalid indices.
 * Shared across Electron main (`core/modelBundle.ts`) and Chromium renderer
 * (`renderer/src/vrmLoader.ts`) with zero `node:*` or third-party loader
 * dependencies.
 */

const GLTF_MAGIC = 0x46546c67; // "glTF" little-endian
const GLTF_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export const MAX_GLB_BYTES = 128 * 1024 * 1024;
export const MAX_JSON_CHUNK_BYTES = 16 * 1024 * 1024;
export const MAX_NODES = 4096;
export const MAX_MESHES = 512;
export const MAX_PRIMITIVES = 2048;
export const MAX_IMAGES = 128;
export const MAX_MATERIALS = 512;
export const MAX_SKINS = 64;
export const MAX_ACCESSORS = 4096;
export const MAX_BUFFER_VIEWS = 4096;
export const MAX_ACCESSOR_COUNT = 2_000_000;
export const MAX_TEXTURE_DIM = 4096;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export const VRM_VISEME_PRESETS = ["aa", "ih", "ou", "ee", "oh"] as const;
export type VrmVisemePreset = (typeof VRM_VISEME_PRESETS)[number];

export interface VrmMeta {
  specVersion: "1.0" | "0.x";
  name: string;
  version: string;
  authors: string[];
  licenseUrl: string;
  commercialUsage: string;
  comment: string;
}

export interface VrmMorphBind {
  node: number;
  mesh?: number;
  index: number;
  weight: number;
}

export interface VrmExpressionDef {
  name: string;
  preset: string;
  isBinary: boolean;
  binds: VrmMorphBind[];
}

export interface VrmSpringJoint {
  node: number;
  hitRadius: number;
  stiffness: number;
  gravityPower: number;
  gravityDir: readonly [number, number, number];
  dragForce: number;
}

export interface VrmSpringCollider {
  node: number;
  shape: "sphere" | "capsule";
  offset: readonly [number, number, number];
  radius: number;
  tail?: readonly [number, number, number];
}

export interface VrmSpringChain {
  name: string;
  joints: VrmSpringJoint[];
  colliders: VrmSpringCollider[];
  center?: number;
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC2" | "VEC3" | "VEC4" | "MAT4";
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

export interface GltfMeshPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}

export interface GltfMesh {
  name?: string;
  primitives: GltfMeshPrimitive[];
}

export interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  translation?: readonly [number, number, number];
  rotation?: readonly [number, number, number, number];
  scale?: readonly [number, number, number];
  matrix?: readonly number[];
}

export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: readonly [number, number, number, number];
    baseColorTexture?: { index: number };
    metallicFactor?: number;
    roughnessFactor?: number;
  };
  alphaMode?: "OPAQUE" | "MASK" | "BLEND";
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: {
    VRMC_materials_mtoon?: {
      shadeColorFactor?: readonly [number, number, number];
      shadingToonyFactor?: number;
      shadingShiftFactor?: number;
      outlineWidthMode?: string;
      outlineWidthFactor?: number;
      outlineColorFactor?: readonly [number, number, number];
    };
  };
}

export interface GltfImage {
  name?: string;
  mimeType?: string;
  bufferView?: number;
  uri?: string;
}

export interface GltfTexture {
  source?: number;
  sampler?: number;
}

export interface GltfSkin {
  name?: string;
  inverseBindMatrices?: number;
  skeleton?: number;
  joints: number[];
}

export interface ParsedVrmDocument {
  meta: VrmMeta;
  /** Canonical VRM 1.0 bone name (e.g. `head`, `hips`, `leftUpperArm`) -> glTF node index. */
  humanoidBones: Record<string, number>;
  /** Preset expression/viseme name (e.g. `aa`, `happy`, `blink`) -> binds & binary flag. */
  expressions: Record<string, VrmExpressionDef>;
  springs: VrmSpringChain[];
  nodes: GltfNode[];
  meshes: GltfMesh[];
  materials: GltfMaterial[];
  textures: GltfTexture[];
  images: GltfImage[];
  skins: GltfSkin[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  scenes: { nodes?: number[] }[];
  defaultScene: number;
  binChunk: Uint8Array;
}

export interface VrmSummary {
  specVersion: "1.0" | "0.x";
  name: string;
  version: string;
  authors: string[];
  license: string;
  comment: string;
}

const VRM0_EXPRESSION_MAP: Record<string, string> = {
  a: "aa",
  i: "ih",
  u: "ou",
  e: "ee",
  o: "oh",
  blink: "blink",
  blink_l: "blinkLeft",
  blink_r: "blinkRight",
  joy: "happy",
  angry: "angry",
  sorrow: "sad",
  fun: "relaxed",
  surprised: "surprised",
  neutral: "neutral",
  lookup: "lookUp",
  lookdown: "lookDown",
  lookleft: "lookLeft",
  lookright: "lookRight",
};

const VRM0_BONE_MAP: Record<string, string> = {
  hips: "hips",
  spine: "spine",
  chest: "chest",
  upperChest: "upperChest",
  neck: "neck",
  head: "head",
  leftEye: "leftEye",
  rightEye: "rightEye",
  jaw: "jaw",
  leftShoulder: "leftShoulder",
  leftUpperArm: "leftUpperArm",
  leftLowerArm: "leftLowerArm",
  leftHand: "leftHand",
  rightShoulder: "rightShoulder",
  rightUpperArm: "rightUpperArm",
  rightLowerArm: "rightLowerArm",
  rightHand: "rightHand",
  leftUpperLeg: "leftUpperLeg",
  leftLowerLeg: "leftLowerLeg",
  leftFoot: "leftFoot",
  rightUpperLeg: "rightUpperLeg",
  rightLowerLeg: "rightLowerLeg",
  rightFoot: "rightFoot",
};

function asRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function asString(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

function asNumber(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

function asNonNegInt(val: unknown): number | undefined {
  return typeof val === "number" && Number.isInteger(val) && val >= 0 ? val : undefined;
}

function asVec3(val: unknown, fallback: readonly [number, number, number]): [number, number, number] {
  if (!Array.isArray(val) || val.length < 3) return [fallback[0], fallback[1], fallback[2]];
  return [
    asNumber(val[0], fallback[0]),
    asNumber(val[1], fallback[1]),
    asNumber(val[2], fallback[2]),
  ];
}

function asVec4(
  val: unknown,
  fallback: readonly [number, number, number, number],
): [number, number, number, number] {
  if (!Array.isArray(val) || val.length < 4) {
    return [fallback[0], fallback[1], fallback[2], fallback[3]];
  }
  return [
    asNumber(val[0], fallback[0]),
    asNumber(val[1], fallback[1]),
    asNumber(val[2], fallback[2]),
    asNumber(val[3], fallback[3]),
  ];
}

function vec3ObjToTuple(
  val: unknown,
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (Array.isArray(val)) return asVec3(val, fallback);
  const rec = asRecord(val);
  if (!rec) return [fallback[0], fallback[1], fallback[2]];
  return [
    asNumber(rec["x"], fallback[0]),
    asNumber(rec["y"], fallback[1]),
    asNumber(rec["z"], fallback[2]),
  ];
}

function extractGlbChunks(bytes: Uint8Array): { json: Record<string, unknown>; bin: Uint8Array } {
  if (bytes.byteLength > MAX_GLB_BYTES) {
    throw new RangeError(`VRM/GLB file exceeds maximum allowed size (${MAX_GLB_BYTES} bytes).`);
  }
  if (bytes.byteLength < 20) {
    throw new RangeError("VRM/GLB file is truncated (smaller than 20-byte header).");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLTF_MAGIC) {
    throw new Error("Invalid VRM/GLB file: missing glTF binary header magic.");
  }
  const version = view.getUint32(4, true);
  if (version !== GLTF_VERSION) {
    throw new Error(`Unsupported glTF binary version ${version}; expected 2.`);
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength < 20 || declaredLength > bytes.byteLength) {
    throw new RangeError("Invalid VRM/GLB container: declared length is out of bounds.");
  }

  let offset = 12;
  let jsonRecord: Record<string, unknown> | null = null;
  let binChunk: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder("utf-8");

  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkLength > declaredLength - offset) {
      throw new RangeError("Corrupted VRM/GLB chunk: length exceeds container bounds.");
    }
    const slice = bytes.subarray(offset, offset + chunkLength);
    if (chunkType === CHUNK_JSON && jsonRecord === null) {
      if (chunkLength > MAX_JSON_CHUNK_BYTES) {
        throw new RangeError(`glTF JSON chunk exceeds maximum allowed size (${MAX_JSON_CHUNK_BYTES} bytes).`);
      }
      const parsed = JSON.parse(decoder.decode(slice)) as unknown;
      jsonRecord = asRecord(parsed);
      if (!jsonRecord) throw new Error("glTF JSON chunk must be an object.");
    } else if (chunkType === CHUNK_BIN && binChunk.byteLength === 0) {
      binChunk = slice;
    }
    offset += chunkLength;
  }

  if (!jsonRecord) {
    throw new Error("Invalid VRM/GLB file: missing JSON chunk.");
  }
  return { json: jsonRecord, bin: binChunk };
}

/** Fast metadata check for model import dialogs and bundle indexing. */
export function readVrmSummary(bytes: Uint8Array): VrmSummary | null {
  try {
    const parsed = parseVrmGlb(bytes);
    return {
      specVersion: parsed.meta.specVersion,
      name: parsed.meta.name,
      version: parsed.meta.version,
      authors: parsed.meta.authors,
      license: parsed.meta.licenseUrl,
      comment: parsed.meta.comment,
    };
  } catch {
    return null;
  }
}

function parseVrm1Meta(vrmc: Record<string, unknown>, nodes: GltfNode[]): VrmMeta {
  const metaRec = asRecord(vrmc["meta"]) ?? {};
  const authors = Array.isArray(metaRec["authors"])
    ? metaRec["authors"].filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
  const name = asString(metaRec["name"]).trim() || "VRM 1.0 Avatar";
  const version = asString(metaRec["version"], "1.0").trim();
  const licenseUrl = asString(metaRec["licenseUrl"], "https://vrm.dev/licenses/1.0/").trim();
  const commercialUsage = asString(metaRec["commercialUsage"], "personalNonProfit");
  const commentParts = [
    authors.length > 0 ? `Authors: ${authors.join(", ")}` : "",
    version ? `Version: ${version}` : "",
    `VRM Spec: 1.0 (${nodes.length} nodes)`,
    licenseUrl ? `License: ${licenseUrl}` : "",
  ].filter(Boolean);
  return {
    specVersion: "1.0",
    name,
    version,
    authors,
    licenseUrl,
    commercialUsage,
    comment: commentParts.join("\n"),
  };
}

function parseVrm0Meta(vrm0: Record<string, unknown>): VrmMeta {
  const metaRec = asRecord(vrm0["meta"]) ?? {};
  const author = asString(metaRec["author"]).trim();
  const authors = author ? [author] : [];
  const name = asString(metaRec["title"]).trim() || "VRM 0.x Avatar";
  const version = asString(metaRec["version"], "0.x").trim();
  const licenseUrl = asString(metaRec["otherLicenseUrl"] ?? metaRec["licenseName"], "VRM 0.x").trim();
  const commercialUsage = asString(metaRec["commercialUssageName"], "Disallow");
  const commentParts = [
    author ? `Author: ${author}` : "",
    version ? `Version: ${version}` : "",
    `License: ${licenseUrl}`,
  ].filter(Boolean);
  return {
    specVersion: "0.x",
    name,
    version,
    authors,
    licenseUrl,
    commercialUsage,
    comment: commentParts.join("\n"),
  };
}

function sanitizeNodes(raw: unknown): GltfNode[] {
  if (!Array.isArray(raw)) return [];
  const out: GltfNode[] = [];
  for (const item of raw.slice(0, MAX_NODES)) {
    const rec = asRecord(item);
    if (!rec) {
      out.push({});
      continue;
    }
    const children = Array.isArray(rec["children"])
      ? rec["children"].filter((c): c is number => typeof c === "number" && Number.isInteger(c) && c >= 0)
      : undefined;
    const mesh = asNonNegInt(rec["mesh"]);
    const skin = asNonNegInt(rec["skin"]);
    const translation = Array.isArray(rec["translation"]) ? asVec3(rec["translation"], [0, 0, 0]) : undefined;
    const rotation = Array.isArray(rec["rotation"]) ? asVec4(rec["rotation"], [0, 0, 0, 1]) : undefined;
    const scale = Array.isArray(rec["scale"]) ? asVec3(rec["scale"], [1, 1, 1]) : undefined;
    out.push({
      ...(typeof rec["name"] === "string" ? { name: rec["name"].slice(0, 120) } : {}),
      ...(mesh !== undefined ? { mesh } : {}),
      ...(skin !== undefined ? { skin } : {}),
      ...(children ? { children } : {}),
      ...(translation ? { translation } : {}),
      ...(rotation ? { rotation } : {}),
      ...(scale ? { scale } : {}),
    });
  }
  return out;
}

function sanitizeAttrMap(raw: unknown): Record<string, number> {
  const rec = asRecord(raw);
  if (!rec) return {};
  const attrs: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) {
    const idx = asNonNegInt(v);
    if (idx !== undefined) attrs[k] = idx;
  }
  return attrs;
}

function sanitizeMeshes(raw: unknown): GltfMesh[] {
  if (!Array.isArray(raw)) return [];
  const out: GltfMesh[] = [];
  let totalPrims = 0;
  for (const item of raw.slice(0, MAX_MESHES)) {
    const rec = asRecord(item);
    if (!rec) {
      out.push({ primitives: [] });
      continue;
    }
    const rawPrims = Array.isArray(rec["primitives"]) ? rec["primitives"] : [];
    const primitives: GltfMeshPrimitive[] = [];
    for (const pItem of rawPrims) {
      if (totalPrims >= MAX_PRIMITIVES) break;
      const pRec = asRecord(pItem);
      if (!pRec) continue;
      totalPrims += 1;
      const indices = asNonNegInt(pRec["indices"]);
      const material = asNonNegInt(pRec["material"]);
      const mode = asNonNegInt(pRec["mode"]);
      const rawTargets = Array.isArray(pRec["targets"]) ? pRec["targets"] : undefined;
      const targets = rawTargets
        ? rawTargets.slice(0, 256).map((t) => sanitizeAttrMap(t))
        : undefined;
      primitives.push({
        attributes: sanitizeAttrMap(pRec["attributes"]),
        ...(indices !== undefined ? { indices } : {}),
        ...(material !== undefined ? { material } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(targets ? { targets } : {}),
      });
    }
    out.push({
      ...(typeof rec["name"] === "string" ? { name: rec["name"].slice(0, 120) } : {}),
      primitives,
    });
  }
  return out;
}

function sanitizeAccessors(raw: unknown): GltfAccessor[] {
  if (!Array.isArray(raw)) return [];
  const out: GltfAccessor[] = [];
  for (const item of raw.slice(0, MAX_ACCESSORS)) {
    const rec = asRecord(item);
    if (!rec) {
      out.push({ componentType: 0, count: 0, type: "SCALAR" });
      continue;
    }
    const bufferView = asNonNegInt(rec["bufferView"]);
    const byteOffset = asNonNegInt(rec["byteOffset"]);
    const componentType = asNonNegInt(rec["componentType"]) ?? 0;
    const count = asNonNegInt(rec["count"]) ?? 0;
    const rawType = asString(rec["type"], "SCALAR");
    const type: GltfAccessor["type"] = Object.hasOwn(TYPE_COMPONENTS, rawType)
      ? (rawType as GltfAccessor["type"])
      : "SCALAR";
    out.push({
      ...(bufferView !== undefined ? { bufferView } : {}),
      ...(byteOffset !== undefined ? { byteOffset } : {}),
      componentType,
      count,
      type,
    });
  }
  return out;
}

function sanitizeBufferViews(raw: unknown): GltfBufferView[] {
  if (!Array.isArray(raw)) return [];
  const out: GltfBufferView[] = [];
  for (const item of raw.slice(0, MAX_BUFFER_VIEWS)) {
    const rec = asRecord(item);
    if (!rec) {
      out.push({ buffer: 0, byteLength: 0 });
      continue;
    }
    const buffer = asNonNegInt(rec["buffer"]) ?? 0;
    const byteOffset = asNonNegInt(rec["byteOffset"]);
    const byteLength = asNonNegInt(rec["byteLength"]) ?? 0;
    const byteStride = asNonNegInt(rec["byteStride"]);
    out.push({
      buffer,
      ...(byteOffset !== undefined ? { byteOffset } : {}),
      byteLength,
      ...(byteStride !== undefined ? { byteStride } : {}),
    });
  }
  return out;
}

function sanitizeImages(raw: unknown): GltfImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_IMAGES).map((item) => {
    const rec = asRecord(item);
    if (!rec) return {};
    const bufferView = asNonNegInt(rec["bufferView"]);
    return {
      ...(typeof rec["name"] === "string" ? { name: rec["name"].slice(0, 120) } : {}),
      ...(typeof rec["mimeType"] === "string" ? { mimeType: rec["mimeType"] } : {}),
      ...(bufferView !== undefined ? { bufferView } : {}),
      ...(typeof rec["uri"] === "string" ? { uri: rec["uri"] } : {}),
    };
  });
}

function sanitizeTextures(raw: unknown): GltfTexture[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_MATERIALS).map((item) => {
    const rec = asRecord(item);
    if (!rec) return {};
    const source = asNonNegInt(rec["source"]);
    const sampler = asNonNegInt(rec["sampler"]);
    return {
      ...(source !== undefined ? { source } : {}),
      ...(sampler !== undefined ? { sampler } : {}),
    };
  });
}

function sanitizeMaterials(raw: unknown): GltfMaterial[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_MATERIALS).map((item) => {
    const rec = asRecord(item);
    if (!rec) return {};
    const pbr = asRecord(rec["pbrMetallicRoughness"]);
    const baseColorTex = asRecord(pbr?.["baseColorTexture"]);
    const texIndex = asNonNegInt(baseColorTex?.["index"]);
    const ext = asRecord(rec["extensions"]);
    const mtoon = asRecord(ext?.["VRMC_materials_mtoon"]);
    const alphaRaw = rec["alphaMode"];
    const alphaMode =
      alphaRaw === "OPAQUE" || alphaRaw === "MASK" || alphaRaw === "BLEND" ? alphaRaw : undefined;
    return {
      ...(typeof rec["name"] === "string" ? { name: rec["name"].slice(0, 120) } : {}),
      ...(pbr
        ? {
            pbrMetallicRoughness: {
              ...(Array.isArray(pbr["baseColorFactor"])
                ? { baseColorFactor: asVec4(pbr["baseColorFactor"], [1, 1, 1, 1]) }
                : {}),
              ...(texIndex !== undefined ? { baseColorTexture: { index: texIndex } } : {}),
            },
          }
        : {}),
      ...(alphaMode ? { alphaMode } : {}),
      ...(rec["doubleSided"] === true ? { doubleSided: true } : {}),
      ...(mtoon
        ? {
            extensions: {
              VRMC_materials_mtoon: {
                ...(Array.isArray(mtoon["shadeColorFactor"])
                  ? { shadeColorFactor: asVec3(mtoon["shadeColorFactor"], [0.8, 0.8, 0.8]) }
                  : {}),
              },
            },
          }
        : {}),
    };
  });
}

function sanitizeSkins(raw: unknown): GltfSkin[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SKINS).map((item) => {
    const rec = asRecord(item);
    if (!rec) return { joints: [] };
    const ibm = asNonNegInt(rec["inverseBindMatrices"]);
    const skel = asNonNegInt(rec["skeleton"]);
    const joints = Array.isArray(rec["joints"])
      ? rec["joints"].filter((j): j is number => typeof j === "number" && Number.isInteger(j) && j >= 0)
      : [];
    return {
      ...(typeof rec["name"] === "string" ? { name: rec["name"].slice(0, 120) } : {}),
      ...(ibm !== undefined ? { inverseBindMatrices: ibm } : {}),
      ...(skel !== undefined ? { skeleton: skel } : {}),
      joints,
    };
  });
}

/** Parses a `.vrm` binary GLB file into structured VRM 1.0 metadata, humanoid bones, expressions, and spring chains. */
export function parseVrmGlb(bytes: Uint8Array): ParsedVrmDocument {
  const { json, bin } = extractGlbChunks(bytes);
  const nodes = sanitizeNodes(json["nodes"]);
  const meshes = sanitizeMeshes(json["meshes"]);
  const materials = sanitizeMaterials(json["materials"]);
  const textures = sanitizeTextures(json["textures"]);
  const images = sanitizeImages(json["images"]);
  const skins = sanitizeSkins(json["skins"]);
  const accessors = sanitizeAccessors(json["accessors"]);
  const bufferViews = sanitizeBufferViews(json["bufferViews"]);
  const rawScenes = Array.isArray(json["scenes"]) ? json["scenes"] : [];
  const scenes = rawScenes.slice(0, 32).map((s) => {
    const rec = asRecord(s);
    const sNodes = Array.isArray(rec?.["nodes"])
      ? rec["nodes"].filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0)
      : undefined;
    return sNodes ? { nodes: sNodes } : {};
  });
  const rawDefaultScene = asNonNegInt(json["scene"]) ?? 0;
  const defaultScene = rawDefaultScene < scenes.length ? rawDefaultScene : 0;

  const extensions = asRecord(json["extensions"]) ?? {};
  const vrmcVrm = asRecord(extensions["VRMC_vrm"]);
  const vrmcSpring = asRecord(extensions["VRMC_springBone"]);
  const vrm0 = asRecord(extensions["VRM"]);

  const humanoidBones: Record<string, number> = {};
  const expressions: Record<string, VrmExpressionDef> = {};
  const springs: VrmSpringChain[] = [];
  let meta: VrmMeta;

  if (vrmcVrm) {
    meta = parseVrm1Meta(vrmcVrm, nodes);
    const humanoid = asRecord(vrmcVrm["humanoid"]);
    const humanBones = asRecord(humanoid?.["humanBones"]);
    if (humanBones) {
      for (const [boneName, entry] of Object.entries(humanBones)) {
        const rec = asRecord(entry);
        const nodeIdx = asNonNegInt(rec?.["node"]);
        if (nodeIdx !== undefined && nodeIdx < nodes.length) {
          humanoidBones[boneName] = nodeIdx;
        }
      }
    }

    const exprBlock = asRecord(vrmcVrm["expressions"]);
    const parseExprGroup = (group: Record<string, unknown> | null) => {
      if (!group) return;
      for (const [presetName, rawDef] of Object.entries(group)) {
        const def = asRecord(rawDef);
        if (!def) continue;
        const rawBinds = Array.isArray(def["morphTargetBinds"]) ? def["morphTargetBinds"] : [];
        const binds: VrmMorphBind[] = [];
        for (const item of rawBinds) {
          const b = asRecord(item);
          const nodeIdx = asNonNegInt(b?.["node"]);
          const morphIdx = asNonNegInt(b?.["index"]);
          if (nodeIdx === undefined || morphIdx === undefined || nodeIdx >= nodes.length) continue;
          binds.push({
            node: nodeIdx,
            index: morphIdx,
            weight: asNumber(b?.["weight"], 1),
          });
        }
        expressions[presetName] = {
          name: presetName,
          preset: presetName,
          isBinary: def["isBinary"] === true,
          binds,
        };
      }
    };
    parseExprGroup(asRecord(exprBlock?.["preset"]));
    parseExprGroup(asRecord(exprBlock?.["custom"]));

    if (vrmcSpring) {
      const rawColliders = Array.isArray(vrmcSpring["colliders"]) ? vrmcSpring["colliders"] : [];
      const parsedColliders: VrmSpringCollider[] = [];
      for (const item of rawColliders) {
        const c = asRecord(item);
        const nodeIdx = asNonNegInt(c?.["node"]);
        const shapeRec = asRecord(c?.["shape"]);
        const sphere = asRecord(shapeRec?.["sphere"]);
        const capsule = asRecord(shapeRec?.["capsule"]);
        if (nodeIdx === undefined || nodeIdx >= nodes.length) continue;
        if (capsule) {
          parsedColliders.push({
            node: nodeIdx,
            shape: "capsule",
            offset: asVec3(capsule["offset"], [0, 0, 0]),
            radius: Math.max(0.001, asNumber(capsule["radius"], 0.05)),
            tail: asVec3(capsule["tail"], [0, 0.1, 0]),
          });
        } else if (sphere) {
          parsedColliders.push({
            node: nodeIdx,
            shape: "sphere",
            offset: asVec3(sphere["offset"], [0, 0, 0]),
            radius: Math.max(0.001, asNumber(sphere["radius"], 0.05)),
          });
        }
      }

      const rawGroups = Array.isArray(vrmcSpring["colliderGroups"])
        ? vrmcSpring["colliderGroups"]
        : [];
      const groups: VrmSpringCollider[][] = rawGroups.map((g) => {
        const rec = asRecord(g);
        const indices = Array.isArray(rec?.["colliders"]) ? rec["colliders"] : [];
        const out: VrmSpringCollider[] = [];
        for (const idx of indices) {
          if (typeof idx === "number" && Number.isInteger(idx) && parsedColliders[idx]) {
            out.push(parsedColliders[idx]);
          }
        }
        return out;
      });

      const rawSprings = Array.isArray(vrmcSpring["springs"]) ? vrmcSpring["springs"] : [];
      for (let sIdx = 0; sIdx < rawSprings.length; sIdx += 1) {
        const s = asRecord(rawSprings[sIdx]);
        if (!s) continue;
        const rawJoints = Array.isArray(s["joints"]) ? s["joints"] : [];
        const joints: VrmSpringJoint[] = [];
        for (const item of rawJoints) {
          const j = asRecord(item);
          const jNode = asNonNegInt(j?.["node"]);
          if (!j || jNode === undefined || jNode >= nodes.length) continue;
          joints.push({
            node: jNode,
            hitRadius: Math.max(0, asNumber(j["hitRadius"], 0.02)),
            stiffness: Math.max(0, asNumber(j["stiffness"], 1)),
            gravityPower: Math.max(0, asNumber(j["gravityPower"], 0)),
            gravityDir: asVec3(j["gravityDir"], [0, -1, 0]),
            dragForce: Math.min(1, Math.max(0, asNumber(j["dragForce"], 0.5))),
          });
        }
        const chainColliders: VrmSpringCollider[] = [];
        const cgIndices = Array.isArray(s["colliderGroups"]) ? s["colliderGroups"] : [];
        for (const cgIdx of cgIndices) {
          if (typeof cgIdx === "number" && Number.isInteger(cgIdx) && groups[cgIdx]) {
            chainColliders.push(...groups[cgIdx]);
          }
        }
        if (joints.length >= 2) {
          const centerNode = asNonNegInt(s["center"]);
          springs.push({
            name: asString(s["name"], `spring-${sIdx}`),
            joints,
            colliders: chainColliders,
            ...(centerNode !== undefined && centerNode < nodes.length ? { center: centerNode } : {}),
          });
        }
      }
    }
  } else if (vrm0) {
    meta = parseVrm0Meta(vrm0);
    const humanoid = asRecord(vrm0["humanoid"]);
    const humanBones = Array.isArray(humanoid?.["humanBones"]) ? humanoid["humanBones"] : [];
    for (const item of humanBones) {
      const b = asRecord(item);
      const nodeIdx = asNonNegInt(b?.["node"]);
      if (!b || typeof b["bone"] !== "string" || nodeIdx === undefined || nodeIdx >= nodes.length) {
        continue;
      }
      const canonicalBone = VRM0_BONE_MAP[b["bone"]] ?? b["bone"];
      humanoidBones[canonicalBone] = nodeIdx;
    }

    const blendMaster = asRecord(vrm0["blendShapeMaster"]);
    const blendGroups = Array.isArray(blendMaster?.["blendShapeGroups"])
      ? blendMaster["blendShapeGroups"]
      : [];
    for (const item of blendGroups) {
      const g = asRecord(item);
      if (!g) continue;
      const rawPreset = asString(g["presetName"], asString(g["name"], "")).toLowerCase();
      const mapped = VRM0_EXPRESSION_MAP[rawPreset] ?? asString(g["name"], rawPreset);
      if (!mapped) continue;
      const rawBinds = Array.isArray(g["binds"]) ? g["binds"] : [];
      const binds: VrmMorphBind[] = [];
      for (const bItem of rawBinds) {
        const b = asRecord(bItem);
        const meshIdx = asNonNegInt(b?.["mesh"]);
        const morphIdx = asNonNegInt(b?.["index"]);
        if (meshIdx === undefined || morphIdx === undefined) continue;
        const nodeIdx = nodes.findIndex((n) => n.mesh === meshIdx);
        if (nodeIdx >= 0) {
          binds.push({
            node: nodeIdx,
            mesh: meshIdx,
            index: morphIdx,
            weight: asNumber(b?.["weight"], 100) / 100,
          });
        }
      }
      expressions[mapped] = {
        name: mapped,
        preset: mapped,
        isBinary: g["isBinary"] === true,
        binds,
      };
    }

    const secAnim = asRecord(vrm0["secondaryAnimation"]);
    const rawColliderGroups = Array.isArray(secAnim?.["colliderGroups"])
      ? secAnim["colliderGroups"]
      : [];
    const colliderGroups: VrmSpringCollider[][] = rawColliderGroups.map((cg) => {
      const rec = asRecord(cg);
      const nodeIdx = asNonNegInt(rec?.["node"]);
      const cols = Array.isArray(rec?.["colliders"]) ? rec["colliders"] : [];
      if (nodeIdx === undefined || nodeIdx >= nodes.length) return [];
      return cols
        .map((c) => asRecord(c))
        .filter((c): c is Record<string, unknown> => c !== null)
        .map((c) => ({
          node: nodeIdx,
          shape: "sphere" as const,
          offset: vec3ObjToTuple(c["offset"], [0, 0, 0]),
          radius: Math.max(0.001, asNumber(c["radius"], 0.05)),
        }));
    });

    const boneGroups = Array.isArray(secAnim?.["boneGroups"]) ? secAnim["boneGroups"] : [];
    for (let gIdx = 0; gIdx < boneGroups.length; gIdx += 1) {
      const bg = asRecord(boneGroups[gIdx]);
      if (!bg) continue;
      const boneIndices = Array.isArray(bg["bones"]) ? bg["bones"] : [];
      const stiffness = Math.max(0, asNumber(bg["stiffiness"] ?? bg["stiffness"], 1));
      const gravityPower = Math.max(0, asNumber(bg["gravityPower"], 0));
      const gravityDir = vec3ObjToTuple(bg["gravityDir"], [0, -1, 0]);
      const dragForce = Math.min(1, Math.max(0, asNumber(bg["dragForce"], 0.4)));
      const hitRadius = Math.max(0, asNumber(bg["hitRadius"], 0.02));
      const colGroupRefs = Array.isArray(bg["colliderGroups"]) ? bg["colliderGroups"] : [];
      const chainColliders: VrmSpringCollider[] = [];
      for (const cgIdx of colGroupRefs) {
        if (typeof cgIdx === "number" && Number.isInteger(cgIdx) && colliderGroups[cgIdx]) {
          chainColliders.push(...colliderGroups[cgIdx]);
        }
      }
      for (const rootNode of boneIndices) {
        if (typeof rootNode !== "number" || !Number.isInteger(rootNode) || rootNode < 0 || rootNode >= nodes.length) {
          continue;
        }
        const chainNodes: number[] = [];
        let cursor: number | undefined = rootNode;
        const visited = new Set<number>();
        while (
          cursor !== undefined &&
          cursor >= 0 &&
          cursor < nodes.length &&
          !visited.has(cursor) &&
          chainNodes.length < 32
        ) {
          visited.add(cursor);
          chainNodes.push(cursor);
          cursor = nodes[cursor]?.children?.[0];
        }
        if (chainNodes.length >= 2) {
          const centerNode = asNonNegInt(bg["center"]);
          springs.push({
            name: asString(bg["comment"], `vrm0-spring-${gIdx}-${rootNode}`),
            joints: chainNodes.map((node) => ({
              node,
              hitRadius,
              stiffness,
              gravityPower,
              gravityDir,
              dragForce,
            })),
            colliders: chainColliders,
            ...(centerNode !== undefined && centerNode < nodes.length ? { center: centerNode } : {}),
          });
        }
      }
    }
  } else {
    throw new Error("GLB file does not contain VRMC_vrm (1.0) or VRM (0.x) extension metadata.");
  }

  return {
    meta,
    humanoidBones,
    expressions,
    springs,
    nodes,
    meshes,
    materials,
    textures,
    images,
    skins,
    accessors,
    bufferViews,
    scenes,
    defaultScene,
    binChunk: bin,
  };
}

const TYPE_COMPONENTS: Record<GltfAccessor["type"], number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

function floatCompBytes(componentType: number): number | null {
  switch (componentType) {
    case 5126:
      return 4; // FLOAT
    case 5123:
    case 5122:
      return 2; // UNSIGNED_SHORT / SHORT
    case 5121:
    case 5120:
      return 1; // UNSIGNED_BYTE / BYTE
    default:
      return null;
  }
}

function indexCompBytes(componentType: number): number | null {
  switch (componentType) {
    case 5125:
      return 4; // UNSIGNED_INT
    case 5123:
      return 2; // UNSIGNED_SHORT
    case 5121:
      return 1; // UNSIGNED_BYTE
    default:
      return null;
  }
}

function validateAccessorSpan(
  doc: ParsedVrmDocument,
  accessorIndex: number,
  compBytes: number,
  numComps: number,
): { accessor: GltfAccessor; baseOffset: number; stride: number } {
  if (!Number.isInteger(accessorIndex) || accessorIndex < 0 || accessorIndex >= doc.accessors.length) {
    throw new RangeError(`glTF accessor index ${accessorIndex} out of bounds.`);
  }
  const accessor = doc.accessors[accessorIndex];
  if (!accessor || accessor.bufferView === undefined) {
    throw new RangeError(`Missing glTF accessor ${accessorIndex} or bufferView.`);
  }
  if (!Number.isInteger(accessor.bufferView) || accessor.bufferView < 0 || accessor.bufferView >= doc.bufferViews.length) {
    throw new RangeError(`glTF bufferView index ${accessor.bufferView} out of bounds.`);
  }
  const bv = doc.bufferViews[accessor.bufferView];
  if (!bv) throw new RangeError(`Missing glTF bufferView ${accessor.bufferView}.`);

  const count = accessor.count;
  if (!Number.isInteger(count) || count < 0 || count > MAX_ACCESSOR_COUNT) {
    throw new RangeError(`glTF accessor ${accessorIndex} count (${count}) exceeds safety cap.`);
  }

  const bvOffset = bv.byteOffset ?? 0;
  const bvLen = bv.byteLength;
  const accOffset = accessor.byteOffset ?? 0;
  if (
    !Number.isInteger(bvOffset) ||
    bvOffset < 0 ||
    !Number.isInteger(bvLen) ||
    bvLen < 0 ||
    !Number.isInteger(accOffset) ||
    accOffset < 0 ||
    bvOffset + bvLen > doc.binChunk.byteLength
  ) {
    throw new RangeError(`glTF bufferView ${accessor.bufferView} exceeds BIN chunk bounds.`);
  }

  const minStride = numComps * compBytes;
  const stride = bv.byteStride ?? minStride;
  if (!Number.isInteger(stride) || stride < minStride) {
    throw new RangeError(`glTF bufferView ${accessor.bufferView} has invalid stride (${stride}).`);
  }

  const baseOffset = bvOffset + accOffset;
  if (count > 0) {
    const requiredEnd = baseOffset + (count - 1) * stride + minStride;
    if (requiredEnd > bvOffset + bvLen || requiredEnd > doc.binChunk.byteLength) {
      throw new RangeError(`glTF accessor ${accessorIndex} exceeds bufferView/BIN chunk bounds.`);
    }
  }
  return { accessor, baseOffset, stride };
}

/** Decodes a glTF binary accessor as a tightly packed, finite `Float32Array`. */
export function readAccessorFloat32(doc: ParsedVrmDocument, accessorIndex: number): Float32Array {
  const rawAcc = doc.accessors[accessorIndex];
  if (!rawAcc) throw new RangeError(`Missing glTF accessor ${accessorIndex}.`);
  if (!Object.hasOwn(TYPE_COMPONENTS, rawAcc.type)) {
    throw new RangeError(`Unsupported glTF accessor type "${String(rawAcc.type)}".`);
  }
  const compBytes = floatCompBytes(rawAcc.componentType);
  if (compBytes === null) {
    throw new RangeError(`Unsupported glTF float componentType ${rawAcc.componentType}.`);
  }
  const numComps = TYPE_COMPONENTS[rawAcc.type];
  const { accessor, baseOffset, stride } = validateAccessorSpan(
    doc,
    accessorIndex,
    compBytes,
    numComps,
  );
  const out = new Float32Array(accessor.count * numComps);
  const view = new DataView(doc.binChunk.buffer, doc.binChunk.byteOffset, doc.binChunk.byteLength);

  for (let i = 0; i < accessor.count; i += 1) {
    const rowStart = baseOffset + i * stride;
    for (let c = 0; c < numComps; c += 1) {
      const bytePos = rowStart + c * compBytes;
      let val: number;
      if (accessor.componentType === 5126) {
        val = view.getFloat32(bytePos, true);
      } else if (accessor.componentType === 5123) {
        val = view.getUint16(bytePos, true);
      } else if (accessor.componentType === 5121) {
        val = view.getUint8(bytePos);
      } else if (accessor.componentType === 5122) {
        val = view.getInt16(bytePos, true);
      } else {
        val = view.getInt8(bytePos);
      }
      out[i * numComps + c] = Number.isFinite(val) ? val : 0;
    }
  }
  return out;
}

/** Decodes scalar index accessor (`UNSIGNED_BYTE` / `UNSIGNED_SHORT` / `UNSIGNED_INT`) into `Uint32Array`. */
export function readAccessorIndices(doc: ParsedVrmDocument, accessorIndex: number): Uint32Array {
  const rawAcc = doc.accessors[accessorIndex];
  if (!rawAcc) throw new RangeError(`Missing glTF index accessor ${accessorIndex}.`);
  const compBytes = indexCompBytes(rawAcc.componentType);
  if (compBytes === null) {
    throw new RangeError(`Unsupported glTF index componentType ${rawAcc.componentType}.`);
  }
  const { accessor, baseOffset, stride } = validateAccessorSpan(doc, accessorIndex, compBytes, 1);
  const out = new Uint32Array(accessor.count);
  const view = new DataView(doc.binChunk.buffer, doc.binChunk.byteOffset, doc.binChunk.byteLength);

  for (let i = 0; i < accessor.count; i += 1) {
    const pos = baseOffset + i * stride;
    out[i] =
      accessor.componentType === 5125
        ? view.getUint32(pos, true)
        : accessor.componentType === 5123
          ? view.getUint16(pos, true)
          : view.getUint8(pos);
  }
  return out;
}

function isPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isJpegSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function parseJpegDims(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isJpegSignature(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 2;
  while (pos + 4 <= bytes.byteLength) {
    if (bytes[pos] !== 0xff) return null;
    while (pos < bytes.byteLength && bytes[pos] === 0xff) pos += 1;
    if (pos >= bytes.byteLength) return null;
    const marker = bytes[pos] ?? 0;
    pos += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (pos + 2 > bytes.byteLength) return null;
    const segLen = view.getUint16(pos, false);
    if (segLen < 2 || pos + segLen > bytes.byteLength) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (pos + 7 > bytes.byteLength) return null;
      const height = view.getUint16(pos + 3, false);
      const width = view.getUint16(pos + 5, false);
      return { width, height };
    }
    pos += segLen;
  }
  return null;
}

function parseWebpDims(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isWebpSignature(bytes) || bytes.byteLength < 30) return null;
  const chunkTag = String.fromCharCode(
    bytes[12] ?? 0,
    bytes[13] ?? 0,
    bytes[14] ?? 0,
    bytes[15] ?? 0,
  );
  if (chunkTag === "VP8X") {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return { width, height };
  }
  if (chunkTag === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const width = ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff;
    const height = ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff;
    return { width, height };
  }
  if (chunkTag === "VP8L" && bytes[20] === 0x2f) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const word = view.getUint32(21, true);
    const width = (word & 0x3fff) + 1;
    const height = ((word >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

/**
 * Validates embedded image MIME allowlist (`image/png`, `image/jpeg`, `image/webp`),
 * byte cap, magic bytes, and decoded header dimensions (`<= 4096x4096`).
 */
export function inspectEmbeddedImage(
  bytes: Uint8Array,
  rawMimeType: string,
): { ok: true; mimeType: string; width: number; height: number } | { ok: false; reason: string } {
  const mimeType = rawMimeType.trim().toLowerCase();
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    return { ok: false, reason: `Disallowed embedded image MIME type "${rawMimeType}".` };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `Image byte size (${bytes.byteLength}) out of allowed bounds.` };
  }
  let width: number;
  let height: number;
  if (mimeType === "image/png") {
    if (!isPngSignature(bytes) || bytes.byteLength < 24) {
      return { ok: false, reason: "Truncated or invalid PNG header." };
    }
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
      return { ok: false, reason: "PNG missing IHDR header chunk." };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16, false);
    height = view.getUint32(20, false);
  } else if (mimeType === "image/jpeg") {
    const dims = parseJpegDims(bytes);
    if (!dims) return { ok: false, reason: "Corrupted or unsupported JPEG header." };
    width = dims.width;
    height = dims.height;
  } else {
    const dims = parseWebpDims(bytes);
    if (!dims) return { ok: false, reason: "Corrupted or unsupported WebP header." };
    width = dims.width;
    height = dims.height;
  }

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_TEXTURE_DIM ||
    height > MAX_TEXTURE_DIM
  ) {
    return {
      ok: false,
      reason: `Embedded texture dimensions ${width}x${height} exceed ${MAX_TEXTURE_DIM}px cap.`,
    };
  }
  return { ok: true, mimeType, width, height };
}

export function extractImageBytes(
  doc: ParsedVrmDocument,
  imageIndex: number,
): { bytes: Uint8Array; mimeType: string } | null {
  if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= doc.images.length) {
    return null;
  }
  const img = doc.images[imageIndex];
  if (!img || img.bufferView === undefined) return null;
  if (!Number.isInteger(img.bufferView) || img.bufferView < 0 || img.bufferView >= doc.bufferViews.length) {
    return null;
  }
  const mimeType = (img.mimeType || "image/png").trim().toLowerCase();
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    return null;
  }
  const bv = doc.bufferViews[img.bufferView];
  if (!bv) return null;
  const start = bv.byteOffset ?? 0;
  const len = bv.byteLength;
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    !Number.isInteger(len) ||
    len <= 0 ||
    len > MAX_IMAGE_BYTES ||
    start + len > doc.binChunk.byteLength
  ) {
    return null;
  }
  const slice = doc.binChunk.subarray(start, start + len);
  if (mimeType === "image/png") {
    if (!isPngSignature(slice)) return null;
    if (slice.byteLength >= 24 && !inspectEmbeddedImage(slice, mimeType).ok) return null;
  } else if (mimeType === "image/jpeg") {
    if (!isJpegSignature(slice)) return null;
    if (slice.byteLength >= 11 && !inspectEmbeddedImage(slice, mimeType).ok) return null;
  } else {
    if (!isWebpSignature(slice)) return null;
    if (slice.byteLength >= 30 && !inspectEmbeddedImage(slice, mimeType).ok) return null;
  }
  return { bytes: slice, mimeType };
}

// --- Deterministic Verlet Spring-Bone Solver ------------------------------

export interface SpringRuntimeJointState {
  node: number;
  currentTail: [number, number, number];
  prevTail: [number, number, number];
  boneAxis: [number, number, number];
  boneLength: number;
  joint: VrmSpringJoint;
}

export interface SpringRuntimeChainState {
  name: string;
  joints: SpringRuntimeJointState[];
  colliders: VrmSpringCollider[];
}

function sub3(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add3(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a: readonly [number, number, number], s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function len3(a: readonly [number, number, number]): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function norm3(a: readonly [number, number, number]): [number, number, number] {
  const l = len3(a);
  if (l < 1e-8) return [0, -1, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

function dot3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Simulates VRM `VRMC_springBone` secondary motion (hair, ribbons, skirts, accessories)
 * using length-constrained Verlet integration and sphere/capsule collision projection.
 */
export class VerletSpringSolver {
  readonly chains: SpringRuntimeChainState[] = [];

  constructor(
    springDefs: readonly VrmSpringChain[],
    initialWorldPos: (node: number) => readonly [number, number, number],
  ) {
    for (const def of springDefs) {
      const runtimeJoints: SpringRuntimeJointState[] = [];
      for (let i = 0; i < def.joints.length - 1; i += 1) {
        const j = def.joints[i];
        const next = def.joints[i + 1];
        if (!j || !next) continue;
        const headPos = initialWorldPos(j.node);
        const tailPos = initialWorldPos(next.node);
        const delta = sub3(tailPos, headPos);
        const boneLength = Math.max(0.01, len3(delta));
        const boneAxis = norm3(delta);
        runtimeJoints.push({
          node: j.node,
          currentTail: [tailPos[0], tailPos[1], tailPos[2]],
          prevTail: [tailPos[0], tailPos[1], tailPos[2]],
          boneAxis,
          boneLength,
          joint: j,
        });
      }
      if (runtimeJoints.length > 0) {
        this.chains.push({
          name: def.name,
          joints: runtimeJoints,
          colliders: [...def.colliders],
        });
      }
    }
  }

  /**
   * Advances spring chains by `dt` seconds.
   * Calls `applyJointAim(node, headPos, nextTailPos)` so the caller can orient the bone TransformNode.
   */
  step(
    dt: number,
    readWorldPos: (node: number) => readonly [number, number, number],
    applyJointAim?: (node: number, headPos: readonly [number, number, number], tailPos: readonly [number, number, number]) => void,
    externalForce: readonly [number, number, number] = [0, 0, 0],
  ): void {
    const clampedDt = Math.max(0.001, Math.min(0.05, Number.isFinite(dt) ? dt : 0.016));
    for (const chain of this.chains) {
      for (let idx = 0; idx < chain.joints.length; idx += 1) {
        const state = chain.joints[idx];
        if (!state) continue;
        const headPos =
          idx === 0
            ? readWorldPos(state.node)
            : chain.joints[idx - 1]?.currentTail ?? readWorldPos(state.node);

        const inertia = scale3(sub3(state.currentTail, state.prevTail), 1 - state.joint.dragForce);
        const restTail = add3(headPos, scale3(state.boneAxis, state.boneLength));
        const stiffnessVec = scale3(
          sub3(restTail, state.currentTail),
          state.joint.stiffness * clampedDt,
        );
        const gravityVec = scale3(
          state.joint.gravityDir,
          state.joint.gravityPower * clampedDt,
        );
        const extVec = scale3(externalForce, clampedDt);

        let nextTail = add3(
          state.currentTail,
          add3(inertia, add3(stiffnessVec, add3(gravityVec, extVec))),
        );

        // Constrain segment to constant rest bone length.
        const dirFromHead = norm3(sub3(nextTail, headPos));
        nextTail = add3(headPos, scale3(dirFromHead, state.boneLength));

        // Resolve sphere & capsule colliders.
        for (const col of chain.colliders) {
          const colOrigin = add3(readWorldPos(col.node), col.offset);
          const minDist = col.radius + state.joint.hitRadius;
          if (col.shape === "capsule" && col.tail) {
            const segEnd = add3(readWorldPos(col.node), col.tail);
            const ab = sub3(segEnd, colOrigin);
            const abLenSq = Math.max(1e-8, dot3(ab, ab));
            const t = Math.max(0, Math.min(1, dot3(sub3(nextTail, colOrigin), ab) / abLenSq));
            const closest = add3(colOrigin, scale3(ab, t));
            const diff = sub3(nextTail, closest);
            const d = len3(diff);
            if (d < minDist) {
              nextTail = add3(closest, scale3(norm3(diff), minDist));
              nextTail = add3(headPos, scale3(norm3(sub3(nextTail, headPos)), state.boneLength));
            }
          } else {
            const diff = sub3(nextTail, colOrigin);
            const d = len3(diff);
            if (d < minDist) {
              nextTail = add3(colOrigin, scale3(norm3(diff), minDist));
              nextTail = add3(headPos, scale3(norm3(sub3(nextTail, headPos)), state.boneLength));
            }
          }
        }

        state.prevTail = state.currentTail;
        state.currentTail = nextTail;
        applyJointAim?.(state.node, headPos, nextTail);
      }
    }
  }
}
