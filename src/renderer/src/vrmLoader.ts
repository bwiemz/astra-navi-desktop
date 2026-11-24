import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import type { Scene } from "@babylonjs/core/scene";
import {
  extractImageBytes,
  inspectEmbeddedImage,
  parseVrmGlb,
  readAccessorFloat32,
  readAccessorIndices,
  VerletSpringSolver,
  type ParsedVrmDocument,
  type VrmMeta,
} from "../../shared/vrm.ts";

export interface LoadedVrmRig {
  readonly doc: ParsedVrmDocument;
  readonly meta: VrmMeta;
  readonly root: TransformNode;
  readonly meshes: Mesh[];
  /** Humanoid bone name (e.g. `head`, `hips`, `leftUpperArm`) -> Babylon `TransformNode`. */
  readonly humanNodes: ReadonlyMap<string, TransformNode>;
  /** All canonical VRM expression preset names available on this model. */
  readonly expressionNames: ReadonlySet<string>;
  /** Sets a VRM expression or viseme weight (`aa`, `ih`, `ou`, `ee`, `oh`, `blink`, `happy`, ...). */
  setExpression(name: string, weight: number): void;
  /** Poses a canonical VRM humanoid bone relative to its rest local orientation. */
  setBoneLocalRotation(boneName: string, rotation: Quaternion): void;
  /** Advances spring-bone physics chains (`VRMC_springBone`) by `dt` seconds. */
  stepSpringBones(dt: number): void;
  /** Applies custom outline / specular / rim toon overrides cleanly. */
  applyShaderPreset(preset: {
    specularScale?: number;
    rimLight?: number;
    outlineThickness?: number;
  }): void;
  dispose(): void;
}

const MAX_MORPH_TARGETS_PER_PRIM = 256;

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function finiteClamp01(v: unknown, fallback: number): number {
  const n = finiteOr(v, fallback);
  return Math.max(0, Math.min(1, n));
}

function wouldCreateNodeCycle(parentOf: ReadonlyMap<number, number>, parentIdx: number, childIdx: number): boolean {
  if (parentIdx === childIdx) return true;
  let cursor: number | undefined = parentIdx;
  const seen = new Set<number>([childIdx]);
  while (cursor !== undefined) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}

/**
 * Pure `@babylonjs/core` loader for `.vrm` (VRM 1.0 & VRM 0.x) binary GLB avatars.
 * Builds skinned/morphed meshes, VRM humanoid bone nodes, expression bindings,
 * toon/standard materials with validated embedded textures, and `VRMC_springBone` physics.
 */
