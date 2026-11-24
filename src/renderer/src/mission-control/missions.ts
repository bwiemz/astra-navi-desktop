import type { MissionControlAction, MissionDagView } from "../../../shared/missionControl.ts";

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

function buildDagSvg(mission: MissionDagView): HTMLElement {
  const wrap = el("div", "dag-svg");
  const svgNs = "http://www.w3.org/2000/svg";
  const nodeWidth = 175;
  const nodeHeight = 52;
  const gap = 36;
  const width = Math.max(360, mission.nodes.length * (nodeWidth + gap) + 20);
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", "82");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `DAG for ${mission.title}`);

  mission.edges.forEach((edge) => {
    const x1 = 16 + edge.fromStep * (nodeWidth + gap) + nodeWidth;
    const x2 = 16 + edge.toStep * (nodeWidth + gap);
    const y = 14 + nodeHeight / 2;
    const line = document.createElementNS(svgNs, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", edge.relation === "retry-gate" ? "#f59e0b" : "#38bdf8");
    line.setAttribute("stroke-width", "2");
    svg.appendChild(line);
  });

  mission.nodes.forEach((node, idx) => {
    const x = 16 + idx * (nodeWidth + gap);
    const y = 14;
    const rect = document.createElementNS(svgNs, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(nodeWidth));
    rect.setAttribute("height", String(nodeHeight));
    rect.setAttribute("rx", "6");
    rect.setAttribute("fill", "#0f172a");
    rect.setAttribute(
      "stroke",
      node.state === "done"
        ? "#22c55e"
        : node.state === "failed" || node.state === "refused"
          ? "#ef4444"
          : node.state === "asking"
            ? "#f59e0b"
            : "#38bdf8",
    );
    rect.setAttribute("stroke-width", "1.5");
    svg.appendChild(rect);

    const title = document.createElementNS(svgNs, "text");
    title.setAttribute("x", String(x + 8));
    title.setAttribute("y", String(y + 20));
    title.setAttribute("fill", "#e2e8f0");
    title.setAttribute("font-size", "11");
    title.textContent = `${idx + 1}. ${node.title.slice(0, 22)}`;
    svg.appendChild(title);

    const sub = document.createElementNS(svgNs, "text");
    sub.setAttribute("x", String(x + 8));
    sub.setAttribute("y", String(y + 38));
    sub.setAttribute("fill", "#94a3b8");
    sub.setAttribute("font-size", "10");
    sub.textContent = `${node.state} · ${node.whereName.slice(0, 16)}`;
    svg.appendChild(sub);
  });

  wrap.appendChild(svg);
  return wrap;
}

export function renderMissionsPanel(
  container: HTMLElement,
  missions: readonly MissionDagView[],
  onAction: (id: string, action: MissionControlAction) => Promise<void>,
): void {
  container.replaceChildren();
  if (missions.length === 0) {
    const empty = el("div", "card");
    empty.appendChild(el("p", "muted", "No durable multi-step missions recorded yet."));
    container.appendChild(empty);
    return;
  }

  for (const mission of missions) {
    const card = el("article", "card");
    const header = el("div", "card-header");
    const info = el("div");
    info.appendChild(el("h2", "card-title", mission.title));
    info.appendChild(
      el(
        "p",
        "muted",
        `${mission.goal}${mission.wakeDescription ? ` · Wake: ${mission.wakeDescription}` : ""}`,
      ),
    );
    header.appendChild(info);

    const right = el("div", "btn-row");
    right.appendChild(el("span", `badge ${mission.state}`, mission.state));

    const addBtn = (
      label: string,
      action: MissionControlAction,
      enabled: boolean,
      cls = "",
    ): void => {
      if (!enabled) return;
      const btn = el("button", cls, label);
      btn.type = "button";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        void onAction(mission.id, action);
      });
      right.appendChild(btn);
    };

    addBtn("Approve Step", "approve", mission.canApprove, "btn-ok");
    addBtn("Pause", "pause", mission.canPauseOrCancel && mission.state !== "blocked");
    addBtn("Resume", "resume", mission.canResume, "btn-primary");
    addBtn("Rollback Checkpoint", "rollback", mission.canRollback);
    addBtn("Cancel", "cancel", mission.canPauseOrCancel, "btn-danger");

    header.appendChild(right);
    card.appendChild(header);

    if (mission.note) {
      card.appendChild(el("p", "muted", `Status note: ${mission.note}`));
    }

    if (mission.nodes.length > 0) {
      card.appendChild(buildDagSvg(mission));
    }

    const stepsWrap = el("div", "step-list");
    for (const step of mission.nodes) {
      const item = el("div", "step-item");
      const top = el("div", "list-row-top");
      top.appendChild(
        el("strong", "", `Step ${step.index + 1}: ${step.title} (${step.whereName})`),
      );
      top.appendChild(el("span", `badge ${step.state}`, step.state));
      item.appendChild(top);
      item.appendChild(el("div", "muted", `Command: ${step.command}`));
      if (step.approvedSummary) {
        item.appendChild(el("div", "muted", step.approvedSummary));
      }
      if (step.outputPreview) {
        const pre = el("pre", "code-box", step.outputPreview);
        item.appendChild(pre);
      }
      if (step.diffPreview) {
        const details = document.createElement("details");
        const sum = el("summary", "muted", "Inspect step output / diff");
        details.appendChild(sum);
        details.appendChild(el("pre", "code-box", step.diffPreview));
        item.appendChild(details);
      }
      stepsWrap.appendChild(item);
    }
    card.appendChild(stepsWrap);

    if (mission.thread.length > 0) {
      const details = document.createElement("details");
      details.appendChild(
        el("summary", "muted", `Checkpoint Timeline (${mission.thread.length} events)`),
      );
      for (const entry of mission.thread) {
        details.appendChild(
          el("div", "muted", `[${entry.at.slice(0, 19).replace("T", " ")}] ${entry.kind}: ${entry.text}`),
        );
      }
      card.appendChild(details);
    }

    container.appendChild(card);
  }
}
