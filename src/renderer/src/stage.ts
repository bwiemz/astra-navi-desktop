import "babylon-mmd/esm/Loader/pmxLoader";
import "babylon-mmd/esm/Loader/pmdLoader";
import "babylon-mmd/esm/Loader/mmdOutlineRenderer";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { MmdStandardMaterialBuilder } from "babylon-mmd/esm/Loader/mmdStandardMaterialBuilder";
import { SdefInjector } from "babylon-mmd/esm/Loader/sdefInjector";
import type { IMmdRuntimeLinkedBone } from "babylon-mmd/esm/Runtime/IMmdRuntimeLinkedBone";
import type { MmdModel } from "babylon-mmd/esm/Runtime/mmdModel";
import { MmdRuntime } from "babylon-mmd/esm/Runtime/mmdRuntime";
import { MmdStandardMaterialProxy } from "babylon-mmd/esm/Runtime/mmdStandardMaterialProxy";
import { MmdWasmInstanceTypeSPR } from "babylon-mmd/esm/Runtime/Optimized/InstanceType/singlePhysicsRelease";
import { GetMmdWasmInstance } from "babylon-mmd/esm/Runtime/Optimized/mmdWasmInstance";
import { MultiPhysicsRuntime } from "babylon-mmd/esm/Runtime/Optimized/Physics/Bind/Impl/multiPhysicsRuntime";
import { MmdBulletPhysics } from "babylon-mmd/esm/Runtime/Optimized/Physics/mmdBulletPhysics";
import type { Mood } from "../../shared/ipc.ts";
import {
  evaluateGestureMotion,
  GESTURES,
  type Gesture,
  type GestureMotionSample,
} from "../../shared/gestures.ts";
import {
  blendAmbientScreenLighting,
  computeTimeOfDayLighting,
  facingYawForEdge,
  PresenceTracker,
  ROOM_SCENE_SPECS,
  type DockEdge,
  type PresenceUpdate,
  type RoomScenePreset,
  type StageLightingState,
} from "../../shared/spatialStage.ts";
import {
  sampleVisemeWeights,
  VISEME_MORPH_CANDIDATES,
  type VisemeFrame,
  type VisemeWeights,
  type VowelViseme,
} from "../../shared/visemes.ts";
import { loadVrmIntoScene, type LoadedVrmRig } from "./vrmLoader.ts";

export { GESTURES, evaluateGestureMotion, type Gesture, type GestureMotionSample };

/**
 * Face shapes for each mood, using the standard MMD morph names. Each slot lists
 * alternatives in order of preference, because models do not all carry the same set.
 */
const MOOD_FACES: Record<Mood, readonly (readonly [names: readonly string[], weight: number])[]> = {
  neutral: [],
  happy: [
    [["口角上げ", "にっこり", "にこり口", "happy"], 0.7],
    [["にこり", "relaxed"], 0.5],
    [["笑い", "なごみ"], 0.3],
  ],
  excited: [
    [["ワ", "わ", "あ２", "お1", "あ", "happy"], 0.6],
    [["にこり", "surprised"], 0.55],
    [["上"], 0.3],
  ],
  thinking: [
    [["真面目", "relaxed"], 0.45],
    [["ん", "う", "ou"], 0.4],
    [["じと目"], 0.25],
  ],
  surprised: [
    [["びっくり", "surprised"], 0.85],
    [["上"], 0.6],
    [["お", "□", "oh"], 0.55],
  ],
  worried: [
    [["困る", "sad"], 0.8],
    [["口角下げ", "∧"], 0.5],
  ],
  smug: [
    [["にやり", "にやり２", "口角上げ", "happy"], 0.65],
    [["じと目", "relaxed"], 0.4],
    [["真面目"], 0.3],
  ],
  sad: [
    [["困る", "sad"], 0.7],
    [["口角下げ", "∧"], 0.7],
    [["下"], 0.3],
    [["まばたき", "blink"], 0.2],
  ],
};

const BLINK_MORPHS = ["まばたき", "blink"] as const;
const BROW_UP_MORPHS = ["上", "眉上", "surprised"] as const;
const SURPRISE_MORPHS = ["びっくり", "びっくり1", "surprised"] as const;

const VRM_VISEME_CANDIDATES: Record<VowelViseme, readonly string[]> = {
  A: ["aa", ...VISEME_MORPH_CANDIDATES.A],
  I: ["ih", ...VISEME_MORPH_CANDIDATES.I],
  U: ["ou", ...VISEME_MORPH_CANDIDATES.U],
  E: ["ee", ...VISEME_MORPH_CANDIDATES.E],
  O: ["oh", ...VISEME_MORPH_CANDIDATES.O],
};

/**
 * How often she is drawn. A figure standing still does not need the screen's full rate,
 * and every frame she takes is one the graphics card is not giving to a game.
 */
const FRAMES_PER_SECOND = { lively: 60, idle: 20, asleep: 6 } as const;
const LOW_POWER_FPS = { lively: 30, idle: 15, asleep: 4 } as const;
/** After something happens she stays at the lively rate this long, so easing finishes smoothly. */
const LIVELY_FOR_MS = 2500;

const TALK_MORPHS = ["あ", "aa", "a", "A"] as const;
const DEG = Math.PI / 180;

/** Moves a value toward its target at a rate that does not depend on the frame rate. */
function approach(current: number, target: number, perSecond: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-perSecond * dt));
}

type RigBoneKey =
  | "hips"
  | "upper"
  | "neck"
  | "head"
  | "eyes"
  | "leftEye"
  | "rightEye"
  | "leftShoulder"
  | "rightShoulder"
  | "leftArm"
  | "rightArm"
  | "leftElbow"
  | "rightElbow";

