import "./style.css";
import type {
  StudioToolsBridge,
  TurnXrayItem,
  TurnXraySnapshot,
} from "../../../shared/studioTools.ts";

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
  if (!found) throw new Error(`Missing Turn X-Ray DOM element #${id}.`);
  return found as T;
}

const subtitleEl = requireEl<HTMLElement>("xray-subtitle");
const statusEl = requireEl<HTMLElement>("xray-status");
const refreshBtn = requireEl<HTMLButtonElement>("xray-refresh");
const panelTurns = requireEl<HTMLElement>("panel-turns");
const panelProvenance = requireEl<HTMLElement>("panel-provenance");
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".st-tab"));

let snapshot: TurnXraySnapshot | null = null;
let selectedTurnId: string | null = null;

for (const btn of tabButtons) {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab === "provenance" ? "provenance" : "turns";
    for (const other of tabButtons) {
      const active = other === btn;
      other.classList.toggle("active", active);
      other.setAttribute("aria-selected", String(active));
    }
    panelTurns.hidden = tab !== "turns";
    panelProvenance.hidden = tab !== "provenance";
  });
}

function renderTurnDetail(container: HTMLElement, turn: TurnXrayItem): void {
  container.replaceChildren();
  const card = el("div", "card stack");

  const header = el("div", "row-between");
  header.append(
    el("h2", undefined, `Turn ${turn.at.slice(11, 19)} (${turn.brain})`),
    el("span", "badge", `${turn.wholeMs} ms total · first word ${turn.firstWordMs ?? "—"} ms`),
  );
  card.append(header);
  card.append(el("div", "mono", `Prompt: ${turn.said}`));
  card.append(el("div", "mono", `Reply: ${turn.replyPreview || "(empty / tool-only)"}`));

  // Latency Waterfall Bar
  card.append(el("strong", undefined, "Latency Waterfall"));
  const bar = el("div", "waterfall-bar");
  const totalPct = Math.max(1, turn.waterfall.reduce((sum, s) => sum + s.percent, 0));
  for (const stage of turn.waterfall) {
    const seg = el("div", `seg-${stage.stage}`);
    seg.style.width = `${Math.max(4, (stage.percent / totalPct) * 100)}%`;
    seg.title = `${stage.label}: ${stage.ms} ms (${stage.percent}%)`;
    bar.append(seg);
  }
  card.append(bar);

  const legend = el("div", "stack");
  for (const stage of turn.waterfall) {
    legend.append(el("div", "mono", `• ${stage.label}: ${stage.ms} ms (${stage.percent}%)`));
  }
  card.append(legend);

  // Token Budget Meter
  card.append(el("strong", undefined, "Context Token Budget"));
  const budget = turn.tokenBudget;
  const meter = el("div", "budget-meter");
  const fill = el("div", "budget-fill");
  fill.style.width = `${Math.round(budget.utilizationRatio * 100)}%`;
  meter.append(fill);
  card.append(meter);
  card.append(
    el(
      "div",
      "mono",
      `Prompt ${budget.promptTokens} + Output ${budget.completionTokens} = Held ${budget.heldTokens} / ${budget.contextLimit} tokens (Remaining: ${budget.remainingTokens})`,
    ),
  );

  // Routing & Tool Calls
  card.append(el("strong", undefined, `Tool Calls (${turn.calls.length}) & Routing`));
  if (turn.pickedReasons.length > 0) {
    for (const r of turn.pickedReasons) {
      card.append(el("div", "mono", `Routed ${r.tool}: ${r.reason}`));
    }
  }
  if (turn.calls.length === 0) {
    card.append(el("div", "mono", "No tool calls executed on this turn."));
  } else {
    for (const c of turn.calls) {
      const box = el("div", "row-between mono");
      box.append(
        el("span", undefined, `${c.tool} (${c.ms} ms) ${c.inputPreview}`),
        el("span", `badge ${c.outcome === "done" ? "ok" : "warn"}`, `${c.outcome}${c.gate ? ` / ${c.gate}` : ""}`),
      );
      card.append(box);
    }
  }

  if (turn.checks.length > 0) {
    card.append(el("strong", undefined, "Post-Reply Checks"));
    for (const ck of turn.checks) {
      card.append(el("span", "badge warn", `${ck.found} -> ${ck.did}`));
    }
  }

  container.append(card);
}

