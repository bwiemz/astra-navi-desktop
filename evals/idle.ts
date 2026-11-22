import { summarise } from "./scoring.ts";
import type { CaseResult, Report, SuiteStamp } from "./types.ts";

/**
 * Running her suite a piece at a time, whenever the graphics card is free, until the
 * whole of it is done: the parts that decide what to run next and how the pieces are
 * put together. Nothing here touches a file or the card; `scripts/idle-eval.ts` does.
 */

/** What is kept between pieces. */
export interface IdleProgress {
  /** The suite and her own rules as they were when this round began. */
  stamp: SuiteStamp;
  brain: string;
  repeat: number;
  /** When the round began. */
  startedAt: string;
  /** The pieces finished so far, in the order they were run. */
  parts: Report[];
}

export function sameStamp(a: SuiteStamp, b: SuiteStamp): boolean {
  return a.marking === b.marking && a.world === b.world && a.her === b.her;
}

/** The cases a round has finished: every run asked for was made. */
export function finishedCases(progress: IdleProgress): Map<string, CaseResult> {
  const done = new Map<string, CaseResult>();
  for (const part of progress.parts) {
    for (const result of part.cases) {
      // A piece cut short by a game may hold a case with fewer runs than asked for.
      if (result.runs.length >= progress.repeat && !done.has(result.id))
        done.set(result.id, result);
    }
  }
  return done;
}

/** The next cases to run, in the suite's own order. Empty when the round is complete. */
export function nextPiece(
  every: readonly string[],
  progress: IdleProgress,
  size: number,
): string[] {
  const done = finishedCases(progress);
  return every.filter((id) => !done.has(id)).slice(0, Math.max(1, Math.floor(size)));
}

/**
 * One report out of the pieces of a finished round, as if it had been one run. Scores
 * are worked out afresh over all the cases. The speed figures are those of the largest
 * piece: pieces run at different times of day beside different things, and an average
 * of them would describe none.
 * @param every The suite's cases in order; the report keeps that order.
 */
export function mergedReport(
  label: string,
  every: readonly string[],
  progress: IdleProgress,
): Report {
  const done = finishedCases(progress);
  const cases = every.flatMap((id) => {
    const result = done.get(id);
    return result ? [result] : [];
  });
  const largest = [...progress.parts].sort((a, b) => b.cases.length - a.cases.length)[0];
  if (!largest) throw new Error("There is nothing to put together: no piece was finished.");
  return {
    label,
    brain: progress.brain,
    suite: progress.stamp,
    startedAt: progress.startedAt,
    minutes: progress.parts.reduce((sum, part) => sum + part.minutes, 0),
    settings: { ...largest.settings, repeat: progress.repeat },
    ...summarise(cases),
    speed: largest.speed,
    pieces: progress.parts.length,
    cases,
  };
}