interface Rig {
  readonly kind: "mmd" | "vrm";
  readonly mmdModel?: MmdModel;
  readonly vrmRig?: LoadedVrmRig;
  morphNames: ReadonlySet<string>;
  talkMorph: string | null;
  visemeMorphs: Record<VowelViseme, string | null>;
  visemeWeights: VisemeWeights;
  setMorphWeight(name: string, weight: number): void;
  setBoneRotation(bone: RigBoneKey, rotation: Quaternion): void;
  stepPhysics(dt: number): void;
  /** Everything the loader created for this model, so it can all be released together. */
  dispose(): void;
  /** Morph weights currently applied for the mood, eased toward their targets. */
  face: Map<string, number>;
}

/** The 3D character: loads the model and keeps it alive with small procedural motion. */
export class Stage {
  private readonly canvas: HTMLCanvasElement;
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly skyLight: HemisphericLight;
  private readonly sunLight: DirectionalLight;
  private readonly mmdRuntime: MmdRuntime;
  private readonly hasPhysics: boolean;
  private rig: Rig | null = null;
  private loadToken = 0;

  private dockFacingDeg = 0;
  private dockFacingDegTarget = 0;
  private roomGroup: TransformNode | null = null;
  private roomPreset: RoomScenePreset = "none";
  private lightingMode: "default" | "time-of-day" | "screen-ambient" = "default";
  private currentLighting: StageLightingState = computeTimeOfDayLighting(13);
  private readonly presenceTracker = new PresenceTracker({ enabled: false });
  private webcamStream: MediaStream | null = null;
  private webcamTimer: number | null = null;

  private mood: Mood = "neutral";
  private thinking = false;
  private talkUntil = 0;
  private talkLevel = 0;
  /** Loudness of her spoken voice right now, or null when she is not speaking aloud. */
  private voiceLevel: number | null = null;
  private mouthOpen = 0;
  private visemeTrack: {
    frames: readonly VisemeFrame[];
    startedAtMs: number;
    totalDurationMs: number;
  } | null = null;
  private clock = 0;
  private nextBlinkAt = 2;
  private blinkStartedAt = -1;
  private saccade = { x: 0, y: 0 };
  private saccadeTarget = { x: 0, y: 0 };
  private nextSaccadeAt = 1.4;
  private gaze = { x: 0, y: 0 };
  private gazeTarget = { x: 0, y: 0 };
  private tilt = 0;
  private lookUp = 0;
  /** 0 awake to 1 asleep, eased. */
  private sleep = 0;
  private asleep = false;
  /** 0 to 1 while she is listening to someone speak, eased. */
  private attention = 0;
  private listening = false;
  private gesture: { kind: Gesture; startedAt: number } | null = null;
  /** A start that fades by itself: used when she is woken. */
  private startle = 0;
  private visible = true;
  private livelyUntil = 0;
  private breathingScale = 1;
  private talkGestureScale = 1;
  private paralinguisticTarget = { leanForward: 0, headTiltDeg: 0, energyScale: 1 };
  private paralinguistic = { leanForward: 0, headTiltDeg: 0, energyScale: 1 };
  private lastFrameAt = 0;
  private frameRequest = 0;
  private framesDrawn = 0;
  private countedSince = 0;
  private lowPower = false;
  private solidBackdrop = false;

