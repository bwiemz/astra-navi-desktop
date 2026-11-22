/**
 * Her test suite, run a piece at a time whenever the graphics card is free, until the
 * whole of it is done; then a comparison with the last whole round.
 *
 *   npm run idle-eval -- --label nightly --brain standard
 *
 * Leave it running, or start it from a timer. It waits while a game has the card or
 * the card is busy with something else, runs the next piece when it is free, and keeps
 * what is done between pieces (in evals/results/idle/<label>/), so a game in the
 * middle costs one piece at most. When every case is done it writes
 * evals/results/<label>.json, keeps the round before it as <label>.previous.json, and
 * writes how the two differ to <label>.diff.md. If her own rules or the suite change
 * while a round is under way, the round starts over: a report is of one state of her.
 * (A change to the cases themselves is seen only when this is started afresh, as it
 * holds them in mind: stop and start it after editing a case.)
 *
 * Options: --label NAME (needed), --brain small|standard|large (default small),
 * --piece N cases at a time (default 30), --repeat N runs a case (default 1),
 * --wait MINUTES between looks at a busy card (default 5), --once (run one piece if the
 * card is free now and stop; for a timer), --baseline LABEL (compare with that report
 * in place of the round before).
 *
 * Each piece is an ordinary `npm run eval`, with all its own care: it will not start on
 * top of a game and stops if one begins.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ALL_CASES } from "../evals/cases/index.ts";
import { loadReport, RESULTS_DIR } from "../evals/files.ts";
import { cardHolders, runningCommands, whyNotNow } from "../evals/guard.ts";
import {
  finishedCases,
  mergedReport,
  nextPiece,
  sameStamp,
  type IdleProgress,
} from "../evals/idle.ts";
import { compareReports } from "../evals/scoring.ts";
import { suiteStamp } from "../evals/stamp.ts";
import type { Report } from "../evals/types.ts";
import { gameOnCard } from "../src/core/cardWatch.ts";
import { sessionIdleMs, unattendedReason } from "../src/core/idleCheck.ts";
import { extractReportTrainingData, isTeacherBrain } from "../src/core/trainingExport.ts";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name: string): string | null => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
};
const label = (option("--label") ?? "").replace(/[^\w.-]+/g, "-");
// A name of dots alone would be a folder above this round's own.
if (label === "" || label.startsWith(".")) {
  console.error("Give the round a name that starts with a letter or a number: --label nightly");
  process.exit(1);
}
const brain = option("--brain") ?? "small";
const piece = Math.max(1, Number(option("--piece") ?? 30) || 30);
const repeat = Math.max(1, Number(option("--repeat") ?? 1) || 1);
const waitMinutes = Math.max(1, Number(option("--wait") ?? 5) || 5);
const once = args.includes("--once");
const minIdleMinutes = Math.max(
  0,
  Number(option("--min-idle") ?? (args.includes("--unattended") ? 10 : 0)) || 0,
);
const baseline = option("--baseline");

const folder = join(RESULTS_DIR, "idle", label);
const progressFile = join(folder, "progress.json");
const every = ALL_CASES.map((test) => test.id);
const say = (text: string): void =>
  console.log(`[${new Date().toTimeString().slice(0, 5)}] ${text}`);

async function loadProgress(): Promise<IdleProgress | null> {
  try {
    return JSON.parse(await readFile(progressFile, "utf8")) as IdleProgress;
  } catch {
    return null;
  }
}

async function saveProgress(progress: IdleProgress): Promise<void> {
  await mkdir(folder, { recursive: true });
  const tmp = `${progressFile}.tmp`;
  // Written beside it and moved into place, so a crash leaves the last whole copy.
  await writeFile(tmp, JSON.stringify(progress), "utf8");
  await rename(tmp, progressFile);
}

/** Why the card should be left alone just now, or null when it is free. */
async function whyNot(): Promise<string | null> {
  const [holders, commands, game, idleMs] = await Promise.all([
    cardHolders(),
    runningCommands(),
    gameOnCard().catch(() => "something that could not be told"),
    minIdleMinutes > 0 ? sessionIdleMs() : Promise.resolve(null),
  ]);
  if (game !== null) return `a game is running (${game})`;
  const unattended = unattendedReason(idleMs, minIdleMinutes);
  if (unattended !== null) return unattended;
  // Said here as part of a sentence, so without the advice and the full stop it ends on.
  const busy = whyNotNow({ utilisation: await cardBusy(), holders, commands });
  return busy === null
    ? null
    : (busy.split(". ")[0] ?? busy).replace(/\.$/, "").replace(/^The /, "the ");
}

async function cardBusy(): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn("nvidia-smi", [
      "--query-gpu=utilization.gpu",
      "--format=csv,noheader,nounits",
    ]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => done(null));
    child.on("close", () => {
      const busy = Number(out.trim().split("\n")[0]);
      done(Number.isFinite(busy) ? busy : null);
    });
  });
}

/** The piece that is running, so that stopping this stops it too. */
let running: ReturnType<typeof spawn> | null = null;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    // The run of the suite stops itself cleanly on this and writes what it finished.
    running?.kill("SIGINT");
    setTimeout(() => process.exit(130), running ? 45_000 : 0).unref();
  });
}

