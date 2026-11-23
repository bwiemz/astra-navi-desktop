import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, shell } from "electron";
import { describeActions, type ActionLog } from "../core/actionLog.ts";
import type { Agenda } from "../core/agenda.ts";
import type { ConversationArchive } from "../core/archive.ts";
import type { ConfigStore } from "../core/config.ts";
import type { LocalEngine } from "../core/engine.ts";
import type { GameWatch } from "../core/gameWatch.ts";
import type { Initiative } from "../core/initiative.ts";
import { describeLearned } from "../core/learned.ts";
import type { Learner } from "../core/learner.ts";
import type { MemoryStore } from "../core/memory.ts";
import type { NoticeWatch } from "../core/notices.ts";
import {
  actionsFile,
  actionsPageFile,
  dataDir,
  learnedFile,
  memoryFile,
  modelsDir,
} from "../core/paths.ts";
import type { Reach } from "../core/reach.ts";
import { describeSelfCheck, selfCheck, type SelfCheckResult } from "../core/selfCheck.ts";
import type { VoiceBackend } from "../core/voice/backend.ts";
import type { Speaker } from "../core/voice/speaker.ts";
import { fetchJson } from "../core/web.ts";

/**
 * The pages she writes out for the user to read: a check of her own systems, the record
 * of everything she has done, and everything she has learned. Each is put together from
 * how things stand at that moment, written to a file only the user can read, and opened.
 */

export interface ReportsDeps {
  config: ConfigStore;
  engine(): LocalEngine | null;
  memoryStore(): MemoryStore | null;
  archive(): ConversationArchive | null;
  actions(): ActionLog | null;
  learner(): Learner | null;
  noticeWatch(): NoticeWatch | null;
  agenda(): Agenda | null;
  gameWatch(): GameWatch | null;
  initiative(): Initiative | null;
  reach(): Reach | null;
  voiceBackend(): VoiceBackend | null;
  speaker(): Speaker | null;
  /** The microphone conversation is switched on. */
  listening(): boolean;
  /** The game her brain was put away for, while that is why she is asleep. */
  brainAsleepFor(): string | null;
  describeBraveUse(): string;
}

export interface Reports {
  runSelfCheck(): Promise<SelfCheckResult>;
  showSelfCheck(): Promise<void>;
  showActions(): Promise<void>;
  showLearned(): Promise<void>;
}

export function createReports(deps: ReportsDeps): Reports {
  /** Looks over her own systems: what is working, how much room she takes, what could be freed. */
  async function runSelfCheck(): Promise<SelfCheckResult> {
    const all = deps.memoryStore()?.all() ?? [];
    const info = (await deps.engine()?.brainInfo()) ?? {
      label: "Unknown",
      fileName: null,
      onDisk: false,
      loaded: false,
    };
    return selfCheck({
      dataDir: dataDir(),
      modelsDir: modelsDir(),
      brain: info,
      workingMemory: { meter: deps.engine()?.meter() ?? null, gaveCardTo: deps.brainAsleepFor() },
      notices: {
        on: deps.config.value.notices.read,
        held: deps.noticeWatch()?.held ?? 0,
        trouble: deps.noticeWatch()?.trouble ?? null,
      },
      agenda: {
        calendars: deps.config.value.agenda.calendars.length,
        unread: deps.agenda()?.lastLook()?.unread ?? null,
        headsUpMinutes: deps.config.value.agenda.headsUpMinutes,
      },
      gameMode: {
        quiet: deps.config.value.quietInGames,
        playing: deps.gameWatch()?.current()?.game ?? null,
        held: deps.initiative()?.heldCount ?? 0,
      },
      voice: {
        label: deps.voiceBackend()?.label ?? "No voice",
        ready: deps.speaker()?.canSpeak ?? false,
      },
      listening: deps.listening(),
      handsOff: deps.config.value.handsOff,
      notes: {
        total: all.length,
        topics: all.filter((memory) => memory.kind === "topic").length,
        skills: all.filter((memory) => memory.kind === "skill").length,
      },
      pastExchanges: deps.archive()?.count ?? 0,
      waitingToWriteUp: deps.learner()?.waiting ?? 0,
      actionsRecorded: deps.actions()?.recent(100_000).length ?? 0,
      searchEngine: deps.config.value.search.searxngUrl
        ? "your SearXNG"
        : deps.config.value.search.braveApiKey
          ? deps.describeBraveUse()
          : null,
      // In kilobytes, summed over the app's processes.
      memoryInUse:
        app.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) * 1024,
      reach: (await deps.reach()?.status()) ?? null,
      canReachTheWeb: async () => {
        await fetchJson("https://en.wikipedia.org/w/rest.php/v1/search/page?q=ship&limit=1", {
          timeoutMs: 5000,
        });
        return true;
      },
    });
  }

  /** Writes her self-check out as a readable page and opens it. */
  async function showSelfCheck(): Promise<void> {
    const result = await runSelfCheck();
    const file = join(dataDir(), "self-check.md");
    const page = [
      "# Astra Navi's self-check",
      "",
      `Taken ${new Date().toLocaleString("en-GB")}.`,
      "",
      "```",
      describeSelfCheck(result),
      "```",
      "",
    ].join("\n");
    await writeFile(file, page, { encoding: "utf8", mode: 0o600 });
    const problem = await shell.openPath(file);
    if (problem) console.warn("[self-check] could not open the page:", problem);
  }

  /** Writes the record of everything she has done out as a readable page and opens it. */
  async function showActions(): Promise<void> {
    const actions = deps.actions();
    if (!actions) return;
    await actions.flush();
    const file = actionsPageFile();
    await writeFile(file, describeActions(actions.recent(400), actionsFile()), {
      encoding: "utf8",
      mode: 0o600,
    });
    const problem = await shell.openPath(file);
    if (problem) console.warn("[actions] could not open the page:", problem);
  }

  /** Writes everything in her long-term memory out as a readable page and opens it. */
  async function showLearned(): Promise<void> {
    const memoryStore = deps.memoryStore();
    if (!memoryStore) return;
    const file = learnedFile();
    await writeFile(file, describeLearned(memoryStore.all(), memoryFile()), {
      encoding: "utf8",
      mode: 0o600,
    });
    const problem = await shell.openPath(file);
    if (problem) console.warn("[learned] could not open the page:", problem);
  }

  return { runSelfCheck, showSelfCheck, showActions, showLearned };
}
