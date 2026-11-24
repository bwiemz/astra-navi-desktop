import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import { buildContextBucket, EpisodicGraph } from "../src/core/episodic.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { ApprovalDesk } from "../src/core/missionApproval.ts";
import { MissionBoard, planMission } from "../src/core/missionPlan.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { CompiledSkillStore, synthesizeSkillFromTrajectories } from "../src/core/skillCompiler.ts";
import { makeOrder, StandingOrders } from "../src/core/standingOrders.ts";
import { HerStore } from "../src/core/store.ts";
import { TraceKeeper } from "../src/core/trace.ts";
import {
  buildMissionDagEdges,
  buildPolicyConflictGraph,
} from "../src/shared/missionControl.ts";

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
let windowCreateCount = 0;
let lastCreatedWindow: {
  webContents: {
    id: number;
    setWindowOpenHandler: (fn: unknown) => void;
    on: (ev: string, fn: unknown) => void;
    once: (ev: string, fn: () => void) => void;
    send: (ch: string, ...args: unknown[]) => void;
  };
  removeMenu: () => void;
  once: (ev: string, fn: () => void) => void;
  on: (ev: string, fn: () => void) => void;
  loadURL: (url: string) => Promise<void>;
  isDestroyed: () => boolean;
  show: () => void;
  focus: () => void;
} | null = null;

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  BrowserWindow: class MockBrowserWindow {
    webContents = {
      id: 42,
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      once: (_ev: string, fn: () => void) => fn(),
      send: () => undefined,
    };
    removeMenu = () => undefined;
    once = () => undefined;
    on = () => undefined;
    loadURL = async () => undefined;
    isDestroyed = () => false;
    show = () => undefined;
    focus = () => undefined;
    setWindowInstance(win: typeof lastCreatedWindow): void {
      windowCreateCount += 1;
      lastCreatedWindow = win;
    }
    constructor() {
      this.setWindowInstance(this);
    }
  },
}));

