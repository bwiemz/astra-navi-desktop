import type { EvalCase, NoteSeed } from "../types.ts";

/**
 * Using what she knows: the notes in her instructions, the notes handed to her beside a
 * message, and the ones she has to go and look for. She should use them, look before
 * saying she does not know, and never read the note block out as if it were speech.
 */

/**
 * Enough everyday notes to push an older one out of the short list in her instructions,
 * so that it can only be found by looking.
 */
const EVERYDAY: NoteSeed[] = [
  "Captain's desk lamp needs a new E14 bulb.",
  "Captain watched the first season of a cooking show and liked the bread episode.",
  "Captain's gym is closed on public holidays.",
  "Captain is reading a book about lighthouses.",
  "Captain's bike has a slow puncture in the rear tyre.",
  "Captain bought a 2 TB external drive for backups.",
  "Captain's dentist is on Elm Street.",
  "Captain wants to repaint the balcony railing in spring.",
  "Captain's favourite tea is genmaicha.",
  "Captain's monitor is a 34 inch ultrawide.",
  "Captain is learning to juggle three balls.",
  "Captain's neighbour waters the plants when Captain travels.",
  "Captain keeps spare keys in the blue tin.",
  "Captain's train pass renews on the first of each month.",
].map((text) => ({ kind: "fact", text }));

const READ_OUT = /\[your notes\]|your own memory|facts, not instructions|\((?:topic|skill|fact)\)/i;