  /** Sets up the scene. Hair and cloth physics are loaded first; the character still works without them. */
  static async create(canvas: HTMLCanvasElement): Promise<Stage> {
    const engine = new Engine(canvas, true, {
      alpha: true,
      premultipliedAlpha: true,
      stencil: true,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    // Lets the loader's spherical deformation (smoother elbows and knees) work.
    SdefInjector.OverrideEngineCreateEffect(engine);
    const scene = new Scene(engine);
    let physics: MmdBulletPhysics | null = null;
    try {
      const wasm = await GetMmdWasmInstance(new MmdWasmInstanceTypeSPR());
      const physicsRuntime = new MultiPhysicsRuntime(wasm);
      physicsRuntime.setGravity(new Vector3(0, -98, 0));
      physicsRuntime.register(scene);
      physics = new MmdBulletPhysics(physicsRuntime);
    } catch (error) {
      console.warn("Physics engine did not load; hair and cloth will not move.", error);
    }
    return new Stage(canvas, engine, scene, physics);
  }

  private constructor(
    canvas: HTMLCanvasElement,
    engine: Engine,
    scene: Scene,
    physics: MmdBulletPhysics | null,
  ) {
    this.canvas = canvas;
    this.engine = engine;
    this.scene = scene;
    this.hasPhysics = physics !== null;
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.ambientColor = new Color3(0.5, 0.5, 0.5);

    this.camera = new FreeCamera("camera", new Vector3(0, 10, -45), this.scene);
    this.camera.fov = 20 * DEG;
    this.camera.minZ = 1;
    this.camera.maxZ = 500;
    this.camera.setTarget(new Vector3(0, 10, 0));

    this.skyLight = new HemisphericLight("sky", new Vector3(0, 1, 0), this.scene);
    this.skyLight.intensity = 0.35;
    this.sunLight = new DirectionalLight("sun", new Vector3(0.4, -1, 1), this.scene);
    this.sunLight.intensity = 0.85;

    this.mmdRuntime = new MmdRuntime(this.scene, physics);
    // Our motion has to be written to the bones before the runtime reads them each frame.
    this.scene.onBeforeAnimationsObservable.add(() => this.animate());
    this.mmdRuntime.register(this.scene);

    this.frameRequest = requestAnimationFrame(this.tick);
    new ResizeObserver(() => {
      this.engine.resize();
      this.stir();
    }).observe(canvas);
  }

  get hasModel(): boolean {
    return this.rig !== null;
  }

  /**
   * The drawing loop. It runs at the screen's rate but only draws when a frame is due:
   * sixty a second while something is happening, far fewer while she just stands
   * there, and none at all while her window is hidden.
   */
  private readonly tick = (now: number): void => {
    this.frameRequest = this.visible ? requestAnimationFrame(this.tick) : 0;
    const pace =
      this.asleep && now > this.livelyUntil ? "asleep" : now < this.livelyUntil ? "lively" : "idle";
    // A little slack, or a frame that arrives a hair early would be skipped and the rate halved.
    const fpsTable = this.lowPower ? LOW_POWER_FPS : FRAMES_PER_SECOND;
    if (now - this.lastFrameAt < 1000 / fpsTable[pace] - 2) return;
    this.lastFrameAt = now;
    this.engine.beginFrame();
    this.scene.render();
    this.engine.endFrame();
    // For checking the pacing: how many frames were really drawn, every ten seconds.
    this.framesDrawn += 1;
    if (now - this.countedSince >= 10_000) {
      console.debug(
        `[stage] ${(this.framesDrawn / ((now - this.countedSince) / 1000)).toFixed(1)} frames a second (${pace})`,
      );
      this.framesDrawn = 0;
      this.countedSince = now;
    }
  };

  /** Something is happening: draw at the full rate for a little while. */
  private stir(): void {
    this.livelyUntil = performance.now() + LIVELY_FOR_MS;
  }

  /** Stops drawing while her window cannot be seen, and picks up again when it can. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible && this.frameRequest === 0) {
      this.stir();
      this.frameRequest = requestAnimationFrame(this.tick);
    }
  }

  /** Caps stage FPS (30/15/4) and lowers render resolution scaling for battery-conscious laptops. */
  setLowPowerMode(on: boolean): void {
    if (on === this.lowPower) return;
    this.lowPower = on;
    this.engine.setHardwareScalingLevel(on ? 1.5 : 1);
    this.stir();
  }

  /** Uses an opaque navy backdrop in Solid-Docked window mode instead of transparent overlay compositing. */
  setSolidBackdrop(on: boolean): void {
    if (on === this.solidBackdrop) return;
    this.solidBackdrop = on;
    if (this.roomPreset === "none") {
      this.scene.clearColor = on
        ? new Color4(0x14 / 255, 0x18 / 255, 0x24 / 255, 1)
        : new Color4(0, 0, 0, 0);
    }
    this.stir();
  }

  /** Orients Astra slightly toward the desktop center when docked on left/right monitor edges. */
  setDockEdge(edge: DockEdge): void {
    this.dockFacingDegTarget = facingYawForEdge(edge);
    this.stir();
  }

  private disposeRoomScene(): void {
    if (!this.roomGroup) return;
    for (const child of this.roomGroup.getChildren()) {
      const asMesh = child as Mesh;
      asMesh.material?.dispose();
      asMesh.dispose?.();
    }
    this.roomGroup.dispose();
    this.roomGroup = null;
  }

  /** Builds or removes lightweight procedural 3D desk/room scenery behind the character. */
  setRoomScene(preset: RoomScenePreset): void {
    if (preset === this.roomPreset && this.roomGroup) return;
    this.roomPreset = preset;
    this.disposeRoomScene();
    const spec = ROOM_SCENE_SPECS[preset];
    if (preset === "none") {
      this.scene.clearColor = this.solidBackdrop
        ? new Color4(0x14 / 255, 0x18 / 255, 0x24 / 255, 1)
        : new Color4(0, 0, 0, 0);
      this.stir();
      return;
    }

    const [cr, cg, cb, ca] = spec.backdropColor;
    this.scene.clearColor = new Color4(cr, cg, cb, ca);
    const group = new TransformNode(`room:${preset}`, this.scene);
    const floorMat = new StandardMaterial(`room-floor-mat:${preset}`, this.scene);
    floorMat.diffuseColor = new Color3(spec.floorColor[0], spec.floorColor[1], spec.floorColor[2]);
    floorMat.specularColor = new Color3(0.05, 0.05, 0.05);

    const floor = CreateGround(`room-floor:${preset}`, { width: 42, height: 32 }, this.scene);
    floor.position = new Vector3(0, -0.05, 4);
    floor.material = floorMat;
    floor.parent = group;

    const deskMat = new StandardMaterial(`room-desk-mat:${preset}`, this.scene);
    deskMat.diffuseColor = new Color3(spec.deskColor[0], spec.deskColor[1], spec.deskColor[2]);
    deskMat.specularColor = new Color3(0.12, 0.12, 0.12);

    const deskTop = CreateBox(`room-desk:${preset}`, { width: 22, height: 0.9, depth: 8 }, this.scene);
    deskTop.position = new Vector3(0, 6.2, 11);
    deskTop.material = deskMat;
    deskTop.parent = group;

    const accentMat = new StandardMaterial(`room-accent-mat:${preset}`, this.scene);
    accentMat.emissiveColor = new Color3(
      spec.accentColor[0] * 0.45,
      spec.accentColor[1] * 0.45,
      spec.accentColor[2] * 0.45,
    );
    accentMat.diffuseColor = new Color3(spec.accentColor[0], spec.accentColor[1], spec.accentColor[2]);

    const accentStrip = CreateBox(`room-accent:${preset}`, { width: 16, height: 0.35, depth: 0.4 }, this.scene);
    accentStrip.position = new Vector3(0, 7.0, 14.2);
    accentStrip.material = accentMat;
    accentStrip.parent = group;

    this.roomGroup = group;
    this.stir();
  }

  private applyLightingState(state: StageLightingState): void {
    this.currentLighting = state;
    this.skyLight.diffuse = new Color3(state.skyColor[0], state.skyColor[1], state.skyColor[2]);
    this.skyLight.groundColor = new Color3(
      state.groundColor[0],
      state.groundColor[1],
      state.groundColor[2],
    );
    this.skyLight.intensity = state.skyIntensity;
    this.sunLight.diffuse = new Color3(state.sunColor[0], state.sunColor[1], state.sunColor[2]);
    this.sunLight.direction = new Vector3(
      state.sunDirection[0],
      state.sunDirection[1],
      state.sunDirection[2],
    );
    this.sunLight.intensity = state.sunIntensity;
    this.scene.ambientColor = new Color3(
      state.ambientColor[0],
      state.ambientColor[1],
      state.ambientColor[2],
    );
    this.stir();
  }

  setLightingMode(mode: "default" | "time-of-day" | "screen-ambient", now = new Date()): void {
    this.lightingMode = mode;
    if (mode === "default") {
      this.skyLight.intensity = 0.35;
      this.sunLight.intensity = 0.85;
      this.sunLight.direction = new Vector3(0.4, -1, 1);
      this.scene.ambientColor = new Color3(0.5, 0.5, 0.5);
      this.stir();
      return;
    }
    this.applyTimeOfDayLighting(now);
  }

  applyTimeOfDayLighting(now = new Date()): StageLightingState {
    const computed = computeTimeOfDayLighting(now);
    if (this.lightingMode !== "screen-ambient") {
      this.applyLightingState(computed);
    } else {
      this.currentLighting = computed;
    }
    return computed;
  }

  applyScreenAmbientColor(rgb: readonly [number, number, number], strength = 0.45): StageLightingState {
    const blended = blendAmbientScreenLighting(this.currentLighting, rgb, strength);
    this.applyLightingState(blended);
    return blended;
  }

  /**
   * Feeds a tiny grayscale webcam frame strictly in memory for opt-in presence/gaze tracking.
   * Zero frames are persisted or transmitted off-device.
   */
  feedPresenceFrame(
    luma: Uint8Array,
    width: number,
    height: number,
    nowMs = Date.now(),
  ): PresenceUpdate {
    const update = this.presenceTracker.processFrame(luma, width, height, nowMs);
    if (!update.enabled) return update;
    if (update.action === "wake") this.setAsleep(false);
    else if (update.action === "sleep") this.setAsleep(true);
    if (update.present && update.gazeTarget) {
      this.lookAt(update.gazeTarget.x, update.gazeTarget.y);
    }
    return update;
  }

  private stopWebcamPresence(): void {
    if (this.webcamTimer !== null && typeof window !== "undefined") {
      window.clearInterval(this.webcamTimer);
    }
    this.webcamTimer = null;
    if (this.webcamStream) {
      for (const track of this.webcamStream.getTracks()) track.stop();
      this.webcamStream = null;
    }
  }

  /** Enables or disables local opt-in webcam presence detection (`false` by default). */
  async setWebcamPresenceEnabled(enabled: boolean): Promise<boolean> {
    this.presenceTracker.setEnabled(enabled);
    this.stopWebcamPresence();
    if (!enabled) return false;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return true;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 160, height: 120 },
        audio: false,
      });
      if (!this.presenceTracker.enabled) {
        for (const t of stream.getTracks()) t.stop();
        return false;
      }
      this.webcamStream = stream;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      void video.play().catch(() => undefined);
      const sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = 32;
      sampleCanvas.height = 24;
      const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
      this.webcamTimer = window.setInterval(() => {
        if (!ctx || video.readyState < 2) return;
        ctx.drawImage(video, 0, 0, 32, 24);
        const rgba = ctx.getImageData(0, 0, 32, 24).data;
        const luma = new Uint8Array(32 * 24);
        for (let i = 0; i < luma.length; i += 1) {
          const base = i * 4;
          luma[i] = Math.round(
            0.299 * (rgba[base] ?? 0) +
              0.587 * (rgba[base + 1] ?? 0) +
              0.114 * (rgba[base + 2] ?? 0),
          );
        }
        this.feedPresenceFrame(luma, 32, 24, Date.now());
      }, 500);
      return true;
    } catch {
      return false;
    }
  }

  setMood(mood: Mood): void {
    if (mood !== this.mood) this.stir();
    this.mood = mood;
    if (mood === "excited") this.play("perk");
  }

  setThinking(thinking: boolean): void {
    if (thinking !== this.thinking) this.stir();
    this.thinking = thinking;
  }

  /** Call whenever new words arrive; the mouth keeps moving for a moment afterwards. */
  talk(): void {
    this.talkUntil = this.clock + 0.35;
    this.stir();
  }

  /** Drives her mouth from the sound of her voice. Pass null when she stops speaking. */
  setVoiceLevel(level: number | null): void {
    this.voiceLevel = level;
    if (level !== null) this.stir();
  }

  /** Drives multi-vowel lip-sync from time-aligned phoneme visemes synchronized to audio playback. */
  setVisemes(frames: readonly VisemeFrame[], startedAtMs = performance.now()): void {
    if (frames.length === 0) {
      this.clearVisemes();
      return;
    }
    const last = frames[frames.length - 1];
    const totalDurationMs = last ? last.timeMs + last.durationMs : 0;
    this.visemeTrack = { frames: [...frames], startedAtMs, totalDurationMs };
    this.stir();
  }

  /** Clears active viseme track cleanly (for barge-in interruption or end of speech). */
  clearVisemes(): void {
    this.visemeTrack = null;
  }

  /** Where to look, each axis from -1 to 1 across the window. */
  lookAt(x: number, y: number): void {
    this.gazeTarget = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    this.stir();
  }

  /** Maps normalized [0..1] screen coordinates from vision/input onto directional eye and head gaze. */
  setScreenGaze(normX: number, normY: number): void {
    const nx = Math.max(0, Math.min(1, normX));
    const ny = Math.max(0, Math.min(1, normY));
    this.lookAt((nx - 0.5) * 2, (0.5 - ny) * 2);
  }

  /** She leans in and pays attention while someone is speaking to her. */
  setListening(listening: boolean): void {
    if (listening !== this.listening) this.stir();
    this.listening = listening;
  }

  /**
   * Asleep is how she looks while her brain is put away to give the graphics card back:
   * eyes closed, head down, breathing slowly. Waking is a small start, then herself again.
   */
  setAsleep(asleep: boolean): void {
    if (asleep === this.asleep) return;
    this.asleep = asleep;
    if (!asleep) this.startle = 1;
    this.stir();
  }

  /** Makes one short movement: a nod, a shake of the head, a little bounce, a wave. */
  play(kind: Gesture): void {
    this.gesture = { kind, startedAt: this.clock };
    this.livelyUntil = performance.now() + GESTURES[kind] * 1000 + LIVELY_FOR_MS;
  }

  /** Applies paralinguistic posture hints from native S2S audio analysis. */
  setParalinguisticPosture(hint: {
    leanForward: number;
    headTiltDeg: number;
    energyScale: number;
  }): void {
    this.paralinguisticTarget = {
      leanForward: Math.max(-1, Math.min(1, hint.leanForward)),
      headTiltDeg: Math.max(-12, Math.min(12, hint.headTiltDeg)),
      energyScale: Math.max(0.6, Math.min(1.6, hint.energyScale)),
    };
    this.stir();
  }

  /** Applies custom mmdStandard/mmdOutline shader presets from a signed character `.bundle`. */
  applyShaderPreset(preset: {
    outlineWidth?: number;
    outlineColor?: string;
    specularScale?: number;
  }): void {
    this.rig?.vrmRig?.applyShaderPreset(preset);
    for (const mat of this.scene.materials) {
      const mmdMat = mat as unknown as {
        outlineWidth?: number;
        outlineColor?: Color3;
        specularPower?: number;
      };
      if (typeof preset.outlineWidth === "number" && typeof mmdMat.outlineWidth === "number") {
        mmdMat.outlineWidth = preset.outlineWidth;
      }
      if (preset.outlineColor && mmdMat.outlineColor instanceof Color3) {
        mmdMat.outlineColor = Color3.FromHexString(preset.outlineColor);
      }
      if (typeof preset.specularScale === "number" && typeof mmdMat.specularPower === "number") {
        mmdMat.specularPower = Math.max(1, 32 * preset.specularScale);
      }
    }
    this.stir();
  }

  /** Applies idle breathing and speech gesture scale presets from a character `.bundle`. */
  applyAnimationPreset(preset: {
    breathingAmplitude?: number;
    talkGestureScale?: number;
  }): void {
    if (typeof preset.breathingAmplitude === "number") {
      this.breathingScale = Math.max(0.2, Math.min(2, preset.breathingAmplitude));
    }
    if (typeof preset.talkGestureScale === "number") {
      this.talkGestureScale = Math.max(0.2, Math.min(2, preset.talkGestureScale));
    }
    this.stir();
  }

  /** Removes the current model, if any. */
  clearModel(): void {
    this.loadToken += 1;
    const rig = this.rig;
    this.rig = null;
    if (!rig) return;
    if (rig.kind === "mmd" && rig.mmdModel) {
      this.mmdRuntime.destroyMmdModel(rig.mmdModel);
    }
    rig.dispose();
  }

  /** Loads an MMD (`.pmx`/`.pmd`) or VRM 1.0/0.x (`.vrm`) avatar. */
  async loadModel(url: string): Promise<boolean> {
    this.clearModel();
    const token = this.loadToken;
    const cleanUrl = url.split("?")[0]?.toLowerCase() ?? "";

    if (cleanUrl.endsWith(".vrm") || cleanUrl.endsWith(".glb")) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load VRM model (${response.status}).`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (token !== this.loadToken) return false;

      const vrmRig = await loadVrmIntoScene(this.scene, bytes, "avatar");
      if (token !== this.loadToken) {
        vrmRig.dispose();
        return false;
      }

      const morphNames = vrmRig.expressionNames;
      const vrmViseme = (key: VowelViseme): string | null =>
        VRM_VISEME_CANDIDATES[key].find((name) => morphNames.has(name)) ?? null;

      const VRM_BONE_MAP: Record<RigBoneKey, readonly string[]> = {
        hips: ["hips"],
        upper: ["chest", "upperChest", "spine"],
        neck: ["neck"],
        head: ["head"],
        eyes: [],
        leftEye: ["leftEye"],
        rightEye: ["rightEye"],
        leftShoulder: ["leftShoulder"],
        rightShoulder: ["rightShoulder"],
        leftArm: ["leftUpperArm"],
        rightArm: ["rightUpperArm"],
        leftElbow: ["leftLowerArm"],
        rightElbow: ["rightLowerArm"],
      };

      this.rig = {
        kind: "vrm",
        vrmRig,
        morphNames,
        talkMorph: TALK_MORPHS.find((name) => morphNames.has(name)) ?? null,
        visemeMorphs: {
          A: vrmViseme("A"),
          I: vrmViseme("I"),
          U: vrmViseme("U"),
          E: vrmViseme("E"),
          O: vrmViseme("O"),
        },
        visemeWeights: { A: 0, I: 0, U: 0, E: 0, O: 0 },
        setMorphWeight: (name, weight) => vrmRig.setExpression(name, weight),
        setBoneRotation: (boneKey, rotation) => {
          const targetBone = VRM_BONE_MAP[boneKey].find((b) => vrmRig.humanNodes.has(b));
          if (targetBone) vrmRig.setBoneLocalRotation(targetBone, rotation);
        },
        stepPhysics: (dt) => vrmRig.stepSpringBones(dt),
        face: new Map(),
        dispose: () => vrmRig.dispose(),
      };
      this.frameMeshes(vrmRig.meshes);
      console.info(
        `VRM ${vrmRig.meta.specVersion} model loaded (${vrmRig.meta.name}): ${vrmRig.humanNodes.size} humanoid bones, ${morphNames.size} expressions, ${vrmRig.doc.springs.length} spring chains.`,
      );
      return true;
    }

    const container = await LoadAssetContainerAsync(url, this.scene, {
      pluginExtension: cleanUrl.endsWith(".pmd") ? ".pmd" : ".pmx",
      // Passed explicitly: without a builder the loader produces meshes with no materials.
      pluginOptions: { mmdmodel: { materialBuilder: new MmdStandardMaterialBuilder() } },
    });
    if (token !== this.loadToken) {
      container.dispose();
      return false;
    }
    container.addAllToScene();
    const mesh = container.meshes[0] as Mesh | undefined;

    let model: MmdModel;
    try {
      if (!mesh) throw new Error("The model file contains no mesh.");
      try {
        model = this.mmdRuntime.createMmdModel(mesh, {
          materialProxyConstructor: MmdStandardMaterialProxy,
          buildPhysics: this.hasPhysics,
        });
      } catch (error) {
        console.warn(
          "Hair and cloth physics could not be set up for this model; showing it without.",
          error,
        );
        model = this.mmdRuntime.createMmdModel(mesh, {
          materialProxyConstructor: MmdStandardMaterialProxy,
          buildPhysics: false,
        });
      }
    } catch (error) {
      container.dispose();
      throw error;
    }

    const bone = (...names: string[]): IMmdRuntimeLinkedBone | null => {
      for (const name of names) {
        const found = model.runtimeBones.find((candidate) => candidate.name === name);
        if (found) return found.linkedBone;
      }
      return null;
    };
    const mmdBones: Record<RigBoneKey, IMmdRuntimeLinkedBone | null> = {
      hips: bone("腰", "センター"),
      upper: bone("上半身"),
      neck: bone("首"),
      head: bone("頭"),
      eyes: bone("両目"),
      leftEye: bone("左目"),
      rightEye: bone("右目"),
      leftShoulder: bone("左肩"),
      rightShoulder: bone("右肩"),
      leftArm: bone("左腕"),
      rightArm: bone("右腕"),
      leftElbow: bone("左ひじ"),
      rightElbow: bone("右ひじ"),
    };
    const morphNames = new Set(model.morph.morphs.map((morph) => morph.name));
    const visemeMorph = (key: VowelViseme): string | null =>
      VISEME_MORPH_CANDIDATES[key].find((name) => morphNames.has(name)) ?? null;
    this.rig = {
      kind: "mmd",
      mmdModel: model,
      morphNames,
      talkMorph: TALK_MORPHS.find((name) => morphNames.has(name)) ?? null,
      visemeMorphs: {
        A: visemeMorph("A"),
        I: visemeMorph("I"),
        U: visemeMorph("U"),
        E: visemeMorph("E"),
        O: visemeMorph("O"),
      },
      visemeWeights: { A: 0, I: 0, U: 0, E: 0, O: 0 },
      setMorphWeight: (name, weight) => model.morph.setMorphWeight(name, weight),
      setBoneRotation: (boneKey, rotation) => {
        const b = mmdBones[boneKey];
        if (b) b.rotationQuaternion = rotation;
      },
      stepPhysics: () => undefined,
      face: new Map(),
      dispose: () => container.dispose(),
    };
    this.frameMeshes([mesh, ...mesh.getChildMeshes()]);
    console.info(
      `Model loaded: ${model.runtimeBones.length} bones, ${morphNames.size} morphs, physics ${this.hasPhysics ? "on" : "off"}.`,
      `Face morphs available: ${[...morphNames].join(" ")}`,
    );
    return true;
  }

  /** Developer aid: scene numbers plus a picture of the canvas as it is right now. */
  debugSnapshot(): { info: Record<string, unknown>; image: string } {
    this.engine.beginFrame();
    this.scene.render();
    this.engine.endFrame();
    const image = this.canvas.toDataURL("image/png");
    return {
      image,
      info: {
        canvas: [this.canvas.width, this.canvas.height],
        cameraPosition: this.camera.position.asArray(),
        cameraTarget: this.camera.getTarget().asArray(),
        meshes: this.scene.meshes.length,
        activeMeshes: this.scene.getActiveMeshes().length,
        materials: this.scene.materials.length,
        texturesReady: this.scene.textures.filter((texture) => texture.isReady()).length,
        textures: this.scene.textures.length,
        multiMaterials: this.scene.multiMaterials.length,
        activeCamera: this.scene.activeCamera?.name ?? null,
        sample: this.scene.meshes.slice(0, 6).map((mesh) => ({
          name: mesh.name,
          cls: mesh.getClassName(),
          material: mesh.material ? `${mesh.material.getClassName()}:${mesh.material.name}` : null,
          materialReady: mesh.material?.isReady(mesh) ?? null,
          alpha: mesh.material?.alpha ?? null,
          visible: mesh.isVisible,
          enabled: mesh.isEnabled(),
          vertices: mesh.getTotalVertices(),
          subMeshes: mesh.subMeshes?.length ?? 0,
          ready: mesh.isReady(),
          abs: mesh.getAbsolutePosition().asArray(),
        })),
      },
    };
  }

  /** Points the camera so the whole figure fills the canvas with a little headroom. */
  private frameMeshes(parts: readonly { getVerticesData(kind: string): unknown }[]): void {
    let bottom = Infinity;
    let top = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (const part of parts) {
      const positions = part.getVerticesData(VertexBuffer.PositionKind) as ArrayLike<number> | null;
      if (!positions) continue;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i] ?? 0;
        const y = positions[i + 1] ?? 0;
        if (y < bottom) bottom = y;
        if (y > top) top = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (!Number.isFinite(bottom) || !Number.isFinite(top)) {
      bottom = 0;
      top = 20;
      left = -5;
      right = 5;
    }
    const height = Math.max(1, top - bottom);
    const centerX = (left + right) / 2;
    const centerY = bottom + height / 2;
    const distance = (height * 0.56) / Math.tan(this.camera.fov / 2);
    this.camera.position = new Vector3(centerX, centerY, -distance);
    this.camera.setTarget(new Vector3(centerX, centerY, 0));
    this.camera.maxZ = distance * 3;
  }

  private animate(): void {
    const dt = Math.min(0.1, this.engine.getDeltaTime() / 1000);
    this.clock += dt;
    const rig = this.rig;
    if (!rig) return;
    const t = this.clock;

    // --- face ---------------------------------------------------------------
    const targets = new Map<string, number>();
    const mood: Mood = this.thinking && this.mood === "neutral" ? "thinking" : this.mood;
    for (const [names, weight] of MOOD_FACES[mood]) {
      const name = names.find((candidate) => rig.morphNames.has(candidate));
      if (name) targets.set(name, weight);
    }
    for (const name of new Set([...rig.face.keys(), ...targets.keys()])) {
      const next = approach(rig.face.get(name) ?? 0, targets.get(name) ?? 0, 7, dt);
      if (next < 0.002 && !targets.has(name)) {
        rig.face.delete(name);
        rig.setMorphWeight(name, 0);
      } else {
        rig.face.set(name, next);
      }
    }

    this.sleep = approach(this.sleep, this.asleep ? 1 : 0, this.asleep ? 1.2 : 5, dt);
    this.attention = approach(this.attention, this.listening && !this.asleep ? 1 : 0, 5, dt);
    this.startle = approach(this.startle, 0, 2.5, dt);

    // One-off mocap-inspired conversation gestures across 10 curated shapes.
    let motion: GestureMotionSample = {
      nod: 0,
      shake: 0,
      perk: 0,
      wave: 0,
      waveSwing: 0,
      think: 0,
      point: 0,
      shrug: 0,
      salute: 0,
      cheer: 0,
      bow: 0,
    };
    if (this.gesture) {
      const phase = (t - this.gesture.startedAt) / GESTURES[this.gesture.kind];
      if (phase >= 1) this.gesture = null;
      else motion = evaluateGestureMotion(this.gesture.kind, phase);
    }

    if (this.blinkStartedAt < 0 && t >= this.nextBlinkAt) this.blinkStartedAt = t;
    let blink = 0;
    if (this.blinkStartedAt >= 0) {
      const phase = (t - this.blinkStartedAt) / 0.2;
      if (phase >= 1) {
        this.blinkStartedAt = -1;
        this.nextBlinkAt = t + 1.8 + Math.random() * 4.2;
      } else {
        blink = Math.sin(phase * Math.PI);
      }
    }

    this.talkLevel = approach(this.talkLevel, t < this.talkUntil ? 1 : 0, 14, dt);
    let targetVisemes: VisemeWeights = { A: 0, I: 0, U: 0, E: 0, O: 0 };
    if (this.visemeTrack) {
      const elapsedMs = Math.max(0, performance.now() - this.visemeTrack.startedAtMs);
      if (elapsedMs > this.visemeTrack.totalDurationMs + 150) {
        this.visemeTrack = null;
      } else {
        targetVisemes = sampleVisemeWeights(this.visemeTrack.frames, elapsedMs);
      }
    }
    const visemeKeys: readonly VowelViseme[] = ["A", "I", "U", "E", "O"];
    for (const key of visemeKeys) {
      rig.visemeWeights[key] = approach(rig.visemeWeights[key], targetVisemes[key], 28, dt);
    }
    const visemesDriving =
      this.visemeTrack !== null ||
      visemeKeys.some((key) => rig.visemeWeights[key] > 0.015);

    const wanted =
      this.voiceLevel !== null
        ? this.voiceLevel * 0.75
        : this.talkLevel * (0.2 + 0.4 * Math.abs(Math.sin(t * 13.5) * Math.sin(t * 5.1 + 1)));
    this.mouthOpen = approach(this.mouthOpen, wanted, 30, dt);
    const mouth = this.mouthOpen;

    const applied = new Map(rig.face);
    const blinkMorph = BLINK_MORPHS.find((name) => rig.morphNames.has(name));
    if (blinkMorph) {
      applied.set(blinkMorph, Math.max(applied.get(blinkMorph) ?? 0, blink, this.sleep));
    }
    const browUp = BROW_UP_MORPHS.find((name) => rig.morphNames.has(name));
    if (browUp && this.attention > 0.01) {
      applied.set(browUp, Math.max(applied.get(browUp) ?? 0, this.attention * 0.3));
    }
    const surprise = SURPRISE_MORPHS.find((name) => rig.morphNames.has(name));
    if (surprise && this.startle > 0.02) {
      applied.set(surprise, Math.max(applied.get(surprise) ?? 0, this.startle * 0.7));
    } else if (surprise && !rig.face.has(surprise)) {
      applied.set(surprise, 0);
    }
    if (browUp && this.attention <= 0.01 && !rig.face.has(browUp)) applied.set(browUp, 0);
    if (visemesDriving) {
      for (const key of visemeKeys) {
        const morphName = rig.visemeMorphs[key];
        if (!morphName) continue;
        applied.set(morphName, Math.max(applied.get(morphName) ?? 0, rig.visemeWeights[key]));
      }
    } else {
      for (const key of visemeKeys) {
        const morphName = rig.visemeMorphs[key];
        if (morphName && !rig.face.has(morphName)) applied.set(morphName, 0);
      }
      if (rig.talkMorph) applied.set(rig.talkMorph, Math.max(applied.get(rig.talkMorph) ?? 0, mouth));
    }
    for (const [name, weight] of applied) rig.setMorphWeight(name, weight);

    // --- body + procedural idle polish -------------------------------------
    const awake = 1 - this.sleep;
    if (t >= this.nextSaccadeAt) {
      this.nextSaccadeAt = t + 2.1 + Math.random() * 2.8;
      this.saccadeTarget = {
        x: (Math.random() - 0.5) * 0.32,
        y: (Math.random() - 0.5) * 0.18,
      };
    }
    this.saccade.x = approach(this.saccade.x, this.saccadeTarget.x * awake, 14, dt);
    this.saccade.y = approach(this.saccade.y, this.saccadeTarget.y * awake, 14, dt);

    this.gaze.x = approach(this.gaze.x, this.gazeTarget.x * awake, 4, dt);
    this.gaze.y = approach(this.gaze.y, this.gazeTarget.y * awake, 4, dt);
    this.dockFacingDeg = approach(this.dockFacingDeg, this.dockFacingDegTarget * awake, 3, dt);
    this.tilt = approach(this.tilt, mood === "thinking" ? 1 : 0, 3, dt);
    this.lookUp = approach(this.lookUp, mood === "thinking" ? 1 : mood === "sad" ? -1 : 0, 3, dt);

    this.paralinguistic.leanForward = approach(
      this.paralinguistic.leanForward,
      this.paralinguisticTarget.leanForward,
      4,
      dt,
    );
    this.paralinguistic.headTiltDeg = approach(
      this.paralinguistic.headTiltDeg,
      this.paralinguisticTarget.headTiltDeg,
      4,
      dt,
    );
    this.paralinguistic.energyScale = approach(
      this.paralinguistic.energyScale,
      this.paralinguisticTarget.energyScale,
      4,
      dt,
    );
    const breath =
      Math.sin(t * (1.7 - 0.8 * this.sleep)) *
      (1 + 0.8 * this.sleep) *
      this.breathingScale *
      this.paralinguistic.energyScale;
    const sway = Math.sin(t * 0.53) * awake * this.talkGestureScale;
    const weightShift = Math.sin(t * 0.37 + 0.6) * 1.4 * awake;
    const drift = Math.sin(t * 0.31 + 1.3) * awake;
    const listenNod = this.attention * Math.sin(t * 3.1) * 1.6;
    const lean =
      -this.attention * 3 -
      this.paralinguistic.leanForward * 4 * awake +
      motion.perk * 2 -
      motion.bow * 22 -
      this.sleep * 4;

    const eyeRotation = Quaternion.RotationYawPitchRoll(
      (this.gaze.x * 8 + this.saccade.x * 5) * DEG * awake,
      (this.gaze.y * 6 + this.saccade.y * 4) * DEG * awake,
      0,
    );
    rig.setBoneRotation("eyes", eyeRotation);
    rig.setBoneRotation("leftEye", eyeRotation.clone());
    rig.setBoneRotation("rightEye", eyeRotation.clone());

    rig.setBoneRotation(
      "hips",
      Quaternion.RotationYawPitchRoll(weightShift * 0.9 * DEG, 0, weightShift * 0.7 * DEG),
    );
    rig.setBoneRotation(
      "upper",
      Quaternion.RotationYawPitchRoll(
        (sway * 1.2 + this.gaze.x * 3 + this.dockFacingDeg * 0.45) * DEG - motion.point * 7 * DEG,
        breath * 0.75 * DEG + lean * DEG,
        drift * 0.8 * DEG - weightShift * 0.5 * DEG,
      ),
    );
    rig.setBoneRotation(
      "neck",
      Quaternion.RotationYawPitchRoll(
        (this.gaze.x * 6 + this.dockFacingDeg * 0.25) * DEG,
        this.gaze.y * 3 * DEG - motion.bow * 6 * DEG,
        0,
      ),
    );
    rig.setBoneRotation(
      "head",
      Quaternion.RotationYawPitchRoll(
        this.gaze.x * 10 * DEG + sway * 1.5 * DEG + motion.shake * 12 * DEG + motion.think * 6 * DEG,
        this.gaze.y * 7 * DEG +
          this.lookUp * 6 * DEG * awake -
          breath * 0.5 * DEG -
          (motion.nod * 9 + listenNod + motion.bow * 14) * DEG -
          this.sleep * 20 * DEG +
          this.startle * 6 * DEG,
        this.tilt * 9 * DEG * awake +
          this.paralinguistic.headTiltDeg * DEG * awake +
          drift * 1.5 * DEG +
          this.attention * 5 * DEG +
          motion.think * 11 * DEG +
          motion.shrug * 7 * DEG +
          this.sleep * 6 * DEG,
      ),
    );

    const shoulderBreath = breath * 1.1 * DEG + motion.shrug * 14 * DEG;
    rig.setBoneRotation("leftShoulder", Quaternion.RotationYawPitchRoll(0, 0, shoulderBreath));
    rig.setBoneRotation("rightShoulder", Quaternion.RotationYawPitchRoll(0, 0, -shoulderBreath));

    const armDrop = 36 * DEG + breath * 0.6 * DEG - motion.perk * 7 * DEG - motion.shrug * 12 * DEG;
    const elbowForward = 14 * DEG + breath * 0.8 * DEG;
    const elbowIn = 8 * DEG;
    const rightBusy = Math.max(motion.wave, motion.think, motion.point, motion.salute, motion.cheer, motion.shrug);
    const leftBusy = Math.max(motion.cheer, motion.shrug);
    const rightEase = 1 - rightBusy;
    const leftEase = 1 - leftBusy;

    rig.setBoneRotation(
      "leftArm",
      Quaternion.RotationYawPitchRoll(
        motion.cheer * 14 * DEG,
        0,
        -armDrop + motion.cheer * 78 * DEG - motion.shrug * 10 * DEG,
      ),
    );
    rig.setBoneRotation(
      "leftElbow",
      Quaternion.RotationYawPitchRoll(
        elbowForward * leftEase,
        0,
        -elbowIn * leftEase + motion.cheer * (58 - motion.waveSwing * 22) * DEG - motion.shrug * 35 * DEG,
      ),
    );

    rig.setBoneRotation(
      "rightArm",
      Quaternion.RotationYawPitchRoll(
        (motion.wave * -15 + motion.point * -32 + motion.think * -24 + motion.salute * -28 + motion.cheer * -14) * DEG,
        motion.point * -38 * DEG,
        armDrop - (motion.wave * 86 + motion.cheer * 78 + motion.salute * 68 + motion.think * 42 + motion.point * 44) * DEG,
      ),
    );
    rig.setBoneRotation(
      "rightElbow",
      Quaternion.RotationYawPitchRoll(
        -elbowForward * rightEase,
        0,
        elbowIn * rightEase +
          (motion.wave * (-70 + motion.waveSwing * 28) +
            motion.cheer * (-58 + motion.waveSwing * 22) +
            motion.salute * -105 +
            motion.think * -92 +
            motion.point * 6 +
            motion.shrug * 35) *
            DEG,
      ),
    );

    rig.stepPhysics(dt);
  }

  dispose(): void {
    this.stopWebcamPresence();
    this.disposeRoomScene();
    this.clearModel();
    if (this.frameRequest !== 0) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = 0;
    }
    this.engine.dispose();
  }
}
