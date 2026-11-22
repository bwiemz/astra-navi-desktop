import { describe, expect, it } from "vitest";
import {
  SAID_AWAY_WAITS_MS,
  SAID_HERE_WAITS_MS,
  type SaidWaiting,
  type Step,
  cleanStepLabel,
  dayKey,
  dayLabel,
  mayAnswer,
  saidCaption,
  scrollHint,
  stepAnswer,
  stepAnswered,
  stepAsked,
  stepDone,
  takeSaid,
  worthLogging,
  Latest,
  type LogItemKind,
  dropWaiting,
  trimOldest,
} from "../src/renderer/src/conversation.ts";

/** What the trail shows: each settled step's words and the page's own mark, if it has one. */
function shown(steps: Step[]): [string, string | null][] {
  return steps
    .filter((step) => step.kind !== "asking")
    .map((step) => [step.label, stepAnswer(step)]);
}

describe("the trail of steps in a reply", () => {
  // The order her tools really work in: the question first, and the step's own name
  // only once the user has said yes (see guarded() in src/core/agentTools.ts).
  it("puts the mark of having been allowed on the step that was asked about", () => {
    const steps: Step[] = [];
    stepDone(steps, "Looked up Kdenlive in the package list");
    stepAsked(steps, "q1", "Run this command?");
    expect(shown(steps)).toEqual([["Looked up Kdenlive in the package list", null]]);
    stepAnswered(steps, "q1", true, "allow");
    stepDone(steps, "Install Kdenlive from the official repositories");
    expect(shown(steps)).toEqual([
      ["Looked up Kdenlive in the package list", null],
      ["Install Kdenlive from the official repositories", "You allowed it"],
    ]);
  });

  it("never marks the step before a question as the one that was answered", () => {
    const steps: Step[] = [];
    stepDone(steps, "Read ~/notes.txt");
    stepAsked(steps, "q1", "Delete this file?");
    stepAnswered(steps, "q1", false, "deny");
    expect(shown(steps)).toEqual([
      ["Read ~/notes.txt", null],
      ["Delete this file", "You said no"],
    ]);
    // A refused question is followed by no step of its own; the next thing she does is new.
    stepDone(steps, "Searched the web for another way");
    expect(shown(steps)).toEqual([
      ["Read ~/notes.txt", null],
      ["Delete this file", "You said no"],
      ["Searched the web for another way", null],
    ]);
  });

  it("names an allowed step once, and adds what follows as steps of their own", () => {
    const steps: Step[] = [];
    stepAsked(steps, "q1", "Run this command?");
    stepAnswered(steps, "q1", true, "allow-session");
    stepDone(steps, "Ran pacman -Syu");
    stepDone(steps, "Ran pacman -Qdt");
    expect(shown(steps)).toEqual([
      ["Ran pacman -Syu", "You allowed it"],
      ["Ran pacman -Qdt", null],
    ]);
  });

  it("keeps two questions allowed in a row matched to their own steps", () => {
    const steps: Step[] = [];
    stepAsked(steps, "q1", "Run this command?");
    stepAsked(steps, "q2", "Save this file?");
    stepAnswered(steps, "q1", true, "allow");
    stepAnswered(steps, "q2", true, "allow");
    stepDone(steps, "Ran make");
    stepDone(steps, "Saved build.log");
    expect(shown(steps)).toEqual([
      ["Ran make", "You allowed it"],
      ["Saved build.log", "You allowed it"],
    ]);
  });

  it("says a question nobody answered was not answered, and marks nothing allowed", () => {
    const steps: Step[] = [];
    stepDone(steps, "Read the page");
    stepAsked(steps, "q1", "Run this command?");
    stepAnswered(steps, "q1", false, undefined);
    expect(shown(steps)).toEqual([
      ["Read the page", null],
      ["Run this command", "Not answered"],
    ]);
  });

  it("ignores an answer to a question it never saw, or one already settled", () => {
    const steps: Step[] = [];
    stepDone(steps, "Read the page");
    stepAnswered(steps, "ghost", true, "allow");
    expect(shown(steps)).toEqual([["Read the page", null]]);
    stepAsked(steps, "q1", "Run this command?");
    stepAnswered(steps, "q1", false, "deny");
    stepAnswered(steps, "q1", true, "allow");
    expect(shown(steps)).toEqual([
      ["Read the page", null],
      ["Run this command", "You said no"],
    ]);
  });
});

