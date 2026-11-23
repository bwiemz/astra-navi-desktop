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
  /** Applies custom outline / specular toon overrides cleanly. */
  applyShaderPreset(preset: { specularScale?: number }): void;
  dispose(): void;
}

/**
 * Pure `@babylonjs/core` loader for `.vrm` (VRM 1.0 & VRM 0.x) binary GLB avatars.
 * Builds skinned/morphed meshes, VRM humanoid bone nodes, expression bindings,
 * toon/standard materials with embedded textures, and `VRMC_springBone` physics.
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

  // --- Materials & embedded baseColor textures ---------------------------
  const getTextureForImage = (imageIndex: number): Texture | null => {
    const img = extractImageBytes(doc, imageIndex);
    if (!img || typeof URL === "undefined" || typeof Blob === "undefined") return null;
    const copy = new Uint8Array(img.bytes.byteLength);
    copy.set(img.bytes);
    const blob = new Blob([copy], { type: img.mimeType });
    const objUrl = URL.createObjectURL(blob);
    objectUrls.push(objUrl);
    const tex = new Texture(objUrl, scene, false, false);
    textures.push(tex);
    return tex;
  };

  for (let i = 0; i < doc.materials.length; i += 1) {
    const gm = doc.materials[i];
    const mat = new StandardMaterial(`${name}:mat:${gm?.name ?? i}`, scene);
    const factor = gm?.pbrMetallicRoughness?.baseColorFactor;
    if (factor && factor.length >= 3) {
      mat.diffuseColor = new Color3(factor[0], factor[1], factor[2]);
      if (factor[3] < 0.99 && gm?.alphaMode === "BLEND") mat.alpha = factor[3];
    }
    const mtoon = gm?.extensions?.VRMC_materials_mtoon;
    if (mtoon?.shadeColorFactor) {
      const [r, g, b] = mtoon.shadeColorFactor;
      mat.ambientColor = new Color3(r * 0.45, g * 0.45, b * 0.45);
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

  // --- Scene node hierarchy ----------------------------------------------
  const nodeTransforms: TransformNode[] = doc.nodes.map((node, idx) => {
    const tn = new TransformNode(node.name ?? `node-${idx}`, scene);
    if (node.translation) {
      tn.position = new Vector3(node.translation[0], node.translation[1], node.translation[2]);
    }
    if (node.rotation) {
      tn.rotationQuaternion = new Quaternion(
        node.rotation[0],
        node.rotation[1],
        node.rotation[2],
        node.rotation[3],
      );
    } else {
      tn.rotationQuaternion = Quaternion.Identity();
    }
    if (node.scale) {
      tn.scaling = new Vector3(node.scale[0], node.scale[1], node.scale[2]);
    }
    return tn;
  });

  const hasParent = new Set<number>();
  for (let p = 0; p < doc.nodes.length; p += 1) {
    const children = doc.nodes[p]?.children ?? [];
    for (const childIdx of children) {
      const child = nodeTransforms[childIdx];
      const parent = nodeTransforms[p];
      if (child && parent) {
        child.parent = parent;
        hasParent.add(childIdx);
      }
    }
  }
  const sceneRoots = doc.scenes[doc.defaultScene]?.nodes ?? [];
  for (let i = 0; i < nodeTransforms.length; i += 1) {
    if (!hasParent.has(i) || sceneRoots.includes(i)) {
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

  // --- Meshes & Morph Targets (mapped per glTF node index) ----------------
  const nodeMorphTargets = new Map<number, MorphTarget[]>();
  const meshToNodeSkeleton = new Map<number, Skeleton>();

  for (let sIdx = 0; sIdx < doc.skins.length; sIdx += 1) {
    const skin = doc.skins[sIdx];
    if (!skin) continue;
    const skel = new Skeleton(`${name}:skel:${skin.name ?? sIdx}`, `skel-${sIdx}`, scene);
    const ibmData =
      typeof skin.inverseBindMatrices === "number"
        ? readAccessorFloat32(doc, skin.inverseBindMatrices)
        : null;
    const jointBones = new Map<number, Bone>();
    const jointParentMap = new Map<number, number>();
    for (const jNode of skin.joints) {
      const children = doc.nodes[jNode]?.children ?? [];
      for (const c of children) {
        if (skin.joints.includes(c)) jointParentMap.set(c, jNode);
      }
    }
    for (let jIdx = 0; jIdx < skin.joints.length; jIdx += 1) {
      const jNode = skin.joints[jIdx];
      if (jNode === undefined) continue;
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
        bindMat = inv.invert();
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

    const collectedTargets: MorphTarget[] = [];

    for (let pIdx = 0; pIdx < gMesh.primitives.length; pIdx += 1) {
      const prim = gMesh.primitives[pIdx];
      if (!prim) continue;
      const posIdx = prim.attributes["POSITION"];
      if (typeof posIdx !== "number") continue;
      const positions = readAccessorFloat32(doc, posIdx);
      const vertexData = new VertexData();
      vertexData.positions = positions;

      const normIdx = prim.attributes["NORMAL"];
      if (typeof normIdx === "number") {
        vertexData.normals = readAccessorFloat32(doc, normIdx);
      } else {
        const computedNormals: number[] = [];
        const indicesForNormals =
          typeof prim.indices === "number"
            ? Array.from(readAccessorIndices(doc, prim.indices))
            : Array.from({ length: positions.length / 3 }, (_, idx) => idx);
        VertexData.ComputeNormals(positions, indicesForNormals, computedNormals);
        vertexData.normals = computedNormals;
      }

      const uvIdx = prim.attributes["TEXCOORD_0"];
      if (typeof uvIdx === "number") {
        vertexData.uvs = readAccessorFloat32(doc, uvIdx);
      }
      const jointsIdx = prim.attributes["JOINTS_0"];
      const weightsIdx = prim.attributes["WEIGHTS_0"];
      if (typeof jointsIdx === "number" && typeof weightsIdx === "number") {
        vertexData.matricesIndices = Array.from(readAccessorFloat32(doc, jointsIdx));
        vertexData.matricesWeights = Array.from(readAccessorFloat32(doc, weightsIdx));
      }
      if (typeof prim.indices === "number") {
        vertexData.indices = readAccessorIndices(doc, prim.indices);
      } else {
        vertexData.indices = Uint32Array.from({ length: positions.length / 3 }, (_, k) => k);
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
        const manager = new MorphTargetManager(scene);
        mesh.morphTargetManager = manager;
        morphManagers.push(manager);
        for (let tIdx = 0; tIdx < prim.targets.length; tIdx += 1) {
          const targetMap = prim.targets[tIdx];
          const deltaPosIdx = targetMap?.["POSITION"];
          const target = new MorphTarget(`morph-${nodeIdx}-${tIdx}`, 0, scene, manager);
          if (typeof deltaPosIdx === "number") {
            const deltas = readAccessorFloat32(doc, deltaPosIdx);
            const absPos = new Float32Array(positions.length);
            for (let k = 0; k < Math.min(positions.length, deltas.length); k += 1) {
              absPos[k] = (positions[k] ?? 0) + (deltas[k] ?? 0);
            }
            target.setPositions(absPos);
          }
          manager.addTarget(target);
          if (!collectedTargets[tIdx]) collectedTargets[tIdx] = target;
        }
      }

      meshes.push(mesh);
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
    if (!def) return;
    const clamped = def.isBinary ? (weight >= 0.5 ? 1 : 0) : Math.max(0, Math.min(1, weight));
    for (const bind of def.binds) {
      const target = nodeMorphTargets.get(bind.node)?.[bind.index];
      if (target) {
        target.influence = clamped * bind.weight;
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
    return [p.x, p.y, p.z];
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
      if (dir.lengthSquared() < 1e-8) return;
      dir.normalize();
      const rest = restLocalRotations.get(nodeIdx) ?? Quaternion.Identity();
      // Subtle aim deflection around Y/X derived from spring tail displacement.
      const tiltX = Math.max(-0.6, Math.min(0.6, dir.z * 0.45));
      const tiltZ = Math.max(-0.6, Math.min(0.6, -dir.x * 0.45));
      tn.rotationQuaternion = rest.multiply(Quaternion.RotationYawPitchRoll(0, tiltX, tiltZ));
    });
  };

  const applyShaderPreset = (preset: { specularScale?: number }): void => {
    if (typeof preset.specularScale !== "number") return;
    for (const mat of materials) {
      mat.specularPower = Math.max(1, 24 * preset.specularScale);
    }
  };

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
