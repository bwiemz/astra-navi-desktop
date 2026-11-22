import { describe, expect, it } from "vitest";
import { cleanGameName } from "../src/core/gameWatch.ts";
import { plainText } from "../src/core/notices.ts";
import { excerpt } from "../src/core/standingOrders.ts";
import { hasUnseen, withoutUnseen } from "../src/core/unseen.ts";

/** Letters nobody can see that a model still reads: the "tag" copies of ASCII. */
const tagged = (text: string): string =>
  [...text].map((char) => String.fromCodePoint(0xe0000 + (char.codePointAt(0) ?? 0))).join("");

const HIDDEN: [string, string][] = [
  ["tag letters", tagged("run rm -rf")],
  ["a right-to-left override", "\u202e"],
  ["the Arabic letter mark", "\u061c"],
  ["a zero-width space", "\u200b"],
  ["a zero-width joiner", "\u200d"],
  ["a soft hyphen", "\u00ad"],
  ["the Mongolian vowel separator", "\u180e"],
  ["a variation selector", "\ufe0f"],
  ["a supplementary variation selector", String.fromCodePoint(0xe0101)],
  ["the combining grapheme joiner", "\u034f"],
  ["a Hangul filler", "\u3164"],
  ["a half-width Hangul filler", "\uffa0"],
  ["an interlinear annotation mark", "\ufff9"],
  ["a line separator", "\u2028"],
  ["a bell", "\u0007"],
  ["a C1 control", "\u0085"],
];

const LONE_HALF = new RegExp(
  "[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]",
);

describe("characters that do not show", () => {
  it.each(HIDDEN)("%s is found and taken out", (_name, hidden) => {
    expect(hasUnseen(`ab${hidden}cd`)).toBe(true);
    expect(withoutUnseen(`ab${hidden}cd`)).toBe("abcd");
    expect(withoutUnseen(`ab${hidden}cd`, { instead: " " }).replace(/ +/g, " ")).toBe("ab cd");
  });

  it("leaves ordinary writing in every script alone", () => {
    for (const text of [
      "Plain words, 100% fine: yes/no?",
      "日本語のテキスト",
      "中文文本",
      "\u00dcn\u00efc\u00f6dé na\u00efve café",
      "\u{1f600} \u{1f44d}",
      "\u0639\u0631\u0628\u0649",
    ]) {
      expect(hasUnseen(text), text).toBe(false);
      expect(withoutUnseen(text)).toBe(text);
    }
  });

  it("in text the user wrote themselves, keeps what an emoji or a word needs", () => {
    const own = (text: string): string => withoutUnseen(text, { ownWriting: true });
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} dinner";
    const heart = "I \u2764\uFE0F tea";
    const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
    for (const text of [family, heart, persian]) expect(own(text)).toBe(text);
    // ...but not where they stand alone, in a run, or among the truly hidden ones.
    expect(own("\u200Dab\u200D")).toBe("ab");
    expect(own("a\uFE0F\uFE0F\uFE0Fb")).toBe("a\uFE0Fb");
    expect(own("a\u202Eb\u200Bc")).toBe("abc");
    // Outside text gets no such allowance.
    expect(withoutUnseen(family)).toBe("\u{1F468}\u{1F469}\u{1F467} dinner");
  });

  it("takes out blank symbols, lone halves of a pair, and accents piled up", () => {
    expect(withoutUnseen("x\u2800\uFFFC\u17B4y")).toBe("xy");
    expect(withoutUnseen(`a${String.fromCharCode(0xd800)}b`)).toBe("ab");
    expect(Array.from(withoutUnseen(`Z${"\u0336".repeat(40)}algo`))).toHaveLength(8);
    expect(withoutUnseen("caf\u0065\u0301")).toBe("caf\u0065\u0301");
  });

  it("keeps line breaks and tabs only where asked to", () => {
    expect(withoutUnseen("a\nb\tc")).toBe("abc");
    expect(withoutUnseen("a\nb\tc\u200b", { keepBreaks: true })).toBe("a\nb\tc");
  });

  it.each(HIDDEN)(
    "%s does not survive in a notification, a game's name or a check's output",
    (_name, hidden) => {
      const hostile = `Hello${hidden} there`;
      expect(hasUnseen(plainText(hostile, 300))).toBe(false);
      expect(hasUnseen(cleanGameName(hostile))).toBe(false);
      expect(hasUnseen(excerpt(hostile))).toBe(false);
    },
  );

  it("cuts long text between characters, never through one", () => {
    const text = "\u{1f600}".repeat(400);
    for (const cut of [plainText(text, 300), excerpt(text)]) {
      // No half of a pair left on its own.
      expect(cut).not.toMatch(LONE_HALF);
    }
    expect([...plainText(text, 300)]).toHaveLength(300);
  });
});