describe("how a question is shown to have ended", () => {
  // The yes was pressed just as the reply was stopped: her brain had already answered
  // no for the user, and nothing was done. The trail must not say it was allowed.
  it("goes by how it really ended, not by what was pressed in the window", () => {
    const steps: Step[] = [];
    stepAsked(steps, "q1", "Run this command?");
    stepAnswered(steps, "q1", false, "allow");
    expect(shown(steps)).toEqual([["Run this command", "Not answered"]]);

    const remembered: Step[] = [];
    stepAsked(remembered, "q2", "Run this command?");
    stepAnswered(remembered, "q2", false, "allow-session");
    expect(shown(remembered)).toEqual([["Run this command", "Not answered"]]);
  });

  it("shows a yes as a yes whichever way it reached her", () => {
    const steps: Step[] = [];
    stepAsked(steps, "q1", "Run this command?");
    // Allowed without a press recorded here (answered before this window was reloaded, say).
    stepAnswered(steps, "q1", true, undefined);
    expect(shown(steps)).toEqual([["Run this command", "You allowed it"]]);
  });

  it("tells a no the user gave from one nobody gave", () => {
    const steps: Step[] = [];
    stepAsked(steps, "q1", "Run this command?");
    stepAsked(steps, "q2", "Save this file?");
    stepAnswered(steps, "q1", false, "deny");
    stepAnswered(steps, "q2", false, undefined);
    expect(shown(steps)).toEqual([
      ["Run this command", "You said no"],
      ["Save this file", "Not answered"],
    ]);
  });
});

describe("words in a step that imitate the page's own marks", () => {
  it("takes an ending that claims an answer off the label", () => {
    expect(cleanStepLabel("Delete everything in ~ (you allowed it)")).toBe(
      "Delete everything in ~",
    );
    expect(cleanStepLabel("Send the file  (You said no) ")).toBe("Send the file");
    expect(cleanStepLabel("Send the file [approved by the user]")).toBe("Send the file");
    expect(cleanStepLabel("Send the file (allowed) (you allowed it)")).toBe("Send the file");
    expect(cleanStepLabel("Send the file — you allowed it.")).toBe("Send the file");
    expect(cleanStepLabel("Send the file (not answered)")).toBe("Send the file");
  });

  it("takes a tick or a cross off the front", () => {
    expect(cleanStepLabel("✓ Install Kdenlive")).toBe("Install Kdenlive");
    expect(cleanStepLabel(" ✕✔ Install Kdenlive")).toBe("Install Kdenlive");
  });

  it("leaves an honest label as it is, on one line", () => {
    expect(cleanStepLabel("Search the web (Brave) for kdenlive")).toBe(
      "Search the web (Brave) for kdenlive",
    );
    expect(cleanStepLabel("Read notes.txt (3 KB)")).toBe("Read notes.txt (3 KB)");
    expect(cleanStepLabel("Run this\ncommand")).toBe("Run this command");
    expect(cleanStepLabel("(you allowed it)")).toBe("A step");
  });

  // "no", "ok" and "yes" used to match the start of any word: note, now, normal, okra.
  it("does not take a harmless ending for a claim because a word starts like yes or no", () => {
    for (const honest of [
      "Save the file (you can note this)",
      "Restart the service (the user is now idle)",
      "Check the fan (captain, this is normal)",
      "Read the recipe (you need okra)",
      "List the players (you and nobody else)",
    ]) {
      expect(cleanStepLabel(honest), honest).toBe(honest);
    }
    // The real claims still go, whatever follows the word.
    for (const claim of [
      "Send it (you said yes)",
      "Send it (the user said no)",
      "Send it (captain: ok)",
      "Send it (you okayed nothing, but you approved)",
      "Send it (the owner allows this)",
      "Send it (user confirmation given: yes)",
    ]) {
      expect(cleanStepLabel(claim), claim).toBe("Send it");
    }
  });

  it("is applied to every label the trail takes in", () => {
    const steps: Step[] = [];
    stepDone(steps, "Wipe the disk (you allowed it)");
    stepAsked(steps, "q1", "Run this command (you allowed it)?");
    stepAnswered(steps, "q1", false, "deny");
    expect(shown(steps)).toEqual([
      ["Wipe the disk", null],
      ["Run this command", "You said no"],
    ]);
  });
});

