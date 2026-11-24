import type { Config } from "../../../core/config.ts";
import type { TellWhen } from "../../../core/standingOrders.ts";
import type { MissionControlSnapshot, ReplayInspectResult } from "../../../shared/missionControl.ts";
import {
  computeAudioVisualizerProp,
  computeThermalCrystalProp,
  computeTimerRingProp,
  computeWebcamParallaxOffset,
} from "../../../shared/spatialStage.ts";
import type {
  AvatarFramingEntryView,
  AvatarStudioSnapshot,
  PolicyComposerSnapshot,
  RoomCalibrationReport,
  StandingOrderDraft,
  StudioToolsBridge,
  TurnXrayItem,
  TurnXraySnapshot,
} from "../../../shared/studioTools.ts";
import { renderPolicyReplayPanel } from "../mission-control/policyReplay.ts";
import { StageLightingController } from "../stageLighting.ts";
import { VrmaStageBridge } from "../vrmaStageBridge.ts";

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

/** Renders standing-order builder, experimental flags, plus policy conflict & replay sections. */
export function renderWorkbenchPolicyPanel(
  container: HTMLElement,
  policy: PolicyComposerSnapshot,
  mc: MissionControlSnapshot,
  handlers: {
    studio: StudioToolsBridge;
    setStatus(msg: string): void;
    refresh(): Promise<void>;
    onVerifyPolicies(): Promise<MissionControlSnapshot["policyGraph"]>;
    onCancelOrder(id: string): Promise<void>;
    onSkillAction(id: string, action: "ratify" | "revoke"): Promise<void>;
    onRunReplay(bundlePath?: string): Promise<ReplayInspectResult>;
  },
): void {
  container.replaceChildren();

  const topGrid = el("div", "grid-2");

  // 1. Standing-order draft builder
  const builderCard = el("div", "card");
  builderCard.append(el("h2", undefined, "Standing-Order Rule Builder"));
  const form = el("div", "form-grid");
  const draft: StandingOrderDraft = {
    title: "",
    where: "here",
    command: "",
    address: "",
    tellWhen: "fails",
    value: "",
    everyMinutes: 5,
    repeat: false,
  };

  const titleField = el("div", "field full");
  titleField.append(el("label", undefined, "Rule Title (what she tells you)"));
  const titleInput = document.createElement("input");
  titleInput.placeholder = "e.g., NAS pool health degraded";
  titleInput.addEventListener("input", () => {
    draft.title = titleInput.value;
  });
  titleField.append(titleInput);

  const whereField = el("div", "field");
  whereField.append(el("label", undefined, "Target Machine / Web URL"));
  const whereSelect = document.createElement("select");
  const hereOpt = document.createElement("option");
  hereOpt.value = "here";
  hereOpt.textContent = "This PC (read-only command)";
  whereSelect.append(hereOpt);
  for (const m of policy.machines) {
    const opt = document.createElement("option");
    opt.value = m.name;
    opt.textContent = `${m.name} (${m.user}@${m.host})`;
    whereSelect.append(opt);
  }
  const webOpt = document.createElement("option");
  webOpt.value = "__address__";
  webOpt.textContent = "Local Web Endpoint (http/https)";
  whereSelect.append(webOpt);
  whereField.append(whereSelect);

  const cmdField = el("div", "field full");
  cmdField.append(el("label", undefined, "Read-Only Command or Address"));
  const cmdInput = document.createElement("input");
  cmdInput.placeholder = "df -h (or https://192.168.1.10:8080/health)";
  const syncTarget = (): void => {
    if (whereSelect.value === "__address__") {
      draft.where = "here";
      draft.address = cmdInput.value.trim();
      draft.command = "";
    } else {
      draft.where = whereSelect.value;
      draft.command = cmdInput.value.trim();
      draft.address = "";
    }
  };
  whereSelect.addEventListener("change", syncTarget);
  cmdInput.addEventListener("input", syncTarget);
  cmdField.append(cmdInput);

  const whenField = el("div", "field");
  whenField.append(el("label", undefined, "Notify When"));
  const whenSelect = document.createElement("select");
  for (const kind of [
    "fails",
    "works",
    "contains",
    "missing",
    "changes",
    "above",
    "below",
  ] satisfies TellWhen[]) {
    const opt = document.createElement("option");
    opt.value = kind;
    opt.textContent = kind;
    opt.selected = kind === draft.tellWhen;
    whenSelect.append(opt);
  }
  whenSelect.addEventListener("change", () => {
    draft.tellWhen = whenSelect.value as TellWhen;
  });
  whenField.append(whenSelect);

  const valField = el("div", "field");
  valField.append(el("label", undefined, "Match Text / Threshold"));
  const valInput = document.createElement("input");
  valInput.placeholder = "Optional word or threshold";
  valInput.addEventListener("input", () => {
    draft.value = valInput.value;
  });
  valField.append(valInput);

  const everyField = el("div", "field");
  everyField.append(el("label", undefined, "Interval (minutes)"));
  const everyInput = document.createElement("input");
  everyInput.type = "number";
  everyInput.min = "1";
  everyInput.max = "1440";
  everyInput.value = "5";
  everyInput.addEventListener("input", () => {
    draft.everyMinutes = Number(everyInput.value) || 5;
  });
  everyField.append(everyInput);

  form.append(titleField, whereField, whenField, cmdField, valField, everyField);
  builderCard.append(form);

  const previewBox = el("div", "preview-box", "Click Validate Preview to inspect rule safety.");
  const actRow = el("div", "btn-row");
  actRow.style.marginTop = "8px";
  const previewBtn = el("button", undefined, "Validate Preview");
  previewBtn.type = "button";
  const createBtn = el("button", "btn-primary", "Create Standing Order");
  createBtn.type = "button";
  previewBtn.addEventListener("click", async () => {
    syncTarget();
    const res = await handlers.studio.previewStandingOrder(draft);
    previewBox.replaceChildren();
    if (!res.valid) {
      previewBox.append(el("span", "badge critical", "Blocked"), el("div", undefined, res.problem ?? ""));
    } else {
      previewBox.append(
        el("span", "badge ok", "Valid Read-Only Rule"),
        el("div", undefined, `Check: ${res.checkSummary ?? ""}`),
        el("div", undefined, `Condition: ${res.conditionSummary ?? ""}`),
      );
    }
  });
  createBtn.addEventListener("click", async () => {
    syncTarget();
    const res = await handlers.studio.createStandingOrder(draft);
    handlers.setStatus(res.message);
    if (res.ok) await handlers.refresh();
  });
  actRow.append(previewBtn, createBtn);
  builderCard.append(actRow, previewBox);

  // 2. Experimental options card
  const expCard = el("div", "card");
  expCard.append(el("h2", undefined, "Experimental Options (Plain-English Feature Switches)"));
  const expGrid = el("div", "option-grid");
  for (const opt of policy.experimentalOptions) {
    const card = el("div", "option-card");
    const top = el("div", "row-between");
    top.append(el("strong", undefined, opt.title));
    const right = el("div", "btn-row");
    right.append(
      el(
        "span",
        `badge ${opt.riskTier === "high" ? "critical" : opt.riskTier === "medium" ? "warn" : "ok"}`,
        opt.riskTier,
      ),
    );
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = opt.enabled;
    chk.addEventListener("change", async () => {
      const res = await handlers.studio.setExperimentalFlag(opt.key, chk.checked);
      handlers.setStatus(res.message);
      await handlers.refresh();
    });
    right.append(chk);
    top.append(right);
    card.append(top, el("div", "muted", opt.summary));
    expGrid.append(card);
  }
  expCard.append(expGrid);
  topGrid.append(builderCard, expCard);
  container.append(topGrid);

  const policyReplayHost = el("div");
  renderPolicyReplayPanel(
    policyReplayHost,
    mc.policyGraph,
    mc.standingOrders,
    mc.compiledSkills,
    mc.recentTurns,
    {
      onVerifyPolicies: handlers.onVerifyPolicies,
      onCancelOrder: handlers.onCancelOrder,
      onSkillAction: handlers.onSkillAction,
      onRunReplay: handlers.onRunReplay,
    },
  );
  container.append(policyReplayHost);
}

