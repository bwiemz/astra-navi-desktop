import "./style.css";
import type { MissionControlSnapshot } from "../../../shared/missionControl.ts";
import type {
  AvatarStudioSnapshot,
  PolicyComposerSnapshot,
  TurnXraySnapshot,
} from "../../../shared/studioTools.ts";
import { WORKBENCH_TABS, type WorkbenchBridge, type WorkbenchTab } from "../../../shared/workbench.ts";
import { renderMemoryPanel } from "../mission-control/memory.ts";
import { renderMissionsPanel } from "../mission-control/missions.ts";
import { renderWorkbenchAudioPanel } from "./audioCalibration.ts";
import { createWorkbenchAvatarPanel } from "./avatarStudio.ts";
import { renderWorkbenchPolicyPanel } from "./policyComposer.ts";
import { renderWorkbenchXrayPanel } from "./turnXray.ts";

declare global {
  interface Window {
    workbench: WorkbenchBridge;
  }
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing Workbench DOM element #${id}.`);
  return el as T;
}

const titleEl = requireEl<HTMLElement>("wb-title");
const subtitleEl = requireEl<HTMLElement>("wb-subtitle");
const statusEl = requireEl<HTMLElement>("wb-status");
const refreshBtn = requireEl<HTMLButtonElement>("wb-refresh");
const panelMap: Record<WorkbenchTab, HTMLElement> = {
  missions: requireEl<HTMLElement>("panel-missions"),
  memory: requireEl<HTMLElement>("panel-memory"),
  policy: requireEl<HTMLElement>("panel-policy"),
  xray: requireEl<HTMLElement>("panel-xray"),
  audio: requireEl<HTMLElement>("panel-audio"),
  avatar: requireEl<HTMLElement>("panel-avatar"),
};
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".wb-nav-btn"));

let activeTab: WorkbenchTab = "missions";
let lastMc: MissionControlSnapshot | null = null;
let lastPolicy: PolicyComposerSnapshot | null = null;
let lastXray: TurnXraySnapshot | null = null;
let lastAvatar: AvatarStudioSnapshot | null = null;
const xrayState = { selectedTurnId: null as string | null };

const setStatus = (msg: string): void => {
  statusEl.textContent = msg;
};

const avatarPanel = createWorkbenchAvatarPanel(
  panelMap.avatar,
  window.workbench.studioTools,
  setStatus,
);

function selectTab(next: WorkbenchTab): void {
  activeTab = next;
  const meta = WORKBENCH_TABS.find((t) => t.id === next);
  titleEl.textContent = meta?.label ?? "Workbench";
  for (const btn of navButtons) {
    const match = btn.dataset.tab === next;
    btn.classList.toggle("active", match);
    btn.setAttribute("aria-selected", String(match));
  }
  (Object.keys(panelMap) as WorkbenchTab[]).forEach((key) => {
    panelMap[key].hidden = key !== next;
  });
  avatarPanel.setActive(next === "avatar");
}

for (const btn of navButtons) {
  btn.addEventListener("click", () => {
    const tab = (btn.dataset.tab as WorkbenchTab) || "missions";
    selectTab(tab);
  });
}

window.workbench.onSelectTab((tab) => {
  selectTab(tab);
  void refresh();
});

function renderAll(): void {
  if (!lastMc || !lastPolicy || !lastXray || !lastAvatar) return;

  subtitleEl.textContent =
    `${lastMc.missions.length} missions · ${lastMc.memories.length} memories · ` +
    `${lastXray.turns.length} turns · ${lastMc.standingOrders.length} orders`;

  renderMissionsPanel(panelMap.missions, lastMc.missions, async (id, action) => {
    const res = await window.workbench.missionControl.actMission(id, action);
    setStatus(res.message);
    await refresh();
    if (res.ok && (action === "approve" || action === "resume")) {
      setTimeout(() => {
        if (!refreshBtn.disabled) void refresh();
      }, 450);
    }
  });

  renderMemoryPanel(panelMap.memory, lastMc.memories, lastMc.episodes, lastMc.thresholds, {
    onUpsertMemory: async (input) => {
      const res = await window.workbench.missionControl.upsertMemory(input);
      setStatus(res.message);
      await refresh();
    },
    onPinMemory: async (id, pinned) => {
      const res = await window.workbench.missionControl.pinMemory(id, pinned);
      setStatus(res.message);
      await refresh();
    },
    onDeleteMemory: async (id) => {
      const res = await window.workbench.missionControl.deleteMemory(id);
      setStatus(res.message);
      await refresh();
    },
    onDeleteEpisode: async (id) => {
      const res = await window.workbench.missionControl.deleteEpisode(id);
      setStatus(res.message);
      await refresh();
    },
  });

  renderWorkbenchPolicyPanel(panelMap.policy, lastPolicy, lastMc, {
    studio: window.workbench.studioTools,
    setStatus,
    refresh,
    onVerifyPolicies: async () => {
      const graph = await window.workbench.missionControl.verifyPolicies();
      setStatus(
        graph.ok ? "Policy check clean." : `${graph.counts.critical} critical policy finding(s).`,
      );
      if (lastMc) {
        lastMc = { ...lastMc, policyGraph: graph };
        renderAll();
      }
      return graph;
    },
    onCancelOrder: async (id) => {
      const res = await window.workbench.missionControl.cancelStandingOrder(id);
      setStatus(res.message);
      await refresh();
    },
    onSkillAction: async (id, action) => {
      const res = await window.workbench.missionControl.setSkillStatus(id, action);
      setStatus(res.message);
      await refresh();
    },
    onRunReplay: (bundlePath) => window.workbench.missionControl.inspectReplay(bundlePath),
  });

  renderWorkbenchXrayPanel(panelMap.xray, lastXray, xrayState, {
    studio: window.workbench.studioTools,
    setStatus,
    refresh,
  });

  avatarPanel.update(lastAvatar);
}

async function refresh(): Promise<void> {
  refreshBtn.disabled = true;
  try {
    const [mc, policy, xray, avatar] = await Promise.all([
      window.workbench.missionControl.getSnapshot(),
      window.workbench.studioTools.getPolicyComposerSnapshot(),
      window.workbench.studioTools.getTurnXraySnapshot(),
      window.workbench.studioTools.getAvatarStudioSnapshot(),
    ]);
    lastMc = mc;
    lastPolicy = policy;
    lastXray = xray;
    lastAvatar = avatar;
    renderAll();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", () => {
  void refresh();
});

renderWorkbenchAudioPanel(panelMap.audio, window.workbench.studioTools, setStatus);

selectTab(activeTab);
void refresh();
