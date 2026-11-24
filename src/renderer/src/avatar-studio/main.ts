import "./style.css";
import type { Config } from "../../../core/config.ts";
import {
  computeAudioVisualizerProp,
  computeThermalCrystalProp,
  computeTimerRingProp,
  computeWebcamParallaxOffset,
} from "../../../shared/spatialStage.ts";
import type {
  AvatarFramingEntryView,
  AvatarStudioSnapshot,
  StudioToolsBridge,
} from "../../../shared/studioTools.ts";
import { StageLightingController } from "../stageLighting.ts";
import { VrmaStageBridge } from "../vrmaStageBridge.ts";

declare global {
  interface Window {
    studioTools: StudioToolsBridge;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function requireEl<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing Avatar Studio DOM element #${id}.`);
  return found as T;
}

const subtitleEl = requireEl<HTMLElement>("studio-subtitle");
const statusEl = requireEl<HTMLElement>("studio-status");
const saveBtn = requireEl<HTMLButtonElement>("studio-save");
const canvas = requireEl<HTMLCanvasElement>("studio-canvas");
const readoutEl = requireEl<HTMLElement>("prop-readout");
const controlsRoot = requireEl<HTMLElement>("studio-controls");
const gestureButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-gesture]"),
);

const lighting = new StageLightingController({ smoothingAlpha: 0.25, screenStrength: 0.45 });
const stageBridge = new VrmaStageBridge();

let snapshot: AvatarStudioSnapshot | null = null;
let framing: AvatarFramingEntryView = {
  modelHash: "default00",
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rimLight: 1,
  outlineThickness: 1,
};
let windowMode: Config["windowMode"] = "floating";
let lowPowerStage = false;
let simulatedHour = 19;
let screenHueR = 72;
let screenHueG = 148;
let screenHueB = 225;
let gazeX = 0;
let gazeY = 0;
let gpuTempC = 64;
let lastTick = performance.now();
let animSec = 0;

for (const btn of gestureButtons) {
  btn.addEventListener("click", () => {
    const gesture = btn.dataset.gesture;
    if (gesture === "wave" || gesture === "nod" || gesture === "shrug") {
      stageBridge.triggerGesture(gesture);
      statusEl.textContent = `Triggered ${gesture} cue in stage preview.`;
    }
  });
}

canvas.addEventListener("mousemove", (ev) => {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  gazeX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  gazeY = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
  stageBridge.lookAtNormalized(gazeX, gazeY);
});

function addRangeControl(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
): void {
  const wrap = el("div", "field");
  const lab = el("label");
  const titleSpan = el("span", undefined, label);
  const valSpan = el("span", undefined, format(value));
  lab.append(titleSpan, valSpan);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    const next = Number(input.value);
    valSpan.textContent = format(next);
    onChange(next);
  });

  wrap.append(lab, input);
  parent.append(wrap);
}