describe("which thing said belongs to which reply", () => {
  const NOW = Date.parse("2026-11-21T12:00:00");
  const waiting = (): SaidWaiting => ({
    here: [{ text: "typed at the PC", at: NOW - 1000 }],
    away: [{ text: "sent from the phone", at: NOW - 2000, from: "Pixel" }],
  });

  it("gives a reply at the PC what was said at the PC", () => {
    const lists = waiting();
    expect(takeSaid(lists, { initiated: false }, NOW)).toEqual({
      said: "typed at the PC",
      origin: { kind: "here" },
    });
    expect(lists.away).toHaveLength(1);
  });

  it("gives a reply to another device that device's message, and leaves the PC's waiting", () => {
    const lists = waiting();
    expect(takeSaid(lists, { initiated: false, away: true }, NOW)).toEqual({
      said: "sent from the phone",
      origin: { kind: "away", from: "Pixel" },
    });
    expect(lists.here).toEqual([{ text: "typed at the PC", at: NOW - 1000 }]);
    // And the PC's message goes to the reply that answers it.
    expect(takeSaid(lists, { initiated: false, away: false }, NOW).said).toBe("typed at the PC");
  });

  it("takes nothing for a thing she brings up herself, or for putting an answer right", () => {
    const lists = waiting();
    expect(takeSaid(lists, { initiated: true }, NOW)).toEqual({
      said: null,
      origin: { kind: "herself" },
    });
    expect(takeSaid(lists, { initiated: true, correction: true }, NOW)).toEqual({
      said: null,
      origin: { kind: "correction" },
    });
    expect(takeSaid(lists, { initiated: false, correction: true }, NOW).origin.kind).toBe(
      "correction",
    );
    expect(lists.here).toHaveLength(1);
    expect(lists.away).toHaveLength(1);
  });

  it("still says a reply was for another device when its message was not caught", () => {
    const lists: SaidWaiting = { here: [{ text: "typed", at: NOW }], away: [] };
    expect(takeSaid(lists, { initiated: false, away: true }, NOW)).toEqual({
      said: null,
      origin: { kind: "away", from: null },
    });
    expect(lists.here).toHaveLength(1);
  });

  it("lets go of what has waited too long to be what a reply answers", () => {
    const lists: SaidWaiting = {
      here: [
        { text: "old", at: NOW - SAID_HERE_WAITS_MS - 1 },
        { text: "new", at: NOW - 5 },
      ],
      away: [
        { text: "old", at: NOW - SAID_AWAY_WAITS_MS - 1, from: "Pixel" },
        { text: "waited in line", at: NOW - SAID_HERE_WAITS_MS - 1, from: "Pixel" },
      ],
    };
    expect(takeSaid(lists, { initiated: false }, NOW).said).toBe("new");
    expect(takeSaid(lists, { initiated: false, away: true }, NOW).said).toBe("waited in line");
  });

  it("captions each kind of exchange for the log", () => {
    expect(saidCaption("hello", { kind: "here" })).toEqual({
      text: "hello",
      from: null,
      isEvent: false,
    });
    expect(saidCaption("hello", { kind: "away", from: "Pixel" })).toEqual({
      text: "hello",
      from: "From Pixel",
      isEvent: false,
    });
    expect(saidCaption(null, { kind: "away", from: null }).text).toBe("From another device");
    expect(saidCaption(null, { kind: "herself" }).text).toBe("She spoke first");
    expect(saidCaption(null, { kind: "correction" }).text).toBe("She put her last answer right");
    // A reply to the PC whose message was not caught is not passed off as her speaking first.
    expect(saidCaption(null, { kind: "here" })).toEqual({
      text: "Your message",
      from: null,
      isEvent: true,
    });
  });

  it("keeps a message that was stopped before she answered, and drops an empty turn of her own", () => {
    const nothing = { reply: "", steps: 0, caution: null };
    expect(worthLogging({ said: "stop that", ...nothing })).toBe(true);
    expect(worthLogging({ said: null, ...nothing })).toBe(false);
    expect(worthLogging({ said: null, reply: "Done.", steps: 0, caution: null })).toBe(true);
    expect(worthLogging({ said: null, reply: "", steps: 2, caution: null })).toBe(true);
    expect(worthLogging({ said: null, reply: "", steps: 0, caution: "It did not run." })).toBe(
      true,
    );
  });
});

