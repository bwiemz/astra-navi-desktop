import type {
  CompiledSkillInspectorItem,
  PolicyConflictGraph,
  ReplayInspectResult,
  ReplayTurnView,
  StandingOrderInspectorItem,
} from "../../../shared/missionControl.ts";

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

export interface PolicyReplayHandlers {
  onVerifyPolicies(): Promise<PolicyConflictGraph>;
  onCancelOrder(id: string): Promise<void>;
  onSkillAction(id: string, action: "ratify" | "revoke"): Promise<void>;
  onRunReplay(bundlePath?: string): Promise<ReplayInspectResult>;
}

function buildPolicyGraphSvg(graph: PolicyConflictGraph): HTMLElement {
  const wrap = el("div", "dag-svg");
  const svgNs = "http://www.w3.org/2000/svg";
  const rowH = 38;
  const height = Math.max(120, Math.min(440, graph.nodes.length * rowH + 24));
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", "680");
  svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Policy conflict graph");

  const positions = new Map<string, { x: number; y: number }>();
  const leftNodes = graph.nodes.filter((n) => n.kind === "config");
  const midNodes = graph.nodes.filter((n) => n.kind === "order" || n.kind === "skill" || n.kind === "watch");
  const rightNodes = graph.nodes.filter((n) => n.kind === "finding");

  const placeColumn = (nodes: typeof graph.nodes, x: number): void => {
    nodes.forEach((n, idx) => {
      positions.set(n.id, { x, y: 20 + idx * rowH });
    });
  };
  placeColumn(leftNodes, 12);
  placeColumn(midNodes, 230);
  placeColumn(rightNodes, 455);

  for (const edge of graph.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;
    const line = document.createElementNS(svgNs, "line");
    line.setAttribute("x1", String(a.x + 170));
    line.setAttribute("y1", String(a.y + 13));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y + 13));
    line.setAttribute(
      "stroke",
      edge.relation === "critical" ? "#ef4444" : edge.relation === "warning" ? "#f59e0b" : "#475569",
    );
    line.setAttribute("stroke-width", "1.5");
    svg.appendChild(line);
  }

  for (const node of graph.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const rect = document.createElementNS(svgNs, "rect");
    rect.setAttribute("x", String(pos.x));
    rect.setAttribute("y", String(pos.y));
    rect.setAttribute("width", "170");
    rect.setAttribute("height", "26");
    rect.setAttribute("rx", "4");
    rect.setAttribute("fill", "#0f172a");
    rect.setAttribute(
      "stroke",
      node.severity === "critical"
        ? "#ef4444"
        : node.severity === "warning"
          ? "#f59e0b"
          : "#38bdf8",
    );
    svg.appendChild(rect);

    const text = document.createElementNS(svgNs, "text");
    text.setAttribute("x", String(pos.x + 6));
    text.setAttribute("y", String(pos.y + 17));
    text.setAttribute("fill", "#e2e8f0");
    text.setAttribute("font-size", "10");
    text.textContent = node.label.slice(0, 26);
    svg.appendChild(text);
  }

  wrap.appendChild(svg);
  return wrap;
}