/** Runs one piece as an ordinary run of the suite and returns the report it wrote, if any. */
async function runPiece(ids: readonly string[], number: number): Promise<Report | null> {
  const pieceLabel = `idle-${label}-piece-${number}`;
  const written = await new Promise<string | null>((done) => {
    const child = (running = spawn(
      process.execPath,
      [
        join(ROOT, "scripts", "eval.ts"),
        "--exactly",
        ids.join(","),
        "--label",
        pieceLabel,
        "--overwrite",
        "--repeat",
        String(repeat),
      ],
      {
        cwd: ROOT,
        env: { ...process.env, AI_CHAN_BRAIN: brain },
        stdio: ["ignore", "pipe", "inherit"],
      },
    ));
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => done(null));
    child.on("close", () => {
      running = null;
      done(/^Written to (.+)$/m.exec(out)?.[1]?.trim() ?? null);
    });
  });
  if (written === null || !existsSync(written)) return null;
  try {
    return await loadReport(written);
  } catch {
    // Cut off while it was being written: the same as not having run.
    return null;
  } finally {
    await rm(written, { force: true });
  }
}

const pause = (minutes: number): Promise<void> =>
  new Promise((done) => setTimeout(done, minutes * 60_000));

/** Pieces in a row that did not run. A piece that can never run must not be tried for ever. */
let failedInARow = 0;
const MOST_FAILED_IN_A_ROW = 3;

for (;;) {
  const stamp = suiteStamp(ALL_CASES);
  let progress = await loadProgress();
  if (
    progress &&
    (!sameStamp(progress.stamp, stamp) || progress.repeat !== repeat || progress.brain !== brain)
  ) {
    say(
      "Her rules, the suite, the brain or the number of runs changed since this round began: starting it over.",
    );
    progress = null;
  }
  progress ??= { stamp, brain, repeat, startedAt: new Date().toISOString(), parts: [] };
  const next = nextPiece(every, progress, piece);
  if (next.length === 0) {
    const report = mergedReport(label, every, progress);
    const file = join(RESULTS_DIR, `${label}.json`);
    const previous = join(RESULTS_DIR, `${label}.previous.json`);
    // If this very round is already there (a stop came between writing it and clearing
    // up), it must not be copied over the round before it as well.
    const alreadyWritten =
      existsSync(file) &&
      (await loadReport(file).then(
        (there) => there.startedAt === report.startedAt,
        () => false,
      ));
    if (!alreadyWritten) {
      if (existsSync(file)) await copyFile(file, previous);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    }
    await rm(folder, { recursive: true, force: true });
    say(
      `The round is complete: ${report.cases.length} cases, ${(report.overall * 100).toFixed(0)}% overall. Written to ${file}`,
    );
    const against = baseline ?? (existsSync(previous) ? previous : null);
    if (against) {
      const diff = compareReports(await loadReport(against), report);
      const diffFile = join(RESULTS_DIR, `${label}.diff.md`);
      await writeFile(diffFile, `${diff}\n`, "utf8");
      console.log(`\n${diff}\n\nThe comparison is in ${diffFile}`);
    } else {
      say("There is no earlier round to compare it with yet.");
    }
    const { pairs, sft } = extractReportTrainingData(report, {
      teacherOnlyForClean: isTeacherBrain(report.brain),
    });
    if (pairs.length > 0) {
      const pairsPath = join(RESULTS_DIR, `${label}.pairs.jsonl`);
      await writeFile(
        pairsPath,
        `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      say(`Exported ${pairs.length} preference pairs to ${pairsPath}`);
    }
    if (sft.length > 0) {
      const sftPath = join(RESULTS_DIR, `${label}.sft.jsonl`);
      await writeFile(
        sftPath,
        `${sft.map((row) => JSON.stringify(row)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      say(`Exported ${sft.length} SFT examples to ${sftPath}`);
    }
    break;
  }
  const reason = await whyNot();
  if (reason !== null) {
    if (once) {
      say(`Not now: ${reason}. ${finishedCases(progress).size} of ${every.length} cases are done.`);
      process.exit(3);
    }
    say(`Waiting ${waitMinutes} minutes: ${reason}.`);
    await pause(waitMinutes);
    continue;
  }
  const done = finishedCases(progress).size;
  say(
    `Running cases ${done + 1} to ${done + next.length} of ${every.length} with the ${brain} brain.`,
  );
  const part = await runPiece(next, progress.parts.length + 1);
  if (part === null || part.cases.length === 0) {
    if (once) {
      say("That piece did not run (the card was taken, or the run failed). Nothing was lost.");
      process.exit(3);
    }
    failedInARow += 1;
    if (failedInARow >= MOST_FAILED_IN_A_ROW) {
      say(
        `${failedInARow} pieces in a row did not run, so this is not the card being busy. Stopping; what is done is kept. Try one by hand to see why: npm run eval -- --exactly ${next[0] ?? ""}`,
      );
      process.exit(4);
    }
    say(`That piece did not run. Looking again in ${waitMinutes} minutes.`);
    await pause(waitMinutes);
    continue;
  }
  failedInARow = 0;
  progress.parts.push(part);
  await saveProgress(progress);
  if (once) {
    say(`${finishedCases(progress).size} of ${every.length} cases are done.`);
    break;
  }
}
