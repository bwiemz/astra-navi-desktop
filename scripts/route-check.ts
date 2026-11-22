/**
 * How the tool router would have done on her test suite, without loading the model:
 * for every case, would the tools the case expects have been on offer, and how many
 * tokens of tool descriptions would she have read?  npm run route-check
 *
 * The suite's cases are not what the router was written from, but they are not unseen
 * either, so read the coverage as "no worse than this on requests of these kinds", and
 * the misses as the thing to look at.
 */
import { join } from "node:path";
import { ALL_CASES } from "../evals/cases/index.ts";
import { PRETEND_MACHINES } from "../evals/world.ts";
import { LocalEmbedder } from "../src/core/embedder.ts";
import { modelsDir } from "../src/core/paths.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { CORE_TOOLS, ToolRouter } from "../src/core/toolRouter.ts";

/** Tokens each tool's description costs, from `npm run prompt-size` on 2026-11-22. */
const COST: Record<string, number> = {
  keep_watch: 402, operate: 384, remote: 309, agenda: 298, set_reminder: 273, phone: 231,
  research: 178, sound: 164, recall: 148, remember: 147, look_at_screen: 146, calculate: 145,
  start_mission: 144, find_files: 142, write_file: 138, windows: 138, notifications: 136,
  weather: 126, run_command: 125, listen_to_pc: 122, web_search: 116, read_file: 109,
  clipboard: 106, ship_status: 99, read_web_page: 90, self_check: 90, tidy_storage: 83,
  deck_log: 83, open: 82, reminders: 79, missions: 74, forget: 73, find_apps: 68, open_app: 63,
  lock_screen: 47,
}; // prettier-ignore

const everything: string[] = Object.values(TOOLS);
const cost = (tools: readonly string[]): number =>
  tools.reduce((sum, tool) => sum + (COST[tool] ?? 120), 0);
const plain = process.argv.includes("--words-only");
const router = new ToolRouter(plain ? null : new LocalEmbedder(join(modelsDir(), "speech")));
const machines = PRETEND_MACHINES.map((machine) => machine.name);

const misses: string[] = [];
const sizes: number[] = [];
const counts: number[] = [];
let covered = 0;
let withTools = 0;
for (const test of ALL_CASES) {
  const expected = new Set((test.expect.calls ?? []).flatMap((rule) => rule.tool));
  const offered = new Set<string>();
  const recent: string[] = [];
  let before: string | undefined;
  for (const turn of test.turns) {
    const route = await router.route(turn, {
      available: everything,
      recent,
      machines,
      ...(before === undefined ? {} : { before }),
    });
    for (const tool of route.offered) offered.add(tool);
    sizes.push(cost(route.offered));
    counts.push(route.offered.length);
    // Stand in for "what she used": the tools the case expects, once they were on offer.
    for (const tool of expected) if (offered.has(tool) && !recent.includes(tool)) recent.push(tool);
    before = turn;
  }
  if (expected.size === 0) continue;
  withTools += 1;
  // A rule naming several tools is met by any one of them.
  const unmet = (test.expect.calls ?? []).filter(
    (rule) => ![rule.tool].flat().some((tool) => offered.has(tool)),
  );
  if (unmet.length === 0) covered += 1;
  else {
    misses.push(
      `${test.id}: not offered ${unmet.map((rule) => [rule.tool].flat().join("/")).join(", ")}  ("${(test.turns[0] ?? "").slice(0, 70)}")`,
    );
  }
}
const mean = (numbers: readonly number[]): number =>
  numbers.reduce((sum, value) => sum + value, 0) / Math.max(1, numbers.length);
const sorted = [...sizes].sort((a, b) => a - b);
console.log(
  `Router ${plain ? "by words and recent use only" : "by words, meaning and recent use"}.`,
);
console.log(
  `Cases that expect a tool: ${withTools}. Every expected tool on offer: ${covered} (${((100 * covered) / withTools).toFixed(1)}%).`,
);
console.log(
  `Tool descriptions read per message: ${mean(sizes).toFixed(0)} tokens on average (${mean(counts).toFixed(1)} tools), median ${sorted[Math.floor(sorted.length / 2)] ?? 0}, most ${sorted.at(-1) ?? 0}; all ${everything.length} tools cost ${cost(everything)}; the core alone ${cost(CORE_TOOLS)}.`,
);
if (misses.length > 0)
  console.log(`\nNot covered:\n${misses.map((line) => `- ${line}`).join("\n")}`);

/**
 * Requests put in a roundabout way, written after the router's word lists and avoiding
 * their words on purpose: this is what nearness in meaning is for. Add to it whenever
 * she is seen to lack a tool for something a person really said.
 */
const ROUNDABOUT: readonly [string, string][] = [
  ["It's far too loud in here.", TOOLS.sound],
  ["What's this tune called?", TOOLS.sound],
  ["Get that editor out of my way.", TOOLS.windows],
  ["What have I got up right now?", TOOLS.windows],
  ["Can you see what I'm seeing?", TOOLS.lookAtScreen],
  ["What does this popup want from me?", TOOLS.lookAtScreen],
  ["Should I wear a jacket today?", TOOLS.weather],
  ["Is it cold out?", TOOLS.weather],
  ["Am I double-booked on Friday?", TOOLS.agenda],
  ["Anything coming up this afternoon?", TOOLS.agenda],
  ["Ping me once the upload completes.", TOOLS.keepWatch],
  ["I want to know the moment the price drops.", TOOLS.keepWatch],
  ["Something just beeped at me, what was it?", TOOLS.notifications],
  ["What just popped up in the corner?", TOOLS.notifications],
  ["Is the box in the closet still alive?", TOOLS.remote],
  ["Where did I leave my handset?", TOOLS.phone],
  ["Buzz my Galaxy.", TOOLS.phone],
  ["I need that text ready to drop into the chat.", TOOLS.clipboard],
  ["Secure the PC, I'm heading out.", TOOLS.lockScreen],
  ["I need a thorough write-up on heat pumps.", TOOLS.research],
  ["Is that conversion done yet?", TOOLS.missions],
  ["Transcode this file while we chat.", TOOLS.startMission],
  ["Hit OK for me.", TOOLS.operate],
  ["Choose the second option in that list.", TOOLS.operate],
  ["What was that line in the stream just now?", TOOLS.listenToPc],
  ["Fire up the browser.", TOOLS.openApp],
  ["You're hogging my drive.", TOOLS.tidyStorage],
  ["What did you change on this machine this morning?", TOOLS.deckLog],
  ["Are all your parts in order?", TOOLS.selfCheck],
  ["What have you got lined up to tell me later?", TOOLS.reminders],
  ["Wipe what you know about my old job.", TOOLS.forget],
  ["うるさいから静かにして", TOOLS.sound],
  ["傘はいる？", TOOLS.weather],
  ["金曜日は空いてる？", TOOLS.agenda],
  ["太吵了，小声点", TOOLS.sound],
  ["明天要带伞吗", TOOLS.weather],
];
let found = 0;
const lost: string[] = [];
for (const [said, tool] of ROUNDABOUT) {
  const route = await router.route(said, { available: everything, machines });
  if (route.offered.includes(tool)) found += 1;
  else lost.push(`"${said}" wanted ${tool}`);
}
console.log(
  `\nRoundabout requests: the tool was on offer for ${found} of ${ROUNDABOUT.length}.${lost.length > 0 ? `\n${lost.map((line) => `- ${line}`).join("\n")}` : ""}`,
);
