import type { MissionControlBridge } from "./missionControl.ts";
import type { StudioToolsBridge } from "./studioTools.ts";
import type { Wave2Bridge } from "./wave2Control.ts";

/**
 * Shared navigation & IPC contract for the unified tabbed Workbench window (`workbench.html`).
 * Replaces four separate secondary Electron windows with one shared Chromium process.
 */

export type WorkbenchTab =
  | "missions"
  | "memory"
  | "policy"
  | "xray"
  | "audio"
  | "avatar"
  | "extensions";

export interface WorkbenchTabMeta {
  id: WorkbenchTab;
  label: string;
  shortDesc: string;
}

export const WORKBENCH_TABS: readonly WorkbenchTabMeta[] = [
  { id: "missions", label: "Missions", shortDesc: "Multi-step DAGs & checkpoints" },
  { id: "memory", label: "Memory Graph", shortDesc: "Semantic notes & episodic thresholds" },
  { id: "policy", label: "Policy Composer", shortDesc: "Standing orders, rules & replay" },
  { id: "xray", label: "Turn X-Ray", shortDesc: "Latency, tokens & conflicts" },
  { id: "audio", label: "Audio & AEC", shortDesc: "Room echo, barge-in & wake gate" },
  { id: "avatar", label: "Avatar Studio", shortDesc: "Stage framing, lighting & props" },
  { id: "extensions", label: "Extensions & Sync", shortDesc: "Vault RAG, LAN peers & plugins" },
];

export interface WorkbenchBridge {
  missionControl: MissionControlBridge;
  studioTools: StudioToolsBridge;
  wave2: Wave2Bridge;
  onSelectTab(cb: (tab: WorkbenchTab) => void): () => void;
}
