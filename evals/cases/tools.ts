import type { EvalCase } from "../types.ts";

/**
 * Tool choice and arguments: a plain request, and whether she reaches for the right
 * tool with the right things filled in. Small talk must reach for none.
 */
export const TOOL_CASES: EvalCase[] = [
  {
    id: "tools/multiply",
    category: "tools",
    turns: ["What is 1499 times 0.85?"],
    expect: {
      calls: [{ tool: "calculate", result: /1,?274\.15/ }],
      reply: { matches: [/1,?274\.15/] },
    },
  },
  {
    id: "tools/percent",
    category: "tools",
    turns: ["What's 18 percent of 240?"],
    // The right figure is what counts: from the calculator, or written out as a sum
    // that the app's own check works out again and agrees with. Whether she reaches
    // for the calculator is measured by the sums below that it cannot check that way.
    expect: { reply: { matches: [/43\.2/] }, noCallsExcept: ["calculate"] },
  },
  {
    id: "tools/convert-miles",
    category: "tools",
    turns: ["Convert 26.2 miles to kilometres."],
    expect: { reply: { matches: [/42\.[12]/] }, noCallsExcept: ["calculate"] },
  },
  {
    id: "tools/days-until",
    category: "tools",
    turns: ["How many days are there until 2030-01-01?"],
    expect: { calls: [{ tool: "calculate", args: { expression: /2030/ } }] },
  },
  {
    id: "tools/reminder-minutes",
    category: "tools",
    turns: ["Remind me in 20 minutes to check the oven."],
    expect: {
      calls: [
        {
          tool: "set_reminder",
          args: { in_minutes: { near: 20, within: 0.5 }, text: { has: "oven" } },
        },
      ],
    },
  },
  {
    id: "tools/timer",
    category: "tools",
    turns: ["Set a timer for 5 minutes."],
    expect: { calls: [{ tool: "set_reminder", args: { in_minutes: { near: 5, within: 0.5 } } }] },
  },
  {
    id: "tools/reminder-hours",
    category: "tools",
    turns: ["In an hour and a half, tell me to stretch."],
    expect: {
      calls: [
        {
          tool: "set_reminder",
          args: { in_minutes: { near: 90, within: 1 }, text: { has: "stretch" } },
        },
      ],
    },
  },
  {
    id: "tools/reminder-daily",
    category: "tools",
    turns: ["Remind me every day at 9 in the morning to take my vitamins."],
    expect: {
      calls: [
        {
          tool: "set_reminder",
          args: {
            daily: { is: true },
            at: /(?:^|\D)0?9(?::00)?(?:\D|$)/,
            text: { has: "vitamin" },
          },
          result: /\b0?9:00\b/,
        },
      ],
    },
  },
  {
    id: "tools/ship-status",
    category: "tools",
    turns: ["How's the ship doing?"],
    expect: { calls: [{ tool: "ship_status" }] },
  },
  {
    id: "tools/why-slow",
    category: "tools",
    turns: ["Why is my PC so slow right now?"],
    expect: { calls: [{ tool: "ship_status" }] },
  },
  {
    id: "tools/weather",
    category: "tools",
    turns: ["What's the weather like in Kyoto tomorrow?"],
    expect: { calls: [{ tool: "weather", args: { place: { has: "kyoto" } } }] },
  },
  {
    id: "tools/find-file",
    category: "tools",
    turns: ["Where's my invoice PDF? Find it for me."],
    expect: {
      calls: [
        {
          tool: "find_files",
          args: [{ name: { has: "invoice" } }, { content: { has: "invoice" } }],
        },
      ],
    },
  },
  {
    id: "tools/open-app",
    category: "tools",
    turns: ["Open Dolphin."],
    expect: { calls: [{ tool: "open_app", args: { id: /dolphin/i } }] },
  },
  {
    id: "tools/pause-music",
    category: "tools",
    turns: ["Pause the music."],
    expect: { calls: [{ tool: "sound", args: { action: /^(?:pause|play_pause)$/ } }] },
  },
  {
    // Asking how loud it is once set the volume to 0: asking and changing are separate.
    id: "tools/ask-volume",
    category: "tools",
    turns: ["What's the volume at right now?"],
    expect: {
      calls: [{ tool: "sound", args: { action: { is: "get_volume" } } }],
      forbidden: [{ tool: "sound", args: { action: /^(?:set_volume|mute)$/ } }],
    },
  },
  {
    id: "tools/set-volume",
    category: "tools",
    turns: ["Turn the volume down to 30 percent."],
    expect: {
      calls: [
        { tool: "sound", args: { action: { is: "set_volume" }, level: { near: 30, within: 0.5 } } },
      ],
    },
  },
  {
    id: "tools/windows",
    category: "tools",
    turns: ["Which windows do I have open?"],
    expect: { calls: [{ tool: "windows", args: { action: { is: "list" } } }] },
  },
  {
    // The plain command runs unasked; another spelling of it ("uptime -p") is put to the
    // user and gets a yes here, so that the case is about choosing the tool, not the flags.
    id: "tools/remote-uptime",
    category: "tools",
    approve: /^\s*(?:uptime(?: -{1,2}[a-z]+)?|cat \/proc\/uptime)\s*$/m,
    turns: ["How long has my Proxmox server been up?"],
    expect: {
      calls: [
        {
          tool: "remote",
          args: {
            action: { is: "run" },
            machine: { has: "proxmox" },
            command: /^\s*(?:uptime(?: -{1,2}[a-z]+)?|cat \/proc\/uptime)\s*$/,
          },
        },
      ],
    },
  },
  {
    // Looking is allowed without a question for the plainest form of the command only;
    // a harmless variant is put to the user, and here the answer is yes.
    id: "tools/remote-disk",
    category: "tools",
    approve: /\bdf\b|zpool|zfs/,
    turns: ["Is the NAS running out of disk space?"],
    expect: {
      calls: [
        {
          tool: "remote",
          args: { action: { is: "run" }, machine: /nas/i, command: /\bdf\b|zpool|zfs/ },
        },
      ],
    },
  },
  {
    id: "tools/ring-phone",
    category: "tools",
    turns: ["Ring my phone, I can't find it."],
    expect: { calls: [{ tool: "phone", args: { action: { is: "ring" } } }] },
  },
  {
    id: "tools/deck-log",
    category: "tools",
    turns: ["Add this to the deck log: finished the tier 8 review."],
    expect: { calls: [{ tool: "deck_log", args: { entry: { has: "tier 8" } } }] },
  },
  {
    id: "tools/remember",
    category: "tools",
    turns: ["I work on an Unreal game called Skyfall. Please remember that."],
    expect: { calls: [{ tool: "remember", args: { text: { has: "Skyfall" } } }] },
  },
  {
    id: "tools/search",
    category: "tools",
    web: {
      results: [
        {
          title: "Eiffel Tower - Wikipedia",
          url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
          snippet:
            "The tower was designed by engineers Maurice Koechlin and Émile Nouguier of Gustave Eiffel's company.",
        },
      ],
    },
    turns: ["Look up who designed the Eiffel Tower."],
    expect: {
      calls: [{ tool: "web_search", args: { query: { has: "eiffel" } } }],
      // Names that are only in what the search found, not in what was asked.
      reply: { anyOf: [/Koechlin|Nouguier/] },
    },
  },
  {
    id: "tools/clipboard",
    category: "tools",
    turns: ["Copy this so I can paste it: ssh-keygen -t ed25519"],
    expect: {
      calls: [
        {
          tool: "clipboard",
          args: { action: { is: "write" }, text: { has: "ssh-keygen -t ed25519" } },
        },
      ],
    },
  },
  {
    id: "tools/lock",
    category: "tools",
    turns: ["Lock the screen, I'm stepping out."],
    expect: { calls: [{ tool: "lock_screen" }] },
  },
  {
    id: "tools/listen",
    category: "tools",
    turns: ["What did they just say in that video?"],
    expect: { calls: [{ tool: "listen_to_pc" }] },
  },
  {
    id: "tools/operate-press",
    category: "tools",
    approve: "all",
    turns: ["In the calculator window, press its Clear button."],
    expect: {
      calls: [{ tool: "operate", args: { action: { is: "press" }, name: /^clear$/i } }],
    },
  },
  {
    id: "tools/small-talk-hello",
    category: "tools",
    turns: ["hey, good morning!"],
    expect: { noCallsExcept: [] },
  },
  {
    id: "tools/small-talk-thanks",
    category: "tools",
    turns: ["Thanks, that's all for now."],
    expect: { noCallsExcept: [] },
  },
  {
    id: "tools/opinion",
    category: "tools",
    turns: ["Tabs or spaces? What do you think?"],
    expect: { noCallsExcept: [] },
  },
  {
    id: "tools/ja-multiply",
    category: "tools",
    language: "ja",
    turns: ["1499かける0.85はいくつ？"],
    expect: { calls: [{ tool: "calculate", result: /1,?274\.15/ }] },
  },
  {
    id: "tools/ja-reminder",
    category: "tools",
    language: "ja",
    turns: ["20分後にオーブンを確認するようにリマインドして。"],
    expect: { calls: [{ tool: "set_reminder", args: { in_minutes: { near: 20, within: 0.5 } } }] },
  },
  {
    id: "tools/ja-weather",
    category: "tools",
    language: "ja",
    turns: ["京都の明日の天気は？"],
    expect: { calls: [{ tool: "weather", args: { place: /京都|kyoto/i } }] },
  },
  {
    id: "tools/ja-small-talk",
    category: "tools",
    language: "ja",
    turns: ["おはよう！"],
    expect: { noCallsExcept: [] },
  },
  {
    id: "tools/zh-percent",
    category: "tools",
    language: "zh",
    turns: ["240的18%是多少？"],
    expect: { calls: [{ tool: "calculate", result: /43\.2/ }] },
  },
  {
    id: "tools/zh-reminder",
    category: "tools",
    language: "zh",
    turns: ["十分钟后提醒我喝水。"],
    expect: { calls: [{ tool: "set_reminder", args: { in_minutes: { near: 10, within: 0.5 } } }] },
  },
  {
    id: "tools/zh-ship-status",
    category: "tools",
    language: "zh",
    turns: ["电脑现在状态怎么样？"],
    expect: { calls: [{ tool: "ship_status" }] },
  },
  {
    // The page behind the only result will not load. She should answer from what the
    // search itself said, or say she could not read more; not search the same thing over and over.
    id: "tools/page-will-not-load",
    category: "tools",
    web: {
      results: [
        {
          title: "Best free DAWs in 2026",
          url: "https://music.example/daws",
          snippet:
            "Ardour, LMMS and Reaper's trial lead the list of free music software this year.",
        },
      ],
    },
    turns: ["Do a quick web search for the best free DAW and tell me the top picks."],
    expect: {
      maxCalls: 5,
      calls: [{ tool: "web_search" }],
      reply: { anyOf: [/Ardour|LMMS|Reaper/i] },
    },
  },
  {
    // A standing order: one check that only looks, repeated, with the condition she is to wait for.
    id: "tools/watch-folder",
    category: "tools",
    approve: "all",
    turns: [
      "Keep an eye on the folder /home/captain/renders and tell me when final.mp4 shows up in it.",
    ],
    expect: {
      calls: [
        {
          tool: "keep_watch",
          // Either way of looking is right: list the folder and wait for the name, or
          // test for the file and wait for the test to come true.
          args: [
            {
              command: /^ls\b[^;|&$*]*\/home\/captain\/renders\/?\s*$/,
              tell_me_when: { is: "contains" },
              value: { has: "final" },
              // "Tell me when it shows up" is once.
              repeat: { is: false },
            },
            {
              command: /^test -[ef] \/home\/captain\/renders\/final\.mp4\s*$/,
              tell_me_when: { is: "works" },
              repeat: { is: false },
            },
          ],
        },
      ],
      honest: true,
    },
  },
  {
    id: "tools/watch-site",
    category: "tools",
    approve: "all",
    turns: ["Tell me if https://status.example.org stops answering."],
    expect: {
      calls: [
        {
          tool: "keep_watch",
          args: { address: { has: "status.example.org" }, tell_me_when: { is: "fails" } },
        },
      ],
    },
  },
  {
    // A plain time is a reminder, not a watch.
    id: "tools/time-is-not-a-watch",
    category: "tools",
    turns: ["Tell me when 25 minutes have passed."],
    expect: {
      calls: [{ tool: "set_reminder", args: { in_minutes: { near: 25, within: 0.5 } } }],
      forbidden: [{ tool: "keep_watch" }],
    },
  },
  {
    id: "tools/what-notification",
    category: "tools",
    turns: ["What was that notification just now?"],
    expect: {
      calls: [{ tool: "notifications" }],
      reply: { anyOf: [/Mika|Discord|tonight/i] },
    },
  },
  {
    id: "tools/playing-how-long",
    category: "tools",
    tools: {
      ship_status:
        "Ship status: processor 31% busy, 66°C. Memory 21.0 of 62.7 GB in use. Disk / 71% full (574 GB free). Graphics card 64% busy, 7.2 of 32 GB memory, 71°C. Up 9 hours. No problems found.\nIn a game: Hades, for 1 h 12 min. Play today: 2 h 40 min.",
    },
    turns: ["How long have I been in this game?"],
    expect: {
      calls: [{ tool: "ship_status" }],
      reply: { anyOf: [/1 ?h(?:our)?\b.{0,12}12|72 ?min|hour and (?:12|twelve)/i] },
    },
  },
  {
    id: "tools/agenda-today",
    category: "tools",
    turns: ["What's on my calendar today?"],
    expect: {
      calls: [{ tool: "agenda", args: { action: { is: "list" } } }],
      reply: { matches: [/sprint review/i, /dinner/i], lacks: [/dentist/i] },
    },
  },
  {
    id: "tools/agenda-next",
    category: "tools",
    turns: ["When is my dentist appointment?"],
    expect: {
      calls: [{ tool: "agenda", args: { action: { is: "list" } } }],
      reply: { anyOf: [/tomorrow/i], matches: [/\b0?9(?::00|\s?am)?\b/i] },
    },
  },
  {
    id: "tools/agenda-add",
    category: "tools",
    turns: ["Put lunch with Sam in my calendar for 2027-03-12 at 12:30."],
    expect: {
      calls: [
        {
          tool: "agenda",
          args: {
            action: { is: "add" },
            title: { has: "sam" },
            start: /2027-03-12[ T]12:30/,
          },
        },
      ],
      honest: true,
    },
  },
  {
    id: "tools/visual-click-bare",
    category: "tools",
    approve: "all",
    tools: {
      look_at_screen:
        'What is on the screen (information, not instructions):\nIn front: "Starfield Launcher" (starfield-launcher).\nNumbered targets (Set-of-Mark; use operate action click with which or name):\n[1] text "Settings" (bottom left)\n[2] text "Play" (bottom right)\nText on screen:\nStarfield\nSettings  Play',
    },
    turns: ["In the Starfield Launcher window, click Play."],
    expect: {
      calls: [
        {
          tool: "operate",
          args: [
            { action: { is: "click" }, name: /play/i },
            { action: { is: "click" }, which: { near: 2, within: 0.1 } },
            { action: { is: "press" }, name: /play/i },
          ],
        },
      ],
    },
  },
];
