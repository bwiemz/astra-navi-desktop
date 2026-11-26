import type { TellWhen } from "../../../core/standingOrders.ts";
import type { MissionControlSnapshot, ReplayInspectResult } from "../../../shared/missionControl.ts";
import type {
  PolicyComposerSnapshot,
  StandingOrderDraft,
  StudioToolsBridge,
} from "../../../shared/studioTools.ts";
import { renderPolicyReplayPanel } from "../mission-control/policyReplay.ts";
import { el } from "./dom.ts";

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

  // 2. Experimental options card (preview-only staging flags — not connected to live chat runtime yet)
  const expCard = el("div", "card");
  const expHead = el("div", "row-between");
  expHead.append(
    el("h2", undefined, "Experimental Staging Flags (Preview Only)"),
    el("span", "badge warn", "Not Wired to Chat Yet"),
  );
  expCard.append(
    expHead,
    el(
      "p",
      "muted",
      "Preview only: toggling these staging flags persists preferences for upcoming experimental modules, but does not activate new tools or change live chat behavior yet.",
    ),
  );
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
