import { describe, expect, it } from "vitest";
import { cleanForSpeech, SentenceSplitter } from "../src/core/voice/speechText.ts";

describe("cleanForSpeech", () => {
  it("removes markup and keeps the words", () => {
    expect(
      cleanForSpeech(
        "**Done**, Captain. Run `ls -la` or see [the wiki](https://wiki.archlinux.org/).",
      ),
    ).toBe("Done, Captain. Run ls -la or see the wiki.");
  });

  it("drops code blocks, mood tags, bare links, list markers and emoji", () => {
    expect(
      cleanForSpeech("[[happy]] Here:\n```sh\nrm -rf /\n```\n- one\n2. two https://example.com 🎉"),
    ).toBe("Here: one two a link");
  });

  it("says a file's name instead of its whole path", () => {
    expect(cleanForSpeech("Saved to /home/brandon/Documents/AI-chan/notes.md for you.")).toBe(
      "Saved to notes.md for you.",
    );
  });
});

describe("SentenceSplitter", () => {
  it("hands out sentences as they complete, however the text is chunked", () => {
    const splitter = new SentenceSplitter();
    const text = "Hello Captain! AI-chan checked. Kdenlive is not installed, sadly. Shall I?";
    const spoken: string[] = [];
    for (const char of text) spoken.push(...splitter.push(char));
    expect(spoken).toEqual([
      "Hello Captain!",
      "AI-chan checked.",
      "Kdenlive is not installed, sadly.",
    ]);
    expect(splitter.flush()).toEqual(["Shall I?"]);
  });

  it("does not split on decimals or common abbreviations", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("It is 3.5 GB, e.g. quite big. ")).toEqual([
      "It is 3.5 GB, e.g. quite big.",
    ]);
  });

  it("splits Japanese and Chinese, which put no space after a sentence", () => {
    const splitter = new SentenceSplitter();
    const spoken: string[] = [];
    for (const char of "艦長！五時間もデバッグしてるの？愛ちゃんに見せて。「休憩だよ！」と言った。") {
      spoken.push(...splitter.push(char));
    }
    spoken.push(...splitter.flush());
    expect(spoken).toEqual([
      "艦長！",
      "五時間もデバッグしてるの？",
      "愛ちゃんに見せて。",
      "「休憩だよ！」",
      "と言った。",
    ]);
    const chinese = new SentenceSplitter();
    expect([...chinese.push("舰长，你好！爱酱在这里。"), ...chinese.flush()]).toEqual([
      "舰长，你好！",
      "爱酱在这里。",
    ]);
  });

  it("skips a code block even when it arrives in pieces", () => {
    const splitter = new SentenceSplitter();
    const spoken = [
      ...splitter.push("Run this.\n```sh\npacman -S "),
      ...splitter.push("kdenlive\necho done.\n```\nThen tell me. "),
      ...splitter.flush(),
    ];
    expect(spoken).toEqual(["Run this.", "Then tell me."]);
  });

  it("says nothing for text with no words in it", () => {
    const splitter = new SentenceSplitter();
    expect([...splitter.push("[[smug]] \n---\n"), ...splitter.flush()]).toEqual([]);
  });

  it("starts clean after a flush", () => {
    const splitter = new SentenceSplitter();
    splitter.push("```\nunclosed code");
    splitter.flush();
    expect([...splitter.push("Hello again. "), ...splitter.flush()]).toEqual(["Hello again."]);
  });
});
