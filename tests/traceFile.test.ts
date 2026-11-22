import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnTrace } from "../src/core/trace.ts";
import { TraceFile } from "../src/core/traceFile.ts";

const trace = (said: string): TurnTrace => ({
  at: "2026-11-22T01:00:00.000Z",
  kind: "user",
  said,
  spoken: false,
  brain: "Small",
  offered: ["sound"],
  calls: [],
  reply: "Hello, Captain.",
  checks: [],
  withheld: false,
  ms: { whole: 900, firstWord: 300 },
  tokens: { read: 40, written: 12, held: 8800 },
});

describe("the records of her replies kept on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-tracefile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one line a reply, in order, to a file only the user can read", async () => {
    const file = join(dir, "deeper", "traces.jsonl");
    const kept = new TraceFile(file);
    for (const said of ["one", "two", "three"]) kept.append(trace(said));
    await kept.whenWritten();
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as TurnTrace).said)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("is deleted when asked, after what was still being written, and starts afresh", async () => {
    const file = join(dir, "traces.jsonl");
    const kept = new TraceFile(file);
    kept.append(trace("before"));
    await kept.clear();
    await expect(stat(file)).rejects.toThrow();
    kept.append(trace("after"));
    await kept.whenWritten();
    expect((await readFile(file, "utf8")).trimEnd().split("\n")).toHaveLength(1);
    // Clearing a file that is not there is no failure.
    await new TraceFile(join(dir, "never-written.jsonl")).clear();
  });

  it("lets a record go with one warning when it cannot be written, and goes on", async () => {
    // A folder sits where the file should be.
    const file = join(dir, "traces.jsonl");
    await mkdir(file);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const kept = new TraceFile(file);
      kept.append(trace("one"));
      kept.append(trace("two"));
      await kept.whenWritten();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
