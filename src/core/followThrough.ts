import {
  acknowledgesNo,
  asksAboutLiveState,
  asksBack,
  asksForASum,
  asksForSomething,
  claimsAnAction,
  claimsFlatly,
  declinesToSay,
  onlySaysSheWill,
  PLAY_TIME,
  saysItIsHappeningNow,
  saysSheHasNoWay,
  saysSheLooked,
  soundsLikeARequest,
  toolForLiveState,
} from "./claims.ts";
import { replaceInternalCaptain } from "./characterLayer.ts";
import { TOOLS } from "./permissions.ts";
import { describeWrongSums, sumsIn } from "./sums.ts";
import type { TracedCheck } from "./trace.ts";

/**
 * Follow-through: what is done about a reply whose words have nothing behind them.
 *
 * A small model will say "timer set!" without setting one, "AI-chan checked the
 * notifications" without looking, or give the volume from nowhere. Each such reply is
 * read here once it is finished, against what was really done while it was written,
 * and one of two things follows: she is sent back, once, to do it properly (her second
 * go is hidden from the user until it has something to show), or a note saying so is
 * put under her reply.
 *
 * This file decides; it changes nothing. The brain hands it what happened and carries
 * out what comes back, in order. The wording rules themselves are in `claims.ts`.
 */

/**
 * Asked of the model after a reply in which it used no tool. A small model will
 * sometimes say "timer set!" without setting one; this is how that is caught.
 */
export const CLAIM_CHECK = {
  claimed: {
    type: "noul",
    instruction:
      "Look only at the assistant's most recent reply. Does it tell the user that the assistant has just done one of these: set a reminder or a timer, saved or remembered something, started a job or a download or an install, written a file or a log entry, opened an app or a page, paused or changed music or the volume, moved or closed a window, copied something to the clipboard, locked the screen, started research, or changed something on the computer?",
    criteria: {
      true: "The reply states or promises that such an action was carried out or is now under way",
      false: "The reply only talks, answers, asks, offers, or says it could not do it",
    },
  },
} as const;

/**
 * How sure the model's own second look must be before a claim is corrected. Set low on
 * purpose: the wording check has already found a statement that something was done, and
 * an unkept promise is worse than one needless "let me actually do that".
 */
export const CLAIM_THRESHOLD = 0.35;

const CORRECTION =
  "Your last reply told Captain something was done, but you did not call the tool for it, so nothing actually happened. Put it right now: call the tool that does it (tools are allowed for this message). If you cannot, tell Captain plainly that it has not been done.";
const LOOKUP_CORRECTION =
  "Your last reply said you had checked, looked or worked something out, but you called no tool, so what you reported was made up. Put it right now: call the tool that finds it out (tools are allowed for this message) and answer only from what it returns, saying first that your earlier answer was not checked. If you cannot find it out, tell Captain plainly that you have not checked.";
const LIVE_CORRECTION =
  "Put it right now: call the tool that finds it out (tools are allowed for this message) and answer only from what it returns, saying first that your earlier answer was not checked. If no tool of yours can tell, say plainly that you cannot check it.";
const STOPPED_CORRECTION =
  "Your last reply said you were about to check or find something, and then you stopped without calling any tool, so Captain is still waiting for the answer. Do it now: call the tool (tools are allowed for this message) and answer from what it returns. If no tool of yours can do it, say plainly that you cannot.";
const SUM_CORRECTION =
  "Captain asked for a sum and you gave a figure without the calculator. Call calculate now with that sum (tools are allowed for this message) and give Captain the figure it returns in one short sentence. If it is the same figure, just say it again; do not apologise.";
const MORE_TOOLS_CORRECTION =
  "Your last reply said you could not do what Captain asked. You were shown only some of your tools then; for this message you have all of them. Look through them: if one fits, use it now and do what was asked. If none does, say in one sentence that you cannot.";
const SPOKEN_CORRECTION =
  " Your reply will be spoken aloud, so keep it to one or two plain sentences.";

const REFUSED_NOTICE =
  "She said that was done, but it was not: the step needed your say-so and did not get it, so nothing was changed.";
const STOPPED_NOTICE = "She said she would look that up and then stopped. Ask her again.";
const UNCHECKED_NOTICE =
  "She answered that without looking it up. Treat it as a guess, or ask her again.";
