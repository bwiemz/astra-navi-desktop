import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Agenda, describeOccurrence, occurrencesIn, parseCalendar } from "../src/core/agenda.ts";
import { createAgendaTools } from "../src/core/agendaTools.ts";
import type { ToolHost } from "../src/core/agentTools.ts";
import { TOOLS } from "../src/core/permissions.ts";

/**
 * The days on which the clocks change, where a day is twenty-three or twenty-five hours
 * long. These tests are run on New York's clock whatever the machine's own is: there
 * 8 March 2026 loses an hour and 1 November 2026 gains one.
 */
const machine = process.env["TZ"];
beforeAll(() => {
  process.env["TZ"] = "America/New_York";
});
afterAll(() => {
  if (machine === undefined) delete process.env["TZ"];
  else process.env["TZ"] = machine;
});

const local = (y: number, m: number, d: number, h = 0, min = 0): Date =>
  new Date(y, m - 1, d, h, min);
const cal = (...events: string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const event = (...lines: string[]): string => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
/** The whole of one day: from its midnight to the last moment before the next. */
const day = (y: number, m: number, d: number): [Date, Date] => [
  local(y, m, d),
  new Date(local(y, m, d + 1).getTime() - 1),
];

let dir: string;
let now: Date;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-agenda-clocks-"));
  now = local(2026, 3, 1, 12);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tool(agenda: Agenda): (input: Record<string, unknown>) => Promise<string> {
  const host: ToolHost = {
    policy: () => ({ workspace: dir, home: dir }),
    memory: undefined as never,
    learnAddresses: () => undefined,
    noteOutsideText: () => undefined,
    noteChange: () => undefined,
    signal: () => undefined,
    activity: () => undefined,
    ran: () => undefined,
    ask: () => Promise.resolve(true),
    step: () => 1,
  };
  const handler = createAgendaTools(host, agenda, () => now)[TOOLS.agenda]?.handler as (
    input: unknown,
  ) => Promise<string>;
  return (input) =>
    handler({ action: "list", from: "", days: 0, title: "", start: "", end: "", id: "", ...input });
}

describe("on the days the clocks change", () => {
  it("is really being run on a clock that changes", () => {
    expect(local(2026, 3, 9).getTime() - local(2026, 3, 8).getTime()).toBe(23 * 3_600_000);
    expect(local(2026, 11, 2).getTime() - local(2026, 11, 1).getTime()).toBe(25 * 3_600_000);
  });

  it("lists a whole-day entry on its own day only, though that day is an hour short", () => {
    const events = parseCalendar(
      cal(
        event("UID:d1", "SUMMARY:Clocks forward", "DTSTART;VALUE=DATE:20260308"),
        event(
          "UID:d2",
          "SUMMARY:Every day",
          "DTSTART;VALUE=DATE:20260306",
          "RRULE:FREQ=DAILY;COUNT=5",
        ),
      ),
    );
    const on = (d: number): string[] =>
      occurrencesIn(events, "Home", ...day(2026, 3, d)).map(
        (item) => `${item.title} ${item.start.getDate()}`,
      );
    expect(on(7)).toEqual(["Every day 7"]);
    expect(on(8)).toEqual(["Clocks forward 8", "Every day 8"]);
    expect(on(9)).toEqual(["Every day 9"]);
    expect(on(11)).toEqual([]);
    // And a whole day starts and ends at midnight, however long it is.
    const [short] = occurrencesIn(events, "Home", ...day(2026, 3, 8));
    expect(short?.start).toEqual(local(2026, 3, 8));
    expect(short?.end).toEqual(local(2026, 3, 9));
  });

  it("asks for a day by its dates, so the short day does not reach into the next", async () => {
    const path = "/x/home.ics";
    const agenda = new Agenda({
      file: join(dir, "agenda.json"),
      sources: () => [{ name: "Home", source: path }],
      readFile: () =>
        Promise.resolve(
          cal(
            event("UID:n1", "SUMMARY:After midnight", "DTSTART:20260309T003000"),
            event("UID:n2", "SUMMARY:Tomorrow all day", "DTSTART;VALUE=DATE:20260309"),
            event("UID:n3", "SUMMARY:Late on the long day", "DTSTART:20261101T233000"),
            event("UID:n4", "SUMMARY:Breakfast", "DTSTART:20260308T080000"),
          ),
        ),
    });
    const list = tool(agenda);
    const short = await list({ from: "2026-03-08" });
    expect(short).toContain("Breakfast");
    expect(short).not.toContain("After midnight");
    expect(short).not.toContain("Tomorrow all day");
    expect(await list({ from: "2026-03-09" })).toContain("After midnight");
    // The day the clocks go back is twenty-five hours long, and all of it is that day.
    expect(await list({ from: "2026-11-01" })).toContain("Late on the long day");
    expect(await list({ from: "2026-10-31", days: 2 })).toContain("Late on the long day");
  });

  it("keeps a repeating time at the same hour across the change", () => {
    const events = parseCalendar(
      cal(event("UID:r1", "SUMMARY:Coffee", "DTSTART:20260307T090000", "RRULE:FREQ=DAILY;COUNT=3")),
    );
    expect(
      occurrencesIn(events, "Home", local(2026, 3, 7), local(2026, 3, 10)).map(
        (item) => item.start,
      ),
    ).toEqual([local(2026, 3, 7, 9), local(2026, 3, 8, 9), local(2026, 3, 9, 9)]);
  });
});

describe("a calendar's whole days, when the machine's clock is moved while she runs", () => {
  it("are worked out again for the new clock, not served from what was kept", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = join(dir, "family.ics");
    await writeFile(
      path,
      cal(
        event("UID:b1", "SUMMARY:Mum's birthday", "DTSTART;VALUE=DATE:20261124"),
        // A time with no zone of its own is a time on the reader's clock.
        event("UID:b2", "SUMMARY:Cake", "DTSTART:20261124T150000"),
      ),
    );
    now = local(2026, 11, 21, 16);
    const agenda = new Agenda({
      file: join(dir, "agenda.json"),
      sources: () => [{ name: "Family", source: path }],
      now: () => now,
    });
    // A whole week is looked at first, so that what is kept covers every day asked for below.
    const here = await agenda.between(local(2026, 11, 20), local(2026, 11, 28));
    expect(here.items.map((item) => item.start)).toEqual([
      local(2026, 11, 24),
      local(2026, 11, 24, 15),
    ]);
    // The same agenda, the same unchanged file; the laptop is now on Tokyo's clock.
    process.env["TZ"] = "Asia/Tokyo";
    try {
      const there = await agenda.between(...day(2026, 11, 24));
      expect(there.items.map((item) => [item.title, item.start])).toEqual([
        ["Mum's birthday", local(2026, 11, 24)],
        ["Cake", local(2026, 11, 24, 15)],
      ]);
      expect((await agenda.between(...day(2026, 11, 23))).items).toEqual([]);
      expect((await agenda.between(...day(2026, 11, 25))).items).toEqual([]);
    } finally {
      process.env["TZ"] = "America/New_York";
    }
  });
});

