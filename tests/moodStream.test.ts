import { describe, expect, it } from "vitest";
import { MoodStream } from "../src/core/moodStream.ts";
import type { Mood } from "../src/shared/ipc.ts";

function run(chunks: string[]): { text: string; moods: Mood[] } {
  let text = "";
  const moods: Mood[] = [];
  const stream = new MoodStream({
    text: (delta) => {
      text += delta;
    },
    mood: (mood) => moods.push(mood),
  });
  for (const chunk of chunks) stream.push(chunk);
  stream.flush();
  return { text, moods };
}

describe("MoodStream", () => {
  it("removes a leading tag and reports the mood", () => {
    expect(run(["[[happy]] Hello, Captain!"])).toEqual({
      text: "Hello, Captain!",
      moods: ["happy"],
    });
  });

  it("handles a tag split across every possible chunk boundary", () => {
    const full = "[[surprised]]\nReally?";
    for (let cut = 1; cut < full.length; cut++) {
      expect(run([full.slice(0, cut), full.slice(cut)])).toEqual({
        text: "Really?",
        moods: ["surprised"],
      });
    }
  });

  it("handles one character at a time", () => {
    expect(run([..."[[smug]] Told you."])).toEqual({ text: "Told you.", moods: ["smug"] });
  });

  it("picks up a tag in the middle of a reply", () => {
    expect(run(["Hmm. [[thinking]] Let me look."])).toEqual({
      text: "Hmm. Let me look.",
      moods: ["thinking"],
    });
  });

  it("treats a made-up mood at the start of a reply as a mood, not as text", () => {
    expect(run(["[[curious]] Let me check."])).toEqual({
      text: "Let me check.",
      moods: ["thinking"],
    });
    expect(run(["[[sparkly]] Ta-da!"])).toEqual({ text: "Ta-da!", moods: ["neutral"] });
  });

  it("leaves unknown double-bracket text alone", () => {
    expect(run(["Use [[wikilinks]] here."])).toEqual({
      text: "Use [[wikilinks]] here.",
      moods: [],
    });
  });

  it("does not swallow ordinary brackets or an unfinished tag", () => {
    expect(run(["array[0] and [1]"]).text).toBe("array[0] and [1]");
    expect(run(["ends with [[hap"]).text).toBe("ends with [[hap");
    expect(run(["a long [[ that is never closed and keeps going on"]).text).toBe(
      "a long [[ that is never closed and keeps going on",
    );
  });

  it("starts clean for the next reply after a flush", () => {
    let text = "";
    const stream = new MoodStream({ text: (delta) => (text += delta), mood: () => undefined });
    stream.push("  first");
    stream.flush();
    stream.push("  second");
    stream.flush();
    expect(text).toBe("firstsecond");
  });

  it("stops showing a reply at tool markup written out as text, however it is split", () => {
    for (const chunks of [
      [
        "[[surprised]] Got it, Captain. Let me read the file.\n<tool_call>\n<function=read_file>",
        '{"path": "x"}</function></tool_call>',
      ],
      ["Reading it now. <to", "ol_call><function=read_file>"],
      ["On it. ", "<function=open>", "more"],
    ]) {
      const shown: string[] = [];
      const stream = new MoodStream({ text: (delta) => shown.push(delta), mood: () => undefined });
      stream.hideToolMarkup = true;
      for (const chunk of chunks) stream.push(chunk);
      stream.flush();
      expect(shown.join("")).not.toMatch(/tool_call|function=|path/);
      expect(shown.join("").length).toBeGreaterThan(5);
      // The next reply starts clean.
      stream.push("Next reply <b>fine</b>");
      stream.flush();
      expect(shown.join("")).toContain("Next reply <b>fine</b>");
    }
  });

  it("shows tool markup as written in a reply that has tools, where it is just text", () => {
    const shown: string[] = [];
    const stream = new MoodStream({ text: (delta) => shown.push(delta), mood: () => undefined });
    stream.push("A call looks like <tool_call><function=open> in this format.");
    stream.flush();
    expect(shown.join("")).toBe("A call looks like <tool_call><function=open> in this format.");
  });

  it("does not hold back or lose ordinary text that merely contains an angle bracket", () => {
    const shown: string[] = [];
    const stream = new MoodStream({ text: (delta) => shown.push(delta), mood: () => undefined });
    stream.hideToolMarkup = true;
    stream.push("Use a < b and <too");
    stream.push("ls> here");
    stream.push(" then 5 <");
    stream.flush();
    expect(shown.join("")).toBe("Use a < b and <tools> here then 5 <");
  });
});

