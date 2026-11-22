import { describe, expect, it } from "vitest";
import { compareText } from "../src/core/textDiff.ts";

describe("what changes between two versions of a text", () => {
  it("says so when nothing does", () => {
    expect(compareText("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0, text: "", same: true });
  });

  it("shows a changed line with the lines around it, and where it is", () => {
    const before = "port 8080\nhost 0.0.0.0\nworkers 2\nlog /var/log/app.log\ncolour on\n";
    const after = "port 8080\nhost 0.0.0.0\nworkers 8\nlog /var/log/app.log\ncolour on\n";
    const diff = compareText(before, after, { context: 1 });
    expect(diff).toMatchObject({ added: 1, removed: 1, same: false });
    expect(diff.text).toBe(
      [
        "@@ -2,3 +2,3 @@",
        " host 0.0.0.0",
        "-workers 2",
        "+workers 8",
        " log /var/log/app.log",
      ].join("\n"),
    );
  });

  it("shows a file that is new, or emptied, as all added or all removed", () => {
    expect(compareText("", "one\ntwo\n").text).toBe("@@ -1,0 +1,2 @@\n+one\n+two");
    expect(compareText("one\ntwo\n", "")).toMatchObject({ added: 0, removed: 2 });
  });

  it("keeps changes far apart in pieces of their own", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const changed = [...lines];
    changed[2] = "line three";
    changed[26] = "line twenty-seven";
    const diff = compareText(lines.join("\n"), changed.join("\n"), { context: 1 });
    expect(diff.text.match(/^@@/gm)).toHaveLength(2);
    expect(diff.text).toContain("@@ -2,3 +2,3 @@");
    expect(diff.text).toContain("@@ -26,3 +26,3 @@");
    expect(diff.text).not.toContain("line 15");
  });

  it("counts lines put in and taken out without a line for line match", () => {
    const diff = compareText("a\nb\nc\n", "a\nx\ny\nc\nd\n");
    expect(diff).toMatchObject({ added: 3, removed: 1 });
    expect(diff.text.split("\n").filter((line) => line.startsWith("+"))).toEqual([
      "+x",
      "+y",
      "+d",
    ]);
  });

  it("cuts a long comparison short and says how much is left", () => {
    const before = Array.from({ length: 200 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 200 }, (_, index) => `new ${index}`).join("\n");
    const diff = compareText(before, after, { maxLines: 10 });
    expect(diff.text.split("\n")).toHaveLength(11);
    expect(diff.text).toMatch(/… \(\d+ more lines of changes\)$/);
    expect(diff).toMatchObject({ added: 200, removed: 200 });
  });

  it("does not try a comparison that would take too long, and notes a change of ending only", () => {
    const huge = Array.from({ length: 3000 }, (_, index) => `l${index}`).join("\n");
    expect(compareText(huge, `${huge}\nmore`).text).toMatch(/^\(too long to compare/);
    expect(compareText("a\nb", "a\nb\n").text).toBe(
      "(only the line break at the very end differs)",
    );
  });
});