describe("a whole day of her own, when the machine's clock is moved", () => {
  it("stays on the day it was put down for", async () => {
    const file = join(dir, "agenda.json");
    now = local(2026, 11, 21, 16);
    const first = new Agenda({ file, sources: () => [], now: () => now });
    await first.add("Mum's birthday", local(2026, 11, 24), null, true);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      entries: [{ start: "2026-11-24", end: null, allDay: true }],
    });
    // The laptop is carried to Tokyo, fourteen hours ahead.
    process.env["TZ"] = "Asia/Tokyo";
    try {
      const there = new Agenda({ file, sources: () => [], now: () => now });
      const found = await there.between(...day(2026, 11, 24));
      expect(found.items).toHaveLength(1);
      expect(describeOccurrence(found.items[0] as never, local(2026, 11, 20))).toBe(
        `Tue 24 Nov, all day: Mum's birthday · AI-chan [${found.items[0]?.id ?? ""}]`,
      );
      expect((await there.between(...day(2026, 11, 23))).items).toEqual([]);
      expect((await there.between(...day(2026, 11, 25))).items).toEqual([]);
    } finally {
      process.env["TZ"] = "America/New_York";
    }
  });

  it("reads a whole day written down by an earlier version as a moment, as the day it meant", async () => {
    const file = join(dir, "agenda.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "a-old111",
            title: "Day off",
            start: local(2026, 11, 24).toISOString(),
            end: null,
            allDay: true,
          },
        ],
      }),
    );
    now = local(2026, 11, 21, 16);
    const agenda = new Agenda({ file, sources: () => [], now: () => now });
    expect((await agenda.between(...day(2026, 11, 24))).items.map((item) => item.title)).toEqual([
      "Day off",
    ]);
    expect((await agenda.between(...day(2026, 11, 25))).items).toEqual([]);
  });
});