const GUESSED_NOTICE =
  "She said she had checked, but nothing was looked up. Treat what she reported as a guess, or ask her again.";
const UNDONE_NOTICE =
  "She said that was done, but no action was actually carried out. Nothing was set, saved or started. Ask her again or do it another way.";

/** For this many of her replies after a tool was used, what it found counts as still in front of her. */
const TURNS_A_LOOK_STAYS_FRESH = 2;
/** A message this long holds something pasted in, which she can truthfully say she looked at. */
const LONG_ENOUGH_TO_BE_A_PASTE = 400;

/** A finished reply, and what was really done while it was written. */
export interface FinishedReply {
  /** What it answered. */
  message: {
    text: string;
    spoken: boolean;
    /** Not typed or said by the user: the app telling her something happened. */
    event: boolean;
    /** Her second go at something she was sent back for. */
    correction?: boolean;
    /** Her second go at something she said she had looked up, or answered without looking. */
    lookup?: boolean;
  };
  /** Everything she said, as shown. */
  reply: string;
  /** How much of it came before her last tool call. */
  saidBeforeLastTool: number;
  /** Tool calls so much as tried while it was written. */
  steps: number;
  /** Those that worked. */
  toolsDone: number;
  /** Those that worked and do something lasting (see `ACTION_TOOLS`). */
  actionsRun: number;
  /** A step was put to the user and refused. */
  refused: boolean;
  /** Her notes on the subject were handed to her with the message. */
  hadNotes: boolean;
  /** The line about what is on screen that went with the message; "" when none did. */
  onScreen: string;
  /** How many of her replies ago a tool was last used. */
  turnsSinceTool: number;
  /** She was offered only the tools picked out for this message. */
  offeredFewer: boolean;
  /** Optional active user form of address so follow-through corrections don't say "Captain" when customized. */
  userAddress?: string;
  /** Whether she has this tool at all, on offer just now or not. */
  has(tool: string): boolean;
  /** Whether this tool was on offer for this reply. */
  offered(tool: string): boolean;
  /** The reply was cut off. Asked each time: it can happen while the model is asked. */
  aborted(): boolean;
  /** The user has already said something more. Asked each time, for the same reason. */
  userWentOn(): boolean;
  /**
   * The model's own second look at whether the reply says something was done: how sure
   * it is, from 0 to 1, or null when the look could not be had.
   */
  secondLook(): Promise<number | null>;
}

/** One thing to be done about a reply, in the order found. */
export interface FollowUp {
  found: TracedCheck["found"];
  did: TracedCheck["did"];
  /** For "note": what is put under her reply. */
  notice?: string;
  /** For "again": what she is told, hidden from the user. */
  correction?: { text: string; lookup: boolean };
}

export interface Checked {
  followUps: FollowUp[];
  /** True when something in the reply was not so: it is then not one to learn from. */
  falseClaim: boolean;
}

const debug = (line: string): void => {
  if (process.env["AI_CHAN_DEBUG"]) console.log(`\n[brain] ${line}`);
};

const start = (reply: string): string => reply.slice(0, 70).replace(/\n/g, " ");

/**
 * Reads a finished reply against what was done, and says what is to follow. At most one
 * second go is ever asked for; a note about a wrong sum may come as well.
 */