export function renderPolicyReplayPanel(
  container: HTMLElement,
  policyGraph: PolicyConflictGraph,
  orders: readonly StandingOrderInspectorItem[],
  skills: readonly CompiledSkillInspectorItem[],
  turns: readonly ReplayTurnView[],
  handlers: PolicyReplayHandlers,
): void {
  container.replaceChildren();

  // 1. Policy audit + conflict graph
  const policyCard = el("div", "card");
  const pHead = el("div", "card-header");
  const pInfo = el("div");
  pInfo.appendChild(el("h2", "card-title", "Security Policy Conflict Graph (ruleAudit)"));
  pInfo.appendChild(
    el(
      "p",
      "muted",
      `Critical: ${policyGraph.counts.critical} · Warnings: ${policyGraph.counts.warning} · Info: ${policyGraph.counts.info}`,
    ),
  );
  pHead.appendChild(pInfo);

  const pActions = el("div", "btn-row");
  pActions.appendChild(
    el(
      "span",
      `badge ${policyGraph.ok ? "ok" : "critical"}`,
      policyGraph.ok ? "No Critical Conflicts" : "Critical Conflict Found",
    ),
  );
  const verifyBtn = el("button", "btn-primary", "Re-Verify Rules");
  verifyBtn.type = "button";
  verifyBtn.addEventListener("click", () => {
    verifyBtn.disabled = true;
    void handlers.onVerifyPolicies();
  });
  pActions.appendChild(verifyBtn);
  pHead.appendChild(pActions);
  policyCard.appendChild(pHead);
  policyCard.appendChild(buildPolicyGraphSvg(policyGraph));

  for (const f of policyGraph.findings) {
    const row = el("div", "list-row");
    const top = el("div", "list-row-top");
    top.appendChild(el("strong", "", `${f.code} — ${f.subject}`));
    top.appendChild(el("span", `badge ${f.severity}`, f.severity));
    row.appendChild(top);
    row.appendChild(el("div", "", f.message));
    row.appendChild(el("div", "muted", `Fix: ${f.remediation}`));
    policyCard.appendChild(row);
  }
  container.appendChild(policyCard);

  // 2. Standing Orders & Compiled Skills side-by-side
  const midGrid = el("div", "grid-2");

  const orderCard = el("div", "card");
  orderCard.appendChild(el("h2", "card-title", `Standing Orders (${orders.length})`));
  if (orders.length === 0) {
    orderCard.appendChild(el("p", "muted", "No active standing orders."));
  } else {
    for (const order of orders) {
      const row = el("div", "list-row");
      const top = el("div", "list-row-top");
      top.appendChild(el("strong", "", `${order.title} (every ${order.everyMinutes}m)`));
      const cancelBtn = el("button", "btn-danger", "Cancel Order");
      cancelBtn.type = "button";
      cancelBtn.addEventListener("click", () => {
        void handlers.onCancelOrder(order.id);
      });
      top.appendChild(cancelBtn);
      row.appendChild(top);
      row.appendChild(el("div", "muted", `${order.target} -> ${order.conditionSummary}`));
      orderCard.appendChild(row);
    }
  }
  midGrid.appendChild(orderCard);

  const skillCard = el("div", "card");
  const skillHead = el("div", "list-row-top");
  skillHead.appendChild(el("h2", "card-title", `Compiled Skills (${skills.length})`));
  skillHead.appendChild(el("span", "badge warn", "Preview Only — Not Wired to Chat"));
  skillCard.appendChild(skillHead);
  skillCard.appendChild(
    el(
      "p",
      "muted",
      "Experimental preview: automatic skill compilation and live chat tool injection are not wired into the runtime yet.",
    ),
  );
  if (skills.length === 0) {
    skillCard.appendChild(el("p", "muted", "No compiled skills registered."));
  } else {
    for (const skill of skills) {
      const row = el("div", "list-row");
      const top = el("div", "list-row-top");
      top.appendChild(el("strong", "", `${skill.name} (${skill.slug})`));
      const right = el("div", "btn-row");
      right.appendChild(el("span", `badge ${skill.status}`, skill.status));
      if (skill.status === "proposed") {
        const ratifyBtn = el("button", "btn-ok", "Ratify");
        ratifyBtn.type = "button";
        ratifyBtn.addEventListener("click", () => {
          void handlers.onSkillAction(skill.id, "ratify");
        });
        right.appendChild(ratifyBtn);
      }
      if (skill.status !== "revoked") {
        const revokeBtn = el("button", "btn-danger", "Revoke");
        revokeBtn.type = "button";
        revokeBtn.addEventListener("click", () => {
          void handlers.onSkillAction(skill.id, "revoke");
        });
        right.appendChild(revokeBtn);
      }
      top.appendChild(right);
      row.appendChild(top);
      row.appendChild(
        el(
          "div",
          "muted",
          `${skill.stepCount} step(s) · capabilities: ${skill.requiredCapabilities.join(", ") || "none"}`,
        ),
      );
      if (skill.driftReason) row.appendChild(el("div", "muted", `Note: ${skill.driftReason}`));
      skillCard.appendChild(row);
    }
  }
  midGrid.appendChild(skillCard);
  container.appendChild(midGrid);

  // 3. Replay & Turn Debugger
  const replayCard = el("div", "card");
  const rHead = el("div", "card-header");
  rHead.appendChild(
    el("h2", "card-title", `Time-Travel Policy Replay Debugger (${turns.length} recent turns)`),
  );
  const replayBtn = el("button", "btn-primary", "Re-Evaluate Live Turns Against Policy");
  replayBtn.type = "button";
  const replayOut = el("div", "muted", "Run zero-LLM policy regression verification over recent turns.");
  replayBtn.addEventListener("click", () => {
    replayBtn.disabled = true;
    void handlers
      .onRunReplay()
      .then((res) => {
        replayOut.replaceChildren();
        replayOut.appendChild(el("div", "", res.message));
        if (res.report && res.report.diffs.length > 0) {
          for (const d of res.report.diffs) {
            replayOut.appendChild(
              el(
                "div",
                "badge critical",
                `Drift [${d.snapshotId} #${d.callIndex}] ${d.tool}: ${d.expectedDecision} -> ${d.actualDecision}`,
              ),
            );
          }
        }
      })
      .finally(() => {
        replayBtn.disabled = false;
      });
  });
  rHead.appendChild(replayBtn);
  replayCard.appendChild(rHead);
  replayCard.appendChild(replayOut);

  for (const turn of turns) {
    const row = el("div", "list-row");
    const top = el("div", "list-row-top");
    top.appendChild(el("strong", "", turn.said || "(no prompt text)"));
    top.appendChild(el("span", "badge", `${turn.brain} · ${turn.offered.length} tools`));
    row.appendChild(top);
    for (const c of turn.calls) {
      row.appendChild(
        el(
          "div",
          "muted",
          `  -> ${c.tool} [${c.outcome}${c.gate ? ` / gate=${c.gate}` : ""}] (${c.ms} ms)`,
        ),
      );
    }
    if (turn.replyPreview) {
      row.appendChild(el("div", "muted", `Reply: ${turn.replyPreview}`));
    }
    replayCard.appendChild(row);
  }
  container.appendChild(replayCard);
}
