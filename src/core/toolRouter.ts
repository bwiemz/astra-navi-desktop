import type { ChatSessionModelFunctions } from "node-llama-cpp";
import type { Embedder } from "./embedder.ts";
import {
  canonicalizeArgs,
  compileJsonSchemaToGbnf,
  compileToolsToGbnf,
  hardenFunctionsForGrammar,
  hardenJsonSchema,
  StreamingJsonParamGuard,
  ToolLoopGuard,
  validateToolArguments,
} from "./grammarGuard.ts";
import { TOOLS } from "./permissions.ts";

export {
  canonicalizeArgs,
  compileJsonSchemaToGbnf,
  compileToolsToGbnf,
  hardenFunctionsForGrammar,
  hardenJsonSchema,
  StreamingJsonParamGuard,
  ToolLoopGuard,
  validateToolArguments,
};

/**
 * Choosing which tools to offer her for one message.
 *
 * Every tool she is offered is described to the model before the first word of the
 * conversation: about 5,300 tokens for all thirty-five, against 3,200 for her
 * instructions. That costs working memory and graphics memory, and a small model picks
 * worse from a long list. Most messages need none of the rarer tools, so only a core is
 * always offered and the rest are added when the message looks as if it is about them.
 *
 * "Looks as if" is decided here without the model: by words that name the thing
 * outright, by nearness in meaning to a few things a person might say (the same small
 * embedding model her memory uses), and by what was used a moment ago, since "and the
 * other one?" says nothing by itself. It errs towards offering: a tool offered and not
 * needed costs a few hundred tokens, a tool needed and not offered costs the request.
 * The brain keeps a second line of defence: when she answers that she cannot, or says
 * she will and stops, her second go is offered everything.
 */

/** Always offered: the everyday tools, and those nearly every other task leans on. */
export const CORE_TOOLS: readonly string[] = [
  TOOLS.remember,
  TOOLS.recall,
  TOOLS.calculate,
  TOOLS.webSearch,
  TOOLS.readWebPage,
  TOOLS.runCommand,
  TOOLS.readFile,
  TOOLS.writeFile,
  TOOLS.findFiles,
  TOOLS.setReminder,
  TOOLS.shipStatus,
];

/** What points to a tool: words that name it outright, and things a person might say. */
interface Hint {
  /** Any of these in the message and the tool is offered, whatever the rest says. */
  words?: RegExp;
  /** Sayings near in meaning to which a message counts as being about this tool. */
  sayings: readonly string[];
  /** Tools that are no use without this one, or it without them. */
  with?: readonly string[];
}

/**
 * One entry for every tool outside the core. Written from what each tool does, in the
 * three languages she speaks; the sayings are examples of a kind, not a list to match.
 */