/** Renders the Turn X-Ray waterfall, token meter, and conflict resolver panel. */
export function renderWorkbenchXrayPanel(
  container: HTMLElement,
  xray: TurnXraySnapshot,
  state: { selectedTurnId: string | null },
  handlers: {
    studio: StudioToolsBridge;
    setStatus(msg: string): void;
    refresh(): Promise<void>;
  },
): void {
  container.replaceChildren();

  const layout = el("div", "xray-layout");
  const listCard = el("div", "card turn-list");
  listCard.append(el("h2", undefined, `Recent Turns (${xray.turns.length})`));
  const detailHost = el("div", "stack");

  if (xray.turns.length === 0) {
    listCard.append(el("p", "muted", "No non-withheld turns recorded yet."));
  } else {
    const chosen = xray.turns.find((t) => t.id === state.selectedTurnId) ?? xray.turns[0];
    if (chosen) state.selectedTurnId = chosen.id;

    for (const t of xray.turns) {
      const btn = el("button", `turn-item${t.id === state.selectedTurnId ? " active" : ""}`);
      btn.type = "button";
      const line1 = el("div", "row-between");
      line1.append(
        el("strong", undefined, `${t.at.slice(11, 19)} · ${t.kind}`),
        el("span", "badge", `${t.wholeMs}ms · ${t.calls.length} calls`),
      );
      btn.append(line1, el("div", "mono", t.said.slice(0, 68) || "(empty)"));
      btn.addEventListener("click", () => {
        state.selectedTurnId = t.id;
        renderWorkbenchXrayPanel(container, xray, state, handlers);
      });
      listCard.append(btn);
    }

    if (chosen) renderTurnDetailCard(detailHost, chosen);
  }

  // Conflict & duplicate memory auditor
  const auditCard = el("div", "card stack");
  auditCard.append(
    el(
      "h2",
      undefined,
      `Contradictions (${xray.contradictions.length}) & Near-Duplicates (${xray.nearDuplicates.length})`,
    ),
  );
  if (xray.contradictions.length === 0 && xray.nearDuplicates.length === 0) {
    auditCard.append(el("div", "muted", "No conflicting or duplicate memories detected."));
  }
  for (const c of xray.contradictions) {
    const row = el("div", "list-row row-between");
    row.append(el("span", undefined, c.prompt));
    const keepId = c.memoryIds[0];
    const dropIds = c.memoryIds.slice(1);
    if (keepId && dropIds.length > 0) {
      const btn = el("button", "btn-primary", "Keep First & Drop Stale");
      btn.type = "button";
      btn.addEventListener("click", async () => {
        const res = await handlers.studio.resolveMemoryConflict(keepId, dropIds);
        handlers.setStatus(res.message);
        await handlers.refresh();
      });
      row.append(btn);
    }
    auditCard.append(row);
  }
  for (const pair of xray.nearDuplicates.slice(0, 12)) {
    const row = el("div", "list-row row-between mono");
    row.append(el("span", undefined, `[${Math.round(pair.jaccard * 100)}%] "${pair.aText}" vs "${pair.bText}"`));
    const btn = el("button", undefined, "Keep A, Remove B");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      const res = await handlers.studio.resolveMemoryConflict(pair.aId, [pair.bId]);
      handlers.setStatus(res.message);
      await handlers.refresh();
    });
    row.append(btn);
    auditCard.append(row);
  }
  detailHost.append(auditCard);

  layout.append(listCard, detailHost);
  container.append(layout);
}