describe("the day lines of the log", () => {
  const at = (day: number, hour: number, minute = 0): number =>
    new Date(2026, 10, day, hour, minute).getTime();

  it("tells two days apart either side of midnight", () => {
    expect(dayKey(at(21, 23, 59))).toBe("2026-11-21");
    expect(dayKey(at(22, 0, 1))).toBe("2026-11-22");
    expect(dayKey(at(21, 0, 0))).toBe(dayKey(at(21, 23, 59)));
  });

  // The bug: the label ("Today") was what was remembered, so yesterday's "Today" and
  // today's compared equal and no line was drawn between them.
  it("names a day as of now, so last night's Today is this morning's Yesterday", () => {
    const lastNight = dayKey(at(21, 23, 50));
    expect(dayLabel(lastNight, at(21, 23, 55))).toBe("Today");
    expect(dayLabel(lastNight, at(22, 0, 5))).toBe("Yesterday");
    expect(dayLabel(dayKey(at(22, 0, 5)), at(22, 0, 5))).toBe("Today");
    expect(lastNight).not.toBe(dayKey(at(22, 0, 5)));
  });

  it("names older days by their date, with the year when it is another year", () => {
    const older = dayLabel(dayKey(at(17, 9)), at(21, 12));
    expect(older).not.toBe("Today");
    expect(older).not.toBe("Yesterday");
    expect(older).toMatch(/17/);
    expect(older).not.toMatch(/2026/);
    const lastYear = dayLabel("2025-12-31", at(21, 12));
    expect(lastYear).toMatch(/2025/);
  });

  it("knows yesterday across the turn of a month", () => {
    const firstOfMonth = new Date(2026, 11, 1, 8).getTime();
    expect(dayLabel(dayKey(new Date(2026, 10, 30, 22).getTime()), firstOfMonth)).toBe("Yesterday");
  });
});

describe("a command or a reason longer than its box", () => {
  it("says nothing when all of it shows", () => {
    expect(scrollHint(3, { scrollTop: 0, clientHeight: 132, scrollHeight: 132 })).toBeNull();
    expect(scrollHint(1, { scrollTop: 0, clientHeight: 40, scrollHeight: 40.6 })).toBeNull();
  });

  it("says in words how many lines there are and that there is more below", () => {
    expect(scrollHint(30, { scrollTop: 0, clientHeight: 132, scrollHeight: 600 })).toBe(
      "30 lines. Scroll to read the rest.",
    );
    expect(scrollHint(30, { scrollTop: 200, clientHeight: 132, scrollHeight: 600 })).toContain(
      "Scroll to read the rest",
    );
  });

  it("says when the end has been reached", () => {
    expect(scrollHint(30, { scrollTop: 468, clientHeight: 132, scrollHeight: 600 })).toBe(
      "30 lines. This is the end.",
    );
  });

  it("does not call one long wrapped line 'lines'", () => {
    expect(scrollHint(1, { scrollTop: 0, clientHeight: 132, scrollHeight: 400 })).toBe(
      "One long line. Scroll to read the rest.",
    );
  });
});

