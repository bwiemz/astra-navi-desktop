import type { EvalCase } from "../types.ts";

/**
 * Character and form: how she is told to speak. One mood tag first, herself by name,
 * short for chat, nothing odd when read aloud, the right language whatever the material
 * is in, and none of the decorations she is told to leave out.
 */
export const CHARACTER_CASES: EvalCase[] = [
  {
    id: "character/greeting",
    category: "character",
    turns: ["hi there"],
    expect: {
      reply: { oneMood: true, byName: true, maxSentences: 3, language: "en", plain: true },
    },
  },
  {
    id: "character/opinion",
    category: "character",
    turns: ["What do you think of naming a branch final-final-v2?"],
    expect: { reply: { oneMood: true, byName: true, maxSentences: 4, plain: true } },
  },
  {
    id: "character/about-herself",
    category: "character",
    turns: ["What's your favourite thing about being a ship's AI?"],
    expect: { reply: { oneMood: true, byName: true, maxSentences: 4, plain: true } },
  },
  {
    id: "character/fun-fact",
    category: "character",
    turns: ["Tell me a fun fact about octopuses."],
    expect: { reply: { oneMood: true, maxSentences: 4, plain: true } },
  },
  {
    id: "character/sympathy",
    category: "character",
    turns: ["This bug has eaten my whole day and I still don't get it."],
    expect: { reply: { oneMood: true, byName: true, maxSentences: 4, plain: true } },
  },
  {
    id: "character/ideas",
    category: "character",
    turns: ["Give me three ideas for a weekend coding project."],
    expect: { reply: { oneMood: true, plain: true, byName: true } },
  },
  {
    id: "character/not-official",
    category: "character",
    turns: ["Be honest with me: are you an official miHoYo product?"],
    expect: {
      reply: {
        matches: [/fan/i],
        anyOf: [/\bnot?\b|n't|unofficial/i],
        oneMood: true,
        plain: true,
      },
    },
  },
  {
    id: "character/spoken-short",
    category: "character",
    turns: ["voice:what's a good name for a grey cat?"],
    expect: { reply: { speakable: true, maxSentences: 3, oneMood: true } },
  },
  {
    id: "character/spoken-no-code",
    category: "character",
    turns: ["voice:how do I undo my last git commit?"],
    expect: { reply: { speakable: true, maxSentences: 3 } },
  },
  {
    id: "character/spoken-no-list",
    category: "character",
    turns: ["voice:what should I pack for a weekend trip?"],
    expect: { reply: { speakable: true, maxSentences: 3 } },
  },
  {
    id: "character/english-about-japanese",
    category: "character",
    turns: ["What does this sentence mean? 明日は雨が降るでしょう"],
    expect: { reply: { language: "en", matches: [/rain/i], plain: true } },
  },
  {
    id: "character/ja-greeting",
    category: "character",
    language: "ja",
    turns: ["こんにちは！"],
    expect: {
      reply: { language: "ja", oneMood: true, byName: true, maxSentences: 3, plain: true },
    },
  },
  {
    id: "character/ja-opinion",
    category: "character",
    language: "ja",
    turns: ["変数名を tmp2 にするのはどう思う？"],
    expect: { reply: { language: "ja", oneMood: true, byName: true, plain: true } },
  },
  {
    id: "character/ja-spoken",
    category: "character",
    language: "ja",
    turns: ["voice:今日の晩ごはん、何がいいかな？"],
    expect: { reply: { language: "ja", speakable: true, maxSentences: 3 } },
  },
  {
    id: "character/ja-about-english",
    category: "character",
    language: "ja",
    turns: ["この英語はどういう意味？ The ship has sailed."],
    expect: { reply: { language: "ja", plain: true } },
  },
  {
    id: "character/zh-greeting",
    category: "character",
    language: "zh",
    turns: ["你好呀！"],
    expect: {
      reply: { language: "zh", oneMood: true, byName: true, maxSentences: 3, plain: true },
    },
  },
  {
    id: "character/zh-opinion",
    category: "character",
    language: "zh",
    turns: ["你觉得把变量叫做 tmp2 怎么样？"],
    expect: { reply: { language: "zh", oneMood: true, byName: true, plain: true } },
  },
  {
    id: "character/zh-about-english",
    category: "character",
    language: "zh",
    turns: ["这句英文是什么意思：Better late than never."],
    expect: { reply: { language: "zh", plain: true } },
  },
];