function renderControls(): void {
  controlsRoot.replaceChildren();

  const modeField = el("div", "field");
  modeField.append(el("label", undefined, "Desktop Window Presentation"));
  const modeSelect = document.createElement("select");
  for (const [val, text] of [
    ["floating", "Floating Transparent Overlay"],
    ["solid-docked", "Solid Docked Window"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    opt.selected = windowMode === val;
    modeSelect.append(opt);
  }
  modeSelect.addEventListener("change", () => {
    windowMode = modeSelect.value === "solid-docked" ? "solid-docked" : "floating";
  });
  modeField.append(modeSelect);
  controlsRoot.append(modeField);

  const lowPowerRow = el("div", "toggle-row");
  const lowPowerText = el("span", undefined, "Low-Power Stage Cap (Battery / VM Friendly)");
  const lowPowerChk = document.createElement("input");
  lowPowerChk.type = "checkbox";
  lowPowerChk.checked = lowPowerStage;
  lowPowerChk.addEventListener("change", () => {
    lowPowerStage = lowPowerChk.checked;
  });
  lowPowerRow.append(lowPowerText, lowPowerChk);
  controlsRoot.append(lowPowerRow);

  addRangeControl(
    controlsRoot,
    "Framing Scale",
    0.45,
    2.2,
    0.02,
    framing.scale,
    (v) => `${v.toFixed(2)}x`,
    (v) => {
      framing.scale = v;
    },
  );
  addRangeControl(
    controlsRoot,
    "Vertical Offset",
    -0.6,
    0.6,
    0.02,
    framing.offsetY,
    (v) => v.toFixed(2),
    (v) => {
      framing.offsetY = v;
    },
  );
  addRangeControl(
    controlsRoot,
    "Rim Light Intensity",
    0.4,
    1.8,
    0.05,
    framing.rimLight,
    (v) => v.toFixed(2),
    (v) => {
      framing.rimLight = v;
    },
  );
  addRangeControl(
    controlsRoot,
    "Toon Outline Thickness",
    0,
    2.5,
    0.05,
    framing.outlineThickness,
    (v) => v.toFixed(2),
    (v) => {
      framing.outlineThickness = v;
    },
  );
  addRangeControl(
    controlsRoot,
    "Simulated Time of Day",
    0,
    23,
    1,
    simulatedHour,
    (v) => `${String(Math.round(v)).padStart(2, "0")}:00`,
    (v) => {
      simulatedHour = Math.round(v);
    },
  );
  addRangeControl(
    controlsRoot,
    "Simulated GPU Temp (Thermal Crystal Prop)",
    40,
    90,
    1,
    gpuTempC,
    (v) => `${Math.round(v)} °C`,
    (v) => {
      gpuTempC = Math.round(v);
    },
  );

  const tintField = el("div", "field");
  tintField.append(el("label", undefined, "Screen-Edge Ambient Palette"));
  const tintSelect = document.createElement("select");
  for (const [val, label] of [
    ["72,148,225", "Cool IDE Teal/Blue"],
    ["235,155,72", "Warm Sunset / Game Torch"],
    ["40,46,62", "Dark Midnight Terminal"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    tintSelect.append(opt);
  }
  tintSelect.addEventListener("change", () => {
    const parts = tintSelect.value.split(",").map((x) => Number(x));
    screenHueR = parts[0] ?? 72;
    screenHueG = parts[1] ?? 148;
    screenHueB = parts[2] ?? 225;
  });
  tintField.append(tintSelect);
  controlsRoot.append(tintField);
}

function drawPreview(nowMs: number): void {
  const dtSec = Math.min(0.1, Math.max(0.004, (nowMs - lastTick) / 1000));
  lastTick = nowMs;
  animSec += dtSec;

  const ctx = canvas.getContext("2d");
  if (ctx) {
    const w = canvas.width;
    const h = canvas.height;
    const simDate = new Date(2026, 10, 23, simulatedHour, 15, 0);
    const edgePixels = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i += 1) {
      edgePixels[i * 4] = screenHueR;
      edgePixels[i * 4 + 1] = screenHueG;
      edgePixels[i * 4 + 2] = screenHueB;
      edgePixels[i * 4 + 3] = 255;
    }

    const lightState = lighting.step({
      now: simDate,
      edgePixels,
      width: 8,
      height: 8,
      channels: 4,
    });
    const pose = stageBridge.step(dtSec);
    const parallax = computeWebcamParallaxOffset({ x: gazeX, y: gazeY });

    const bgGrad = ctx.createRadialGradient(
      w * 0.5 + parallax.offsetX * 140,
      h * 0.42 - parallax.offsetY * 140,
      30,
      w * 0.5,
      h * 0.5,
      w * 0.72,
    );
    const r = Math.round(lightState.skyColor[0] * 255);
    const g = Math.round(lightState.skyColor[1] * 255);
    const b = Math.round(lightState.skyColor[2] * 255);
    bgGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.42)`);
    bgGrad.addColorStop(1, "#090e1a");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Stylized embodied silhouette reacting live to scale, offsetY, rim light, and pose breath/tilt
    const cx = w * 0.5 + framing.offsetX * 120 + pose.hipsOffset[0] * 100 + parallax.offsetX * 80;
    const cy = h * 0.58 - framing.offsetY * 120 - pose.hipsOffset[1] * 100;
    const s = framing.scale;
    const tiltRad = (pose.eyeYawDeg * 0.12 * Math.PI) / 180;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tiltRad);
    ctx.scale(s, s);

    // Rim highlight halo
    ctx.lineWidth = Math.max(1, framing.outlineThickness * 2.2);
    ctx.strokeStyle = `rgba(${Math.round(lightState.sunColor[0] * 255)}, ${Math.round(lightState.sunColor[1] * 255)}, ${Math.round(lightState.sunColor[2] * 255)}, ${Math.min(1, 0.35 * framing.rimLight)})`;
    ctx.fillStyle = "#1e293b";

    // Torso
    ctx.beginPath();
    ctx.roundRect(-42, 12, 84, 118, 22);
    ctx.fill();
    ctx.stroke();

    // Head + eye gaze indicators
    ctx.beginPath();
    ctx.arc(0, -34, 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const eyeDx = (pose.eyeYawDeg / 36) * 8;
    const eyeDy = -(pose.eyePitchDeg / 22) * 5;
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(-14 + eyeDx, -36 + eyeDy, 4.5, 0, Math.PI * 2);
    ctx.arc(14 + eyeDx, -36 + eyeDy, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Holographic desk props preview
    const remSec = 45 - (animSec % 45);
    const timerProp = computeTimerRingProp({ enabled: true, totalSec: 45, remainingSec: remSec });
    const samples = Array.from({ length: 32 }, (_, idx) =>
      Math.abs(Math.sin(animSec * 4.5 + idx * 0.4)) * 0.32,
    );
    const audioProp = computeAudioVisualizerProp({ enabled: true, samples, barCount: 8 });
    const crystalProp = computeThermalCrystalProp({
      enabled: true,
      gpu: {
        tempC: gpuTempC,
        vramUsedMb: 9200,
        vramTotalMb: 20480,
        throttled: gpuTempC >= 82,
      },
    });

    // Timer arc
    if (timerProp.visible) {
      ctx.beginPath();
      ctx.arc(64, 68, 28, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * timerProp.progress);
      ctx.lineWidth = 5;
      ctx.strokeStyle = timerProp.colorHex;
      ctx.stroke();
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "12px monospace";
      ctx.fillText(`${timerProp.remainingSec}s`, 51, 72);
    }

    // Audio equalizer bars
    if (audioProp.visible) {
      audioProp.bars.forEach((bar, i) => {
        const bx = w - 132 + i * 13;
        const bh = Math.max(4, bar * 54);
        ctx.fillStyle = "#38bdf8";
        ctx.fillRect(bx, h - 24 - bh, 8, bh);
      });
    }

    // Thermal Crystal diamond
    if (crystalProp.visible) {
      ctx.save();
      ctx.translate(w - 58, 66);
      ctx.fillStyle = crystalProp.colorHex;
      ctx.beginPath();
      ctx.moveTo(0, -20);
      ctx.lineTo(15, 0);
      ctx.lineTo(0, 20);
      ctx.lineTo(-15, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    readoutEl.textContent =
      `Lighting=${lightState.period} | Parallax yaw=${parallax.yawDeg}° | ` +
      `Eye=(${pose.eyeYawDeg.toFixed(1)}°, ${pose.eyePitchDeg.toFixed(1)}°) | ` +
      `Crystal=${crystalProp.status} (${gpuTempC}°C)`;
  }

  requestAnimationFrame(drawPreview);
}

saveBtn.addEventListener("click", async () => {
  const res = await window.studioTools.updateAvatarStudioConfig({
    windowMode,
    lowPowerStage,
    framing,
  });
  statusEl.textContent = res.message;
});

async function loadInitial(): Promise<void> {
  try {
    snapshot = await window.studioTools.getAvatarStudioSnapshot();
    windowMode = snapshot.windowMode;
    lowPowerStage = snapshot.lowPowerStage;
    const active = snapshot.framings[0];
    if (active) framing = { ...active };
    subtitleEl.textContent =
      `Mode: ${snapshot.windowMode} · Bundle: ${snapshot.characterBundle ?? "Built-in"} · ` +
      `Tracked models: ${snapshot.framings.length}`;
    renderControls();
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

void loadInitial();
requestAnimationFrame(drawPreview);
