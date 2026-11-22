/**
 * What changes between two versions of a text, line by line, in the form people know
 * from `diff -u`: for showing the user exactly what a write would do to a file before
 * they say yes to it.
 */

/** Past this many lines on either side the comparison is not attempted. */
const MAX_LINES = 2500;

export interface DiffOptions {
  /** Unchanged lines shown around each change. */
  context?: number;
  /** The most lines of comparison to return; the rest is summed up in one last line. */
  maxLines?: number;
}

export interface TextDiff {
  /** Lines only in the new text, and only in the old. */
  added: number;
  removed: number;
  /** The comparison itself. Empty when the two are the same. */
  text: string;
  /** True when the two texts are the same, line for line. */
  same: boolean;
}

type Step = { kind: "same" | "add" | "remove"; line: string };

/** The steps from one list of lines to the other, by the longest run they share. */
function steps(before: readonly string[], after: readonly string[]): Step[] {
  const rows = before.length;
  const columns = after.length;
  // shared[i][j]: how many lines the ends of both, from i and j on, have in common in order.
  const shared: Uint16Array[] = [];
  for (let row = 0; row <= rows; row += 1) shared.push(new Uint16Array(columns + 1));
  for (let row = rows - 1; row >= 0; row -= 1) {
    const here = shared[row];
    const below = shared[row + 1];
    if (!here || !below) continue;
    for (let column = columns - 1; column >= 0; column -= 1) {
      here[column] =
        before[row] === after[column]
          ? (below[column + 1] ?? 0) + 1
          : Math.max(below[column] ?? 0, here[column + 1] ?? 0);
    }
  }
  const made: Step[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      made.push({ kind: "same", line: before[row] ?? "" });
      row += 1;
      column += 1;
    } else if ((shared[row + 1]?.[column] ?? 0) >= (shared[row]?.[column + 1] ?? 0)) {
      made.push({ kind: "remove", line: before[row] ?? "" });
      row += 1;
    } else {
      made.push({ kind: "add", line: after[column] ?? "" });
      column += 1;
    }
  }
  for (; row < rows; row += 1) made.push({ kind: "remove", line: before[row] ?? "" });
  for (; column < columns; column += 1) made.push({ kind: "add", line: after[column] ?? "" });
  return made;
}

function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A text that ends with a line break has no empty last line.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Compares two texts line by line. Lines are marked "-" (only in the old), "+" (only
 * in the new) or " " (in both, shown for a little way around each change), under a
 * "@@" line that says where in each text the piece is.
 */
export function compareText(before: string, after: string, options: DiffOptions = {}): TextDiff {
  const context = Math.max(0, options.context ?? 2);
  const most = Math.max(4, options.maxLines ?? 80);
  const old = linesOf(before);
  const fresh = linesOf(after);
  if (before === after) return { added: 0, removed: 0, text: "", same: true };
  if (old.length > MAX_LINES || fresh.length > MAX_LINES) {
    return {
      added: fresh.length,
      removed: old.length,
      text: `(too long to compare line by line: ${old.length} lines now, ${fresh.length} after)`,
      same: false,
    };
  }
  const made = steps(old, fresh);
  const added = made.filter((step) => step.kind === "add").length;
  const removed = made.filter((step) => step.kind === "remove").length;
  if (added === 0 && removed === 0) {
    // The same lines; only how the text ends differs.
    return {
      added: 0,
      removed: 0,
      text: "(only the line break at the very end differs)",
      same: false,
    };
  }
  // Which steps are shown: every change, and the unchanged lines within reach of one.
  const shown = made.map((step) => step.kind !== "same");
  made.forEach((step, index) => {
    if (step.kind === "same") return;
    for (let near = index - context; near <= index + context; near += 1) {
      if (near >= 0 && near < made.length) shown[near] = true;
    }
  });
  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < made.length) {
    if (!shown[index]) {
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }
    // One piece: a run of shown steps.
    const piece: string[] = [];
    const [oldStart, newStart] = [oldLine, newLine];
    let [oldCount, newCount] = [0, 0];
    while (index < made.length && shown[index]) {
      const step = made[index];
      if (!step) break;
      piece.push(`${step.kind === "same" ? " " : step.kind === "add" ? "+" : "-"}${step.line}`);
      if (step.kind !== "add") {
        oldLine += 1;
        oldCount += 1;
      }
      if (step.kind !== "remove") {
        newLine += 1;
        newCount += 1;
      }
      index += 1;
    }
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...piece);
  }
  const text =
    out.length > most
      ? [...out.slice(0, most), `… (${out.length - most} more lines of changes)`].join("\n")
      : out.join("\n");
  return { added, removed, text, same: false };
}