function renderTurnsPanel(): void {
  panelTurns.replaceChildren();
  const data = snapshot;
  if (!data || data.turns.length === 0) {
    panelTurns.append(el("div", "card", "No non-withheld turn traces recorded yet."));
    return;
  }

  const listCard = el("div", "card turn-list");
  const detailHost = el("div");
  const chosen =
    data.turns.find((t) => t.id === selectedTurnId) ?? data.turns[0];
  if (chosen) selectedTurnId = chosen.id;

  for (const t of data.turns) {
    const btn = el(
      "button",
      `turn-item${t.id === selectedTurnId ? " active" : ""}`,
    );
    btn.type = "button";
    const line1 = el("div", "row-between");
    line1.append(
      el("strong", undefined, `${t.at.slice(11, 19)} · ${t.kind}`),
      el("span", "badge", `${t.wholeMs}ms · ${t.calls.length} calls`),
    );
    const line2 = el("div", "mono", t.said.slice(0, 72) || "(empty)");
    btn.append(line1, line2);
    btn.addEventListener("click", () => {
      selectedTurnId = t.id;
      renderTurnsPanel();
    });
    listCard.append(btn);
  }

  panelTurns.append(listCard, detailHost);
  if (chosen) renderTurnDetail(detailHost, chosen);
}

function renderProvenancePanel(): void {
  panelProvenance.replaceChildren();
  const data = snapshot;
  if (!data) return;

  const stack = el("div", "stack");

  const conflictCard = el("div", "card stack");
  conflictCard.append(
    el("h2", undefined, `Contradiction Auditor (${data.contradictions.length})`),
  );
  if (data.contradictions.length === 0) {
    conflictCard.append(el("div", "mono", "No conflicting host IPs or ports found across saved notes."));
  } else {
    for (const c of data.contradictions) {
      const row = el("div", "row-between");
      row.append(el("span", undefined, c.prompt));
      const firstKeep = c.memoryIds[0];
      const dropIds = c.memoryIds.slice(1);
      if (firstKeep && dropIds.length > 0) {
        const btn = el("button", "btn-primary", "Keep First & Drop Stale");
        btn.type = "button";
        btn.addEventListener("click", async () => {
          const res = await window.studioTools.resolveMemoryConflict(firstKeep, dropIds);
          statusEl.textContent = res.message;
          await refresh();
        });
        row.append(btn);
      }
      conflictCard.append(row);
    }
  }
  stack.append(conflictCard);

  const dupCard = el("div", "card stack");
  dupCard.append(el("h2", undefined, `Near-Duplicate Memories (${data.nearDuplicates.length})`));
  if (data.nearDuplicates.length === 0) {
    dupCard.append(el("div", "mono", "No overlapping duplicate memory clusters above similarity threshold."));
  } else {
    for (const pair of data.nearDuplicates) {
      const row = el("div", "row-between mono");
      row.append(
        el("span", undefined, `[${Math.round(pair.jaccard * 100)}%] "${pair.aText}" vs "${pair.bText}"`),
      );
      const mergeBtn = el("button", undefined, "Keep A, Remove B");
      mergeBtn.type = "button";
      mergeBtn.addEventListener("click", async () => {
        const res = await window.studioTools.resolveMemoryConflict(pair.aId, [pair.bId]);
        statusEl.textContent = res.message;
        await refresh();
      });
      row.append(mergeBtn);
      dupCard.append(row);
    }
  }
  stack.append(dupCard);

  const provCard = el("div", "card stack");
  provCard.append(el("h2", undefined, `Memory Provenance Trail (${data.memories.length} items)`));
  for (const m of data.memories.slice(0, 60)) {
    const row = el("div", "row-between mono");
    row.append(
      el("span", undefined, `[${m.kind}] ${m.text}`),
      el(
        "span",
        "badge",
        `hits:${m.hits} · age:${m.ageDays}d${m.pinned ? " · pinned" : ""}${m.namespace ? ` · ${m.namespace}` : ""}`,
      ),
    );
    provCard.append(row);
  }
  stack.append(provCard);

  panelProvenance.append(stack);
}

async function refresh(): Promise<void> {
  try {
    snapshot = await window.studioTools.getTurnXraySnapshot();
    subtitleEl.textContent =
      `${snapshot.turns.length} turns · ${snapshot.memories.length} memories · ` +
      `${snapshot.contradictions.length} contradictions · updated ${snapshot.generatedAt.slice(11, 19)}`;
    renderTurnsPanel();
    renderProvenancePanel();
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

refreshBtn.addEventListener("click", () => {
  void refresh();
});

void refresh();
