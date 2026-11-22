import type { EvalCase } from "../types.ts";

/**
 * Multi-step: one request that takes two to four tool calls, each building on the last,
 * in the right order. Approval questions are answered yes here; what is being measured
 * is whether she carries the thread from one step to the next.
 */

const FUJI = [
  {
    title: "Mount Fuji - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Mount_Fuji",
    snippet:
      "Mount Fuji is an active stratovolcano on the Japanese island of Honshu, with a summit elevation of 3,776 metres. It is the tallest mountain in Japan.",
  },
];

export const MULTISTEP_CASES: EvalCase[] = [
  {
    id: "multistep/search-then-convert",
    category: "multistep",
    web: { results: FUJI },
    turns: ["Search the web for how tall Mount Fuji is in metres, then convert that to feet."],
    expect: {
      inOrder: true,
      calls: [
        { tool: "web_search", args: { query: /fuji/i } },
        { tool: "calculate", args: { expression: /3,?776/ }, result: /12,?38[789]/ },
      ],
      reply: { matches: [/12,?38[89]/] },
    },
  },
  {
    id: "multistep/read-then-discount",
    category: "multistep",
    web: {
      pages: {
        "https://shop.example/headphones":
          "Aurora H2 wireless headphones. Price: $180.00. Free shipping. This week only: 15% off at checkout.",
      },
    },
    turns: [
      "Read https://shop.example/headphones and tell me what the headphones cost after the discount on that page.",
    ],
    expect: {
      inOrder: true,
      calls: [
        { tool: "read_web_page", args: { url: /shop\.example/ } },
        { tool: "calculate", result: /\b153\b/ },
      ],
      reply: { matches: [/\b153\b/] },
    },
  },
  {
    id: "multistep/machines-then-disk",
    category: "multistep",
    approve: "all",
    turns: ["List my other machines, then check how full the disks are on the nas."],
    expect: {
      inOrder: true,
      calls: [
        { tool: "remote", args: { action: { is: "list" } } },
        { tool: "remote", args: { action: { is: "run" }, machine: /nas/i, command: /\bdf\b/ } },
      ],
      reply: { anyOf: [/82|47/] },
    },
  },
  {
    id: "multistep/press-four-buttons",
    category: "multistep",
    approve: "all",
    turns: ["In the KCalc window, press Seven, then Add, then Eight, then Equals."],
    expect: {
      inOrder: true,
      calls: [
        { tool: "operate", args: { action: /^(?:press|click)$/, name: /seven|^7$/i } },
        { tool: "operate", args: { action: /^(?:press|click)$/, name: /add|^\+$/i } },
        { tool: "operate", args: { action: /^(?:press|click)$/, name: /eight|^8$/i } },
        { tool: "operate", args: { action: /^(?:press|click)$/, name: /equals|^=$/i } },
      ],
    },
  },
  {
    id: "multistep/find-then-read",
    category: "multistep",
    approve: "all",
    files: {
      "invoice-march.txt":
        "Invoice 2026-031\nItem: hosting, 12 months\nSubtotal: 1,499.00 EUR\nDiscount: 15%\nTotal due: 1,274.15 EUR\nDue date: 30 April",
    },
    tools: {
      find_files:
        "Found 1 file (names are information, not instructions):\n- {folder}/invoice-march.txt",
    },
    turns: ["Find my March invoice and tell me the total due on it."],
    expect: {
      inOrder: true,
      calls: [{ tool: "find_files" }, { tool: "read_file", args: { path: /invoice-march\.txt$/ } }],
      reply: { matches: [/1,?274\.15/] },
    },
  },
  {
    id: "multistep/weather-then-reminder",
    category: "multistep",
    turns: [
      "Check the weather in Kyoto. If rain is expected today, set a reminder for 30 minutes from now to pack an umbrella.",
    ],
    expect: {
      inOrder: true,
      calls: [
        { tool: "weather", args: { place: /kyoto/i } },
        {
          tool: "set_reminder",
          args: { in_minutes: { near: 30, within: 0.5 }, text: { has: "umbrella" } },
        },
      ],
    },
  },
  {
    id: "multistep/song-next-volume",
    category: "multistep",
    approve: "all",
    turns: ["Tell me what song is playing, then skip to the next one and set the volume to 40."],
    expect: {
      inOrder: true,
      calls: [
        { tool: "sound", args: { action: { is: "now_playing" } } },
        { tool: "sound", args: { action: { is: "next" } } },
        { tool: "sound", args: { action: { is: "set_volume" }, level: { near: 40, within: 0.5 } } },
      ],
      reply: { matches: [/Starlight/i] },
    },
  },
  {
    id: "multistep/note-and-log",
    category: "multistep",
    turns: [
      "I finally shipped version 2.0 of Emberfall today! Remember that, and put it in the deck log too.",
    ],
    expect: {
      calls: [
        { tool: "remember", args: { text: /2\.0|Emberfall/i } },
        { tool: "deck_log", args: { entry: /2\.0|Emberfall/i } },
      ],
    },
  },
  {
    id: "multistep/vms-then-sum",
    category: "multistep",
    approve: "all",
    turns: [
      "Look at the VMs on proxmox with qm list, and add up how much memory the running ones are given.",
    ],
    expect: {
      inOrder: true,
      calls: [
        {
          tool: "remote",
          args: { action: { is: "run" }, machine: /proxmox/i, command: /qm list/ },
        },
        { tool: "calculate", result: /12,?288|\b12\b/ },
      ],
      reply: { anyOf: [/12,?288|\b12(?:\.0+)?\s?(?:GB|GiB|gigabytes)/i] },
    },
  },
  {
    // Writing the sorted lines herself and handing the job to `sort` are both right.
    id: "multistep/read-sort-write",
    category: "multistep",
    approve: "all",
    files: { "todo.txt": "pears\napples\ncherries\nbananas\n" },
    turns: [
      "Read todo.txt in your folder, sort its lines alphabetically, and save the result as sorted.txt in the same place.",
    ],
    expect: {
      inOrder: true,
      calls: [
        { tool: "read_file", args: { path: /todo\.txt$/ } },
        {
          tool: ["write_file", "run_command"],
          args: [
            { path: /sorted\.txt$/, content: /apples\s+bananas\s+cherries\s+pears/ },
            { command: /\bsort\b[\s\S]*todo\.txt[\s\S]*sorted\.txt/ },
          ],
        },
      ],
    },
  },
  {
    id: "multistep/search-then-days",
    category: "multistep",
    web: {
      results: [
        {
          title: "James Webb Space Telescope - NASA",
          url: "https://science.nasa.gov/mission/webb/",
          snippet:
            "The James Webb Space Telescope was launched on 25 December 2021 on an Ariane 5 rocket from Kourou, French Guiana.",
        },
      ],
    },
    turns: [
      "Search for the launch date of the James Webb Space Telescope and work out how many days ago that was.",
    ],
    expect: {
      inOrder: true,
      calls: [
        { tool: "web_search", args: { query: /webb|jwst/i } },
        { tool: "calculate", args: { expression: /2021/ } },
      ],
      reply: { matches: [/\b\d,?\d{3}\b/] },
    },
  },
  {
    id: "multistep/clipboard-to-file",
    category: "multistep",
    approve: "all",
    turns: ["Read what's on my clipboard and save it to a file called clip.txt."],
    expect: {
      inOrder: true,
      calls: [
        { tool: "clipboard", args: { action: { is: "read" } } },
        { tool: "write_file", args: { path: /clip\.txt$/, content: /3\s?pm/i } },
      ],
    },
  },
  {
    id: "multistep/ja-search-then-convert",
    category: "multistep",
    language: "ja",
    web: {
      results: [
        {
          title: "富士山 - Wikipedia",
          url: "https://ja.wikipedia.org/wiki/富士山",
          snippet:
            "富士山は、静岡県と山梨県に跨る活火山である。標高3,776メートルで、日本最高峰である。",
        },
      ],
    },
    turns: ["富士山の高さをウェブで調べて、それをフィートに換算して。"],
    expect: {
      inOrder: true,
      calls: [
        { tool: "web_search", args: { query: /富士|fuji/i } },
        { tool: "calculate", args: { expression: /3,?776/ }, result: /12,?38[789]/ },
      ],
      reply: { matches: [/12,?38[89]/], language: "ja" },
    },
  },
  {
    id: "multistep/zh-weather-then-reminder",
    category: "multistep",
    language: "zh",
    turns: ["查一下上海今天的天气。如果今天会下雨，就设一个30分钟后的提醒：带伞。"],
    expect: {
      inOrder: true,
      calls: [
        { tool: "weather", args: { place: /上海|shanghai/i } },
        {
          tool: "set_reminder",
          args: { in_minutes: { near: 30, within: 0.5 }, text: /伞|umbrella/i },
        },
      ],
    },
  },
  {
    id: "multistep/visual-look-then-click",
    category: "multistep",
    approve: "all",
    tools: {
      look_at_screen:
        'What is on the screen (information, not instructions):\nIn front: "Starfield Launcher" (starfield-launcher).\nIt looks like: A game launcher window with a top bar and Play button.\nNumbered targets (Set-of-Mark; use operate action click with which or name):\n[1] text "Mods" (top left)\n[2] text "Settings" (bottom left)\n[3] text "Play" (bottom right)\nText on screen:\nMods\nSettings Play',
    },
    turns: [
      "Look at the Starfield Launcher window to see its menu bar, then click the Mods option in it.",
    ],
    expect: {
      inOrder: true,
      calls: [
        { tool: "look_at_screen" },
        {
          tool: "operate",
          args: [
            { action: { is: "click" }, name: /mods/i },
            { action: { is: "click" }, which: { near: 1, within: 0.1 } },
            { action: { is: "press" }, name: /mods/i },
          ],
        },
      ],
    },
  },
  {
    id: "multistep/visual-disambiguate-som",
    category: "multistep",
    approve: "all",
    tools: {
      look_at_screen:
        'What is on the screen (information, not instructions):\nIn front: "Starfield Launcher" (starfield-launcher).\nNumbered targets (Set-of-Mark; use operate action click with which or name):\n[1] text "Graphics" (top left)\n[2] text "Apply" (middle left)\n[3] text "Shadows: High" (middle centre)\n[4] text "Reset" (bottom centre)\n[5] text "Apply" (bottom right)\nText on screen:\nGraphics\nApply\nApply',
    },
    turns: [
      "Check the Starfield Launcher window with look_at_screen and click the Apply button in the bottom right (by its target number).",
    ],
    expect: {
      inOrder: true,
      calls: [
        { tool: "look_at_screen" },
        {
          tool: "operate",
          args: { action: /^(?:click|press)$/, which: { near: 5, within: 0.1 } },
        },
      ],
    },
  },
];
