import type { Config } from "../../../core/config.ts";
import { LayeredSpriteRigManifestSchema } from "../../../shared/avatar2d.ts";
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
import { Canvas2DAvatarRenderer } from "../canvas2dStage.ts";
import { StageLightingController } from "../stageLighting.ts";
import { VrmaStageBridge } from "../vrmaStageBridge.ts";
import { el } from "./dom.ts";

/** Manages the Avatar Studio panel with an explicit pause/resume lifecycle for Chromium savings. */
export function createWorkbenchAvatarPanel(
  container: HTMLElement,
  studio: StudioToolsBridge,
  setStatus: (msg: string) => void,
): {
  update(snapshot: AvatarStudioSnapshot): void;
  setActive(active: boolean): void;
} {
  const lighting = new StageLightingController({ smoothingAlpha: 0.25, screenStrength: 0.45 });
  const stageBridge = new VrmaStageBridge();
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
  let gpuTempC = 64;
  let gazeX = 0;
  let gazeY = 0;
  let animSec = 0;
  let lastTick = performance.now();
  let rafId = 0;
  let isActive = false;

  const grid = el("div", "studio-grid");
  const leftCard = el("div", "card");
  const head = el("div", "card-header");
  head.append(el("h2", undefined, "Live Stage Preview (Ambient Lighting + Props)"));
  const gestureRow = el("div", "btn-row");
  for (const g of ["wave", "nod", "shrug"] as const) {
    const label = g.charAt(0).toUpperCase() + g.slice(1);
    const b = el("button", undefined, label);
    b.type = "button";
    b.addEventListener("click", () => {
      stageBridge.triggerGesture(g);
      setStatus(`Triggered ${g} preview cue.`);
    });
    gestureRow.append(b);
  }
  head.append(gestureRow);

  const canvas = document.createElement("canvas");
  canvas.className = "studio-canvas";
  canvas.width = 500;
  canvas.height = 380;
  const readout = el("div", "mono-readout", "Idle preview");
  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    gazeX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    gazeY = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    stageBridge.lookAtNormalized(gazeX, gazeY);
  });
  leftCard.append(head, canvas, readout);

  const rightCard = el("div", "card stack");
  rightCard.append(el("h2", undefined, "Stage Lighting, Framing & Performance"));
  const controls = el("div", "stack");
  const saveBtn = el("button", "btn-primary", "Save Stage Settings");
  saveBtn.type = "button";
  saveBtn.addEventListener("click", async () => {
    const res = await studio.updateAvatarStudioConfig({ windowMode, lowPowerStage, framing });
    setStatus(res.message);
  });
  rightCard.append(controls, saveBtn);

  const spriteCard = el("div", "card stack");
  spriteCard.append(el("h2", undefined, "2D Layered Sprite Rig Check (`astral-midnight`)"));
  const spriteControls = el("div", "btn-row");
  const loadSpriteBtn = el("button", undefined, "Load & Render 2D Sprite Rig");
  loadSpriteBtn.type = "button";
  loadSpriteBtn.dataset.action = "load-avatar2d-rig";
  const spriteStatus = el("span", "muted", "Click to verify packaged 2D sprite overlay.");
  spriteStatus.dataset.testid = "avatar2d-status";
  spriteControls.append(loadSpriteBtn, spriteStatus);

  const spriteCanvas = document.createElement("canvas");
  spriteCanvas.dataset.testid = "avatar2d-canvas";
  spriteCanvas.width = 512;
  spriteCanvas.height = 512;
  spriteCanvas.style.width = "256px";
  spriteCanvas.style.height = "256px";
  spriteCanvas.style.borderRadius = "8px";
  spriteCanvas.style.border = "1px solid var(--border)";

  loadSpriteBtn.addEventListener("click", async () => {
    loadSpriteBtn.disabled = true;
    spriteStatus.textContent = "Loading 2D sprite rig…";
    try {
      const baseUrl = new URL("./avatar2d/astral-midnight/", window.location.href);
      const rigRes = await fetch(new URL("rig.json", baseUrl).toString());
      if (!rigRes.ok) {
        spriteStatus.textContent = "Supporter 2D sprite rig not installed (optional overlay).";
        return;
      }
      const parsed = LayeredSpriteRigManifestSchema.safeParse((await rigRes.json()) as unknown);
      if (!parsed.success) {
        spriteStatus.textContent = "Invalid 2D rig manifest.";
        return;
      }
      const needed = new Set<string>(parsed.data.layers.map((l) => l.asset));
      for (const v of Object.values(parsed.data.visemeAssets)) if (v) needed.add(v);
      if (parsed.data.blinkEyeAsset) needed.add(parsed.data.blinkEyeAsset);
      for (const m of Object.values(parsed.data.moodOverlays)) if (m) needed.add(m);

      const renderer = new Canvas2DAvatarRenderer({
        ctx: spriteCanvas.getContext("2d"),
        loadAsset: (relAsset) =>
          new Promise((resolveImg, rejectImg) => {
            const img = new Image();
            img.onload = () => resolveImg(img);
            img.onerror = () => rejectImg(new Error(`Failed loading 2D sprite: ${relAsset}`));
            img.src = new URL(relAsset, baseUrl).toString();
          }),
      });
      await renderer.load(parsed.data);
      renderer.renderFrame({
        mood: "happy",
        visemes: { A: 0.7, I: 0, U: 0, E: 0, O: 0 },
        blink: 0,
        gazeX: 0.1,
        gazeY: -0.05,
      });
      const msg = `Rendered 2D rig "${parsed.data.name}" (${needed.size} sprites loaded)`;
      spriteStatus.textContent = msg;
      setStatus(msg);
    } catch (error) {
      spriteStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      loadSpriteBtn.disabled = false;
    }
  });

  spriteCard.append(spriteControls, spriteCanvas);
  grid.append(leftCard, rightCard, spriteCard);
  container.replaceChildren(grid);

  function addSlider(
    label: string,
    min: number,
    max: number,
    step: number,
    val: number,
    fmt: (n: number) => string,
    onChange: (n: number) => void,
  ): void {
    const wrap = el("div", "field");
    const lab = el("label");
    const valSpan = el("span", undefined, fmt(val));
    lab.append(el("span", undefined, label), valSpan);
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = String(min);
    inp.max = String(max);
    inp.step = String(step);
    inp.value = String(val);
    inp.addEventListener("input", () => {
      const next = Number(inp.value);
      valSpan.textContent = fmt(next);
      onChange(next);
    });
    wrap.append(lab, inp);
    controls.append(wrap);
  }

  function renderControls(): void {
    controls.replaceChildren();
    const modeField = el("div", "field");
    modeField.append(el("label", undefined, "Window Presentation"));
    const sel = document.createElement("select");
    for (const [v, text] of [
      ["floating", "Floating Transparent Overlay"],
      ["solid-docked", "Solid Docked Window"],
    ] as const) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text;
      o.selected = windowMode === v;
      sel.append(o);
    }
    sel.addEventListener("change", () => {
      windowMode = sel.value === "solid-docked" ? "solid-docked" : "floating";
    });
    modeField.append(sel);
    controls.append(modeField);

    const lowRow = el("div", "toggle-row");
    lowRow.append(el("span", undefined, "Low-Power Stage Cap"));
    const lowChk = document.createElement("input");
    lowChk.type = "checkbox";
    lowChk.checked = lowPowerStage;
    lowChk.addEventListener("change", () => {
      lowPowerStage = lowChk.checked;
    });
    lowRow.append(lowChk);
    controls.append(lowRow);

    addSlider("Framing Scale", 0.45, 2.2, 0.02, framing.scale, (v) => `${v.toFixed(2)}x`, (v) => {
      framing.scale = v;
    });
    addSlider("Vertical Offset", -0.6, 0.6, 0.02, framing.offsetY, (v) => v.toFixed(2), (v) => {
      framing.offsetY = v;
    });
    addSlider("Rim Light", 0.4, 1.8, 0.05, framing.rimLight, (v) => v.toFixed(2), (v) => {
      framing.rimLight = v;
    });
    addSlider("Simulated Hour", 0, 23, 1, simulatedHour, (v) => `${Math.round(v)}:00`, (v) => {
      simulatedHour = Math.round(v);
    });
    addSlider("Simulated GPU Temp", 40, 90, 1, gpuTempC, (v) => `${Math.round(v)}°C`, (v) => {
      gpuTempC = Math.round(v);
    });
  }

  function tick(nowMs: number): void {
    if (!isActive) {
      rafId = 0;
      return;
    }
    const dtSec = Math.min(0.1, Math.max(0.004, (nowMs - lastTick) / 1000));
    lastTick = nowMs;
    animSec += dtSec;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      const w = canvas.width;
      const h = canvas.height;
      const light = lighting.step({ now: new Date(2026, 10, 23, simulatedHour, 15, 0) });
      const pose = stageBridge.step(dtSec);
      const parallax = computeWebcamParallaxOffset({ x: gazeX, y: gazeY });

      ctx.fillStyle = "#090e1a";
      ctx.fillRect(0, 0, w, h);

      const cx = w * 0.5 + framing.offsetX * 110 + pose.hipsOffset[0] * 90 + parallax.offsetX * 70;
      const cy = h * 0.56 - framing.offsetY * 110 - pose.hipsOffset[1] * 90;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(framing.scale, framing.scale);
      ctx.lineWidth = Math.max(1, framing.outlineThickness * 2);
      ctx.strokeStyle = `rgba(${Math.round(light.sunColor[0] * 255)}, ${Math.round(light.sunColor[1] * 255)}, ${Math.round(light.sunColor[2] * 255)}, ${Math.min(1, 0.4 * framing.rimLight)})`;
      ctx.fillStyle = "#1e293b";
      ctx.beginPath();
      ctx.roundRect(-38, 10, 76, 104, 18);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -30, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      const timer = computeTimerRingProp({
        enabled: true,
        totalSec: 45,
        remainingSec: 45 - (animSec % 45),
      });
      const audio = computeAudioVisualizerProp({
        enabled: true,
        samples: Array.from({ length: 16 }, (_, i) => Math.abs(Math.sin(animSec * 4 + i * 0.4)) * 0.3),
        barCount: 6,
      });
      const crystal = computeThermalCrystalProp({
        enabled: true,
        gpu: { tempC: gpuTempC, vramUsedMb: 9000, vramTotalMb: 20480, throttled: gpuTempC >= 82 },
      });
      if (audio.visible) {
        audio.bars.forEach((b, i) => {
          const bh = Math.max(4, b * 48);
          ctx.fillStyle = "#38bdf8";
          ctx.fillRect(w - 92 + i * 12, h - 20 - bh, 8, bh);
        });
      }
      readout.textContent = `Lighting=${light.period} | Timer=${timer.remainingSec}s | Crystal=${crystal.status} (${gpuTempC}°C)`;
    }
    rafId = requestAnimationFrame(tick);
  }

  renderControls();

  return {
    update(snap: AvatarStudioSnapshot): void {
      windowMode = snap.windowMode;
      lowPowerStage = snap.lowPowerStage;
      if (snap.framings[0]) framing = { ...snap.framings[0] };
      renderControls();
    },
    setActive(active: boolean): void {
      isActive = active;
      if (active && rafId === 0) {
        lastTick = performance.now();
        rafId = requestAnimationFrame(tick);
      } else if (!active && rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },
  };
}