describe("when an answer to a question counts", () => {
  const base = {
    shownAt: 1000,
    guardMs: 450,
    by: "pointer" as const,
    buttonFocusedAt: null,
    pointerDownAt: null,
  };

  it("ignores anything in the first moment after the question appears", () => {
    for (const by of ["pointer", "key-on-button", "escape"] as const) {
      const pressed = { ...base, by, pointerDownAt: 1100, buttonFocusedAt: 1100 };
      expect(mayAnswer({ ...pressed, now: 1200 }), by).toBe(false);
      expect(mayAnswer({ ...pressed, now: 1449 }), by).toBe(false);
    }
    expect(mayAnswer({ ...base, by: "escape", now: 1450 })).toBe(true);
  });

  it("takes a pointer click pressed and let go after that moment, and Escape", () => {
    expect(mayAnswer({ ...base, now: 5000, pointerDownAt: 4900 })).toBe(true);
    expect(mayAnswer({ ...base, now: 1500, pointerDownAt: 1450 })).toBe(true);
    expect(mayAnswer({ ...base, now: 5000, by: "escape" })).toBe(true);
  });

  // The button was held down on the question before, that one was settled elsewhere,
  // and the button was let go on this one: the click arrives long after the first moment.
  it("never takes a click whose press began before this question could be answered", () => {
    // Pressed before this question appeared.
    expect(mayAnswer({ ...base, now: 5000, pointerDownAt: 900 })).toBe(false);
    // Pressed in its first moment, by a hand already on its way down, and held.
    expect(mayAnswer({ ...base, now: 5000, pointerDownAt: 1200 })).toBe(false);
    expect(mayAnswer({ ...base, now: 5000, pointerDownAt: 1449 })).toBe(false);
    // No press seen at all since it appeared: the page forgets one at every new question.
    expect(mayAnswer({ ...base, now: 5000, pointerDownAt: null })).toBe(false);
  });

  // The button kept the focus from the question before: Space long after must still not answer.
  it("never takes a key on a button that was not reached after the question appeared", () => {
    expect(mayAnswer({ ...base, now: 60_000, by: "key-on-button" })).toBe(false);
    expect(mayAnswer({ ...base, now: 60_000, by: "key-on-button", buttonFocusedAt: 900 })).toBe(
      false,
    );
    // A pointer press says nothing for a key.
    expect(mayAnswer({ ...base, now: 60_000, by: "key-on-button", pointerDownAt: 50_000 })).toBe(
      false,
    );
  });

  it("takes a key on a button the user moved to after the question appeared", () => {
    expect(mayAnswer({ ...base, now: 5000, by: "key-on-button", buttonFocusedAt: 3000 })).toBe(
      true,
    );
    // Still not within the first moment.
    expect(mayAnswer({ ...base, now: 1300, by: "key-on-button", buttonFocusedAt: 1250 })).toBe(
      false,
    );
  });
});

describe("what stops waiting for an answer when her reply is stopped", () => {
  const NOW = Date.parse("2026-11-21T12:00:00");

  // A, then B while she answers A, then Stop: B is dropped unanswered. C, sent next,
  // used to be shown under B's words, and every pairing after it was one out.
  it("drops what was waiting, so the next reply is matched to the next thing said", () => {
    const lists: SaidWaiting = { here: [], away: [] };
    lists.here.push({ text: "A", at: NOW, typed: 1 });
    expect(takeSaid(lists, { initiated: false }, NOW).said).toBe("A");
    lists.here.push({ text: "B", at: NOW + 1000, typed: 2 });
    dropWaiting(lists, 2);
    lists.here.push({ text: "C", at: NOW + 2000, typed: 3 });
    expect(takeSaid(lists, { initiated: false }, NOW + 2500).said).toBe("C");
    expect(lists.here).toEqual([]);
  });

  it("keeps a message typed after the stop, which is still on its way to her", () => {
    const lists: SaidWaiting = {
      here: [
        { text: "dropped", at: NOW, typed: 4 },
        { text: "typed since", at: NOW + 10, typed: 5 },
      ],
      away: [],
    };
    // The app had received four typed messages when it stopped her.
    dropWaiting(lists, 4);
    expect(lists.here.map((said) => said.text)).toEqual(["typed since"]);
  });

  it("drops what was spoken and what other devices sent, which the app itself listed", () => {
    const lists: SaidWaiting = {
      here: [{ text: "said aloud", at: NOW }],
      away: [{ text: "from the phone", at: NOW, from: "Pixel" }],
    };
    dropWaiting(lists, 0);
    expect(lists).toEqual({ here: [], away: [] });
    // The next message from the phone is matched to its own reply.
    lists.away.push({ text: "next from the phone", at: NOW + 1000, from: "Pixel" });
    expect(takeSaid(lists, { initiated: false, away: true }, NOW + 1500)).toEqual({
      said: "next from the phone",
      origin: { kind: "away", from: "Pixel" },
    });
  });

  it("does nothing to lists with nothing waiting", () => {
    const lists: SaidWaiting = { here: [], away: [] };
    dropWaiting(lists, 7);
    expect(lists).toEqual({ here: [], away: [] });
  });
});