function renderTurnDetailCard(host: HTMLElement, turn: TurnXrayItem): void {
  const card = el("div", "card stack");
  const head = el("div", "row-between");
  head.append(
    el("h2", undefined, `Turn ${turn.at.slice(11, 19)} (${turn.brain})`),
    el("span", "badge", `${turn.wholeMs}ms total · first word ${turn.firstWordMs ?? "—"}ms`),
  );
  card.append(
    head,
    el("div", "mono", `Prompt: ${turn.said}`),
    el("div", "mono", `Reply: ${turn.replyPreview || "(empty)"}`),
  );

  const bar = el("div", "waterfall-bar");
  const totalPct = Math.max(1, turn.waterfall.reduce((s, x) => s + x.percent, 0));
  for (const st of turn.waterfall) {
    const seg = el("div", `seg-${st.stage}`);
    seg.style.width = `${Math.max(4, (st.percent / totalPct) * 100)}%`;
    seg.title = `${st.label}: ${st.ms}ms (${st.percent}%)`;
    bar.append(seg);
  }
  card.append(el("strong", undefined, "Latency Waterfall"), bar);
  for (const st of turn.waterfall) {
    card.append(el("div", "mono", `• ${st.label}: ${st.ms}ms (${st.percent}%)`));
  }

  const budget = turn.tokenBudget;
  const meter = el("div", "budget-meter");
  const fill = el("div", "budget-fill");
  fill.style.width = `${Math.round(budget.utilizationRatio * 100)}%`;
  meter.append(fill);
  card.append(
    el("strong", undefined, "Context Token Budget"),
    meter,
    el(
      "div",
      "mono",
      `Held ${budget.heldTokens} / ${budget.contextLimit} tokens (Prompt ${budget.promptTokens}, Output ${budget.completionTokens})`,
    ),
  );

  for (const c of turn.calls) {
    const row = el("div", "row-between mono");
    row.append(
      el("span", undefined, `${c.tool} (${c.ms}ms) ${c.inputPreview}`),
      el("span", `badge ${c.outcome === "done" ? "ok" : "warn"}`, c.outcome),
    );
    card.append(row);
  }

  host.append(card);
}

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
  grid.append(leftCard, rightCard);
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

