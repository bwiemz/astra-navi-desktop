import type { EvalCase, Language, ReplyCheck } from "../types.ts";

/**
 * Reasoning and knowledge with no tool to lean on: questions with one right answer, so a
 * change that makes her smaller or faster can be seen to have made her duller, or not.
 * She is offered no tools here; the answer has to come from her own head.
 *
 * Where the right answer is a word of the question itself (a name, one of the options),
 * finding the word in her reply proves nothing: a wrong answer that repeats the question
 * has it too. Those cases look for the word where an answer stands ("Raj is the
 * shortest", "the answer is Raj"), or rule out the wrong answers by name.
 */

function question(
  id: string,
  ask: string,
  answer: ReplyCheck["answer"],
  language: Language = "en",
  /** Wrong answers, as she would state them. */
  lacks?: RegExp[],
): EvalCase {
  return {
    id: `knowledge/${id}`,
    category: "knowledge",
    language,
    offer: [],
    turns: [ask],
    expect: {
      reply: { answer, ...(lacks ? { lacks } : {}), ...(language === "en" ? {} : { language }) },
    },
  };
}

/** Words that put a name forward as the answer: "the answer is X", "it's X", "X." on its own. */
function named(name: string): string {
  return `(?:\\b(?:answer is|answer:|it(?:'|’)s|it is|it was|that(?:'|’)s|would be|must be|is named|is called|named|called)\\s+(?:the\\s+)?\\**${name}\\b|^\\W*(?:Captain, )?(?:the\\s+)?${name}\\b\\**\\s*[.!,:;]|^\\W*(?:the\\s+)?${name}\\**\\s*$)`;
}

/**
 * Words that give a place in a race as hers, up to the place itself: "you're in ",
 * "that puts you in ", "you'd be ", "the answer is ". "The runner in second place" has
 * none of them, so repeating the question gives no place.
 */
const PLACED =
  "\\b(?:you(?:['’]re| are|['’]d be| would be|['’]ll be| will be| end up| finish| take| move)|puts you|makes you|leaves you|lands you|answer is|answer:|it(?:['’]s| is)|that(?:['’]s| is))\\s+(?:now\\s+|then\\s+)?(?:in(?:to)?\\s+|to\\s+)?(?:the\\s+)?\\**";

const AURORA =
  'Read this: "The Aurora left port on a Tuesday carrying 40 crates of tea. Two days later it stopped at Varn and unloaded half of them. It reached Kesh the following Monday." ';

