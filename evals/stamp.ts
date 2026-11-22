import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvalCase, SuiteStamp } from "./types.ts";

/**
 * A short mark of the suite as it stands, kept in every report. Two reports with the
 * same marks were run on the same cases in the same pretend world and marked by the
 * same rules; where those marks differ, a difference in their scores may come from the
 * suite and not from her. A third mark is of her own instructions and rules: when that
 * one differs, the difference in scores includes whatever was changed in her.
 */

const ROOT = resolve(import.meta.dirname, "..");
/**
 * The files whose text decides how a run is marked, besides the cases themselves. The
 * permission rules are here because marking asks them which calls change something.
 */
export const MARKING_FILES = ["evals/scoring.ts", "src/core/claims.ts", "src/core/permissions.ts"];
/** The files whose text decides what she is given, besides the cases themselves. */
export const WORLD_FILES = ["evals/world.ts"];
/**
 * The files that are her, as far as a run can tell: what she is told to be, the gate
 * and rules every tool call passes (the stand-ins too), and what is done to her words
 * and her conversation before anyone sees or keeps them.
 */
export const HER_FILES = [
  "src/core/persona.ts",
  // Added 2026-11-22: a change to how a reply is checked, which tools are offered or
  // how the model is driven is a change in her, and went unmarked until then.
  "src/core/brain.ts",
  "src/core/sums.ts",
  "src/core/toolRouter.ts",
  "src/core/engine.ts",
  "src/core/agentTools.ts",
  "src/core/permissions.ts",
  "src/core/moodStream.ts",
  "src/core/compaction.ts",
  // Added 2026-11-22, when brain.ts and permissions.ts were split: the checks made on a
  // finished reply, the wording rules they use, and what counts as risky.
  "src/core/followThrough.ts",
  "src/core/claims.ts",
  "src/core/riskRules.ts",
];

/** A case as text, with its patterns and functions written out so that a change to one shows. */
function written(value: unknown): string {
  return (
    JSON.stringify(value, (_key, part: unknown) => {
      if (part instanceof RegExp) return `regexp:${String(part)}`;
      if (typeof part === "function") {
        return `function:${Function.prototype.toString.call(part)}`;
      }
      return part;
    }) ?? ""
  );
}

function mark(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\u0000");
  return hash.digest("hex").slice(0, 12);
}

function sources(files: readonly string[], root: string): string[] {
  return files.map((file) => readFileSync(join(root, file), "utf8"));
}

/** The marks for these cases and the files as they are on disk now. */
export function suiteStamp(cases: readonly EvalCase[], root = ROOT): SuiteStamp {
  const marking = cases.map((test) =>
    written({
      id: test.id,
      category: test.category,
      language: test.language ?? "en",
      turns: test.turns.length,
      expect: test.expect,
    }),
  );
  // Everything about a case except what is expected of it: an undefined field is left out.
  const world = cases.map((test) => written({ ...test, expect: undefined }));
  return {
    marking: mark([...sources(MARKING_FILES, root), ...marking]),
    world: mark([...sources(WORLD_FILES, root), ...world]),
    her: mark(sources(HER_FILES, root)),
  };
}