const tempDirs: string[] = [];
const openStores: HerStore[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-chan-mc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  ipcHandlers.clear();
  lastCreatedWindow = null;
  windowCreateCount = 0;
  while (openStores.length > 0) {
    openStores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Mission Control & Memory Inspector backend", () => {
  it("builds DAG edges and policy conflict graphs cleanly", () => {
    const edges = buildMissionDagEdges([{ retries: 0 }, { retries: 2 }, { retries: 0 }]);
    expect(edges).toEqual([
      { fromStep: 0, toStep: 1, relation: "depends" },
      { fromStep: 1, toStep: 2, relation: "retry-gate" },
    ]);

    const graph = buildPolicyConflictGraph({
      ok: false,
      counts: { critical: 1, warning: 0, info: 0 },
      findings: [
        {
          code: "STANDING_ORDER_TARGET_DRIFT",
          severity: "critical",
          subject: "order-1",
          message: "Order target drift",
          remediation: "Re-pin host",
        },
      ],
      orderIds: ["order-1"],
      skillSlugs: ["disk-check"],
    });
    expect(graph.ok).toBe(false);
    expect(graph.nodes.some((n) => n.id === "order:order-1")).toBe(true);
    expect(graph.edges).toContainEqual({
      from: "order:order-1",
      to: "finding:0:STANDING_ORDER_TARGET_DRIFT",
      relation: "critical",
    });
  });

  it("supports memory pinning, episodic listing/deletion, skill revocation, mission pause/rollback, and authorized IPC", async () => {
    const dir = await makeTempDir();
    const cfg = new ConfigStore(join(dir, "config.json"));
    await cfg.load();

    const store = new HerStore(":memory:");
    openStores.push(store);
    const episodic = new EpisodicGraph(store, { now: () => new Date("2026-11-23T10:00:00Z") });
    const bucket = buildContextBucket({ mode: "focus", app: "code", hour: 10 });
    const epId = episodic.recordEpisode({
      kind: "proactive_alert",
      contextBucket: bucket,
      activeApp: "code",
      mode: "focus",
      summary: "GPU temperature warning",
    });
    episodic.recordReaction(epId, { kind: "acted", delayMs: 800 });
    expect(episodic.listRecent(10)).toHaveLength(1);
    expect(episodic.listThresholds()).toHaveLength(1);

    const memory = new MemoryStore(join(dir, "memory.json"));
    await memory.load();
    const { memory: memA } = await memory.save({ kind: "fact", text: "Server lives at 192.168.1.10." });
    const pinned = await memory.pin(memA.id, true);
    expect(pinned?.pinned).toBe(true);
    expect(memory.get(memA.id)?.pinned).toBe(true);

    const skills = new CompiledSkillStore(join(dir, "skills.json"));
    await skills.load();
    const synth = synthesizeSkillFromTrajectories([
      {
        taskKey: "check_logs",
        title: "Read server logs",
        at: "2026-11-23T08:00:00Z",
        steps: [{ tool: TOOLS.readFile, args: { path: "notes/a.txt" }, ok: true, grantedCapabilities: ["fs.read.workspace"] }],
      },
      {
        taskKey: "check_logs",
        title: "Read server logs",
        at: "2026-11-23T09:00:00Z",
        steps: [{ tool: TOOLS.readFile, args: { path: "notes/b.txt" }, ok: true, grantedCapabilities: ["fs.read.workspace"] }],
      },
      {
        taskKey: "check_logs",
        title: "Read server logs",
        at: "2026-11-23T10:00:00Z",
        steps: [{ tool: TOOLS.readFile, args: { path: "notes/c.txt" }, ok: true, grantedCapabilities: ["fs.read.workspace"] }],
      },
    ]);
    expect(synth.ok).toBe(true);
    if (!synth.ok) throw new Error("synth failed");
    await skills.propose(synth.skill);
    await skills.ratify(synth.skill.id);
    const revoked = await skills.revoke(synth.skill.id);
    expect(revoked.status).toBe("revoked");

    const orders = new StandingOrders(join(dir, "orders.json"), {
      store,
      read: async () => ({ ok: true, text: "ok" }),
      onNews: () => undefined,
    });
    const ordRes = makeOrder(
      {
        title: "Check disk",
        where: "here",
        command: "df -h",
        tellWhen: "contains",
        value: "95%",
        everyMinutes: 10,
      },
      [],
      new Date("2026-11-23T10:00:00Z"),
    );
    if ("problem" in ordRes) throw new Error(ordRes.problem);
    await orders.add(ordRes.order);

    let deskResolve: ((ans: boolean | null) => void) | null = null;
    const desk = new ApprovalDesk({
      showAtPc: async () =>
        await new Promise<boolean | null>((resolve) => {
          deskResolve = resolve;
        }),
    });

    const board = new MissionBoard({
      file: join(dir, "missions.json"),
      judge: async () => ({ decision: "allow" }),
      fingerprint: (s) => `${s.where}:${s.command}`,
      run: async () => ({ ok: false, output: "step failed output" }),
      ask: (q, sig) => desk.ask(q, sig),
      tell: () => undefined,
    });
    await board.load();

    const missionRes = planMission(
      {
        title: "Nightly check",
        goal: "Run health check",
        steps: [{ title: "Step 1", where: "here", command: "uname -a", retries: 0 }],
      },
      [],
      new Date("2026-11-23T10:00:00Z"),
    );
    if ("problem" in missionRes) throw new Error(missionRes.problem);
    const mission = missionRes.mission;
    await board.add(mission);
    // Allow mission step to transition cleanly before rollback/pause assertions
    await new Promise((r) => setTimeout(r, 40));

    expect(await board.rollback(mission.id)).toBe(true);
    expect(board.get(mission.id)?.state).toBe("blocked");
    expect(board.get(mission.id)?.steps[0]?.state).toBe("waiting");

    const traces = new TraceKeeper(10);
    traces.add({
      at: "2026-11-23T10:01:00Z",
      kind: "user",
      said: "Read notes/a.txt",
      spoken: false,
      brain: "Small (Qwen3.5 4B)",
      offered: [TOOLS.readFile],
      calls: [
        {
          tool: TOOLS.readFile,
          input: JSON.stringify({ path: "notes/a.txt" }),
          result: "hello",
          outcome: "done",
          asked: false,
          ms: 5,
          gate: "allow",
        },
      ],
      reply: "Read notes/a.txt",
      checks: [],
      withheld: false,
      ms: { whole: 10, firstWord: 5 },
      tokens: { read: 100, written: 20, held: 120 },
    });

    const { buildMissionControlSnapshot } = await import("../src/main/missionControlIpc.ts");
    const { createWorkbenchController } = await import("../src/main/workbenchIpc.ts");

    const deps = {
      appOrigin: "astranavi://app",
      config: cfg,
      dataDir: () => join(dir, ".data"),
      workspaceDir: dir,
      board: () => board,
      approvalDesk: () => desk,
      memoryStore: () => memory,
      episodic: () => episodic,
      orders: () => orders,
      skills: () => skills,
      traces,
      recall: () => null,
      brain: () => null,
    };

    const snap = buildMissionControlSnapshot(deps);
    expect(snap.missions).toHaveLength(1);
    expect(snap.memories).toHaveLength(1);
    expect(snap.memories[0]?.pinned).toBe(true);
    expect(snap.episodes).toHaveLength(1);
    expect(snap.standingOrders).toHaveLength(1);
    expect(snap.compiledSkills[0]?.status).toBe("revoked");
    expect(snap.recentTurns).toHaveLength(1);

    const controller = createWorkbenchController(deps);
    controller.registerIpc();
    controller.open("missions");
    controller.open("avatar");
    expect(lastCreatedWindow).not.toBeNull();
    // Opening different Workbench tabs reuses ONE BrowserWindow instance
    expect(windowCreateCount).toBe(1);
    expect(controller.activeTab()).toBe("avatar");

    // Unauthorized sender must be rejected
    const fakeSender = { sender: { id: 999 } };
    const snapHandler = ipcHandlers.get("mc:snapshot");
    if (!snapHandler) throw new Error("missing mc:snapshot handler");
    expect(() => snapHandler(fakeSender)).toThrow("Unauthorized");

    // Authorized Mission Control sender succeeds & runs replay
    if (!lastCreatedWindow) throw new Error("missing mock BrowserWindow");
    const authorizedEvent = { sender: lastCreatedWindow.webContents };
    const authSnap = snapHandler(authorizedEvent) as ReturnType<typeof buildMissionControlSnapshot>;
    expect(authSnap.missions[0]?.id).toBe(mission.id);

    const epDelHandler = ipcHandlers.get("mc:episode-delete");
    if (!epDelHandler) throw new Error("missing mc:episode-delete handler");
    const epDel = epDelHandler(authorizedEvent, epId) as { ok: boolean };
    expect(epDel.ok).toBe(true);
    expect(episodic.listRecent(10)).toHaveLength(0);

    const replayHandler = ipcHandlers.get("mc:replay-inspect");
    if (!replayHandler) throw new Error("missing mc:replay-inspect handler");
    const replayRes = (await replayHandler(authorizedEvent)) as {
      ok: boolean;
      report: { totalCalls: number; matched: number; drifted: number } | null;
    };
    expect(replayRes.ok).toBe(true);
    expect(replayRes.report?.totalCalls).toBe(1);
    expect(replayRes.report?.matched).toBe(1);
    expect(replayRes.report?.drifted).toBe(0);

    // Path traversal out of <dataDir>/replays must be refused
    const badPathRes = (await replayHandler(authorizedEvent, "../secret.gz")) as {
      ok: boolean;
      message: string;
    };
    expect(badPathRes.ok).toBe(false);
    expect(badPathRes.message).toContain("Refused");

    // Audio & AEC calibration handler enforces sender authorization & returns clean report
    const aecHandler = ipcHandlers.get("studio:run-room-calibration");
    if (!aecHandler) throw new Error("missing studio:run-room-calibration handler");
    expect(() => aecHandler(fakeSender, { mode: "synthetic" })).toThrow("Unauthorized");
    const aecRes = aecHandler(authorizedEvent, { mode: "synthetic" }) as {
      erleDb: number;
      bargeInReady: boolean;
      wakePassRate: number;
    };
    expect(aecRes.erleDb).toBeGreaterThanOrEqual(10);
    expect(aecRes.bargeInReady).toBe(true);
    expect(aecRes.wakePassRate).toBe(1);

    if (deskResolve) (deskResolve as (ans: boolean | null) => void)(false);
    await board.dispose();
  });
});