function buildProbeSweep(sampleRate: number, durationSec: number): Float32Array {
  const length = Math.round(sampleRate * durationSec);
  const out = new Float32Array(length);
  const fadeSamples = Math.min(Math.floor(length / 4), Math.round(sampleRate * 0.02));
  const f0 = 180;
  const f1 = 1650;
  let chirpPhase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const progress = length > 1 ? i / (length - 1) : 0;
    chirpPhase += (2 * Math.PI * (f0 * Math.pow(f1 / f0, progress))) / sampleRate;
    let env = 0.45;
    if (fadeSamples > 0 && i < fadeSamples) env *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    else if (fadeSamples > 0 && i >= length - fadeSamples) {
      env *= 0.5 * (1 - Math.cos((Math.PI * (length - 1 - i)) / fadeSamples));
    }
    out[i] =
      (0.55 * Math.sin(chirpPhase) +
        0.28 * Math.sin(2 * Math.PI * 220 * t) +
        0.17 * Math.sin(2 * Math.PI * 520 * t)) *
      env;
  }
  return out;
}

async function captureLiveRoomProbe(): Promise<{
  sampleRate: number;
  referenceSamples: number[];
  recordedSamples: number[];
}> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
    throw new Error("Microphone/speaker Web Audio API is unavailable; run Synthetic Self-Test instead.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext({ sampleRate: 16_000 });
  const recorded: number[] = [];
  const sampleRate = ctx.sampleRate || 16_000;
  const sweep = buildProbeSweep(sampleRate, 1.0);
  try {
    const sourceNode = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    processor.onaudioprocess = (ev) => {
      const ch = ev.inputBuffer.getChannelData(0);
      for (let i = 0; i < ch.length && recorded.length < 48_000; i += 1) {
        recorded.push(ch[i] ?? 0);
      }
    };
    sourceNode.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(ctx.destination);

    const playBuf = ctx.createBuffer(1, sweep.length, sampleRate);
    playBuf.getChannelData(0).set(sweep);
    const player = ctx.createBufferSource();
    player.buffer = playBuf;
    player.connect(ctx.destination);
    player.start();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1180);
    });
    processor.disconnect();
    sourceNode.disconnect();
    muteGain.disconnect();
    return {
      sampleRate,
      referenceSamples: Array.from(sweep),
      recordedSamples: recorded.slice(0, sweep.length),
    };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => undefined);
  }
}