const MARKS = ["[ship's clock]", "[on screen]", "[your notes]", "[event]", "[voice]"];

/** Runs a reply made of stretches of text with a tool call between each two. */
function reply(stretches: string[][], marks: string[] = MARKS): { text: string; shown: string[] } {
  let text = "";
  const shown: string[] = [];
  const stream = new MoodStream(
    {
      text: (delta) => {
        text += delta;
      },
      mood: () => undefined,
    },
    { sideMarks: marks },
  );
  stretches.forEach((chunks, index) => {
    if (index > 0) {
      stream.push("\n\n");
      stream.afterTool();
      shown.push(text);
    }
    for (const chunk of chunks) stream.push(chunk);
  });
  stream.flush();
  return { text, shown };
}

describe("a mood she made up, arriving a character at a time", () => {
  it("is still taken for a mood when it is a long word", () => {
    for (const tag of ["disappointed", "apologetic", "determined", "contemplative"]) {
      expect(run([...`[[${tag}]] Hi, Captain.`]).text, tag).toBe("Hi, Captain.");
      expect(run([`[[${tag}`, `]] Hi, Captain.`]).text, tag).toBe("Hi, Captain.");
    }
  });

  it("is ordinary text when it is too long to be one, or never closes", () => {
    expect(run([..."[[this is not a mood at all]] Hi."]).text).toBe(
      "[[this is not a mood at all]] Hi.",
    );
    expect(run([..."[[unfinished and then the reply goes on"]).text).toBe(
      "[[unfinished and then the reply goes on",
    );
  });
});

describe("thinking that slips out after a tool call", () => {
  it("is dropped up to the mark that ends it", () => {
    const { text } = reply([
      ["[[thinking]] Checking the folder."],
      [
        "The listing only shows clip.mp4. Let me look again.\n</think>\n\n",
        "The GIF is not there, Captain.",
      ],
    ]);
    expect(text).toBe("Checking the folder.\n\nThe GIF is not there, Captain.");
  });

  it("is dropped whatever way the mark is cut into chunks", () => {
    const after = "Hmm, exit code 0 but no file.\n</think>\n\nNo file was made, Captain.";
    for (let cut = 1; cut < after.length; cut++) {
      const { text } = reply([["Looking."], [after.slice(0, cut), after.slice(cut)]]);
      expect(text, String(cut)).toBe("Looking.\n\nNo file was made, Captain.");
    }
    expect(reply([["Looking."], [...after]]).text).toBe("Looking.\n\nNo file was made, Captain.");
  });

  it("shows nothing of that stretch until it is clear what it is", () => {
    const { shown, text } = reply([
      ["First."],
      ["I should check the path again.\n</think>\n\nSecond."],
      ["Third."],
    ]);
    // What was on screen when each tool started: never the thought.
    expect(shown).toEqual(["First.\n\n", "First.\n\nSecond.\n\n"]);
    expect(text).toBe("First.\n\nSecond.\n\nThird.");
  });

  it("lets an ordinary answer after a tool through unchanged", () => {
    expect(reply([["Let me look."], ["It is 16 degrees in Kyoto, Captain."]]).text).toBe(
      "Let me look.\n\nIt is 16 degrees in Kyoto, Captain.",
    );
  });

  it("stops holding a long answer back once it is long enough to be one", () => {
    let text = "";
    const stream = new MoodStream({ text: (delta) => (text += delta), mood: () => undefined });
    stream.push("Looking.");
    stream.afterTool();
    stream.push("word ".repeat(100));
    expect(text).toBe("Looking.");
    stream.push("word ".repeat(40));
    expect(text.length).toBeGreaterThan(600);
    stream.flush();
    expect(text).toBe(`Looking.${"word ".repeat(140)}`);
  });

  it("never shows the mark itself, even where the thought before it cannot be taken back", () => {
    expect(run(["Thinking out loud.</think> Hello, Captain."]).text).toBe(
      "Thinking out loud. Hello, Captain.",
    );
    expect(reply([["A."], ["<think>quiet</think>B."]]).text).toBe("A.\n\nB.");
  });

  it("starts each reply afresh", () => {
    let text = "";
    const stream = new MoodStream({ text: (delta) => (text += delta), mood: () => undefined });
    stream.push("One.");
    stream.afterTool();
    stream.flush();
    stream.push("Two, straight away");
    expect(text).toBe("One.Two, straight away");
  });
});

