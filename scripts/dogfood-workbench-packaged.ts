import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigStore } from "../src/core/config.ts";
import { buildContextBucket, EpisodicGraph } from "../src/core/episodic.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { planMission } from "../src/core/missionPlan.ts";
import {
  configFile,
  dataDir,
  memoryFile,
  missionsFile,
  ordersFile,
  storeFile,
  workspaceDir,
} from "../src/core/paths.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { makeOrder } from "../src/core/standingOrders.ts";
import { HerStore } from "../src/core/store.ts";
import type { TurnTrace } from "../src/core/trace.ts";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function sampleGpu(): Promise<{ utilPct: number | null; memMiB: number | null }> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
      { timeout: 4000 },
    );
    const first = stdout.trim().split("\n")[0] ?? "";
    const [utilStr, memStr] = first.split(",").map((s) => s.trim());
    const utilPct = utilStr ? Number(utilStr) : null;
    const memMiB = memStr ? Number(memStr) : null;
    return {
      utilPct: utilPct !== null && Number.isFinite(utilPct) ? utilPct : null,
      memMiB: memMiB !== null && Number.isFinite(memMiB) ? memMiB : null,
    };
  } catch {
    return { utilPct: null, memMiB: null };
  }
}

class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (err: Error) => void }
  >();
  readonly consoleErrors: string[] = [];
  readonly pageExceptions: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      let msg: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP error"));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const details = msg.params?.exceptionDetails as { text?: string } | undefined;
        this.pageExceptions.push(details?.text ?? JSON.stringify(msg.params));
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const kind = msg.params?.type;
        if (kind === "error") {
          const args = Array.isArray(msg.params?.args) ? msg.params.args : [];
          this.consoleErrors.push(
            args
              .map((a: { value?: unknown; description?: string }) =>
                String(a.value ?? a.description ?? ""),
              )
              .join(" "),
          );
        }
      } else if (msg.method === "Log.entryAdded") {
        const entry = msg.params?.entry as { level?: string; text?: string } | undefined;
        if (entry?.level === "error") {
          this.consoleErrors.push(entry.text ?? "Log.entryAdded error");
        }
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolveConn, rejectConn) => {
      ws.addEventListener("open", () => resolveConn(), { once: true });
      ws.addEventListener("error", () => rejectConn(new Error(`Failed to open CDP WebSocket: ${wsUrl}`)), {
        once: true,
      });
    });
    const client = new CdpClient(ws);
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    return client;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const res = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "CDP evaluate exception",
      );
    }
    return res.result?.value as T;
  }

  async exec(expression: string): Promise<void> {
    await this.eval<unknown>(expression);
  }

  async waitFor<T>(fnExpr: string, timeoutMs = 12_000, label = fnExpr): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.eval<T>(fnExpr);
      if (value) return value;
      await pause(120);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
  }

  close(): void {
    this.ws.close();
  }
}