export async function loadVrmIntoScene(
  scene: Scene,
  bytes: Uint8Array,
  name = "vrm-avatar",
): Promise<LoadedVrmRig> {
  const doc = parseVrmGlb(bytes);
  const root = new TransformNode(`${name}:root`, scene);
  // VRM 1.0 avatars face +Z; rotate 180 deg around Y so they face Astra's camera at -Z, and mirror Z for RH->LH glTF coords.
  root.scaling = new Vector3(1, 1, -1);
  root.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.PI, 0, 0);

  const objectUrls: string[] = [];
  const textures: Texture[] = [];
  const materials: StandardMaterial[] = [];
  const skeletons: Skeleton[] = [];
  const morphManagers: MorphTargetManager[] = [];
  const meshes: Mesh[] = [];
  const nodeTransforms: TransformNode[] = [];

  const dispose = (): void => {
    for (const mesh of meshes) mesh.dispose();
    for (const manager of morphManagers) manager.dispose();
    for (const skel of skeletons) skel.dispose();
    for (const mat of materials) mat.dispose();
    for (const tex of textures) tex.dispose();
    for (const tn of nodeTransforms) tn.dispose();
    root.dispose();
    for (const url of objectUrls) {
      if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    }
  };

  try {
    // --- Materials & embedded baseColor textures ---------------------------
    const getTextureForImage = (imageIndex: number): Texture | null => {
      const img = extractImageBytes(doc, imageIndex);
      if (!img || !inspectEmbeddedImage(img.bytes, img.mimeType).ok) return null;
      if (typeof URL === "undefined" || typeof Blob === "undefined") return null;
      try {
        const copy = new Uint8Array(img.bytes.byteLength);
        copy.set(img.bytes);
        const blob = new Blob([copy], { type: img.mimeType });
        const objUrl = URL.createObjectURL(blob);
        objectUrls.push(objUrl);
        const tex = new Texture(objUrl, scene, false, false);
        textures.push(tex);
        return tex;
      } catch {
        return null;
      }
    };

    for (let i = 0; i < doc.materials.length; i += 1) {
      const gm = doc.materials[i];
      const mat = new StandardMaterial(`${name}:mat:${gm?.name ?? i}`, scene);
      const factor = gm?.pbrMetallicRoughness?.baseColorFactor;
      if (factor && factor.length >= 3) {
        mat.diffuseColor = new Color3(
          finiteClamp01(factor[0], 1),
          finiteClamp01(factor[1], 1),
          finiteClamp01(factor[2], 1),
        );
        const alpha = finiteClamp01(factor[3], 1);
        if (alpha < 0.99 && gm?.alphaMode === "BLEND") mat.alpha = alpha;
      }
      const mtoon = gm?.extensions?.VRMC_materials_mtoon;
      if (mtoon?.shadeColorFactor) {
        const [r, g, b] = mtoon.shadeColorFactor;
        mat.ambientColor = new Color3(
          finiteClamp01(r, 0.8) * 0.45,
          finiteClamp01(g, 0.8) * 0.45,
          finiteClamp01(b, 0.8) * 0.45,
        );
      } else {
        mat.ambientColor = new Color3(0.35, 0.35, 0.35);
      }
      mat.specularColor = new Color3(0.15, 0.15, 0.15);
      mat.specularPower = 24;
      if (gm?.doubleSided) mat.backFaceCulling = false;
      const texIndex = gm?.pbrMetallicRoughness?.baseColorTexture?.index;
      if (typeof texIndex === "number") {
        const srcIdx = doc.textures[texIndex]?.source;
        if (typeof srcIdx === "number") {
          const tex = getTextureForImage(srcIdx);
          if (tex) {
            mat.diffuseTexture = tex;
            if (gm?.alphaMode === "MASK" || gm?.alphaMode === "BLEND") {
              tex.hasAlpha = true;
              mat.useAlphaFromDiffuseTexture = true;
            }
          }
        }
      }
      materials.push(mat);
    }
    const baseAmbients = materials.map((mat) => mat.ambientColor.clone());

    // --- Scene node hierarchy (cycle-safe) --------------------------------
    for (let idx = 0; idx < doc.nodes.length; idx += 1) {
      const node = doc.nodes[idx];
      const tn = new TransformNode(node?.name ?? `node-${idx}`, scene);
      if (node?.translation) {
        tn.position = new Vector3(
          finiteOr(node.translation[0], 0),
          finiteOr(node.translation[1], 0),
          finiteOr(node.translation[2], 0),
        );
      }
      if (node?.rotation) {
        const q = new Quaternion(
          finiteOr(node.rotation[0], 0),
          finiteOr(node.rotation[1], 0),
          finiteOr(node.rotation[2], 0),
          finiteOr(node.rotation[3], 1),
        );
        tn.rotationQuaternion = q.lengthSquared() > 1e-8 ? q.normalize() : Quaternion.Identity();
      } else {
        tn.rotationQuaternion = Quaternion.Identity();
      }
      if (node?.scale) {
        const sx = finiteOr(node.scale[0], 1);
        const sy = finiteOr(node.scale[1], 1);
        const sz = finiteOr(node.scale[2], 1);
        tn.scaling = new Vector3(
          Math.abs(sx) < 1e-5 ? 1 : sx,
          Math.abs(sy) < 1e-5 ? 1 : sy,
          Math.abs(sz) < 1e-5 ? 1 : sz,
        );
      }
      nodeTransforms.push(tn);
    }

    const parentOf = new Map<number, number>();
    for (let p = 0; p < doc.nodes.length; p += 1) {
      const children = doc.nodes[p]?.children ?? [];
      for (const childIdx of children) {
        if (!Number.isInteger(childIdx) || childIdx < 0 || childIdx >= nodeTransforms.length) continue;
        if (parentOf.has(childIdx) || wouldCreateNodeCycle(parentOf, p, childIdx)) continue;
        const child = nodeTransforms[childIdx];
        const parent = nodeTransforms[p];
        if (child && parent) {
          child.parent = parent;
          parentOf.set(childIdx, p);
        }
      }
    }
    const sceneRoots = doc.scenes[doc.defaultScene]?.nodes ?? [];
    for (let i = 0; i < nodeTransforms.length; i += 1) {
      if (!parentOf.has(i) || sceneRoots.includes(i)) {
        const tn = nodeTransforms[i];
        if (tn && !tn.parent) tn.parent = root;
      }
    }

    // Record rest local quaternions so additive/procedural bone offsets always compose from bind pose.
    const restLocalRotations = new Map<number, Quaternion>();
    for (let i = 0; i < nodeTransforms.length; i += 1) {
      const q = nodeTransforms[i]?.rotationQuaternion;
      restLocalRotations.set(i, q ? q.clone() : Quaternion.Identity());
    }

    // --- Meshes & Morph Targets (mapped per glTF node index -> MorphTarget[][]) ---
    const nodeMorphTargets = new Map<number, MorphTarget[][]>();
    const meshToNodeSkeleton = new Map<number, Skeleton>();

    for (let sIdx = 0; sIdx < doc.skins.length; sIdx += 1) {
      const skin = doc.skins[sIdx];
      if (!skin) continue;
      const skel = new Skeleton(`${name}:skel:${skin.name ?? sIdx}`, `skel-${sIdx}`, scene);
      let ibmData: Float32Array | null = null;
      if (typeof skin.inverseBindMatrices === "number") {
        try {
          ibmData = readAccessorFloat32(doc, skin.inverseBindMatrices);
        } catch {
          ibmData = null;
        }
      }
      const jointSet = new Set(skin.joints.filter((j) => Number.isInteger(j) && j >= 0 && j < doc.nodes.length));
      const jointBones = new Map<number, Bone>();
      const jointParentMap = new Map<number, number>();
      for (const jNode of jointSet) {
        const children = doc.nodes[jNode]?.children ?? [];
        for (const c of children) {
          if (jointSet.has(c) && !jointParentMap.has(c) && c !== jNode) {
            jointParentMap.set(c, jNode);
          }
        }
      }
      for (let jIdx = 0; jIdx < skin.joints.length; jIdx += 1) {
        const jNode = skin.joints[jIdx];
        if (jNode === undefined || !jointSet.has(jNode)) continue;
        const parentNode = jointParentMap.get(jNode);
        const parentBone = parentNode !== undefined ? jointBones.get(parentNode) ?? null : null;
        const tn = nodeTransforms[jNode];
        const localMat = Matrix.Compose(
          tn?.scaling ?? Vector3.One(),
          tn?.rotationQuaternion ?? Quaternion.Identity(),
          tn?.position ?? Vector3.Zero(),
        );
        let bindMat = localMat;
        if (ibmData && (jIdx + 1) * 16 <= ibmData.length) {
          const inv = Matrix.FromArray(ibmData, jIdx * 16);
          const det = inv.determinant();
          if (Number.isFinite(det) && Math.abs(det) >= 1e-10) {
            bindMat = inv.invert();
          }
        }
        const bone = new Bone(doc.nodes[jNode]?.name ?? `joint-${jNode}`, skel, parentBone, localMat, bindMat);
        if (tn) bone.linkTransformNode(tn);
        jointBones.set(jNode, bone);
      }
      skeletons.push(skel);
      meshToNodeSkeleton.set(sIdx, skel);
    }

    for (let nodeIdx = 0; nodeIdx < doc.nodes.length; nodeIdx += 1) {
      const gNode = doc.nodes[nodeIdx];
      const gMeshIdx = gNode?.mesh;
      if (!gNode || typeof gMeshIdx !== "number") continue;
      const gMesh = doc.meshes[gMeshIdx];
      const parentTn = nodeTransforms[nodeIdx];
      if (!gMesh || !parentTn) continue;

      const collectedTargets: MorphTarget[][] = [];

      for (let pIdx = 0; pIdx < gMesh.primitives.length; pIdx += 1) {
        const prim = gMesh.primitives[pIdx];
        if (!prim) continue;
        const posIdx = prim.attributes["POSITION"];
        if (typeof posIdx !== "number") continue;

        let positions: Float32Array;
        try {
          positions = readAccessorFloat32(doc, posIdx);
        } catch {
          continue;
        }
        if (positions.length < 9 || positions.length % 3 !== 0) continue;
        const vertexCount = positions.length / 3;

        let indices: Uint32Array;
        try {
          indices =
            typeof prim.indices === "number"
              ? readAccessorIndices(doc, prim.indices)
              : Uint32Array.from({ length: vertexCount }, (_, k) => k);
        } catch {
          continue;
        }
        let invalidIndex = false;
        for (let k = 0; k < indices.length; k += 1) {
          if ((indices[k] ?? 0) >= vertexCount) {
            invalidIndex = true;
            break;
          }
        }
        if (invalidIndex || indices.length === 0) continue;

        try {
          const vertexData = new VertexData();
          vertexData.positions = positions;
          vertexData.indices = indices;

          const normIdx = prim.attributes["NORMAL"];
          let loadedNormals = false;
          if (typeof normIdx === "number") {
            try {
              const norms = readAccessorFloat32(doc, normIdx);
              if (norms.length === positions.length) {
                vertexData.normals = norms;
                loadedNormals = true;
              }
            } catch {
              loadedNormals = false;
            }
          }
          if (!loadedNormals) {
            const computedNormals: number[] = [];
            VertexData.ComputeNormals(positions, Array.from(indices), computedNormals);
            vertexData.normals = computedNormals;
          }

          const uvIdx = prim.attributes["TEXCOORD_0"];
          if (typeof uvIdx === "number") {
            try {
              const uvs = readAccessorFloat32(doc, uvIdx);
              if (uvs.length === vertexCount * 2) {
                vertexData.uvs = uvs;
              }
            } catch {
              // Skip broken UVs gracefully.
            }
          }

          const jointsIdx = prim.attributes["JOINTS_0"];
          const weightsIdx = prim.attributes["WEIGHTS_0"];
          if (typeof jointsIdx === "number" && typeof weightsIdx === "number") {
            try {
              const joints = readAccessorFloat32(doc, jointsIdx);
              const weights = readAccessorFloat32(doc, weightsIdx);
              if (joints.length === vertexCount * 4 && weights.length === vertexCount * 4) {
                vertexData.matricesIndices = Array.from(joints);
                vertexData.matricesWeights = Array.from(weights);
              }
            } catch {
              // Skip broken skinning attributes gracefully.
            }
          }

          const mesh = new Mesh(`${gMesh.name ?? "vrm-mesh"}-${nodeIdx}-${pIdx}`, scene);
          vertexData.applyToMesh(mesh, false);
          mesh.parent = parentTn;
          if (typeof prim.material === "number" && materials[prim.material]) {
            mesh.material = materials[prim.material] ?? null;
          }
          if (typeof gNode.skin === "number") {
            const skel = meshToNodeSkeleton.get(gNode.skin);
            if (skel) mesh.skeleton = skel;
          }

          if (prim.targets && prim.targets.length > 0) {
            const targetList = prim.targets.slice(0, MAX_MORPH_TARGETS_PER_PRIM);
            const manager = new MorphTargetManager(scene);
            mesh.morphTargetManager = manager;
            morphManagers.push(manager);
            for (let tIdx = 0; tIdx < targetList.length; tIdx += 1) {
              const targetMap = targetList[tIdx];
              const deltaPosIdx = targetMap?.["POSITION"];
              const target = new MorphTarget(`morph-${nodeIdx}-${pIdx}-${tIdx}`, 0, scene, manager);
              if (typeof deltaPosIdx === "number") {
                try {
                  const deltas = readAccessorFloat32(doc, deltaPosIdx);
                  const absPos = new Float32Array(positions.length);
                  for (let k = 0; k < Math.min(positions.length, deltas.length); k += 1) {
                    const sum = (positions[k] ?? 0) + (deltas[k] ?? 0);
                    absPos[k] = Number.isFinite(sum) ? sum : (positions[k] ?? 0);
                  }
                  for (let k = deltas.length; k < positions.length; k += 1) {
                    absPos[k] = positions[k] ?? 0;
                  }
                  target.setPositions(absPos);
                } catch {
                  // Ignore broken morph delta buffer cleanly.
                }
              }
              manager.addTarget(target);
              const bucket = collectedTargets[tIdx] ?? [];
              bucket.push(target);
              collectedTargets[tIdx] = bucket;
            }
          }

          meshes.push(mesh);
        } catch {
          // Skip malformed primitive gracefully rather than crashing the renderer.
        }
      }

      if (collectedTargets.length > 0) {
        nodeMorphTargets.set(nodeIdx, collectedTargets);
      }
    }

    // --- Humanoid bone map & expression presets -----------------------------
    const humanNodes = new Map<string, TransformNode>();
    const humanNodeIndex = new Map<string, number>();
    for (const [boneName, nodeIdx] of Object.entries(doc.humanoidBones)) {
      const tn = nodeTransforms[nodeIdx];
      if (tn) {
        humanNodes.set(boneName, tn);
        humanNodeIndex.set(boneName, nodeIdx);
      }
    }

    const expressionNames = new Set<string>(Object.keys(doc.expressions));

    const setExpression = (exprName: string, weight: number): void => {
      const def = doc.expressions[exprName];
      if (!def || !Number.isFinite(weight)) return;
      const clamped = def.isBinary ? (weight >= 0.5 ? 1 : 0) : Math.max(0, Math.min(1, weight));
      for (const bind of def.binds) {
        if (!Number.isInteger(bind.index) || bind.index < 0) continue;
        const targets = nodeMorphTargets.get(bind.node)?.[bind.index];
        if (!targets) continue;
        const bindWeight = Number.isFinite(bind.weight) ? bind.weight : 1;
        for (const target of targets) {
          target.influence = Math.max(0, Math.min(1, clamped * bindWeight));
        }
      }
    };

    const setBoneLocalRotation = (boneName: string, deltaRotation: Quaternion): void => {
      const nodeIdx = humanNodeIndex.get(boneName);
      const tn = humanNodes.get(boneName);
      if (nodeIdx === undefined || !tn) return;
      const rest = restLocalRotations.get(nodeIdx) ?? Quaternion.Identity();
      tn.rotationQuaternion = rest.multiply(deltaRotation);
    };

    // --- Verlet Spring-Bone physics setup -----------------------------------
    root.computeWorldMatrix(true);
    for (const tn of nodeTransforms) tn.computeWorldMatrix(true);

    const readNodePos = (nodeIdx: number): readonly [number, number, number] => {
      const tn = nodeTransforms[nodeIdx];
      if (!tn) return [0, 0, 0];
      const p = tn.getAbsolutePosition();
      return [finiteOr(p.x, 0), finiteOr(p.y, 0), finiteOr(p.z, 0)];
    };

    const solver = new VerletSpringSolver(doc.springs, readNodePos);

    const stepSpringBones = (dt: number): void => {
      if (solver.chains.length === 0) return;
      for (const tn of nodeTransforms) tn.computeWorldMatrix(true);
      solver.step(dt, readNodePos, (nodeIdx, headPos, tailPos) => {
        const tn = nodeTransforms[nodeIdx];
        if (!tn) return;
        const dx = tailPos[0] - headPos[0];
        const dy = tailPos[1] - headPos[1];
        const dz = tailPos[2] - headPos[2];
        const dir = new Vector3(dx, dy, dz);
        if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z) || dir.lengthSquared() < 1e-8) {
          return;
        }
        dir.normalize();
        const rest = restLocalRotations.get(nodeIdx) ?? Quaternion.Identity();
        // Subtle aim deflection around Y/X derived from spring tail displacement.
        const tiltX = Math.max(-0.6, Math.min(0.6, dir.z * 0.45));
        const tiltZ = Math.max(-0.6, Math.min(0.6, -dir.x * 0.45));
        tn.rotationQuaternion = rest.multiply(Quaternion.RotationYawPitchRoll(0, tiltX, tiltZ));
      });
    };

    const applyShaderPreset = (preset: {
      specularScale?: number;
      rimLight?: number;
      outlineThickness?: number;
    }): void => {
      if (typeof preset.specularScale === "number" && Number.isFinite(preset.specularScale)) {
        for (const mat of materials) {
          mat.specularPower = Math.max(1, 24 * preset.specularScale);
        }
      }
      if (typeof preset.rimLight === "number" && Number.isFinite(preset.rimLight)) {
        const lift = Math.max(0, preset.rimLight - 1) * 0.22;
        const scale = Math.max(0.4, Math.min(1.8, preset.rimLight));
        for (let i = 0; i < materials.length; i += 1) {
          const mat = materials[i];
          const base = baseAmbients[i];
          if (!mat || !base) continue;
          mat.ambientColor = new Color3(
            Math.min(1, base.r * scale),
            Math.min(1, base.g * scale),
            Math.min(1, base.b * scale),
          );
          mat.emissiveColor = new Color3(lift, lift, lift);
        }
      }
      if (typeof preset.outlineThickness === "number" && Number.isFinite(preset.outlineThickness)) {
        const thickness = Math.max(0, Math.min(2.5, preset.outlineThickness));
        for (const mesh of meshes) {
          mesh.renderOutline = thickness > 0.05;
          mesh.outlineWidth = 0.008 * thickness;
          mesh.outlineColor = new Color3(0.11, 0.12, 0.23);
        }
      }
    };

    return {
      doc,
      meta: doc.meta,
      root,
      meshes,
      humanNodes,
      expressionNames,
      setExpression,
      setBoneLocalRotation,
      stepSpringBones,
      applyShaderPreset,
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** Collects vertex positions from any loaded VRM or MMD root mesh list for camera framing. */
export function collectMeshPositions(meshes: readonly AbstractMesh[]): Float32Array[] {
  const out: Float32Array[] = [];
  for (const part of meshes) {
    const pos = part.getVerticesData(VertexBuffer.PositionKind);
    if (!pos) continue;
    out.push(pos instanceof Float32Array ? pos : Float32Array.from(pos));
  }
  return out;
}