export const HINTS: Readonly<Record<string, Hint>> = {
  [TOOLS.forget]: {
    words: /\bforget\b|忘れて|忘记|忘掉/i,
    sayings: ["forget what I told you about that", "delete that note of yours", "それは忘れて"],
  },
  [TOOLS.findApps]: {
    words: /\b(?:installed|app|apps|application|program|programs)\b|アプリ|应用|程序|软件/i,
    sayings: [
      "do I have a video editor installed",
      "which program can open this",
      "インストールされているアプリは",
    ],
    with: [TOOLS.openApp],
  },
  [TOOLS.openApp]: {
    words: /\b(?:open|launch|start|run)\b|開いて|起動|打开|启动/i,
    sayings: ["open Firefox", "launch Steam for me", "start the file manager", "ブラウザを開いて"],
    with: [TOOLS.findApps],
  },
  [TOOLS.open]: {
    words: /\b(?:open|show me|play)\b|開いて|打开/i,
    sayings: [
      "open that file",
      "open this link in the browser",
      "show me the folder",
      "play this video",
    ],
  },
  [TOOLS.reminders]: {
    words:
      /\b(?:reminders?|timers?|alarms?|standing orders?|watch(?:es|ing)?)\b|リマインダー|タイマー|提醒|定时/i,
    sayings: [
      "which reminders are set",
      "cancel that timer",
      "what are you keeping watch on",
      "リマインダーを取り消して",
    ],
  },
  [TOOLS.startMission]: {
    words:
      /\b(?:render|convert|encode|download|install|build|compile|backup|background)\b|変換|ダウンロード|转换|下载|后台/i,
    sayings: [
      "convert this video in the background",
      "start the render and tell me when it is done",
      "download it while we talk",
      "run this long job",
    ],
    with: [TOOLS.missions],
  },
  [TOOLS.planMission]: {
    words:
      /\b(?:mission|step by step|in steps|then|afterwards|overnight|tonight|while i(?:'m| am) (?:away|asleep|out)|over the weekend|update (?:the|my) (?:server|servers|nas|machines?)|upgrade|migrat|back ?up and)\b|手順|段階|今夜|步骤|今晚|然后/i,
    sayings: [
      "update the server tonight and check it came back up",
      "back up the folder, then verify it, then clean up the old copies",
      "do this in steps and ask me before anything risky",
      "start this at three in the morning",
    ],
    with: [TOOLS.missions],
  },
  [TOOLS.missions]: {
    words:
      /\b(?:jobs?|missions?|render|download|progress|still running|finished yet)\b|ジョブ|进度|任务/i,
    sayings: [
      "how is the render going",
      "is the download finished",
      "stop that job",
      "what is running in the background",
    ],
  },
  [TOOLS.deckLog]: {
    words:
      /\b(?:deck log|log|record|what did you do|history of|earlier today|yesterday)\b|ログ|記録|日志|记录/i,
    sayings: [
      "what did you do today",
      "show me the deck log",
      "what commands did you run yesterday",
      "今日は何をしたの",
    ],
  },
  [TOOLS.weather]: {
    words:
      /\b(?:weather|forecast|rain|snow|umbrella|temperature outside|degrees outside|sunny|windy)\b|天気|雨|気温|天气|下雨|气温/i,
    sayings: [
      "what's the weather like tomorrow",
      "will it rain today",
      "do I need a coat",
      "明日の天気は",
    ],
  },
  [TOOLS.lookAtScreen]: {
    words:
      /\b(?:screen|on screen|looking at|this error|this window|what am i|see this|read this|earlier)\b|画面|スクリーン|屏幕|画面上/i,
    sayings: [
      "what's on my screen",
      "look at this error",
      "what does this dialog say",
      "what was I doing earlier",
      "画面を見て",
    ],
  },
  [TOOLS.windows]: {
    words:
      /\b(?:windows?|minimi[sz]e|maximi[sz]e|close|bring up|switch to|focus)\b|ウィンドウ|閉じて|窗口|关闭|最小化/i,
    sayings: [
      "which windows are open",
      "close the editor window",
      "bring Firefox to the front",
      "minimise everything",
      "ウィンドウを閉じて",
    ],
  },
  [TOOLS.sound]: {
    words:
      /\b(?:volume|music|song|track|playing|pause|play|mute|unmute|louder|quieter|skip|next|previous|sound)\b|音量|音楽|曲|再生|ミュート|音乐|暂停|静音|播放/i,
    sayings: [
      "turn the volume down",
      "pause the music",
      "what song is this",
      "skip this track",
      "mute the sound",
      "音量を下げて",
    ],
  },
  [TOOLS.clipboard]: {
    words: /\b(?:clipboard|copy|copied|paste)\b|クリップボード|コピー|剪贴板|复制|粘贴/i,
    sayings: ["copy this so I can paste it", "what's on my clipboard", "put that on the clipboard"],
  },
  [TOOLS.lockScreen]: {
    words: /\block\b|ロック|锁屏|锁定/i,
    sayings: ["lock the screen", "lock my computer, I'm stepping away", "画面をロックして"],
  },
  [TOOLS.research]: {
    words:
      /\b(?:research|look into|dig into|find out everything|compare|report on|deep dive)\b|調査|詳しく調べ|研究|调查/i,
    sayings: [
      "research this for me and write it up",
      "look into the best options and compare them",
      "find out everything you can about it",
      "詳しく調べてまとめて",
    ],
  },
  [TOOLS.selfCheck]: {
    words:
      /\b(?:self[- ]check|check yourself|are you (?:ok|okay|working|all right)|diagnos|what can you do)\b|自己診断|自检/i,
    sayings: ["run a self check", "is everything working with you", "check your own systems"],
  },
  [TOOLS.tidyStorage]: {
    words:
      /\b(?:tidy|clean up|free up|unused models?|storage|taking up space|disk space)\b|片付け|容量|清理|空间/i,
    sayings: [
      "free up some space",
      "which of your models are unused",
      "tidy up your storage",
      "how much room are you taking",
    ],
  },
  [TOOLS.operate]: {
    words:
      /\b(?:click|press|button|type (?:in|into)|fill in|menu|checkbox|tick|scroll|select|dialog|field|tab)\b|クリック|ボタン|入力して|点击|按钮|输入/i,
    sayings: [
      "click the Save button",
      "type my name into the field",
      "press OK in that dialog",
      "scroll down in the browser",
      "tick the box and continue",
    ],
    with: [TOOLS.windows],
  },
  [TOOLS.listenToPc]: {
    words:
      /\b(?:what did (?:he|she|they|it) (?:just )?say|what was that sound|just said|hear that|listen back|said in the video)\b|何て言った|聞こえた|刚才说了什么|听到/i,
    sayings: [
      "what did they just say",
      "what was that in the video",
      "did you hear that",
      "今なんて言ったの",
    ],
  },
  [TOOLS.phone]: {
    words: /\b(?:phone|mobile|ring it|ring my|find my phone)\b|スマホ|携帯|電話|手机/i,
    sayings: [
      "ring my phone, I can't find it",
      "send this link to my phone",
      "is my phone battery low",
      "スマホを鳴らして",
    ],
  },
  [TOOLS.remote]: {
    words:
      /\b(?:server|servers|nas|proxmox|vm|vms|container|containers|docker|ssh|other machine|homelab|node|cluster|zfs|pool)\b|サーバー|服务器|虚拟机|容器/i,
    sayings: [
      "how is the server doing",
      "which containers are running on the NAS",
      "restart the service on the other machine",
      "is the backup pool healthy",
      "サーバーの調子はどう",
    ],
  },
  [TOOLS.keepWatch]: {
    words:
      /\b(?:tell me (?:when|if)|let me know (?:when|if)|keep (?:an eye|watch)|watch (?:for|the|that|my)|notify me (?:when|if)|alert me|as soon as|whenever)\b|知らせて|教えて.*(?:たら|なら)|见到.*告诉|如果.*告诉我|通知我/i,
    sayings: [
      "tell me when the file shows up",
      "let me know if the site goes down",
      "keep an eye on the disk and warn me when it gets full",
      "終わったら教えて",
    ],
    with: [TOOLS.reminders],
  },
  [TOOLS.notifications]: {
    words:
      /\b(?:notifications?|notified|who messaged|did i miss|pinged me|that ping|that popup)\b|通知|お知らせ/i,
    sayings: [
      "what was that notification",
      "did I miss anything while I was away",
      "who just messaged me",
      "さっきの通知は何",
    ],
  },
  [TOOLS.agenda]: {
    words:
      /\b(?:calendar|agenda|schedule|meeting|meetings|appointment|appointments|what do i have|free (?:on|at|this|tomorrow)|busy (?:on|at|this|tomorrow)|event)\b|予定|カレンダー|会議|日程|日历|会议|安排/i,
    sayings: [
      "what's on my calendar today",
      "when is my next meeting",
      "put the dentist down for Tuesday at three",
      "am I free tomorrow afternoon",
      "今日の予定は",
    ],
  },
};

/** A machine's name is as good as the word "server": "how is aw-runner doing?" */
function namesAMachine(message: string, machines: readonly string[]): boolean {
  const said = message.toLowerCase();
  return machines.some((name) => name.length >= 2 && said.includes(name.toLowerCase()));
}

const MCP_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "call", "can", "do", "does",
  "external", "for", "from", "get", "has", "have", "how", "i", "in", "info",
  "information", "instructions", "into", "is", "it", "its", "mcp", "me", "metadata",
  "my", "not", "of", "on", "only", "or", "output", "please", "run", "server", "set",
  "that", "the", "their", "this", "to", "tool", "tools", "use", "what", "when",
  "where", "which", "who", "will", "with", "you", "your",
]);

