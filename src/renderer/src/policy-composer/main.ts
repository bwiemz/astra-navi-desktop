import "./style.css";
import type { TellWhen } from "../../../core/standingOrders.ts";
import type {
  PolicyComposerSnapshot,
  StandingOrderDraft,
  StudioToolsBridge,
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
  if (!found) throw new Error(`Missing Policy Composer DOM element #${id}.`);
  return found as T;
}

const subtitleEl = requireEl<HTMLElement>("policy-subtitle");
const statusEl = requireEl<HTMLElement>("policy-status");
const refreshBtn = requireEl<HTMLButtonElement>("policy-refresh");
const composerPanel = requireEl<HTMLElement>("composer-panel");
const ordersPanel = requireEl<HTMLElement>("orders-panel");
const auditPanel = requireEl<HTMLElement>("audit-panel");
const experimentalPanel = requireEl<HTMLElement>("experimental-panel");

let snapshot: PolicyComposerSnapshot | null = null;

function renderComposer(data: PolicyComposerSnapshot): void {
  composerPanel.replaceChildren();
  composerPanel.append(el("h2", undefined, "Standing-Order Rule Builder"));

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
  for (const m of data.machines) {
    const opt = document.createElement("option");
    opt.value = m.name;
    opt.textContent = `${m.name} (${m.user}@${m.host})`;
    whereSelect.append(opt);
  }
  const webOpt = document.createElement("option");
  webOpt.value = "__address__";
  webOpt.textContent = "Local Web Endpoint (http/https)";
  whereSelect.append(webOpt);

  const cmdField = el("div", "field full");
  const cmdLabel = el("label", undefined, "Read-Only Command or Address");
  const cmdInput = document.createElement("input");
  cmdInput.placeholder = "df -h  (or https://192.168.1.10:8080/health)";

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
  whereField.append(whereSelect);
  cmdField.append(cmdLabel, cmdInput);

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
  valInput.placeholder = "Optional word or threshold number";
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
  composerPanel.append(form);

  const previewBox = el("div", "preview-box", "Click Validate Preview to inspect check safety.");
  const actions = el("div", "row-between");
  actions.style.marginTop = "10px";

  const previewBtn = el("button", undefined, "Validate Preview");
  previewBtn.type = "button";
  const createBtn = el("button", "btn-primary", "Create Standing Order");
  createBtn.type = "button";

  previewBtn.addEventListener("click", async () => {
    syncTarget();
    const res = await window.studioTools.previewStandingOrder(draft);
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
    const res = await window.studioTools.createStandingOrder(draft);
    statusEl.textContent = res.message;
    if (res.ok) await refresh();
  });

  actions.append(previewBtn, createBtn);
  composerPanel.append(actions, previewBox);
}

function renderOrders(data: PolicyComposerSnapshot): void {
  ordersPanel.replaceChildren();
  ordersPanel.append(el("h2", undefined, `Active Standing Orders (${data.orders.length})`));
  if (data.orders.length === 0) {
    ordersPanel.append(el("div", undefined, "No active standing orders configured."));
    return;
  }
  for (const o of data.orders) {
    const box = el("div", "preview-box");
    const head = el("div", "row-between");
    head.append(el("strong", undefined, o.title));
    const cancelBtn = el("button", undefined, "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", async () => {
      const res = await window.studioTools.cancelStandingOrder(o.id);
      statusEl.textContent = res.message;
      await refresh();
    });
    head.append(cancelBtn);
    box.append(
      head,
      el("div", undefined, `${o.checkSummary} · every ${o.everyMinutes}m`),
      el("div", undefined, `Notify when: ${o.conditionSummary}`),
    );
    ordersPanel.append(box);
  }
}

function renderAudit(data: PolicyComposerSnapshot): void {
  auditPanel.replaceChildren();
  const statusBadge = el(
    "span",
    `badge ${data.auditOk ? "ok" : "critical"}`,
    data.auditOk ? "No Critical Policy Conflicts" : "Policy Conflict Detected",
  );
  const head = el("div", "row-between");
  head.append(el("h2", undefined, "Static Security Rule Audit"), statusBadge);
  auditPanel.append(head);

  if (data.auditFindings.length === 0) {
    auditPanel.append(el("div", "preview-box", "All standing orders, fleet rules, and experimental bridges passed static policy checks."));
    return;
  }
  for (const f of data.auditFindings) {
    const item = el("div", "preview-box");
    item.append(
      el("span", `badge ${f.severity === "critical" ? "critical" : "warn"}`, `${f.severity}: ${f.code}`),
      el("div", undefined, `${f.subject} — ${f.message}`),
      el("div", undefined, `Fix: ${f.remediation}`),
    );
    auditPanel.append(item);
  }
}

function renderExperimental(data: PolicyComposerSnapshot): void {
  experimentalPanel.replaceChildren();
  experimentalPanel.append(
    el("h2", undefined, "Experimental Options (Plain-English Feature Switches)"),
  );
  const grid = el("div", "option-grid");
  for (const opt of data.experimentalOptions) {
    const card = el("div", "option-card");
    const top = el("div", "row-between");
    const left = el("div");
    left.append(el("strong", undefined, opt.title));
    const riskBadge = el(
      "span",
      `badge ${opt.riskTier === "high" ? "critical" : opt.riskTier === "medium" ? "warn" : "ok"}`,
      opt.riskTier,
    );
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = opt.enabled;
    chk.addEventListener("change", async () => {
      const res = await window.studioTools.setExperimentalFlag(opt.key, chk.checked);
      statusEl.textContent = res.message;
      await refresh();
    });
    const right = el("div", "row-between");
    right.append(riskBadge, chk);
    top.append(left, right);
    card.append(top, el("div", undefined, opt.summary));
    grid.append(card);
  }
  experimentalPanel.append(grid);
}

async function refresh(): Promise<void> {
  try {
    snapshot = await window.studioTools.getPolicyComposerSnapshot();
    subtitleEl.textContent =
      `${snapshot.machines.length} machines · ${snapshot.orders.length} standing orders · ` +
      `hands-off: ${snapshot.handsOff ? "ON" : "off"} · findings: ${snapshot.auditFindings.length}`;
    renderComposer(snapshot);
    renderOrders(snapshot);
    renderAudit(snapshot);
    renderExperimental(snapshot);
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

refreshBtn.addEventListener("click", () => {
  void refresh();
});

void refresh();