describe("lines of hers that imitate the app's own lines", () => {
  it("are dropped from the end of a reply", () => {
    expect(
      reply([
        [
          "Done, Captain. You'll hear from me at nine.\n\n[ship's clock] Saturday 21 November 2026, 15:55",
        ],
      ]).text.trimEnd(),
    ).toBe("Done, Captain. You'll hear from me at nine.");
    expect(reply([["It is 16°C in Kyoto.\n\n[ship's clock]"]]).text.trimEnd()).toBe(
      "It is 16°C in Kyoto.",
    );
  });

  it("are dropped from the middle, keeping what is around them", () => {
    expect(
      reply([["Here are your windows:\n[on screen] A terminal and an editor.\nThat is all."]]).text,
    ).toBe("Here are your windows:\nThat is all.");
  });

  it("are dropped in doubled brackets, in bold, and whatever the chunking", () => {
    const full =
      "Volume is at 65%.\n\n[[ship's clock]] Saturday, 15:56\n**[On Screen]** Terminal\nAnything else?";
    const want = "Volume is at 65%.\n\nAnything else?";
    expect(reply([[full]]).text).toBe(want);
    expect(reply([[...full]]).text).toBe(want);
    for (let cut = 1; cut < full.length; cut++) {
      expect(reply([[full.slice(0, cut), full.slice(cut)]]).text, String(cut)).toBe(want);
    }
  });

  it("leave a reply that is nothing else empty", () => {
    expect(
      reply([["[[ship's clock]] Saturday 21 November 2026, 15:56\n[on screen] Terminal window"]])
        .text,
    ).toBe("");
  });

  it("do not touch such words inside a sentence, or other brackets at a line start", () => {
    const text = "The line marked [ship's clock] is the time.\n[1] First source\n[x] done";
    expect(reply([[text]]).text).toBe(text);
    expect(reply([[...text]]).text).toBe(text);
  });

  it("do not hold up ordinary text", () => {
    let text = "";
    const stream = new MoodStream(
      { text: (delta) => (text += delta), mood: () => undefined },
      { sideMarks: MARKS },
    );
    stream.push("Hi");
    expect(text).toBe("Hi");
    stream.push(", Captain.\n[shi");
    expect(text).toBe("Hi, Captain.\n");
    stream.push("p happens]");
    stream.flush();
    expect(text).toBe("Hi, Captain.\n[ship happens]");
  });

  it("are caught after leaked thinking as well", () => {
    expect(
      reply([
        ["Looking."],
        ["Wait.\n</think>\n\nAll good.\n\n[ship's clock] 15:57"],
      ]).text.trimEnd(),
    ).toBe("Looking.\n\nAll good.");
  });

  it("change nothing when no marks are given", () => {
    expect(run(["Hello.\n[ship's clock] 15:55"]).text).toBe("Hello.\n[ship's clock] 15:55");
  });
});
