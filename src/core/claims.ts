/**
 * Spotting a reply that says an action was carried out ("timer set", "I've saved that",
 * "I'll remind you at six", "覚えたよ", "已经设置好了").
 *
 * A small model sometimes writes such a sentence without calling the tool that would
 * make it true. Replies found here that ran no such tool get a second look and, if
 * need be, a correction. The patterns aim at statements of something done or under way,
 * and step around talk about what she could do ("AI-chan can set reminders"), offers
 * ("want me to install it?") and things the user did themselves.
 */

/** Persona names this assistant goes by (current Astra / Astra Navi and legacy AI-chan). */
const NAVI_NAME = String.raw`(?:astra(?:\s+navi)?|ai-chan)`;

/** A sentence with one of these is talk about ability, an offer or a question, not a claim. */
const NOT_A_CLAIM =
  /\b(?:can|could|able to|would|if you|just tell me|let me know|want me to|shall i|should i|do you want|you can|you could|you(?:'ve| have)? (?:already )?(?:saved|set))\b|\?\s*$/i;

/**
 * "March 3rd is now saved in my memory", "that's noted in the ship's log": said of her
 * own keeping, which only a tool call makes true.
 */
const KEPT_SOMEWHERE = new RegExp(
  String.raw`(?:\bnow|\bis|\bare|'s|\bbeen)\s+(?:safely |all )?(?:saved|stored|noted|recorded|logged|written down)\s+(?:in|to|into)\s+(?:my|${NAVI_NAME}'s|her|our|the ship's)\s+(?:own\s+)?(?:memory|notes?|notebook|log|list)\b`,
  "i",
);

const CLAIMS: readonly RegExp[] = [
  KEPT_SOMEWHERE,
  /\bready to paste\b|\b(?:on|in|to) (?:your|the) clipboard\b/i,
  /^\W*(?:captain,? )?(?:locked|paused|muted|unmuted|closed|opened|saved|set|started|cancell?ed|deleted|removed|copied|sent|installed|scheduled|launched|minimi[sz]ed|maximi[sz]ed|resumed|skipped|lowered|raised|turned|rang|added|created)\s+(?:the|your|that|this|it|a|an|up|down|off|on)\b/i,
  // "Done, Captain.", "All set!"
  /^\W*(?:done|all done|all set|sorted|finished|got it done)\b\s*[.!,]/i,
  // "Kate Editor closed up."
  /\b[A-Z][\w ]{1,30} (?:closed|locked|paused|muted|saved|deleted|minimi[sz]ed)(?: up| down)?[.!]/,
  // "I've set…", "Astra has saved…", "Astra started…"
  new RegExp(
    String.raw`\b(?:i(?:'ve| have)?|${NAVI_NAME}(?: has| is|'s)?)\s+(?:just |already |now |gone ahead and )?(?:set|saved|noted|logged|started|launched|opened|scheduled|added|created|written|remembered|cancelled|canceled|stopped|installed|paused|resumed|muted|unmuted|locked|closed|minimized|maximized|copied|skipped|lowered|raised|turned|deleted|removed|freed)\b`,
    "i",
  ),
  // "Astra's pausing the music", "I'm turning it down now"
  new RegExp(
    String.raw`\b(?:i'm|i am|${NAVI_NAME}\s+is|${NAVI_NAME}'s)\s+(?:now |just |already )?(?:setting|starting|opening|launching|saving|scheduling|logging|installing|cancelling|canceling|creating|writing|adding|downloading|converting|recording|pausing|resuming|muting|unmuting|locking|closing|minimizing|maximizing|copying|skipping|lowering|raising|turning|deleting|removing|researching|bringing)\b`,
    "i",
  ),
  // "Music paused.", "The volume is set to 40", "Screen locked!"
  /\b(?:music|song|track|video|volume|sound|screen|window|clipboard)\b[^.!?]{0,25}?\b(?:is |has been |'s |are )?(?:now )?(?:paused|resumed|muted|unmuted|locked|closed|minimized|copied|skipped|set to|turned (?:up|down|off|on)|at \d+\s?%)/i,
  // "Timer set!", "Reminder is scheduled", "the job is running"
  /\b(?:timer|reminder|alarm|note|mission|job|download|install(?:ation)?)\b[^.!?]{0,30}?\b(?:is |has been |'s |are )?(?:set|saved|scheduled|started|running|launched|logged|cancelled|canceled|under way|underway)\b/i,
  // "Setting a reminder for 6pm.", "Starting the render now."
  /^\W*(?:setting|starting|opening|launching|saving|scheduling|logging|installing|cancelling|canceling|creating|writing|adding|downloading|converting|recording|pausing|resuming|muting|locking|closing|copying|skipping|turning (?:it|the|that))\b/i,
  // Promises about later, which only a set reminder can keep.
  new RegExp(
    String.raw`\b(?:i'll|i will|${NAVI_NAME}\s+will|${NAVI_NAME}'ll)\s+(?:remind|ping|notify|alert|tell|let) you\b`,
    "i",
  ),
  // Promises to keep something in mind, which only a saved note can keep.
  new RegExp(
    String.raw`\b(?:i'll|i will|${NAVI_NAME}\s+will|${NAVI_NAME}'ll)\s+(?:remember|note|save|write (?:that|it|this) down|make a note)\b`,
    "i",
  ),
  /\b(?:saved it|locked in|done and done)\b/i,
  // "I'll set that timer now.", "Astra will set a 10-minute timer for you.", "Let me
  // pause that." Said with no tool call, the user is left waiting for something that
  // is not coming.
  new RegExp(
    String.raw`\b(?:i'll|i will|i'm going to|i am going to|${NAVI_NAME}\s+will|${NAVI_NAME}'ll|${NAVI_NAME}(?: is|'s) going to|let me)\s+(?:just |quickly |now |go ahead and |get that |get it )?(?:set|start|open|launch|save|schedule|log|install|cancel|create|write|add|download|convert|record|pause|resume|mute|unmute|lock|close|minimize|maximize|copy|skip|lower|raise|turn|delete|remove)\b`,
    "i",
  ),
  // "Kate's closed.", "Done! Kate is closed.", "Firefox has been minimized." The thing is
  // named, not called a window. "The shop is closed" is caught too and let go by the
  // second look, which is what that look is for.
  /(?:\bis|'s|\bare|\bhas been|\bhave been)\s+(?:now |all )?(?:closed|minimi[sz]ed|maximi[sz]ed|paused|muted|unmuted|locked)\b/i,
  // "Volume set.", "Volume lowered."
  /\b(?:volume|sound)\b[^.!?]{0,15}?\b(?:set|lowered|raised|changed|adjusted)\b/i,
];

const CLAIMS_OTHER_LANGUAGES: readonly RegExp[] = [
  /(?:セット|設定|保存|記録|メモ|開始|起動|登録|停止|ミュート|ロック|コピー|再生)(?:した|しました|したよ|しといた|しておいた|完了|済み|しとく)|覚えた|覚えました|覚えておく|覚えとく|リマインドする|お知らせする/,
  /(?:已经?|已)(?:帮你)?(?:设置|设定|设好|保存|记录|记下|记住|启动|打开|安排|暂停|静音|锁定|复制|关闭)|设置好了|设好了|记住了|记下了|保存好了|会提醒你|到时候提醒/,
];

/**
 * Statements that a thing HAS been done, as opposed to being done now or promised:
 * "Done, Captain.", "Screen locked and safe.", "Music is paused.", "I've saved that."
 * After a request, in a reply that used no tool, such a sentence is simply untrue,
 * and there is nothing left to weigh.
 */
/** "Locked the screen for you.", "Paused it.": the doer left out, as people and models both do. */
const DONE_WITHOUT_A_SUBJECT =
  /^\W*(?:captain,? )?(?:locked|paused|muted|unmuted|closed|opened|saved|set|started|cancell?ed|deleted|removed|copied|sent|installed|scheduled|launched|minimi[sz]ed|maximi[sz]ed|resumed|skipped|lowered|raised|turned|rang|added|created)(?:\s+(?:the|your|that|this|it|a|an|up|down|off|on|for (?:you|captain))\b|\s*[.!]+\s*$)/i;
/** "It's ready to paste", "that's on your clipboard now": only the clipboard tool makes it so. */
const ON_THE_CLIPBOARD =
  /\bready to paste\b|\b(?:is|are|it's|that's|now) (?:now )?(?:on|in) (?:your|the) clipboard\b|\bcopied (?:it |that |this )?to (?:your|the) clipboard\b/i;

const DONE: readonly RegExp[] = [
  DONE_WITHOUT_A_SUBJECT,
  KEPT_SOMEWHERE,
  ON_THE_CLIPBOARD,
  /^\W*(?:done|all done|all set|sorted|finished|got it done)\b\s*[.!,]/i,
  new RegExp(
    String.raw`\b(?:i(?:'ve| have)|${NAVI_NAME}(?: has|'s))\s+(?:just |already |now |gone ahead and )?(?:set|saved|noted|logged|started|launched|opened|scheduled|added|created|written|remembered|cancelled|canceled|stopped|installed|paused|resumed|muted|unmuted|locked|closed|minimized|maximized|copied|skipped|lowered|raised|turned|deleted|removed|freed)\b`,
    "i",
  ),
  /\b(?:music|song|track|video|volume|sound|screen|window|clipboard)\b[^.!?]{0,25}?\b(?:is |has been |'s |are )?(?:now )?(?:paused|resumed|muted|unmuted|locked|closed|minimized|copied|skipped|set to|turned (?:up|down|off|on))\b/i,
  /\b(?:timer|reminder|alarm|note|mission|job)\b[^.!?]{0,30}?\b(?:is |has been |'s |are )?(?:set|saved|scheduled|started|logged|cancelled|canceled)\b/i,
  /(?:\bis|'s|\bare|\bhas been|\bhave been)\s+(?:now |all )?(?:closed|minimi[sz]ed|maximi[sz]ed|paused|muted|unmuted|locked)\b/i,
  /\b[A-Z][\w ]{1,30} (?:closed|locked|paused|muted|saved|deleted|minimi[sz]ed)(?: up| down)?[.!]/,
  /\b(?:saved it|locked in|done and done)\b/i,
];

const DONE_OTHER_LANGUAGES: readonly RegExp[] = [
  /(?:セット|設定|保存|記録|メモ|開始|起動|登録|停止|ミュート|ロック|コピー)(?:した|しました|したよ|しといた|しておいた|完了|済み)|覚えた|覚えました/,
  /(?:已经?|已)(?:帮你)?(?:设置|设定|设好|保存|记录|记下|记住|启动|打开|安排|暂停|静音|锁定|复制|关闭)|设置好了|设好了|记住了|记下了|保存好了/,
];

/** A sentence saying that something is NOT so, or was so before now, claims nothing new. */
const NOT_NOW =
  /\b(?:not|never|no|nothing|none|cannot|without|neither|nor|already|earlier|before|still|last time|yesterday)\b|n['’]t\b/i;
const NOT_NOW_OTHER_LANGUAGES =
  /ない|ません|なかった|ず(?:に)?$|さっき|先ほど|昨日|今朝|以前|前に|すでに|もう|没有|没|不|未|别|刚才|之前|昨天|早上|已经.*过了/;

/** A sentence that says outright that the thing did not happen. */
const DENIES =
  /\b(?:not|never|cannot|nothing|unable|without)\b|n['’]t\b|\b(?:failed|declined|refused)\b|^\W*no\s+\w+(?:\s+\w+)?\s+(?:was|were|is|are|has|have)\b/i;

/**
 * Like `claimsAnAction`, but a sentence that says the thing did NOT happen ("That
 * window wasn't closed, Captain") is no claim. For marking a finished reply, where
 * there is no second look to weigh what the first pass let through.
 */
export function claimsAnActionUndenied(reply: string): boolean {
  return sentencesOf(reply).some((sentence) => !DENIES.test(sentence) && claimsAnAction(sentence));
}

/** Words set off in quotation marks are being quoted, not said. */
function withoutQuoted(text: string): string {
  return text.replace(
    /"[^"\n]{0,200}"|“[^”\n]{0,200}”|「[^」\n]{0,200}」|『[^』\n]{0,200}』/g,
    " ",
  );
}

/** True when the reply says, as a plain fact, that something has just been done. */
export function saysItIsDone(reply: string): boolean {
  return sentencesOf(reply).some((sentence) => {
    if (DONE_OTHER_LANGUAGES.some((pattern) => pattern.test(sentence))) {
      return !NOT_NOW_OTHER_LANGUAGES.test(sentence) && !NOT_A_CLAIM_OTHER_LANGUAGES.test(sentence);
    }
    return (
      !NOT_A_CLAIM.test(sentence) &&
      !NOT_NOW.test(sentence) &&
      DONE.some((pattern) => pattern.test(sentence))
    );
  });
}

/** Typed apostrophes come curly as often as straight; the patterns here are written straight. */
function straight(text: string): string {
  return text.replace(/[‘’]/g, "'");
}

function sentencesOf(text: string): string[] {
  // What she shows of a file or a page (a fenced block, a line set off with ">") is
  // that file's wording, not a statement of hers.
  const own = text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/^\s*>.*$/gm, " ");
  return withoutQuoted(straight(own))
    .split(/(?<=[.!?。！？])\s+|(?<=[。！？])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** A sentence in Japanese or Chinese that offers, asks or wishes, and so claims nothing. */
const NOT_A_CLAIM_OTHER_LANGUAGES =
  /たい|ましょうか|ますか|ようか|[?？]$|吗|嗎|要不要|需要我|可以帮|是否/;

/**
 * Sentences that say she is doing a thing, or is about to, in so many words: "Ringing
 * your phone now.", "AI-chan is dimming the speakers to 30 percent.", "I'll set that
 * timer now." Narrow on purpose. A line that merely opens with a doing word ("During
 * the night…", "Opening the door, she…") is a story or an explanation, not a report.
 */
const UNDER_WAY: readonly RegExp[] = [
  // A doing word and "your": it is the user's thing that is being acted on.
  /^\W*[a-z]+ing\s+(?:up |down |off |on )?your\b/i,
  // "Opening Firefox for you", "Pausing it now", "Setting that up right away".
  /^\W*[a-z]+ing\s+[^.!?]{1,40}?\b(?:for you|right now|right away|now)\b\s*[,.!]/i,
  new RegExp(
    String.raw`\b(?:i'm|i am|${NAVI_NAME}\s+is|${NAVI_NAME}'s)\s+(?:now |just |already )?[a-z]+ing\s+(?:your|the|that|this|it)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:i'll|i will|i'm going to|${NAVI_NAME}\s+will|${NAVI_NAME}'ll|${NAVI_NAME}(?: is|'s) going to)\s+(?:just |quickly |now |go ahead and |get that |get it )?(?:set|start|open|launch|save|schedule|log|install|cancel|create|download|pause|resume|mute|unmute|lock|close|minimize|maximize|copy|skip|lower|raise|turn|delete|remove|remind|ping|notify|ring|send|remember)\b`,
    "i",
  ),
];
/** Doing words that open a sentence without reporting an action of hers. */
const NOT_DOING =
  /^\W*(?:being|thinking|speaking|judging|considering|assuming|according|regarding|looking|going|having|knowing|seeing|reading|during|using|following|including|pending|nothing|something|anything|everything|morning|evening)\b/i;

/**
 * True when the reply says, in so many words, that she has done a thing, is doing it
 * or will do it, in a sentence that is neither a question, an offer, a denial, a quote
 * nor about an earlier time. Used only when the user plainly asked for the thing and
 * no tool was so much as tried: then such a sentence is untrue, and there is nothing
 * to weigh. Anything less clear is left to her own second look.
 */
export function claimsFlatly(reply: string): boolean {
  return sentencesOf(reply).some((sentence) => {
    if (DONE_OTHER_LANGUAGES.some((pattern) => pattern.test(sentence))) {
      return !NOT_NOW_OTHER_LANGUAGES.test(sentence) && !NOT_A_CLAIM_OTHER_LANGUAGES.test(sentence);
    }
    if (NOT_A_CLAIM.test(sentence) || NOT_NOW.test(sentence)) return false;
    if (DONE.some((pattern) => pattern.test(sentence))) return true;
    return !NOT_DOING.test(sentence) && UNDER_WAY.some((pattern) => pattern.test(sentence));
  });
}

/**
 * "Ringing your phone now.", "I'm pausing it for you.": she says the thing is happening
 * at this moment, for the user. Unlike "it is set", this cannot be about something done
 * earlier, so in a reply in which no tool was so much as tried it is untrue however
 * the request was worded ("I can't find my phone, can you make it ring?").
 */
/** Doing words for the things she has tools for. Writing, explaining and thinking are not among them. */
const TOOL_DOING =
  "ringing|pausing|resuming|muting|unmuting|locking|opening|launching|closing|setting|starting|installing|uninstalling|downloading|saving|copying|deleting|removing|sending|scheduling|playing|stopping|skipping|turning|lowering|raising|dimming|minimi[sz]ing|maximi[sz]ing|restarting|shutting|cancell?ing|reminding|pinging";
const HAPPENING_NOW: readonly RegExp[] = [
  new RegExp(
    `^\\W*(?:captain,? )?(?:${TOOL_DOING})\\s+[^.!?]{1,40}?\\b(?:now|right now|right away|for you)\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:i'm|i am|${NAVI_NAME}\\s+is|${NAVI_NAME}'s)\\s+(?:${TOOL_DOING})\\s+[^.!?]{1,40}?\\b(?:now|right now|right away|for you)\\b`,
    "i",
  ),
];
/** "Installing it now takes two minutes": advice about doing it now, not a report of doing it. */
const NOW_AS_ADVICE =
  /\bnow\s+(?:is|are|was|would|will|can|could|may|might|should|gives?|takes?|means?|requires?|costs?|helps?|lets?|makes?)\b/i;

/** True when the reply says she is carrying out one of her actions for the user at this very moment. */
export function saysItIsHappeningNow(reply: string): boolean {
  return sentencesOf(reply).some(
    (sentence) =>
      // Offers and questions only: "so you can find it" does not make it an offer.
      !/\b(?:want me to|shall i|should i|do you want|would you like|if you(?:'d)? like|happy to|glad to)\b|\?\s*$/i.test(
        sentence,
      ) &&
      !NOT_NOW.test(sentence) &&
      !NOW_AS_ADVICE.test(sentence) &&
      HAPPENING_NOW.some((pattern) => pattern.test(sentence)),
  );
}

/** Things that can only be known by going and looking with a tool. */
const LOOKED_AT =
  "volume|sound level|notifications?|calendar|agenda|weather|forecast|disk space|storage|battery|temperature|reminders?|timers?|clipboard|(?:open|your) windows|what(?:'s| is) playing|ship(?:'s)? status|system status|play ?time|play log";
/**
 * Sentences that say she went and found something out with a tool: "AI-chan checked
 * the volume", "I've checked your open windows", "Let me calculate that for you"
 * followed by a figure. Only for the things a tool is needed for: "I've gone through
 * your essay" or "I've checked the spelling" is true of text in front of her.
 */
const LOOKED: readonly RegExp[] = [
  new RegExp(
    `\\b(?:i(?:'ve| have)?|${NAVI_NAME}(?: has|'s)?)\\s+(?:just |now |quickly )?(?:checked|looked (?:at|up|into|for)|searched|scanned|pulled up)\\b[^.!?]{0,40}?\\b(?:${LOOKED_AT})\\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:i(?:'ve| have)?|${NAVI_NAME}(?: has|'s)?)\s+(?:just |now |quickly )?(?:did the math|done the math|calculated|run the numbers|ran the numbers)\b`,
    "i",
  ),
  /\blet me (?:just |quickly )?(?:calculate|do the math|run the numbers)\b/i,
  new RegExp(
    `\\blet me (?:just |quickly )?(?:check|look (?:at|up|into)|search|pull up)\\b[^.!?]{0,40}?\\b(?:${LOOKED_AT})\\b`,
    "i",
  ),
];
/** In Japanese and Chinese the thing and the looking come in either order, so each is sought on its own. */
const LOOKED_VERB_OTHER_LANGUAGES =
  /確認した|確認しました|チェックした|調べた|調べました|見てみた|查了|查过|查到|看了一下|检查了/;
const LOOKED_AT_OTHER_LANGUAGES =
  /音量|ウィンドウ|通知|予定|カレンダー|天気|気温|雨|ディスク|状態|システム|窗口|日程|日历|天气|气温|温度|磁盘|状态|系统/;
const WORKED_OUT_OTHER_LANGUAGES = /計算した|計算しました|計算してみた|算了一下|计算了/;
/**
 * "I've looked at your snippet: the timer is never cleared", "I've checked the
 * temperature in your recipe": about something the user wrote, which is in front of her.
 */
const LOOKED_AT_WRITING =
  /\b(?:snippet|code|script|function|recipe|essay|draft|paragraph|sentence|section|chapter|document|text|message|email|letter|list you|what you (?:wrote|sent|pasted))\b/i;
/** She says she cannot, or has not: then "let me check" before it promised nothing false. */
const SAYS_SHE_COULD_NOT =
  /\b(?:can't|cannot|couldn't|could not|unable|not able|no way to|haven't|have not)\b|できな|ません|无法|不能|没法/i;

/**
 * True when the reply says she checked, looked up or worked out something that takes a
 * tool. Meant for a reply in which no tool was even tried: what she then reports was
 * made up.
 */
export function saysSheLooked(reply: string): boolean {
  if (SAYS_SHE_COULD_NOT.test(straight(reply))) return false;
  return sentencesOf(reply).some((sentence) => {
    if (
      WORKED_OUT_OTHER_LANGUAGES.test(sentence) ||
      (LOOKED_VERB_OTHER_LANGUAGES.test(sentence) && LOOKED_AT_OTHER_LANGUAGES.test(sentence))
    ) {
      return !NOT_NOW_OTHER_LANGUAGES.test(sentence) && !NOT_A_CLAIM_OTHER_LANGUAGES.test(sentence);
    }
    return (
      !NOT_NOW.test(sentence) &&
      !/\b(?:a moment ago|last time|a while ago)\b/i.test(sentence) &&
      !LOOKED_AT_WRITING.test(sentence) &&
      LOOKED.some((pattern) => pattern.test(sentence))
    );
  });
}

/**
 * Questions about how things stand right now, which nothing but a tool can answer: the
 * volume, what is playing, which windows are open, the weather, the notifications, the
 * agenda, the reminders, the state of the PC. An answer given without a tool is a guess
 * however it is worded. All of these are looked up by tools that only read, so making
 * her look when she need not have costs a moment and nothing else.
 */
/** What the play-time question is called in a correction; the screen line can answer it too. */
export const PLAY_TIME = "how long the game has been going";
const LIVE_STATE: readonly [RegExp, string, string?, string?][] = [
  [
    /\bwhat(?:'s| is) the volume(?: at| set to| right now| now)?\s*[?.!]*$|\bhow loud is (?:it|the (?:volume|sound|music))(?: right now| now| set)?\s*[?.!]*$|\bis (?:it|the sound|the music|the pc) muted(?: right now| now)?\s*[?.!]*$/i,
    "the volume",
    "sound",
    "get_volume",
  ],
  [
    /\bwhat(?:'s| is) (?:playing|this song)(?: right now| now)?\s*[?.!]*$|\b(?:what|which) song is (?:this|playing)(?: right now| now)?\s*[?.!]*$/i,
    "what is playing",
    "sound",
    "now_playing",
  ],
  [
    /\b(?:what|which) (?:windows|programs|apps) (?:are|do i have) (?:open|running)(?: right now| now| on (?:my|the|this) (?:screen|desktop|pc|computer))?\s*[?.!]*$/i,
    "the open windows",
    "windows",
    "list",
  ],
  [
    /\bwhat was that notification\b|(?:^|[,.!?]\s*)(?:any|do i have any|are there any) (?:new )?notifications\s*\?*\s*$|\bdid i miss (?:any|a) notifications?\b/i,
    "the notifications",
    "notifications",
  ],
  [
    /\bwhat(?:'s| is) on my (?:calendar|agenda|schedule)\b|\bwhat do i have (?:on )?(?:today|tomorrow|this (?:morning|afternoon|evening))\s*[?.!]*$/i,
    "the agenda",
    "agenda",
    "list",
  ],
  [
    /\bhow much disk space (?:is|do i have) (?:left|free)\b|\bhow much space (?:is|do i have) (?:left|free)(?: on (?:my|the|this) (?:disk|drive|ssd|pc|computer|system)| on \/\S*)?\s*[?.!]*$|\bhow(?:'s| is) (?:the|my) (?:pc|computer|ship) (?:doing|holding up)\b|\bwhy is (?:my|the|this) (?:pc|computer) (?:so |this )?slow\b/i,
    "the state of the PC",
    "ship_status",
  ],
  [
    /\bwhat(?:'s| is|'ll| will) the (?:weather|forecast)\b(?![^.!?]*\b(?:mars|venus|jupiter|saturn|mercury|neptune|uranus|pluto|the moon|the sun|space|book|novel|film|movie|game|story|show|series|song|poem|usually|typically|normally|generally|average|climate|january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|fall|winter)\b)[^.!?]{0,40}[?.!]*$|\bwill it (?:rain|snow) (?:today|tomorrow|tonight|this (?:week|weekend|afternoon|evening))\b/i,
    "the weather",
    "weather",
  ],
  [
    /\b(?:what|which) (?:reminders|timers) (?:are|do i have) (?:set|running|on)\b/i,
    "the reminders",
    "reminders",
  ],
  [
    /\bhow long have i been (?:playing|gaming)(?: (?:this(?: game)?|today|tonight|now|so far))*\s*[?.!]*$|\bhow long have i been in (?:this|the) game\b|\bhow (?:long|much) (?:have i|did i) play(?:ed)? today\b|\bhow long has (?:this|the) game been (?:running|open|going)\b/i,
    PLAY_TIME,
    "ship_status",
  ],
  [
    /音量は(?:どのくらい|いくつ|何)|今(?:何が|なにが)再生|どのウィンドウが開い|通知(?:は|が)(?:ある|来て)|今日の予定は/,
    "what was asked",
  ],
  [
    /音量(?:是多少|多大)|(?:现在)?在放什么|开着哪些窗口|有(?:什么|没有)新?通知|今天有什么(?:安排|日程)/,
    "what was asked",
  ],
];

/**
 * What the user is asking about, when it is something only a tool can tell her right
 * now; null otherwise.
 */
export function asksAboutLiveState(said: string): string | null {
  return liveState(said)?.[1] ?? null;
}

/** The volume of a tank is a sum, not a setting. */
const VOLUME_OF_A_SHAPE =
  /\b(?:radius|height|width|length|diameter|depth|cylinder|sphere|cube|cone|tank|box|litres?|liters?|gallons?|cubic)\b/i;

function liveState(said: string): (typeof LIVE_STATE)[number] | null {
  const text = straight(said);
  // "What should I set the volume to", "how do I check the weather": about doing, not about now.
  if (/\b(?:how (?:do|can|would|should) (?:i|you|we)|should i|what should)\b/i.test(text))
    return null;
  const found = LIVE_STATE.find(([pattern]) => pattern.test(text)) ?? null;
  if (found?.[1] === "the volume" && VOLUME_OF_A_SHAPE.test(text)) return null;
  return found;
}

/**
 * The name of the tool that answers such a question, where one tool plainly does, so
 * that a correction can name it: a small model told "call the tool that finds it out"
 * has been seen to answer "AI-chan checked now" and make the answer up a second time.
 */
export function toolForLiveState(said: string): { tool: string; action: string | null } | null {
  const found = liveState(said);
  // With the action that only looks, where the tool has others that change things:
  // "call sound" alone would leave a small model to choose between asking and muting.
  return found?.[2] === undefined ? null : { tool: found[2], action: found[3] ?? null };
}

/**
 * True when the reply puts a question back to the user in place of an answer: "Which
 * town are you in?" to "what's the weather like?". Nothing was guessed, so there is
 * nothing to put right, and sending her to a tool would make her invent the town.
 */
export function asksBack(reply: string): boolean {
  const text = straight(reply);
  if (text.length > 240) return false;
  return /\b(?:where|which|what (?:town|city|place|day|calendar|one)|who)\b[^.!?]*\?/i.test(text);
}

/** "Let me check the server status for you." and then nothing: the start of a reply that never came. */
const SAYS_SHE_WILL = new RegExp(
  String.raw`^\W*(?:(?:ok(?:ay)?|sure|right|alright|got it|one moment|one sec(?:ond)?|hold on|hang on)[,.!]?\s+)?(?:captain[,.!]?\s+)?(?:let me|let ${NAVI_NAME}|i(?:'ll| will| need to|'m going to| am going to| have to)|${NAVI_NAME}\s+(?:will|needs to|is going to|has to)|${NAVI_NAME}'ll|need to|needs to|going to|first,? (?:i|${NAVI_NAME})(?:'ll| will| needs? to)?)\s+(?:just |quickly |first |go and |go )?(?:check|look|find|search|pull up|read|fetch|ping|see (?:what|if|whether|how))\b`,
  "i",
);
/** "I'll look once you tell me which one": waiting on the user, not stopped short. */
const WAITS_FOR_THE_USER = new RegExp(
  String.raw`\b(?:when|once|if|after|as soon as|until) you\b|\btell (?:me|${NAVI_NAME})\b`,
  "i",
);
/** "I'll look at it later", "I'll check back in a bit", "I'll look forward to it": nothing is owed now. */
const NOT_JUST_NOW = new RegExp(
  String.raw`\b(?:later|tomorrow|tonight|soon|eventually|next time|another time|some ?time|back|forward|in a (?:bit|while|minute|moment|sec(?:ond)?)|when (?:i|${NAVI_NAME}))\b`,
  "i",
);

/**
 * True when the whole reply is an announcement that she is about to look something up
 * ("Let me check the Proxmox server status for you.") with nothing after it. With no
 * tool so much as tried in that reply, she stopped before doing it and the user is
 * left waiting for an answer that is not coming.
 */
export function onlySaysSheWill(reply: string): boolean {
  const text = straight(reply)
    .replace(/\[\[\w+\]\]/g, " ")
    .trim();
  if (text.length > 220 || /[?？]/.test(text)) return false;
  if (WAITS_FOR_THE_USER.test(text) || NOT_JUST_NOW.test(text)) return false;
  const sentences = sentencesOf(text);
  if (sentences.length === 0 || sentences.length > 2) return false;
  // Every sentence is such an announcement, or a word or two beside one ("One moment.").
  return (
    sentences.some((sentence) => SAYS_SHE_WILL.test(sentence)) &&
    sentences.every((sentence) => SAYS_SHE_WILL.test(sentence) || sentence.split(/\s+/).length <= 3)
  );
}

/**
 * A sum that is better not done in her head: a percentage, a conversion, or figures
 * with three digits or a decimal point. "What's 7 times 8" is not one.
 */
const SUMS_ASKED: readonly RegExp[] = [
  /\d[\d,.]*\s*(?:%|percent)\s+of\s+[$€£]?\d/i,
  /\bconvert\s+[$€£]?\d[\d,.]*\s*[a-z°]+\s+(?:to|into|in)\s+[a-z°]+/i,
  /\bhow many [a-z]+ (?:is|are|in|make) [$€£]?\d[\d,.]*\s*[a-z]+/i,
  /\d[\d,.]*\s*の\s*\d[\d,.]*\s*(?:%|％|パーセント)/,
  /\d[\d,.]*\s*的\s*(?:百分之\s*\d|\d[\d,.]*\s*[%％])/,
];
const FIGURE = "[$€£]?\\d[\\d,]*(?:\\.\\d+)?";
/** Signs and words that mean a sum wherever they stand between two figures. */
const SUM_IN_WORDS = new RegExp(
  `(${FIGURE})\\s*(?:[×÷−]|\\btimes\\b|\\bmultiplied by\\b|\\bdivided by\\b|\\bplus\\b|\\bminus\\b|かける|掛ける|割る|足す|たす|引く|ひく|乘以?|除以|加上?|减去?)\\s*(${FIGURE})`,
  "i",
);
/**
 * The keyboard's own signs also stand in screen sizes and spans of years ("1920 x
 * 1080", "2023 - 2024"), so they count only where a sum is plainly being asked for.
 */
const SUM_IN_PLAIN_SIGNS = new RegExp(`(${FIGURE})\\s[x*/+-]\\s(${FIGURE})`, "i");
const ASKS_WHAT_IT_COMES_TO =
  /\b(?:what(?:'s| is| does)|calculate|compute|work out|how much is|add up)\b|=\s*\?/i;
const NOTHING_BUT_A_SUM = /^[\s\d.,$€£x*/+()=?-]+$/i;

/** True when the user asks for such a sum. */
export function asksForASum(said: string): boolean {
  const text = straight(said);
  if (/\b(?:how (?:do|can|would|should) (?:i|you|we))\b/i.test(text)) return false;
  if (SUMS_ASKED.some((pattern) => pattern.test(text))) return true;
  const sum =
    SUM_IN_WORDS.exec(text) ??
    (ASKS_WHAT_IT_COMES_TO.test(text) || NOTHING_BUT_A_SUM.test(text)
      ? SUM_IN_PLAIN_SIGNS.exec(text)
      : null);
  if (!sum) return false;
  // Small whole numbers she may do in her head.
  return [sum[1] ?? "", sum[2] ?? ""].some(
    (figure) => figure.includes(".") || figure.replace(/\D/g, "").length >= 3,
  );
}

/**
 * True when the reply takes a no for a no: "Understood, AI-chan has cancelled that",
 * "left as it was". After a refused step that is the right thing to say, whatever
 * doing words are in it.
 */
export function acknowledgesNo(reply: string): boolean {
  return /\b(?:cancell?ed|stopped|left (?:it|that|them|alone|as)|as you (?:said|asked|wish)|understood|won't|will not|not (?:done|doing|going|changed|touched)|nothing (?:was|has been) (?:changed|done|deleted|removed))\b|やめ|取り消|不做了|取消/i.test(
    straight(reply),
  );
}

/** "Astra can't ring your phone from here", "I don't have a tool for that". */
const LACKS_A_WAY = new RegExp(
  String.raw`\b(?:i|${NAVI_NAME})\s+(?:really |simply |just )?(?:can't|cannot|can not|am not able to|is not able to|isn't able to|am unable to|is unable to|don't have (?:a|any|the) (?:way|tool|means|ability|access)|doesn't have (?:a|any|the) (?:way|tool|means|ability|access)|have no (?:way|tool|means)|has no (?:way|tool|means))\b(?!\s+(?:believe|wait|imagine|promise|recommend|agree|decide|help but|stress|thank|stop (?:thinking|laughing)|say (?:for sure|which|what|whether)|tell (?:you )?(?:which|what|whether|for sure)|be sure))`,
  "i",
);

/**
 * True when a short reply says she has no way of doing what was asked. Used when she
 * was offered only some of her tools: the one she needed may have been among the rest.
 */
export function saysSheHasNoWay(reply: string): boolean {
  const text = straight(reply)
    .replace(/\[\[\w+\]\]/g, " ")
    .trim();
  return text.length <= 320 && sentencesOf(text).some((sentence) => LACKS_A_WAY.test(sentence));
}

/** Words a message starts with when it tells or asks about something, not when it asks for a thing to be done. */
const NOT_AN_ORDER =
  /^(?:i|i'm|i've|i'd|we|we're|it|it's|that|that's|this|the|my|your|you|you're|he|she|they|there|what|what's|why|who|who's|how|how's|when|where|which|is|are|was|were|do|does|did|yes|no|ok|okay|thanks|thank|wow|lol|hi|hello|hey|so|and|but|well|oh|ah|hmm|nice|good|great|cool|sorry)$/i;

/**
 * True when a message asks for something to be done: "Make the room dark for me",
 * "Could you dim the lights?", "please ring it". Not a question about how things are,
 * and not talk. Deliberately loose about what is asked for; it is used to tell a
 * request she said she could not carry out from a limit she was only remarking on.
 */
export function soundsLikeARequest(said: string): boolean {
  const text = straight(said).trim();
  if (text === "") return false;
  if (
    /\b(?:can|could|would|will) you\b|\bplease\b|\bi (?:need|want|would like|'d like) you to\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) {
    return /して|ください|お願い|くれ|てよ|请|帮我|帮忙|把|给我/.test(text);
  }
  const first = /^\W*([A-Za-z']+)/.exec(text)?.[1] ?? "";
  return first !== "" && !/\?\s*$/.test(text) && !NOT_AN_ORDER.test(first);
}

/** True when the reply says she cannot tell, has not looked, or asks which is meant. */
export function declinesToSay(reply: string): boolean {
  const text = straight(reply);
  return (
    SAYS_SHE_COULD_NOT.test(text) ||
    /\b(?:don't know|doesn't know|do not know|does not know|not sure|no way of knowing|which (?:one|\w+ do you mean|do you mean)|would need to (?:check|look)|need to (?:check|look))\b/i.test(
      text,
    )
  );
}

/**
 * What a plain request for one of her actions looks like, once any "please" or "can
 * you" is set aside. Each is something she has a tool for and that cannot be done in
 * words alone. Verbs that are as often about text ("write", "make", "add", "note",
 * "keep", "turn", "run", "put", "play", "stop") count only with the thing they act on.
 */
const THINGS_SHE_OPENS =
  "window|app|application|program|browser|terminal|file manager|settings|folder|steam|firefox|chrome|chromium|discord|spotify|kate|dolphin|konsole|blender|unreal|vs ?code|calculator|kcalc|elisa|vlc|obs|gimp|krita|thunderbird|libreoffice";
const ASKED_ACTIONS: readonly string[] = [
  "(?:lock|pause|resume|mute|unmute|minimi[sz]e|maximi[sz]e|install|uninstall|download|restart|ring)\\b",
  "(?:set|start|cancel|stop)\\s+(?:up\\s+)?(?:a|an|the|my|that|this|another)?\\s*(?:\\d+[- ]?\\w*\\s+)?(?:timer|reminder|alarm|countdown|volume)\\b",
  "set the volume\\b|set (?:it|that) to \\d",
  "remind me\\b",
  "remember (?:that|this|my|:)",
  // Opening and closing: a program or a window, not a letter or a story.
  `(?:open|launch|close|quit)\\s+(?:up\\s+)?(?:the\\s+|my\\s+)?(?:[\\w.-]+\\s+)?(?:${THINGS_SHE_OPENS})\\b`,
  // The rest only with the thing a tool acts on; "remove the typos" is done in words.
  "(?:delete|remove|cancel)\\s+(?:the|my|that|this|a|an)?\\s*[^.!?,:]{0,30}?\\b(?:file|folder|reminder|timer|alarm|standing order|calendar entry|appointment)\\b",
  "copy\\s+[^.!?,:]{1,40}?\\bto (?:the|my) clipboard\\b",
  "copy (?:this|that|it)\\s+(?:so (?:that )?i can paste|for (?:me to )?past(?:e|ing))\\b|put (?:this|that|it) on (?:the|my) clipboard\\b",
  "send\\s+[^.!?,:]{1,40}?\\bto (?:the|my) phone\\b",
  "skip\\s+(?:this|the|that)?\\s*(?:song|track)\\b",
  "(?:lower|raise)\\s+the\\s+(?:volume|sound)\\b",
  "save\\s+(?:it|that|this)\\s+(?:as|to|in)\\s+\\S",
  "(?:make|create|add|set)\\s+(?:me\\s+)?(?:a|an|another)\\s+(?:new\\s+)?(?:reminder|timer|alarm|calendar entry|appointment|deck log entry)\\b",
  "turn\\s+(?:(?:the|my|it|that)\\s+)?(?:volume|music|sound|speakers?)?\\s*(?:up|down|off|on)\\b",
  "(?:play|stop|skip|next|previous)\\s+(?:the\\s+)?(?:music|song|track|video|playback)\\b",
  "keep (?:an eye|watch)\\b",
  "put\\s+[^.!?]{1,60}\\b(?:in|on)\\s+(?:my|the)\\s+(?:calendar|agenda|clipboard|deck log)\\b",
  "run\\s+(?:the|my|this|that)\\s+[^.!?]{0,40}\\b(?:script|command|backup|render|job)\\b",
];
const ASKS_FOR = new RegExp(
  `^\\W*(?:(?:hey|ok|okay|alright|right|so|and|now|then|astra(?: navi)?|ai-chan|ai chan)[,!. ]+)*(?:please |pls |kindly |go ahead and |just |quickly )*(?:(?:can|could|would|will) you (?:please |just |quickly )?|i(?:'d| would) like you to |i need you to |i want you to )?(?:${ASKED_ACTIONS.join("|")})`,
  "i",
);
/** "Don't set a reminder", "no need to save it": the opposite of asking for it. */
const ASKS_NOT_TO =
  /^\W*(?:no\b|nope\b|never ?mind|don'?t\b|do not\b|stop asking|forget it|no need|please don'?t)/i;
/** Said after asking: the request is withdrawn. */
const TAKES_IT_BACK =
  /\b(?:never ?mind|forget it|scratch that|no,? wait|actually,? (?:don'?t|no)\b|don'?t bother|cancel that)\b|やっぱり?(?:いい|やめ)|算了|不用了/i;
const ACTIONS_OTHER_LANGUAGES =
  "セット|設定|保存|記録|メモ|開い|開け|閉じ|起動|停止|止め|再生|ミュート|ロック|コピー|送っ|鳴らし|覚え|リマインド|消し|削除|下げ|上げ|设置|设定|保存|记|打开|关闭|关掉|暂停|静音|锁|复制|发送|提醒|删除|调|播放|停止";
const ASKS_FOR_OTHER_LANGUAGES: readonly RegExp[] = [
  // Japanese: one of her actions, asked for in the te-form, with or without a softener.
  new RegExp(
    `(?:${ACTIONS_OTHER_LANGUAGES})[^。！？]{0,6}(?:て|で)(?:ください|下さい|くれ|くれる|ね|よ|ほしい|欲しい|おいて)?[。.!！]?$`,
  ),
  // Chinese: asked of her directly, and naming one of her actions.
  new RegExp(
    `^(?:请(?!问)|請(?!問)|帮我|幫我|麻烦|麻煩|给我|給我|替我|把)[^。！？]{0,30}(?:${ACTIONS_OTHER_LANGUAGES})`,
  ),
];
const QUESTION_OTHER_LANGUAGES =
  /(?:か|かな|の|っけ|かしら|でしょ|よね|吗|嗎|呢|么|麼|吧|嘛|没|沒|没有|沒有)[。.!！]?$|[?？]/;
const REFUSAL_OTHER_LANGUAGES = /^(?:いいえ|いや|やめ|しないで|不要|不用|别|別|算了)/;

/**
 * True when what the user said plainly asks for one of her actions: "lock the screen",
 * "could you pause the music?", "タイマーをセットして". This is what makes a flat "it is
 * done" checkable without a second opinion, so it errs towards false: thanks, a
 * refusal, a request for writing or explaining, a question about how things stand, a
 * request taken back in the next breath and anything unclear are all "no", and are
 * left to the slower look.
 */
export function asksForSomething(said: string): boolean {
  const text = straight(said).trim();
  if (text === "" || TAKES_IT_BACK.test(text)) return false;
  if (ASKS_NOT_TO.test(text) || REFUSAL_OTHER_LANGUAGES.test(text)) return false;
  // Only the first sentence is weighed: "Lock the screen. Is it done?" is a request.
  const first = text.split(/(?<=[.!?。！？])\s+|\n+/)[0] ?? text;
  if (ASKS_FOR.test(first)) return true;
  if (QUESTION_OTHER_LANGUAGES.test(first)) return false;
  return ASKS_FOR_OTHER_LANGUAGES.some((pattern) => pattern.test(first));
}

/** True when the reply states or promises that something was done. */
export function claimsAnAction(said: string): boolean {
  const reply = straight(said);
  if (CLAIMS_OTHER_LANGUAGES.some((pattern) => pattern.test(reply))) return true;
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim());
  return sentences.some(
    (sentence) => !NOT_A_CLAIM.test(sentence) && CLAIMS.some((pattern) => pattern.test(sentence)),
  );
}