export async function checkReply(turn: FinishedReply): Promise<Checked> {
  const { message, reply } = turn;
  const followUps: FollowUp[] = [];
  const spokenToo = message.spoken ? SPOKEN_CORRECTION : "";
  const again = (found: FollowUp["found"], text: string, lookup: boolean): void => {
    const adapted = replaceInternalCaptain(text, turn.userAddress);
    followUps.push({ found, did: "again", correction: { text: adapted + spokenToo, lookup } });
  };
  const note = (found: FollowUp["found"], notice: string): void => {
    followUps.push({ found, did: "note", notice });
  };

  // Words about an action with no action behind them are not let stand. Checked only
  // for replies that used no tool and talk about an action, and never for her telling
  // of an event (there she reports what happened; she did not do it).
  // A message with something pasted into it ("Remove the extra spaces in this file:"
  // and the text) is as likely to want the text changed as the disk, so the rules do
  // not take it for a plain request; her own second look still may.
  const pasted =
    message.text.length > LONG_ENOUGH_TO_BE_A_PASTE || /\n\s*\S|```/.test(message.text.trim());
  const asked = !message.event && !pasted && asksForSomething(message.text);
  // Judged on what she said after her last tool call: "Closing that for you", said
  // before the call, is no claim once she has gone on to say how it went.
  const said = reply.slice(turn.saidBeforeLastTool);
  // Where the rules below may decide by themselves: no tool worked in this reply (one
  // that did may be what she is truthfully reporting on), and nothing was put to the
  // user and refused (then she must not be sent to try again).
  const nothingBehindIt = turn.toolsDone === 0 && !turn.refused;
  // "Ringing your phone now", with no tool so much as tried, is untrue however the
  // request was worded.
  const happeningNow = !message.event && turn.steps === 0 && saysItIsHappeningNow(said);
  const worthChecking =
    !turn.aborted() &&
    turn.actionsRun === 0 &&
    (!message.event || message.correction === true) &&
    (claimsAnAction(said) || (asked && claimsFlatly(said)) || happeningNow);
  let falseClaim = false;
  // A plain "it is done" (or "doing it", or "will do") in answer to a plain request for
  // one of her actions, with nothing done, needs no second opinion. The model's own
  // second look is asked only where there is something to weigh: on the small models
  // that look lets a flat "Screen locked." pass as often as not. The same holds for her
  // second attempt, which exists only because she was told to act. And for a reply in
  // which a step was refused: "Done!" after a no is untrue whatever was asked, and gets
  // a notice, never a second attempt.
  const untrue =
    worthChecking &&
    (happeningNow ||
      (claimsFlatly(said) &&
        ((turn.refused && !acknowledgesNo(said)) ||
          (nothingBehindIt && (message.correction === true || asked)))));
  if (worthChecking) {
    // Otherwise it is put to her: a probability of "yes", of which only a clear one counts.
    let claimed = untrue;
    if (!untrue) {
      const sureness = await turn.secondLook();
      if (sureness !== null) {
        claimed = sureness >= CLAIM_THRESHOLD;
        debug(`follow-through check: ${sureness.toFixed(2)} for: ${start(reply)}`);
      } else if (claimsFlatly(said) && nothingBehindIt) {
        // When the verifier itself fails, fall back to the deterministic flat-claim check rather than silently skipping.
        claimed = true;
        debug(`follow-through verifier failed; caught flat claim via fallback for: ${start(reply)}`);
      }
    } else {
      debug(`said done with nothing done: ${start(reply)}`);
    }
    falseClaim = claimed;
    if (claimed && !turn.aborted()) {
      // No second attempt when she has had one, when the user said no to a step of this
      // reply (she would only ask again), or when they have already said something
      // more (a "never mind" must not be answered by doing it after all).
      if (message.correction || turn.refused || turn.userWentOn()) {
        note("claimed", turn.refused ? REFUSED_NOTICE : UNDONE_NOTICE);
      } else {
        again("claimed", CORRECTION, false);
      }
    }
  }

  // The same for looking: "AI-chan checked the notifications: one from Spotify…", said
  // in a reply in which no tool was so much as tried, is not a slip of wording. Nothing
  // was checked, and whatever she then reported she made up. Not when she was handed
  // something to look at with the message (her notes, the screen line, a long paste):
  // saying she looked at that is true.
  // Where one tool plainly answers what was asked and she has it, the correction names
  // it: "call the tool that finds it out" alone has been answered with a second made-up
  // "AI-chan checked now".
  const itsTool = message.event ? null : toolForLiveState(message.text);
  const callThis =
    itsTool !== null && turn.has(itsTool.tool)
      ? ` The tool for this is ${itsTool.tool}${itsTool.action === null ? "" : ` with action ${itsTool.action}`}: call it before you write anything.`
      : "";
  const handedSomething = turn.hadNotes || turn.onScreen !== "" || pasted;
  // Nor when a tool was used a moment ago in this conversation: "AI-chan checked the
  // forecast" may then be about what she already has in front of her.
  const nothingRecent = turn.turnsSinceTool >= TURNS_A_LOOK_STAYS_FRESH;
  const madeUp =
    !turn.aborted() &&
    !falseClaim &&
    turn.steps === 0 &&
    (message.correction === true || (!message.event && !handedSomething && nothingRecent)) &&
    saysSheLooked(reply);
  if (madeUp) {
    falseClaim = true;
    debug(`said she looked with nothing looked at: ${start(reply)}`);
    if (message.correction || turn.userWentOn()) note("looked", GUESSED_NOTICE);
    else again("looked", LOOKUP_CORRECTION + callThis, true);
  }

  // And when the question itself was about how things stand right now (the volume, the
  // windows, the weather, what the notifications said) and no tool was tried, her
  // answer is a guess whether or not she says she looked.
  const liveState =
    !turn.aborted() && !falseClaim && !message.event && turn.steps === 0 && nothingRecent
      ? asksAboutLiveState(message.text)
      : null;
  if (
    liveState !== null &&
    !pasted &&
    // The line about where Captain is says how long they have been in it.
    !(liveState === PLAY_TIME && turn.onScreen.includes("(for ")) &&
    !declinesToSay(reply) &&
    !asksBack(reply)
  ) {
    falseClaim = true;
    debug(`answered about ${liveState} without looking`);
    if (turn.userWentOn()) {
      note("unchecked", UNCHECKED_NOTICE);
    } else {
      again(
        "unchecked",
        `Captain asked about ${liveState}, which only a tool can tell you, and you answered without calling one, so your answer was a guess. ` +
          LIVE_CORRECTION +
          callThis,
        true,
      );
    }
  }

  // "Let me check the server status for you." and nothing more, with no tool tried: she
  // stopped before doing it, and the user would wait for an answer that is not coming.
  // She is sent to do it.
  if (
    !turn.aborted() &&
    !falseClaim &&
    !message.event &&
    turn.steps === 0 &&
    !turn.refused &&
    onlySaysSheWill(reply)
  ) {
    falseClaim = true;
    debug(`said she would look and stopped: ${reply.slice(0, 70)}`);
    if (turn.userWentOn()) note("stopped", STOPPED_NOTICE);
    else again("stopped", STOPPED_CORRECTION + callThis, true);
  }

  // She said she had no way, and had been shown only some of her tools: the one for it
  // may be among the rest. One more go, with all of them.
  if (
    !turn.aborted() &&
    !falseClaim &&
    !message.event &&
    turn.offeredFewer &&
    turn.steps === 0 &&
    !turn.refused &&
    !turn.userWentOn() &&
    !pasted &&
    soundsLikeARequest(message.text) &&
    saysSheHasNoWay(reply)
  ) {
    falseClaim = true;
    debug("said she had no way: trying with every tool");
    again("no-way", MORE_TOOLS_CORRECTION, false);
  }

  // Her second attempt at a look that again looked at nothing: a plain notice.
  if (
    !turn.aborted() &&
    !falseClaim &&
    message.lookup === true &&
    turn.steps === 0 &&
    !declinesToSay(reply) &&
    !asksBack(reply)
  ) {
    falseClaim = true;
    const stopped = onlySaysSheWill(reply);
    note(stopped ? "stopped" : "looked", stopped ? STOPPED_NOTICE : GUESSED_NOTICE);
  }

  // Any sum she wrote out is worked out again by the calculator itself. A wrong figure
  // gets a note with the right one; this needs no second attempt from her.
  if (!turn.aborted() && !message.event) {
    const sums = sumsIn(reply);
    if (sums.wrong.length > 0) {
      note("wrong-sum", describeWrongSums(sums.wrong));
      falseClaim = true;
    } else if (
      // A sum worth a calculator, answered without one, and with no sum written out
      // that the calculator here could agree with ("1499かける0.85は1274.15よ"). A small
      // model's arithmetic is not to be relied on, so she is sent to the calculator,
      // once. Not when another do-over is already on its way.
      !falseClaim &&
      sums.right === 0 &&
      turn.steps === 0 &&
      !pasted &&
      turn.offered(TOOLS.calculate) &&
      !turn.userWentOn() &&
      asksForASum(message.text) &&
      /\d/.test(reply)
    ) {
      debug("did a sum without the calculator");
      // Not to be learned from as it stands: the figure has not been checked.
      falseClaim = true;
      again("sum", SUM_CORRECTION, false);
    }
  }
  return { followUps, falseClaim };
}
