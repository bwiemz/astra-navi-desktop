import "./style.css";
import type { MissionControlBridge, MissionControlSnapshot } from "../../../shared/missionControl.ts";
import { renderMemoryPanel } from "./memory.ts";
import { renderMissionsPanel } from "./missions.ts";
import { renderPolicyReplayPanel } from "./policyReplay.ts";

declare global {
  interface Window {
    missionControl: MissionControlBridge;
  }
}

type TabKey = "missions" | "memory" | "policy";

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing Mission Control DOM element #${id}.`);
  return el as T;
}

const statusEl = requireEl<HTMLElement>("mc-status");
const subtitleEl = requireEl<HTMLElement>("mc-subtitle");
const refreshBtn = requireEl<HTMLButtonElement>("mc-refresh");
const panelMissions = requireEl<HTMLElement>("panel-missions");
const panelMemory = requireEl<HTMLElement>("panel-memory");
const panelPolicy = requireEl<HTMLElement>("panel-policy");
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mc-tab"));

let activeTab: TabKey = "missions";
let currentSnapshot: MissionControlSnapshot | null = null;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function selectTab(next: TabKey): void {
  activeTab = next;
  for (const btn of tabButtons) {
    const isMatch = btn.dataset.tab === next;
    btn.classList.toggle("active", isMatch);
    btn.setAttribute("aria-selected", String(isMatch));
  }
  panelMissions.hidden = next !== "missions";
  panelMemory.hidden = next !== "memory";
  panelPolicy.hidden = next !== "policy";
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => {
    const key = (btn.dataset.tab as TabKey) || "missions";
    selectTab(key);
  });
}

function render(snapshot: MissionControlSnapshot): void {
  currentSnapshot = snapshot;
  subtitleEl.textContent =
    `${snapshot.missions.length} missions · ${snapshot.memories.length} memories · ` +
    `${snapshot.episodes.length} episodes · updated ${snapshot.generatedAt.slice(11, 19)}`;

  renderMissionsPanel(panelMissions, snapshot.missions, async (id, action) => {
    const res = await window.missionControl.actMission(id, action);
    setStatus(res.message);
    await refresh();
  });

  renderMemoryPanel(
    panelMemory,
    snapshot.memories,
    snapshot.episodes,
    snapshot.thresholds,
    {
      onUpsertMemory: async (input) => {
        const res = await window.missionControl.upsertMemory(input);
        setStatus(res.message);
        await refresh();
      },
      onPinMemory: async (id, pinned) => {
        const res = await window.missionControl.pinMemory(id, pinned);
        setStatus(res.message);
        await refresh();
      },
      onDeleteMemory: async (id) => {
        const res = await window.missionControl.deleteMemory(id);
        setStatus(res.message);
        await refresh();
      },
      onDeleteEpisode: async (id) => {
        const res = await window.missionControl.deleteEpisode(id);
        setStatus(res.message);
        await refresh();
      },
    },
  );

  renderPolicyReplayPanel(
    panelPolicy,
    snapshot.policyGraph,
    snapshot.standingOrders,
    snapshot.compiledSkills,
    snapshot.recentTurns,
    {
      onVerifyPolicies: async () => {
        const graph = await window.missionControl.verifyPolicies();
        setStatus(
          graph.ok
            ? "Policy check clean."
            : `${graph.counts.critical} critical policy finding(s).`,
        );
        if (currentSnapshot) {
          currentSnapshot = { ...currentSnapshot, policyGraph: graph };
          render(currentSnapshot);
        }
        return graph;
      },
      onCancelOrder: async (id) => {
        const res = await window.missionControl.cancelStandingOrder(id);
        setStatus(res.message);
        await refresh();
      },
      onSkillAction: async (id, action) => {
        const res = await window.missionControl.setSkillStatus(id, action);
        setStatus(res.message);
        await refresh();
      },
      onRunReplay: async (bundlePath) => {
        const res = await window.missionControl.inspectReplay(bundlePath);
        setStatus(res.message);
        return res;
      },
    },
  );
  selectTab(activeTab);
}

async function refresh(): Promise<void> {
  refreshBtn.disabled = true;
  setStatus("Refreshing…");
  try {
    const snap = await window.missionControl.getSnapshot();
    render(snap);
    setStatus("Snapshot synced");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", () => {
  void refresh();
});

void refresh();