/** Maximum MCP tools offered by lexical/description routing on a single turn. */
export const MAX_ROUTED_MCP_TOOLS = 8;

function splitIdentifierWords(raw: string): string[] {
  const expanded = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const matches = expanded.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return matches.filter((w) => !MCP_STOP_WORDS.has(w));
}

function tokenMatches(queryToken: string, targetTokens: ReadonlySet<string>): boolean {
  if (targetTokens.has(queryToken)) return true;
  if (queryToken.length >= 4) {
    // Handle simple English singular/plural stems (e.g. "lights" <-> "light", "issues" <-> "issue").
    if (queryToken.endsWith("s") && targetTokens.has(queryToken.slice(0, -1))) return true;
    if (queryToken.endsWith("es") && targetTokens.has(queryToken.slice(0, -2))) return true;
    if (targetTokens.has(`${queryToken}s`)) return true;
  }
  return false;
}

function scoreMcpToolMatch(
  queryTokens: readonly string[],
  rawTextLower: string,
  fullName: string,
  description: string | undefined,
): { score: number; reason: string } {
  const rest = fullName.slice("mcp:".length);
  const dotIdx = rest.indexOf(".");
  const serverId = dotIdx >= 0 ? rest.slice(0, dotIdx) : rest;
  const toolName = dotIdx >= 0 ? rest.slice(dotIdx + 1) : "";

  const serverTokens = new Set(splitIdentifierWords(serverId));
  const toolTokens = new Set(splitIdentifierWords(toolName));
  const descTokens = new Set(splitIdentifierWords(description ?? ""));

  let score = 0;
  let matchedBy = "mcp description";

  const spacedServer = serverId.replace(/[-_]+/g, " ").toLowerCase();
  if (
    (serverId.length >= 3 && rawTextLower.includes(serverId.toLowerCase())) ||
    (spacedServer.length >= 3 && rawTextLower.includes(spacedServer))
  ) {
    score += 4;
    matchedBy = "mcp server";
  }

  for (const qt of queryTokens) {
    if (tokenMatches(qt, toolTokens)) {
      score += 3;
      matchedBy = "mcp name";
    } else if (tokenMatches(qt, serverTokens)) {
      score += 2;
      if (matchedBy === "mcp description") matchedBy = "mcp server";
    } else if (tokenMatches(qt, descTokens)) {
      score += 1.5;
    }
  }

  return { score, reason: matchedBy };
}