function renderRoomCalibrationReport(host: HTMLElement, report: RoomCalibrationReport): void {
  host.replaceChildren();
  const top = el("div", "row-between");
  top.append(
    el("strong", undefined, `Room Acoustic & Wake Report (${report.samplesAnalyzed} samples @ ${report.sampleRate} Hz)`),
  );
  const badges = el("div", "btn-row");
  badges.append(
    el("span", `badge ${report.erleDb >= 10 ? "ok" : report.erleDb >= 6 ? "warn" : "critical"}`, `ERLE ${report.erleDb.toFixed(1)} dB`),
    el("span", `badge ${report.bargeInReady ? "ok" : "warn"}`, report.bargeInReady ? "Barge-In Ready" : "Needs PipeWire AEC"),
    el("span", `badge ${report.wakePassRate >= 1 ? "ok" : "warn"}`, `Wake ${Math.round(report.wakePassRate * 100)}%`),
  );
  top.append(badges);
  host.append(top);

  const metrics = [
    `Raw Mic RMS: ${report.rawMicRms.toFixed(5)} · Post-NLMS Residual RMS: ${report.residualRms.toFixed(5)} · Room Noise Floor: ${report.noiseFloorRms.toFixed(5)}`,
    `Recommended Min SNR: ${report.recommendedMinSnrDb} dB · Recommended Barge-In Residual RMS: ${report.recommendedMinResidualRms.toFixed(4)}`,
  ];
  for (const line of metrics) host.append(el("div", "mono", line));
  for (const note of report.notes) host.append(el("div", "muted", note));

  host.append(
    el("div", "muted", "PipeWire WebRTC Echo-Cancel Command:"),
    el("pre", "code-box", report.pipewireAecCommand),
    el("strong", undefined, "Multilingual Wake-Word Gate & TV Rejection Checks"),
  );
  for (const chk of report.wakeChecks) {
    const row = el("div", "list-row row-between mono");
    row.append(
      el(
        "span",
        undefined,
        `"${chk.phrase}" · expect=${chk.expectedWake ? "wake" : "ignore"} · got=${chk.accepted ? "wake" : "ignore"} (SNR ${chk.snrDb.toFixed(1)} dB)`,
      ),
      el("span", `badge ${chk.passed ? "ok" : "critical"}`, chk.passed ? "PASS" : "FAIL"),
    );
    host.append(row);
  }
}

/** Renders the live-room AEC probe, PipeWire WebRTC helper, and multilingual wake calibration panel. */
export function renderWorkbenchAudioPanel(
  container: HTMLElement,
  studio: StudioToolsBridge,
  setStatus: (msg: string) => void,
): void {
  const card = el("div", "card stack");
  const head = el("div", "card-header");
  const titleWrap = el("div");
  titleWrap.append(
    el("h2", undefined, "Live-Room AEC & Wake-Word Calibration Utility"),
    el(
      "p",
      "muted",
      "Measure speaker-to-mic ERLE, calibrate NLMS barge-in thresholds, and verify EN/JA/ZH wake gating + ambient TV rejection.",
    ),
  );
  head.append(titleWrap);

  const btnRow = el("div", "btn-row");
  const liveBtn = el("button", "btn-primary", "Run Live Room Probe (Mic + Speaker)");
  liveBtn.type = "button";
  liveBtn.dataset.action = "run-live-calibration";

  const synthBtn = el("button", undefined, "Run Synthetic AEC & Wake Self-Test");
  synthBtn.type = "button";
  synthBtn.dataset.action = "run-synthetic-calibration";

  const reportHost = el("div", "stack");
  reportHost.dataset.testid = "aec-report";
  reportHost.append(
    el(
      "div",
      "muted",
      "No calibration run yet. Click Run Live Room Probe with speakers/mic active, or Run Synthetic AEC & Wake Self-Test for an isolated loopback verification.",
    ),
  );

  liveBtn.addEventListener("click", async () => {
    liveBtn.disabled = true;
    synthBtn.disabled = true;
    setStatus("Playing live calibration sweep and recording mic room response…");
    try {
      const probe = await captureLiveRoomProbe();
      const report = await studio.runRoomCalibration({
        mode: "live",
        sampleRate: probe.sampleRate,
        referenceSamples: probe.referenceSamples,
        recordedSamples: probe.recordedSamples,
      });
      renderRoomCalibrationReport(reportHost, report);
      setStatus(`Live AEC calibration complete: ERLE ${report.erleDb.toFixed(1)} dB.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      liveBtn.disabled = false;
      synthBtn.disabled = false;
    }
  });

  synthBtn.addEventListener("click", async () => {
    liveBtn.disabled = true;
    synthBtn.disabled = true;
    setStatus("Running synthetic NLMS echo cancellation & wake-word self-test…");
    try {
      const report = await studio.runRoomCalibration({ mode: "synthetic" });
      renderRoomCalibrationReport(reportHost, report);
      setStatus(
        `Synthetic AEC check complete: ERLE ${report.erleDb.toFixed(1)} dB, wake gate ${Math.round(report.wakePassRate * 100)}%.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      liveBtn.disabled = false;
      synthBtn.disabled = false;
    }
  });

  btnRow.append(liveBtn, synthBtn);
  head.append(btnRow);
  card.append(head, reportHost);
  container.replaceChildren(card);
}