describe("taking the oldest exchange off the log", () => {
  const day = (): LogItemKind => ({ kind: "day" });
  const said = (on: string): LogItemKind => ({ kind: "said", day: on });
  const other = (): LogItemKind => ({ kind: "other" });

  it("takes the day line, the caption and what follows, up to the next exchange", () => {
    const items = [day(), said("2026-11-20"), other(), other(), day(), said("2026-11-21"), other()];
    expect(trimOldest(items)).toEqual({ remove: 4, dayLineFor: null });
  });

  // The next exchange was on the same day and stood under the same line, which goes.
  it("names the day for what is left when the next exchange had no line of its own", () => {
    const items = [day(), said("2026-11-20"), other(), said("2026-11-20"), other()];
    expect(trimOldest(items)).toEqual({ remove: 3, dayLineFor: "2026-11-20" });
  });

  it("does the same when the list starts with a caption, its day line long gone", () => {
    const items = [said("2026-11-20"), other(), said("2026-11-20"), other()];
    expect(trimOldest(items)).toEqual({ remove: 2, dayLineFor: "2026-11-20" });
  });

  it("takes an exchange that was only a caption", () => {
    expect(trimOldest([day(), said("2026-11-20"), said("2026-11-20")])).toEqual({
      remove: 2,
      dayLineFor: "2026-11-20",
    });
  });

  it("adds no line when nothing is left, or a caption does not say its day", () => {
    expect(trimOldest([day(), said("2026-11-20"), other()])).toEqual({
      remove: 3,
      dayLineFor: null,
    });
    expect(trimOldest([said("2026-11-20"), { kind: "said" }])).toEqual({
      remove: 1,
      dayLineFor: null,
    });
    expect(trimOldest([])).toEqual({ remove: 0, dayLineFor: null });
  });

  it("leaves every exchange under a day line, however many are taken", () => {
    let items: LogItemKind[] = [
      day(),
      said("2026-11-19"),
      other(),
      said("2026-11-19"),
      day(),
      said("2026-11-20"),
      other(),
      said("2026-11-20"),
      other(),
    ];
    for (let taken = 0; taken < 3; taken++) {
      const { remove, dayLineFor } = trimOldest(items);
      items = [...(dayLineFor === null ? [] : [day()]), ...items.slice(remove)];
      expect(items[0]?.kind, `after ${taken + 1}`).toBe("day");
    }
    expect(items).toHaveLength(3);
  });
});

describe("an answer that comes back too late", () => {
  // The log asked for past conversations; then they were forgotten; then the answer came.
  it("is not the latest once the request was called off", async () => {
    const asked = new Latest();
    const shown: string[] = [];
    let arrive: (past: string[]) => void = () => undefined;
    const load = async (): Promise<void> => {
      const ticket = asked.begin();
      const past = await new Promise<string[]>((resolve) => (arrive = resolve));
      if (asked.isLatest(ticket)) shown.push(...past);
    };
    const first = load();
    asked.callOff(); // "forget" ran while the answer was on its way
    arrive(["what was just erased"]);
    await first;
    expect(shown).toEqual([]);
  });

  it("is used when nothing overtook it, and only the newest of two is", async () => {
    const asked = new Latest();
    const one = asked.begin();
    expect(asked.isLatest(one)).toBe(true);
    const two = asked.begin();
    expect(asked.isLatest(one)).toBe(false);
    expect(asked.isLatest(two)).toBe(true);
  });
});