function nearness(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length && index < b.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

export interface RouteOptions {
  /** Every tool she could be offered right now, by name. */
  available: readonly string[];
  /** Tools used in the last few replies, most recent last: a follow-up needs them still. */
  recent?: readonly string[];
  /** What the user said before this, for a message that only makes sense after it. */
  before?: string;
  /** What the user's other machines are called. */
  machines?: readonly string[];
  /** Optional descriptions keyed by tool name, used to route external `mcp:*` tools selectively. */
  toolDescriptions?: Readonly<Record<string, string>>;
}

export interface Route {
  /** The tools to offer, in the order of `available`. */
  offered: string[];
  /** Why each tool outside the core is in: "words", "meaning 0.87", "used just now", "goes with …". */
  why: Record<string, string>;
}

/**
 * Nearness in meaning is judged against the other tools, not on a fixed mark: this
 * embedding model scores any two short texts between about 0.75 and 0.90, so "tell me
 * a joke" sits at 0.85 from the deck log and a real match is seldom above 0.88. What
 * tells is how far one tool stands out from the rest for this message, in standard
 * deviations. Measured on 26 requests put in a roundabout way: the right tool stood
 * out by 1.5 or more in 18, and by 1.0 or more among the nearest two in most others,
 * while small talk brought in one to three tools.
 */
export const STANDS_OUT = 1.5;
/** The nearest few are offered on a weaker showing than that. */
export const NEAREST_FEW = 2;
export const STANDS_OUT_AMONG_NEAREST = 1.0;
/** However many stand out, no more than this are added by meaning. */
export const MOST_BY_MEANING = 4;

export class ToolRouter {
  private readonly embedder: Embedder | null;
  private sayings: Promise<Map<string, Float32Array[]>> | null = null;

  /** @param embedder Null to go by words and recent use alone (when the model for it is not there). */
  constructor(embedder: Embedder | null) {
    this.embedder = embedder;
  }

  private known(): Promise<Map<string, Float32Array[]>> {
    this.sayings ??= (async () => {
      const made = new Map<string, Float32Array[]>();
      if (!this.embedder) return made;
      const entries = Object.entries(HINTS);
      const flat = entries.flatMap(([, hint]) => hint.sayings);
      const vectors = await this.embedder.embed(flat, "passage");
      let at = 0;
      for (const [tool, hint] of entries) {
        made.set(tool, vectors.slice(at, at + hint.sayings.length));
        at += hint.sayings.length;
      }
      return made;
    })();
    // A failure (the model could not be loaded) is tried again next time.
    this.sayings.catch(() => {
      this.sayings = null;
    });
    return this.sayings;
  }

  /** The tools to offer for this message. Never throws: at worst everything is offered. */
  async route(message: string, options: RouteOptions): Promise<Route> {
    const available = new Set(options.available);
    const why: Record<string, string> = {};
    const add = (tool: string, reason: string): void => {
      if (available.has(tool) && !CORE_TOOLS.includes(tool) && why[tool] === undefined) {
        why[tool] = reason;
      }
    };
    const mcpTools: string[] = [];
    // Built-in tools with no hints are offered unconditionally; external `mcp:*` tools
    // are routed selectively by server/tool name & description so large servers never flood context.
    for (const tool of available) {
      if (tool.startsWith("mcp:")) {
        mcpTools.push(tool);
      } else if (!CORE_TOOLS.includes(tool) && HINTS[tool] === undefined) {
        add(tool, "no hints");
      }
    }
    const text = `${options.before ? `${options.before}\n` : ""}${message}`;
    for (const [tool, hint] of Object.entries(HINTS)) {
      if (hint.words?.test(text)) add(tool, "words");
    }
    if (namesAMachine(text, options.machines ?? [])) add(TOOLS.remote, "names a machine");
    for (const tool of options.recent ?? []) add(tool, "used just now");
    if (mcpTools.length > 0 && text.trim().length > 0) {
      const queryTokens = [...new Set(splitIdentifierWords(text))];
      const rawLower = text.toLowerCase();
      const scoredMcp = mcpTools
        .map((tool) => {
          const { score, reason } = scoreMcpToolMatch(
            queryTokens,
            rawLower,
            tool,
            options.toolDescriptions?.[tool],
          );
          return { tool, score, reason };
        })
        .filter((entry) => entry.score >= 2)
        .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
        .slice(0, MAX_ROUTED_MCP_TOOLS);
      for (const entry of scoredMcp) {
        add(entry.tool, entry.reason);
      }
    }
    try {
      const known = await this.known();
      if (this.embedder && known.size > 0 && message.trim().length > 0) {
        const [asked] = await this.embedder.embed([message.slice(0, 600)], "query");
        if (asked) {
          const scored = [...known.entries()]
            .filter(([tool]) => available.has(tool))
            .map(([tool, vectors]) => ({
              tool,
              score: Math.max(...vectors.map((vector) => nearness(asked, vector))),
            }))
            .sort((a, b) => b.score - a.score);
          const mean = scored.reduce((sum, { score }) => sum + score, 0) / (scored.length || 1);
          const spread = Math.sqrt(
            scored.reduce((sum, { score }) => sum + (score - mean) ** 2, 0) / (scored.length || 1),
          );
          // An embedder that tells nothing apart must not open the whole list.
          if (spread > 1e-6) {
            scored.slice(0, MOST_BY_MEANING).forEach(({ tool, score }, place) => {
              const out = (score - mean) / spread;
              if (out >= STANDS_OUT || (place < NEAREST_FEW && out >= STANDS_OUT_AMONG_NEAREST)) {
                add(tool, `meaning +${out.toFixed(1)}`);
              }
            });
          }
        }
      }
    } catch {
      // Without the embedding model the words and recent use still stand.
    }
    // Last, what goes with what: once, not chained.
    for (const tool of Object.keys(why)) {
      for (const companion of HINTS[tool]?.with ?? []) add(companion, `goes with ${tool}`);
    }
    return {
      offered: options.available.filter((tool) => CORE_TOOLS.includes(tool) || tool in why),
      why,
    };
  }

  /** Routes relevant tools, hardens nested schemas with `additionalProperties: false`, and compiles GBNF. */
  async routeWithGrammar(
    message: string,
    allFunctions: ChatSessionModelFunctions,
    options: Omit<RouteOptions, "available"> & { loopGuard?: ToolLoopGuard } = {},
  ): Promise<{
    route: Route;
    functions: ChatSessionModelFunctions;
    gbnfGrammar: string;
  }> {
    const available = Object.keys(allFunctions);
    const toolDescriptions =
      options.toolDescriptions ??
      Object.fromEntries(
        Object.entries(allFunctions).map(([name, fn]) => [name, fn.description ?? ""]),
      );
    const route = await this.route(message, { ...options, available, toolDescriptions });
    const selected = Object.fromEntries(
      route.offered
        .map((name) => [name, allFunctions[name]] as const)
        .filter((entry): entry is [string, ChatSessionModelFunctions[string]] => entry[1] !== undefined),
    );
    const functions = hardenFunctionsForGrammar(selected, options.loopGuard);
    return {
      route,
      functions,
      gbnfGrammar: compileToolsToGbnf(functions),
    };
  }
}