async function seedIsolatedState(): Promise<{ wsDir: string; stepFlagFile: string }> {
  const dir = dataDir();
  const wsDir = workspaceDir();
  await rm(dir, { recursive: true, force: true });
  await rm(wsDir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await mkdir(wsDir, { recursive: true });

  const cfg = new ConfigStore(configFile());
  await cfg.load();
  await cfg.update({
    onboardingComplete: true,
    language: "en",
    handsOff: false,
    morningBriefing: false,
    voice: {
      ...cfg.value.voice,
      speak: "never",
      alwaysListening: false,
      otherNames: ["Computer"],
    },
  });

  const memory = new MemoryStore(memoryFile());
  await memory.load();
  await memory.save({ kind: "fact", text: "NAS host runs at 192.168.50.3." });
  await memory.save({ kind: "fact", text: "NAS host runs at 192.168.50.99." });
  await memory.save({ kind: "preference", text: "Prefer concise technical status replies." });

  const sqlite = new HerStore(storeFile());
  try {
    const episodic = new EpisodicGraph(sqlite);
    const bucket = buildContextBucket({ mode: "focus", app: "code", hour: 14 });
    const epId = episodic.recordEpisode({
      kind: "proactive_alert",
      contextBucket: bucket,
      activeApp: "code",
      mode: "focus",
      summary: "Container memory reached 84%",
    });
    episodic.recordReaction(epId, { kind: "acted", delayMs: 650 });
  } finally {
    sqlite.close();
  }

  const stepFlagFile = join(wsDir, "dogfood-step.txt");
  const planned = planMission(
    {
      title: "Dogfood Verification Mission",
      goal: "Approve step in Workbench UI and execute workspace touch command",
      steps: [
        {
          title: "Write dogfood marker",
          where: "here",
          command: "touch dogfood-step.txt",
          retries: 0,
        },
      ],
    },
    [],
    new Date("2026-11-24T12:00:00Z"),
  );
  if ("problem" in planned) throw new Error(planned.problem);
  await writeFile(
    missionsFile(),
    `${JSON.stringify({ version: 1, missions: [planned.mission] }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const ord = makeOrder(
    {
      title: "Workspace Disk Watch",
      where: "here",
      command: "df -h",
      tellWhen: "contains",
      value: "95%",
      everyMinutes: 15,
    },
    [],
    new Date("2026-11-24T12:00:00Z"),
  );
  if ("problem" in ord) throw new Error(ord.problem);
  await writeFile(
    ordersFile(),
    `${JSON.stringify({ version: 1, orders: [ord.order] }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const seededTraces: TurnTrace[] = [
    {
      at: "2026-11-24T12:05:00.000Z",
      kind: "user",
      said: "Read dogfood notes",
      spoken: false,
      brain: "Small (Qwen3.5 4B)",
      offered: [TOOLS.readFile, TOOLS.runCommand],
      pickedFor: { [TOOLS.readFile]: "words" },
      calls: [
        {
          tool: TOOLS.readFile,
          input: JSON.stringify({ path: "notes.txt" }),
          result: "ok",
          outcome: "done",
          asked: false,
          ms: 12,
          gate: "allow",
        },
      ],
      reply: "Checked notes.txt cleanly.",
      checks: [],
      withheld: false,
      ms: { whole: 420, firstWord: 140, stt: null, llm: 390, tools: 12, tts: null },
      tokens: { read: 240, written: 45, held: 285, prompt: 240 },
    },
  ];
  await writeFile(join(dir, "dogfood-traces.json"), JSON.stringify(seededTraces, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  return { wsDir, stepFlagFile };
}

async function waitForWorkbenchCdpUrl(port = 9229, timeoutMs = 25_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = (await res.json()) as {
          type?: string;
          url?: string;
          webSocketDebuggerUrl?: string;
        }[];
        const target = list.find(
          (entry) =>
            entry.url?.includes("workbench.html") && Boolean(entry.webSocketDebuggerUrl),
        );
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch {
      // CDP server still coming up.
    }
    await pause(200);
  }
  throw new Error(`Timed out waiting for workbench.html CDP target on port ${port}.`);
}

async function main(): Promise<void> {
  const binPath = resolve(ROOT, "dist", "linux-unpacked", "astra-navi-desktop");
  assert(
    existsSync(binPath),
    `Packaged binary not found at ${binPath}. Run 'npm run build && npx electron-builder --linux dir --publish never' first.`,
  );

  const { stepFlagFile } = await seedIsolatedState();

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const mainErrors: string[] = [];

  const child = spawn(
    binPath,
    [
      "--remote-debugging-port=9229",
      "--no-sandbox",
      "--enable-features=UseOzonePlatform",
      "--ozone-platform=wayland",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ASTRA_NAVI_DOGFOOD_WORKBENCH: "1",
        ASTRA_NAVI_OZONE: "wayland",
        XDG_SESSION_TYPE: "wayland",
        AI_CHAN_NO_VIRTUAL_INPUT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdoutLines.push(text);
    if (/unhandledRejection|uncaughtException|FATAL:/i.test(text)) {
      mainErrors.push(text.trim());
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrLines.push(text);
    if (/unhandledRejection|uncaughtException|FATAL:/i.test(text)) {
      mainErrors.push(text.trim());
    }
  });

  let cdp: CdpClient | null = null;
  try {
    const wsUrl = await waitForWorkbenchCdpUrl(9229, 25_000);
    cdp = await CdpClient.connect(wsUrl);

    // 1. Missions tab: wait for seeded DAG & click Approve Step
    const approveSeen = await cdp.waitFor<boolean>(
      `(() => {
        const panel = document.getElementById('panel-missions');
        if (!panel) return false;
        const hasSvg = Boolean(panel.querySelector('svg'));
        const approveBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Approve Step');
        if (!hasSvg || !approveBtn) return false;
        approveBtn.click();
        return true;
      })()`,
      15_000,
      "Missions DAG + Approve Step button",
    );
    assert(approveSeen, "Approve Step button not clicked");

    await cdp.waitFor<boolean>(
      `(() => {
        const panel = document.getElementById('panel-missions');
        const text = panel?.textContent ?? '';
        return text.includes('completed') || text.includes('done');
      })()`,
      10_000,
      "Mission transition to completed/done",
    );
    const markerDeadline = Date.now() + 5000;
    while (!existsSync(stepFlagFile) && Date.now() < markerDeadline) await pause(100);
    assert(existsSync(stepFlagFile), `Approved mission step did not create ${stepFlagFile}`);

    // 2. Memory Graph tab: Add -> Edit -> Save -> Delete
    await cdp.exec(`document.querySelector('button.wb-nav-btn[data-tab="memory"]').click()`);
    await cdp.waitFor<boolean>(
      `document.querySelectorAll('#panel-memory .list-row').length >= 2`,
      8_000,
      "Memory Graph populated rows",
    );
    await cdp.exec(`(() => {
      const panel = document.getElementById('panel-memory');
      const input = panel.querySelector('input[type="text"]');
      input.value = 'Packaged dogfood note alpha.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const addBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add Memory');
      addBtn.click();
    })()`);
    await cdp.waitFor<boolean>(
      `document.getElementById('panel-memory').textContent.includes('Packaged dogfood note alpha.')`,
      8_000,
      "Added memory rendered",
    );
    await cdp.exec(`(() => {
      const rows = Array.from(document.querySelectorAll('#panel-memory .list-row'));
      const target = rows.find((r) => r.textContent.includes('Packaged dogfood note alpha.'));
      const editBtn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Edit');
      editBtn.click();
    })()`);
    await cdp.waitFor<boolean>(
      `(() => {
        const ta = document.querySelector('#panel-memory textarea');
        if (!ta) return false;
        ta.value = 'Packaged dogfood note beta.';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const saveBtn = Array.from(ta.parentElement.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save');
        saveBtn.click();
        return true;
      })()`,
      6_000,
      "Memory edit textarea + Save",
    );
    await cdp.waitFor<boolean>(
      `document.getElementById('panel-memory').textContent.includes('Packaged dogfood note beta.')`,
      8_000,
      "Edited memory rendered",
    );
    await cdp.exec(`(() => {
      const rows = Array.from(document.querySelectorAll('#panel-memory .list-row'));
      const target = rows.find((r) => r.textContent.includes('Packaged dogfood note beta.'));
      const delBtn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Delete');
      delBtn.click();
    })()`);
    await cdp.waitFor<boolean>(
      `!document.getElementById('panel-memory').textContent.includes('Packaged dogfood note beta.')`,
      8_000,
      "Deleted memory removed",
    );

    // 3. Policy Composer tab: Preview -> Re-Verify Rules -> Policy Replay
    await cdp.exec(`document.querySelector('button.wb-nav-btn[data-tab="policy"]').click()`);
    await cdp.waitFor<boolean>(
      `Boolean(document.querySelector('#panel-policy svg[aria-label="Policy conflict graph"]'))`,
      8_000,
      "Policy conflict graph SVG",
    );
    await cdp.exec(`(() => {
      const panel = document.getElementById('panel-policy');
      const titleInput = panel.querySelector('input[placeholder*="NAS pool"]');
      const cmdInput = panel.querySelector('input[placeholder*="df -h"]');
      titleInput.value = 'Check Workspace';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      cmdInput.value = 'df -h';
      cmdInput.dispatchEvent(new Event('input', { bubbles: true }));
      const previewBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Validate Preview');
      previewBtn.click();
    })()`);
    await cdp.waitFor<boolean>(
      `document.getElementById('panel-policy').textContent.includes('Valid Read-Only Rule')`,
      8_000,
      "Validate Preview output",
    );
    await cdp.exec(`(() => {
      const panel = document.getElementById('panel-policy');
      const verifyBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Re-Verify Rules');
      verifyBtn.click();
    })()`);
    await cdp.waitFor<boolean>(
      `document.getElementById('wb-status')?.textContent?.includes('Policy check') || document.getElementById('wb-status')?.textContent?.includes('critical policy')`,
      6_000,
      "Re-Verify Rules completion",
    );
    await cdp.exec(`(() => {
      const panel = document.getElementById('panel-policy');
      const replayBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Re-Evaluate Live Turns Against Policy');
      replayBtn.click();
    })()`);
    const replaySummary = await cdp.waitFor<string>(
      `(() => {
        const text = document.getElementById('panel-policy')?.textContent ?? '';
        const match = text.match(/Replayed\\s+\\d+\\s+turn\\(s\\),\\s+\\d+\\s+call\\(s\\):\\s+\\d+\\s+matched,\\s+\\d+\\s+drifted\\./i);
        return match ? match[0] : '';
      })()`,
      8_000,
      "Deterministic replay summary",
    );
    assert(!/drifted/i.test(replaySummary) || /\b0 drifted\b/i.test(replaySummary), `Unexpected replay drift: ${replaySummary}`);

    // 4. Turn X-Ray tab: Waterfall + context token meter
    await cdp.exec(`document.querySelector('button.wb-nav-btn[data-tab="xray"]').click()`);
    const xrayOk = await cdp.waitFor<boolean>(
      `(() => {
        const text = document.getElementById('panel-xray')?.textContent ?? '';
        return Boolean(document.querySelector('#panel-xray .turn-item')) &&
          text.includes('Latency Waterfall') &&
          text.includes('Context Token Budget');
      })()`,
      8_000,
      "Turn X-Ray waterfall & budget",
    );
    assert(xrayOk, "Turn X-Ray failed to render");

    // 5. Audio & AEC tab: Synthetic AEC & Wake Self-Test
    await cdp.exec(`document.querySelector('button.wb-nav-btn[data-tab="audio"]').click()`);
    await cdp.exec(
      `document.querySelector('#panel-audio button[data-action="run-synthetic-calibration"]').click()`,
    );
    const aecText = await cdp.waitFor<string>(
      `(() => {
        const box = document.querySelector('#panel-audio [data-testid="aec-report"]');
        const txt = box?.textContent ?? '';
        return txt.includes('Barge-In Ready') && txt.includes('Wake 100%') ? txt : '';
      })()`,
      8_000,
      "Audio & AEC self-test report",
    );
    const erleMatch = /ERLE\s+([0-9]+(?:\.[0-9]+)?)\s*dB/i.exec(aecText);
    const erleDb = erleMatch ? Number(erleMatch[1]) : 0;
    assert(erleDb >= 10, `Expected synthetic ERLE >= 10 dB, got ${erleDb}`);

    // 6. Avatar Studio tab & rAF suspension proof
    await cdp.exec(`(() => {
      window.__rafCount = 0;
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => orig((ts) => {
        window.__rafCount += 1;
        cb(ts);
      });
    })()`);
    await cdp.exec(`document.querySelector('button.wb-nav-btn[data-tab="avatar"]').click()`);
    await pause(650);
    const activeRafFrames = await cdp.eval<number>(`window.__rafCount`);
    assert(activeRafFrames >= 5, `Expected activeRafFrames >= 5 on Avatar tab, got ${activeRafFrames}`);

    await cdp.exec(`(() => {
      const waveBtn = Array.from(document.querySelectorAll('#panel-avatar button')).find((b) => b.textContent?.trim() === 'Wave');
      if (waveBtn) waveBtn.click();
    })()`);
    const gpuOnAvatar = await sampleGpu();

    await cdp.exec(`document.querySelector('button.wb-nav-btn[data-tab="missions"]').click()`);
    await pause(250);
    await cdp.exec(`(() => { window.__rafCount = 0; })()`);
    await pause(1000);
    const idleRafFrames = await cdp.eval<number>(`window.__rafCount`);
    const gpuOffAvatar = await sampleGpu();
    assert(idleRafFrames === 0, `Expected idleRafFrames === 0 off Avatar tab, got ${idleRafFrames}`);

    assert(
      cdp.pageExceptions.length === 0,
      `Renderer uncaught exceptions: ${cdp.pageExceptions.join(" | ")}`,
    );
    assert(
      cdp.consoleErrors.length === 0,
      `Renderer console errors: ${cdp.consoleErrors.join(" | ")}`,
    );
    assert(
      mainErrors.length === 0,
      `Main process errors: ${mainErrors.join(" | ")}`,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          missionsApproved: true,
          memoryCrudVerified: true,
          policyPreviewVerified: true,
          replaySummary: replaySummary.trim(),
          xrayRendered: true,
          aecErleDb: erleDb,
          activeRafFrames,
          idleRafFrames,
          gpuOnAvatar,
          gpuOffAvatar,
          pageExceptions: cdp.pageExceptions.length,
          consoleErrors: cdp.consoleErrors.length,
          mainErrors: mainErrors.length,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[dogfood] stdout tail:\n", stdoutLines.join("").slice(-2000));
    console.error("[dogfood] stderr tail:\n", stderrLines.join("").slice(-2000));
    throw err;
  } finally {
    cdp?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 3000;
      while (child.exitCode === null && Date.now() < deadline) await pause(100);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}

await main();