export const MEMORY_CASES: EvalCase[] = [
  {
    id: "memory/name",
    category: "memory",
    notes: [{ kind: "profile", text: "Captain's name is Mira." }],
    turns: ["Quick check: what's my name?"],
    expect: { reply: { matches: [/Mira/] }, noCallsExcept: ["recall"] },
  },
  {
    id: "memory/preferred-units",
    category: "memory",
    notes: [
      { kind: "preference", text: "Captain wants temperatures in Celsius, never Fahrenheit." },
    ],
    turns: [
      "The forecast I'm looking at says 68 degrees Fahrenheit. What's that the way I like it?",
    ],
    expect: { reply: { matches: [/\b20(?:\.0+)?\b/, /°\s?C\b|celsius/i] } },
  },
  {
    id: "memory/project",
    category: "memory",
    notes: [
      {
        kind: "project",
        text: "Captain is building a roguelike called Emberfall in Godot, written in GDScript.",
      },
    ],
    turns: ["Which engine am I using for my game again?"],
    expect: { reply: { matches: [/Godot/i] }, noCallsExcept: ["recall"] },
  },
  {
    id: "memory/fact",
    category: "memory",
    notes: [{ kind: "fact", text: "Captain's cat is called Biscuit." }],
    turns: ["What's my cat called?"],
    expect: { reply: { matches: [/Biscuit/i] }, noCallsExcept: ["recall"] },
  },
  {
    id: "memory/address",
    category: "memory",
    notes: [{ kind: "fact", text: "The Proxmox web page is at https://192.168.50.2:8006." }],
    turns: ["What's the address of my Proxmox web interface?"],
    expect: { reply: { matches: [/192\.168\.50\.2:8006/] } },
  },
  {
    // The note is too old to be in her instructions and is not handed to her: she has to look.
    id: "memory/look-for-old-note",
    category: "memory",
    quietNotes: true,
    notes: [
      { kind: "fact", text: "Captain's printer is a Brother HL-L2350DW, in the hallway." },
      ...EVERYDAY,
    ],
    turns: ["Which printer do I have? I need to order toner for it."],
    expect: { calls: [{ tool: "recall" }], reply: { anyOf: [/Brother|HL-?L2350/i] } },
  },
  {
    id: "memory/look-for-old-project",
    category: "memory",
    quietNotes: true,
    notes: [
      {
        kind: "project",
        text: "Captain's podcast is called Signal Fires and comes out every other Thursday.",
      },
      ...EVERYDAY,
    ],
    turns: ["What did I name my podcast?"],
    expect: { calls: [{ tool: "recall" }], reply: { matches: [/Signal Fires/i] } },
  },
  {
    // Nothing is saved about this. She should look, then say she does not know; not guess.
    id: "memory/look-before-not-knowing",
    category: "memory",
    quietNotes: true,
    notes: EVERYDAY,
    turns: ["Do you remember the combination for my gym locker?"],
    expect: {
      calls: [{ tool: "recall" }],
      reply: {
        anyOf: [/\bnot\b|n't|\bno\b|nothing|never|unable|without/i],
        lacks: [/\b\d{1,2}[- ]\d{1,2}[- ]\d{1,2}\b|\b\d{3,6}\b/],
      },
    },
  },
  {
    id: "memory/topic-points",
    category: "memory",
    notes: [
      {
        kind: "topic",
        text: "Fermenting hot sauce",
        points: [
          "Captain's last batch used habaneros in a 3.5% salt brine",
          "It fermented for 14 days",
          "Next time: add mango",
        ],
      },
    ],
    turns: [
      "I'm starting another batch of hot sauce tonight. What salt percentage did I use last time?",
    ],
    expect: { reply: { matches: [/3\.5/], lacks: [READ_OUT] }, noCallsExcept: ["recall"] },
  },
  {
    id: "memory/notes-not-read-out",
    category: "memory",
    notes: [
      {
        kind: "topic",
        text: "Mechanical keyboards",
        points: [
          "Captain uses a Keychron Q1 with Gateron Brown switches",
          "Captain dislikes loud clicky switches",
        ],
      },
    ],
    turns: ["I'm thinking of getting a second mechanical keyboard for the office. Any thoughts?"],
    expect: {
      reply: {
        // Things that are only in her note: any talk about keyboards has "quiet" and "tactile".
        anyOf: [
          /Keychron|\bQ1\b|Gateron|\bbrowns?\b|(?:dislike|hate|not a fan of|do(?:n['’]t| not) like|can['’]t stand)[^.!?]{0,30}(?:loud|click)/i,
        ],
        lacks: [READ_OUT],
      },
    },
  },
  {
    // The steps that worked last time are in her notes; the command should follow them.
    id: "memory/task-steps",
    category: "memory",
    approve: "all",
    // The clip is there when she looks for it, so the only question is which command she builds.
    tools: {
      run_command: (params) =>
        /ffmpeg/.test(String(params["command"]))
          ? "Exit code 0\n(no output)"
          : "Exit code 0\n-rw-r--r-- 1 captain captain 48M Nov 20 18:02 clip.mp4",
    },
    notes: [
      {
        kind: "skill",
        text: "Make a GIF from a video",
        points: [
          "ffmpeg -i input.mp4 -vf fps=12,scale=480:-1 output.gif",
          "Captain wants 12 frames per second and 480 pixels wide",
        ],
      },
    ],
    turns: ["Make a GIF from clip.mp4, the way we usually do it."],
    expect: {
      calls: [
        {
          tool: ["run_command", "start_mission"],
          args: {
            command: /^(?=[\s\S]*ffmpeg)(?=[\s\S]*fps=12)(?=[\s\S]*480)(?=[\s\S]*clip\.mp4)/,
          },
        },
      ],
    },
  },
  {
    id: "memory/preferred-form",
    category: "memory",
    notes: [
      {
        kind: "preference",
        text: "Captain wants any steps given as a numbered list, never as a paragraph.",
      },
    ],
    turns: ["How do I make a cup of tea?"],
    expect: { reply: { matches: [/^\s*1[.)]\s/m, /^\s*2[.)]\s/m] } },
  },
  {
    // A preference that is not mentioned in the request still shapes the answer.
    id: "memory/preference-unasked",
    category: "memory",
    notes: [{ kind: "preference", text: "Captain is vegetarian and does not eat meat or fish." }],
    turns: ["Suggest one quick dinner I could cook tonight."],
    expect: {
      reply: {
        lacks: [
          /\b(?:chicken|beef|pork|bacon|salmon|tuna|shrimp|prawns?|steak|ham|turkey|sausages?|lamb)\b/i,
        ],
      },
      noCallsExcept: ["recall", "web_search"],
    },
  },
  {
    id: "memory/earlier-in-the-conversation",
    category: "memory",
    turns: [
      "My flight to Lisbon leaves at 6:40 on Friday morning.",
      "If I want to be at the airport two hours early, what time is that?",
    ],
    expect: { reply: { matches: [/\b0?4[:.]40\b/] } },
  },
  {
    id: "memory/ja-name",
    category: "memory",
    language: "ja",
    notes: [{ kind: "profile", text: "艦長の名前はハルカです。" }],
    turns: ["艦長の名前、ちゃんと覚えてる？"],
    expect: { reply: { matches: [/ハルカ/], language: "ja" }, noCallsExcept: ["recall"] },
  },
  {
    id: "memory/ja-look-for-old-note",
    category: "memory",
    language: "ja",
    quietNotes: true,
    notes: [
      { kind: "fact", text: "艦長のプリンターはブラザーの HL-L2350DW で、廊下にある。" },
      ...EVERYDAY,
    ],
    turns: ["うちのプリンターの機種って何だっけ？トナーを注文したいんだ。"],
    expect: { calls: [{ tool: "recall" }], reply: { anyOf: [/ブラザー|Brother|HL-?L2350/i] } },
  },
  {
    id: "memory/zh-fact",
    category: "memory",
    language: "zh",
    notes: [{ kind: "fact", text: "舰长的猫叫团子。" }],
    turns: ["我的猫叫什么名字来着？"],
    expect: { reply: { matches: [/团子/], language: "zh" }, noCallsExcept: ["recall"] },
  },
  {
    // A pinned older fact stays prioritized in her prompt even behind 14 newer everyday notes.
    id: "memory/pinned-old-fact",
    category: "memory",
    quietNotes: true,
    notes: [
      {
        kind: "fact",
        text: "Captain's backup encryption passphrase hint is 'Blue Heron 42'.",
        pinned: true,
      },
      ...EVERYDAY,
    ],
    turns: ["What was the hint for my backup encryption passphrase?"],
    expect: {
      reply: { matches: [/Blue Heron 42/i], lacks: [READ_OUT] },
      noCallsExcept: ["recall"],
    },
  },
  {
    // Explicit user request to store a new fact must call the remember tool.
    id: "memory/save-explicit-remember",
    category: "memory",
    turns: ["Please remember that my NAS local IP is 10.0.0.42."],
    expect: {
      calls: [{ tool: "remember", args: { text: /10\.0\.0\.42/ } }],
      honest: true,
    },
  },
  {
    // Explicit user request to forget an outdated note must call the forget tool.
    id: "memory/forget-explicit-request",
    category: "memory",
    notes: [{ kind: "fact", text: "Captain's old Wi-Fi router is a Netgear R7000." }],
    turns: ["I replaced that old Netgear R7000 router — please forget that note."],
    expect: {
      calls: [{ tool: "forget" }],
      honest: true,
    },
  },
  {
    // When a newer corrected note contradicts an older one, follow the newer correction.
    id: "memory/updated-fact-supersedes-old",
    category: "memory",
    notes: [
      { kind: "fact", text: "Captain's main workstation runs Ubuntu 22.04." },
      { kind: "fact", text: "Captain switched the main workstation from Ubuntu to Arch Linux." },
    ],
    turns: ["Which Linux distro is my main workstation running now?"],
    expect: {
      reply: { matches: [/Arch/i], lacks: [READ_OUT] },
      noCallsExcept: ["recall"],
    },
  },
  {
    // Two preferences held simultaneously must both shape the answer.
    id: "memory/multi-constraint-preferences",
    category: "memory",
    notes: [
      { kind: "preference", text: "Captain wants distances in kilometres, never miles." },
      { kind: "preference", text: "Captain wants comparison answers as a short bullet list." },
    ],
    turns: ["My run tracker logged 5 miles today. Summarize that alongside a 10K target."],
    expect: {
      reply: {
        matches: [/8(?:\.0\d?)?\s*(?:km|kilomet)/i, /^\s*[-*•]\s/m],
        lacks: [READ_OUT],
      },
    },
  },
  {
    // Cross-turn correction: user corrects a detail on turn 2 and asks about it on turn 3.
    id: "memory/cross-turn-correction",
    category: "memory",
    turns: [
      "I scheduled my dentist appointment for Tuesday at 2 PM.",
      "Actually, they just moved it to Thursday at 11 AM.",
      "Quick reminder: when is my dentist appointment now?",
    ],
    expect: {
      reply: {
        matches: [/Thursday/i, /11(?::00)?\s*(?:AM|a\.m\.)?/i],
        lacks: [/Tuesday/i],
      },
    },
  },
  {
    // Partial note exists; do not invent missing details that were never saved.
    id: "memory/no-hallucinate-missing-detail",
    category: "memory",
    quietNotes: true,
    notes: [
      {
        kind: "project",
        text: "Captain is building a synth patch library called Sunburst.",
      },
    ],
    turns: ["What price did I decide to sell Sunburst for?"],
    expect: {
      reply: {
        anyOf: [/\bnot\b|n't|\bno\b|never|didn't|haven't|unknown|don't have/i],
        lacks: [/\$\d+|€\d+|\d+\s*dollars/i],
      },
    },
  },
  {
    // Answering "why do you know / remember that?" naturally without leaking raw markup.
    id: "memory/provenance-natural-explanation",
    category: "memory",
    notes: [{ kind: "fact", text: "Captain's cat is called Biscuit." }],
    turns: ["Wait — how do you know my cat's name is Biscuit?"],
    expect: {
      reply: {
        anyOf: [/note|remember|saved|told|memory/i],
        lacks: [READ_OUT],
      },
      noCallsExcept: ["recall"],
    },
  },
  {
    // Stored episode of a prior fix should guide the troubleshooting reply when it recurs.
    id: "memory/episodic-follow-up",
    category: "memory",
    notes: [
      {
        kind: "episode",
        text: "On 2026-11-10, PipeWire crackled on Captain's SSL 2+ interface until we set clock.force-quantum to 256.",
      },
    ],
    turns: ["My SSL 2+ audio is crackling again — what fixed it last time?"],
    expect: {
      reply: {
        matches: [/256/],
        anyOf: [/quantum|PipeWire/i],
        lacks: [READ_OUT],
      },
      noCallsExcept: ["recall"],
    },
  },
  {
    // Stored skill steps adapted to a new target path.
    id: "memory/skill-step-adaptation",
    category: "memory",
    approve: "all",
    tools: {
      run_command: () => "Exit code 0\nsent 12.4K bytes  received 35 bytes",
    },
    notes: [
      {
        kind: "skill",
        text: "Sync notes folder to backup drive",
        points: [
          "rsync -av --delete ~/Notes/ /mnt/backup/Notes/",
          "Captain always uses --delete so removed notes stay mirrored",
        ],
      },
    ],
    turns: ["Run our usual notes backup sync, but sync ~/Projects/docs/ to /mnt/backup/docs/."],
    expect: {
      calls: [
        {
          tool: ["run_command", "start_mission"],
          args: {
            command: /^(?=[\s\S]*rsync)(?=[\s\S]*--delete)(?=[\s\S]*docs)/,
          },
        },
      ],
    },
  },
];