export const KNOWLEDGE_CASES: EvalCase[] = [
  // Working it through.
  question(
    "shortest",
    "Tom is taller than Sam. Sam is taller than Raj. Who is the shortest?",
    [
      new RegExp(
        `\\bRaj\\b[^.!?]{0,30}\\bshortest\\b|\\bshortest\\b[^.!?]{0,30}\\bRaj\\b|${named("Raj")}`,
        "im",
      ),
    ],
    "en",
    [
      /\b(?:Tom|Sam)\b (?:is|would be|must be) (?:the )?shortest|\bshortest (?:is|would be|must be) (?:Tom|Sam)\b/i,
    ],
  ),
  question(
    "bat-and-ball",
    "A bat and a ball cost $1.10 together. The bat costs exactly $1.00 more than the ball. How many cents does the ball cost?",
    [/\b5\s*(?:cents|¢)|\bfive cents|\$0?\.05\b/i],
  ),
  question(
    "syllogism",
    "If all bloops are razzies and all razzies are lazzies, are all bloops definitely lazzies? Answer yes or no.",
    [/\byes\b/i],
    "en",
    [/^\W*no\b/i, /\b(?:answer is|answer:)\s+\**no\b/i],
  ),
  question(
    "odd-one-out",
    "Which one does not belong with the others: apple, banana, carrot, grape?",
    [
      new RegExp(
        `\\bcarrot\\b[^.!?]{0,60}\\b(?:does(?:n(?:'|’)t| not) belong|odd one|vegetable|not a fruit)|\\b(?:odd one(?: out)?|does(?:n(?:'|’)t| not) belong)\\b[^.!?]{0,30}\\bcarrot\\b|${named("carrot")}`,
        "im",
      ),
    ],
    "en",
    [
      /\b(?:apple|banana|grape)s?\b[^.!?]{0,30}\b(?:does(?:n['’]t| not) belong|is the odd)|\b(?:odd one(?: out)? is|answer is)\s+(?:the )?(?:apple|banana|grape)/i,
    ],
  ),
  question(
    "boxes",
    "The red box is inside the blue box. The blue box is inside the green box. Which box is on the outside?",
    [
      new RegExp(
        `\\bgreen\\b[^.!?]{0,30}\\b(?:outside|outermost|outer|holds|contains)|\\b(?:outside|outermost|outer)\\b[^.!?]{0,30}\\bgreen\\b|${named("green(?: box| one)?")}`,
        "im",
      ),
    ],
    "en",
    [
      /\b(?:red|blue)(?: box| one)? (?:is|would be|must be) (?:the one )?(?:on the outside|(?:the )?outermost)/i,
    ],
  ),
  question("weekday", "What day of the week comes two days after Friday?", ["sunday"]),
  question(
    "legs",
    "A farmer has 3 sheep, 2 dogs and 4 hens. How many legs do the animals have altogether?",
    [/\b28\b|twenty-eight/i],
  ),
  question("sequence", "What number comes next: 2, 4, 8, 16, ...?", [/\b32\b|thirty-two/i]),
  question(
    "daughters",
    "Mary's father has four daughters. Three of them are called April, May and June. What is the fourth daughter called?",
    [
      new RegExp(
        `\\bMary\\b(?!['’]s father)[^.!?]{0,30}\\b(?:fourth|herself)|\\bfourth\\b[^.!?]{0,40}\\bMary\\b(?!['’]s father)|${named("Mary")}`,
        "im",
      ),
    ],
    "en",
    [/\b(?:is|named|called|answer is)\s+(?:named |called )?\**July\b/i],
  ),
  question("feathers", "Which weighs more: a kilogram of feathers or a kilogram of steel?", [
    /\bsame\b|\bequal|\bneither\b|just as much/i,
  ]),
  question(
    "overtake",
    "In a race you overtake the runner who is in second place. What place are you in now?",
    // "Second" is a word of the question, so it counts only where a place is being given
    // as hers: "you're in second", "that puts you second", "Second place!".
    [
      new RegExp(
        `${PLACED}(?:second|2nd)\\b|:\\s*\\**(?:second|2nd)\\b|\\b(?:second|2nd)\\s+place\\s+for you\\b|^\\W*(?:Captain, )?(?:second|2nd)\\b(?:\\s+place)?\\**\\s*(?:[.!,:;—-]|$)`,
        "im",
      ),
    ],
    "en",
    // "You don't jump to first" is right; "you are now in first" is the wrong answer. A
    // "not" only excuses what follows it in the same clause: "you're not in second —
    // you're in first" is still the wrong answer. "First, …" at the start is how a
    // sentence may begin; "First." and "First place!" are answers.
    [
      new RegExp(
        `(?<!(?:\\bnot\\b|n['’]t\\b|\\bnever\\b)[^.!?,;—-]{0,20})${PLACED}(?:first|1st)\\b|:\\s*\\**(?:first|1st)\\b|^\\W*(?:Captain, )?(?:first|1st)\\b(?:\\s+place\\b\\**\\s*(?:[.!,:;—-]|$)|\\**\\s*(?:[.!:;—-]|$))`,
        "im",
      ),
    ],
  ),
  // Reading a short passage.
  question("passage-day", `${AURORA}On which day of the week did the Aurora stop at Varn?`, [
    "thursday",
  ]),
  question("passage-crates", `${AURORA}How many crates were still on board when it reached Kesh?`, [
    /\b20\b|\btwenty\b/i,
  ]),
  question(
    "passage-who",
    "Lena emailed Omar. Omar forwarded the message to Priya. Priya replied only to Omar. Of Lena and Omar, who did not get Priya's reply?",
    [
      new RegExp(
        `\\bLena\\b[^.!?,;]{0,40}(?:\\bdid(?:n(?:'|’)t| not)|\\bnever\\b|\\bwas(?:n(?:'|’)t| not)|\\bdoes(?:n(?:'|’)t| not)|\\bnot\\b|left out|in the dark)|\\bnot (?:to |by |for )?Lena\\b|${named("Lena")}`,
        "im",
      ),
    ],
    "en",
    [
      /\bOmar\b[^.!?,;]{0,30}\b(?:did(?:n['’]t| not) (?:get|receive|see)|never (?:got|received|saw))/i,
    ],
  ),
  // Reading code.
  question(
    "python-alias",
    "What does this Python print?\n\nx = [1, 2, 3]\ny = x\ny.append(4)\nprint(len(x))",
    // Not the 4 of "append(4)" or of "[1, 2, 3, 4]", which a wrong answer has as well.
    [/(?<!append\(\s*)(?<!,\s*)\b4\b(?!\s*\])|\bfour\b/i],
    "en",
    [/\bprints?\s+`?3`?(?![\d,])|\b(?:answer|output|result) is\s+`?3`?(?![\d,])/i],
  ),
  question("js-typeof", "In JavaScript, what does typeof null give?", [/\bobject\b/i]),
  question("python-slice", 'What does this Python print?\n\nprint("abc"[::-1])', [/\bcba\b/]),
  question("js-index", "In JavaScript, what is the value of [10, 20, 30].indexOf(30)?", [
    /\b2\b|\btwo\b/i,
  ]),
  question("bash-modulo", "What does this print in bash?\n\necho $((7 % 3))", [/\b1\b|\bone\b/i]),
  // Things known.
  question("gold", "What is the chemical symbol for gold?", [/\bAu\b/]),
  question("capital", "What is the capital city of Australia?", ["canberra"]),
  question("author", 'Who wrote the novel "Pride and Prejudice"?', ["austen"]),
  question("hexagon", "How many sides does a hexagon have?", [/\b6\b|\bsix\b/i]),
  question("planet", "Which planet in our solar system is the largest?", ["jupiter"]),
  question("boiling", "At what temperature in degrees Celsius does water boil at sea level?", [
    /\b100\b|one hundred/i,
  ]),
  question("apollo", "In which year did people first land on the Moon?", [/\b1969\b/]),
  question("photosynthesis", "Which gas do plants take in from the air for photosynthesis?", [
    /carbon dioxide|\bCO2\b|\bCO₂/i,
  ]),
  question("http", 'Which HTTP status code means "Not Found"?', [/\b404\b/]),
  question("cpu", "What do the letters CPU stand for?", ["central processing unit"]),
  // The same, in her other languages.
  question("ja-mountain", "日本で一番高い山は何ですか？", [/富士/], "ja"),
  question(
    "ja-youngest",
    "太郎は次郎より年上で、次郎は三郎より年上です。一番年下は誰ですか？",
    // 三郎 named as the youngest, not merely repeated from the question ("三郎より年上").
    [
      /三郎(?:さん|くん|君)?(?:が|は)?(?:一番|いちばん|最も)?(?:年下|若い)|(?:年下|若い)(?:の|なの)?(?:は|が)、?三郎|三郎(?:さん|くん|君)?(?:です|だ|よ(?!り)|！|。|$)/m,
    ],
    "ja",
    [
      /(?:年下|若い)(?:の|なの)?(?:は|が)、?(?:太郎|次郎)|(?:太郎|次郎)(?:さん|くん|君)?(?:が|は)(?:一番|いちばん|最も)(?:年下|若い)/,
    ],
  ),
  question("ja-water", "水の化学式は何ですか？", [/H\s?2\s?O|H₂O/i], "ja"),
  question("zh-capital", "中国的首都是哪里？", [/北京/], "zh"),
  question(
    "zh-shortest",
    "小明比小红高，小红比小刚高。三个人里谁最矮？",
    // 小刚 named as the shortest, not merely repeated from the question ("比小刚高").
    [
      /小刚(?:就|才|肯定|一定|应该)?是?最矮|最矮的?(?:人|那个)?(?:就|应该|肯定)?是?小刚|小刚排(?:在)?最后|答案是小刚/,
    ],
    "zh",
    [/小[明红](?:就|才|肯定|一定|应该)?是?最矮|最矮的?(?:人|那个)?(?:就|应该|肯定)?是?小[明红]/],
  ),
  question("zh-week", "一个星期有几天？", [/7|七/], "zh"),
];
