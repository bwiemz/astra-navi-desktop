/**
 * Pure TypeScript VRM 1.0 (and VRM 0.x fallback) glTF 2.0 binary parser &
 * deterministic Verlet spring-bone physics solver.
 *
 * Shared across Electron main (`core/modelBundle.ts`) and Chromium renderer
 * (`renderer/src/vrmLoader.ts`) with zero `node:*` or third-party loader
 * dependencies.
 */

const GLTF_MAGIC = 0x46546c67; // "glTF" little-endian
const GLTF_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

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

function asVec3(val: unknown, fallback: readonly [number, number, number]): [number, number, number] {
  if (!Array.isArray(val) || val.length < 3) return [fallback[0], fallback[1], fallback[2]];
  return [
    asNumber(val[0], fallback[0]),
    asNumber(val[1], fallback[1]),
    asNumber(val[2], fallback[2]),
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
  if (declaredLength > bytes.byteLength) {
    throw new RangeError("Truncated VRM/GLB container: declared length exceeds file size.");
  }

  let offset = 12;
  let jsonRecord: Record<string, unknown> | null = null;
  let binChunk: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder("utf-8");

  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + chunkLength > declaredLength) {
      throw new RangeError("Corrupted VRM/GLB chunk: length exceeds container bounds.");
    }
    const slice = bytes.subarray(offset, offset + chunkLength);
    if (chunkType === CHUNK_JSON && jsonRecord === null) {
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

/** Parses a `.vrm` binary GLB file into structured VRM 1.0 metadata, humanoid bones, expressions, and spring chains. */
export function parseVrmGlb(bytes: Uint8Array): ParsedVrmDocument {
  const { json, bin } = extractGlbChunks(bytes);
  const nodes = (Array.isArray(json["nodes"]) ? json["nodes"] : []) as GltfNode[];
  const meshes = (Array.isArray(json["meshes"]) ? json["meshes"] : []) as GltfMesh[];
  const materials = (Array.isArray(json["materials"]) ? json["materials"] : []) as GltfMaterial[];
  const textures = (Array.isArray(json["textures"]) ? json["textures"] : []) as GltfTexture[];
  const images = (Array.isArray(json["images"]) ? json["images"] : []) as GltfImage[];
  const skins = (Array.isArray(json["skins"]) ? json["skins"] : []) as GltfSkin[];
  const accessors = (Array.isArray(json["accessors"]) ? json["accessors"] : []) as GltfAccessor[];
  const bufferViews = (
    Array.isArray(json["bufferViews"]) ? json["bufferViews"] : []
  ) as GltfBufferView[];
  const scenes = (Array.isArray(json["scenes"]) ? json["scenes"] : []) as { nodes?: number[] }[];
  const defaultScene = asNumber(json["scene"], 0);

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
        if (rec && typeof rec["node"] === "number" && Number.isInteger(rec["node"])) {
          humanoidBones[boneName] = rec["node"];
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
          if (!b || typeof b["node"] !== "number" || typeof b["index"] !== "number") continue;
          binds.push({
            node: b["node"],
            index: b["index"],
            weight: asNumber(b["weight"], 1),
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
        const nodeIdx = asNumber(c?.["node"], -1);
        const shapeRec = asRecord(c?.["shape"]);
        const sphere = asRecord(shapeRec?.["sphere"]);
        const capsule = asRecord(shapeRec?.["capsule"]);
        if (nodeIdx < 0) continue;
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
          if (typeof idx === "number" && parsedColliders[idx]) {
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
          if (!j || typeof j["node"] !== "number") continue;
          joints.push({
            node: j["node"],
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
          if (typeof cgIdx === "number" && groups[cgIdx]) {
            chainColliders.push(...groups[cgIdx]);
          }
        }
        if (joints.length >= 2) {
          springs.push({
            name: asString(s["name"], `spring-${sIdx}`),
            joints,
            colliders: chainColliders,
            ...(typeof s["center"] === "number" ? { center: s["center"] } : {}),
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
      if (!b || typeof b["bone"] !== "string" || typeof b["node"] !== "number") continue;
      const canonicalBone = VRM0_BONE_MAP[b["bone"]] ?? b["bone"];
      humanoidBones[canonicalBone] = b["node"];
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
        if (!b || typeof b["mesh"] !== "number" || typeof b["index"] !== "number") continue;
        const nodeIdx = nodes.findIndex((n) => n.mesh === b["mesh"]);
        if (nodeIdx >= 0) {
          binds.push({
            node: nodeIdx,
            mesh: b["mesh"],
            index: b["index"],
            weight: asNumber(b["weight"], 100) / 100,
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
      const nodeIdx = asNumber(rec?.["node"], -1);
      const cols = Array.isArray(rec?.["colliders"]) ? rec["colliders"] : [];
      if (nodeIdx < 0) return [];
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
        if (typeof cgIdx === "number" && colliderGroups[cgIdx]) {
          chainColliders.push(...colliderGroups[cgIdx]);
        }
      }
      for (const rootNode of boneIndices) {
        if (typeof rootNode !== "number") continue;
        const chainNodes: number[] = [];
        let cursor: number | undefined = rootNode;
        const visited = new Set<number>();
        while (cursor !== undefined && !visited.has(cursor) && chainNodes.length < 32) {
          visited.add(cursor);
          chainNodes.push(cursor);
          cursor = nodes[cursor]?.children?.[0];
        }
        if (chainNodes.length >= 2) {
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
            ...(typeof bg["center"] === "number" ? { center: bg["center"] } : {}),
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

/** Decodes a glTF binary accessor as a tightly packed `Float32Array`. */
export function readAccessorFloat32(doc: ParsedVrmDocument, accessorIndex: number): Float32Array {
  const accessor = doc.accessors[accessorIndex];
  if (!accessor || accessor.bufferView === undefined) {
    throw new RangeError(`Missing glTF accessor ${accessorIndex} or bufferView.`);
  }
  const bv = doc.bufferViews[accessor.bufferView];
  if (!bv) throw new RangeError(`Missing glTF bufferView ${accessor.bufferView}.`);
  const numComps = TYPE_COMPONENTS[accessor.type];
  const out = new Float32Array(accessor.count * numComps);
  const baseOffset = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const compBytes =
    accessor.componentType === 5126 ? 4 : accessor.componentType === 5123 || accessor.componentType === 5122 ? 2 : 1;
  const stride = bv.byteStride ?? numComps * compBytes;
  const view = new DataView(doc.binChunk.buffer, doc.binChunk.byteOffset, doc.binChunk.byteLength);

  for (let i = 0; i < accessor.count; i += 1) {
    const rowStart = baseOffset + i * stride;
    for (let c = 0; c < numComps; c += 1) {
      const bytePos = rowStart + c * compBytes;
      if (bytePos + compBytes > doc.binChunk.byteLength) {
        throw new RangeError(`glTF accessor ${accessorIndex} exceeds BIN chunk bounds.`);
      }
      if (accessor.componentType === 5126) {
        out[i * numComps + c] = view.getFloat32(bytePos, true);
      } else if (accessor.componentType === 5123) {
        out[i * numComps + c] = view.getUint16(bytePos, true);
      } else if (accessor.componentType === 5121) {
        out[i * numComps + c] = view.getUint8(bytePos);
      } else if (accessor.componentType === 5122) {
        out[i * numComps + c] = view.getInt16(bytePos, true);
      } else {
        out[i * numComps + c] = view.getInt8(bytePos);
      }
    }
  }
  return out;
}

/** Decodes scalar index accessor (`UNSIGNED_BYTE` / `UNSIGNED_SHORT` / `UNSIGNED_INT`) into `Uint32Array`. */
export function readAccessorIndices(doc: ParsedVrmDocument, accessorIndex: number): Uint32Array {
  const accessor = doc.accessors[accessorIndex];
  if (!accessor || accessor.bufferView === undefined) {
    throw new RangeError(`Missing glTF index accessor ${accessorIndex}.`);
  }
  const bv = doc.bufferViews[accessor.bufferView];
  if (!bv) throw new RangeError(`Missing glTF bufferView ${accessor.bufferView}.`);
  const out = new Uint32Array(accessor.count);
  const baseOffset = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(doc.binChunk.buffer, doc.binChunk.byteOffset, doc.binChunk.byteLength);
  const compBytes =
    accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 1;
  const stride = bv.byteStride ?? compBytes;

  for (let i = 0; i < accessor.count; i += 1) {
    const pos = baseOffset + i * stride;
    if (pos + compBytes > doc.binChunk.byteLength) {
      throw new RangeError(`glTF index accessor ${accessorIndex} exceeds BIN chunk bounds.`);
    }
    out[i] =
      accessor.componentType === 5125
        ? view.getUint32(pos, true)
        : accessor.componentType === 5123
          ? view.getUint16(pos, true)
          : view.getUint8(pos);
  }
  return out;
}

export function extractImageBytes(
  doc: ParsedVrmDocument,
  imageIndex: number,
): { bytes: Uint8Array; mimeType: string } | null {
  const img = doc.images[imageIndex];
  if (!img || img.bufferView === undefined) return null;
  const bv = doc.bufferViews[img.bufferView];
  if (!bv) return null;
  const start = bv.byteOffset ?? 0;
  const end = start + bv.byteLength;
  if (end > doc.binChunk.byteLength) return null;
  return {
    bytes: doc.binChunk.subarray(start, end),
    mimeType: img.mimeType || "image/png",
  };
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
    const clampedDt = Math.max(0.001, Math.min(0.05, dt));
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
