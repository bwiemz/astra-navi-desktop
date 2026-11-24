import type { StudioToolsBridge, TurnXrayItem, TurnXraySnapshot } from "../../../shared/studioTools.ts";
import { el } from "./dom.ts";

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
