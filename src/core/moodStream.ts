import { MOODS, type Mood } from "../shared/ipc.ts";
import type { ParalinguisticCue, PostureHint } from "./multimodal.ts";

const MOOD_SET: ReadonlySet<string> = new Set(MOODS);
const INVENTED_MOOD = /^[a-z]{3,14}$/;
/** Moods a model may make up, mapped to the nearest face she actually has. */
const MOOD_ALIASES: Record<string, Mood> = {
  curious: "thinking",
  confused: "thinking",
  focused: "thinking",
  serious: "thinking",
  cheerful: "happy",
  pleased: "happy",
  proud: "smug",
  playful: "smug",
  teasing: "smug",
  shocked: "surprised",
  concerned: "worried",
  nervous: "worried",
  sorry: "sad",
  apologetic: "sad",
  disappointed: "sad",
  angry: "worried",
  determined: "excited",
};
/** The longest word taken for a mood she made up ("[[disappointed]]"). */
const MAX_INVENTED_MOOD = 14;
/**
 * Longest text that could still turn out to be a mood tag: the brackets, the longest
 * name that would be accepted, and a space either side of it.
 */
const MAX_TAG_LENGTH = Math.max(MAX_INVENTED_MOOD, ...MOODS.map((m) => m.length)) + 6;

/**
 * How a model starts writing out a tool call as plain text. That happens when it wants a
 * tool in a turn where it has none (telling an event); nothing from there on is for the user.
 */
const TOOL_MARKUP = ["<tool_call", "<function="] as const;

/** Ends a stretch of thinking. Seen in a reply, it means the words before it were thoughts. */
const THOUGHT_END = "</think>";
const THOUGHT_START = "<think>";
/**
 * After a tool call a small model sometimes goes on thinking in the open and only then
 * writes the mark that ends its thoughts. Those words cannot be taken back once shown
 * or spoken, so the start of what follows a tool call is kept back until it is this
 * long, or ends, without the mark turning up.
 */
const THOUGHT_WATCH_CHARS = 600;

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MoodStreamOptions {
  /**
   * How the app's own lines beside a message begin ("[ship's clock]"). A model copies
   * the shape of what it is given, so it sometimes ends its reply with such a line of
   * its own. A line of hers that starts this way is not shown.
   */
  sideMarks?: readonly string[];
}

export interface MoodStreamSink {
  text(delta: string): void;
  mood(mood: Mood): void;
  posture?(hint: PostureHint): void;
}

/**
 * The assistant marks its expression inline with tags like `[[happy]]`. This pulls
 * those tags out of streamed text, which can split a tag across any two chunks.
 */
export class MoodStream {
  private readonly sink: MoodStreamSink;
  private held = "";
  private emittedAnything = false;
  /** Text that might be the start of tool markup, kept back until it is clear which. */
  private unsure = "";
  /** Tool markup has started: the rest of this reply is not shown. */
  private muted = false;
  /**
   * Set for a reply written without tools. Only there can tool markup turn up as text;
   * in an ordinary reply the same characters may be her explaining how tool calls look.
   */
  hideToolMarkup = false;
  /** What follows a tool call is being kept back in case it turns out to be thinking. */
  private watching = false;
  private watched = "";
  /** A thought was just dropped and nothing of the reply proper has followed it yet. */
  private afterThought = false;
  /** Matches one of the app's own marks at the start of a line, with what may come before it. */
  private readonly sideLine: RegExp | null;
  private readonly longestSideMark: number;
  /** The start of a line, kept back until it is clear whether it is one of the app's lines. */
  private lineStart = "";
  private atLineStart = true;
  /** The rest of the line being written is one of the app's own and is dropped. */
  private droppingLine = false;

  constructor(sink: MoodStreamSink, options: MoodStreamOptions = {}) {
    this.sink = sink;
    const marks = (options.sideMarks ?? []).filter((mark) => mark.length > 0);
    // "[[ship's clock]]" and "**[ship's clock]**" are the same slip in other clothes.
    this.sideLine =
      marks.length > 0
        ? new RegExp(`^[ \\t*_>-]*\\[?(?:${marks.map(escapeForPattern).join("|")})`, "i")
        : null;
    this.longestSideMark = Math.max(0, ...marks.map((mark) => mark.length)) + 8;
  }

  /** Emits native S2S paralinguistic mood & posture cues directly to stage sinks. */
  pushParalinguistic(cue: ParalinguisticCue): void {
    this.sink.mood(cue.mood);
    this.sink.posture?.(cue.posture);
  }

  /**
   * Call when a tool is about to run. What she has written so far is let go, and the
   * start of what she writes next is watched for thinking that slipped out.
   */
  afterTool(): void {
    this.drain(true);
    this.releaseWatched();
    this.watching = true;
  }

  push(delta: string): void {
    this.held += delta;
    this.drain(false);
  }

  /** Call at the end of a reply: releases anything held back and resets for the next one. */
  flush(): void {
    this.drain(true);
    if (!this.muted) this.send(this.unsure);
    this.releaseWatched();
    this.endLine();
    this.held = "";
    this.unsure = "";
    this.muted = false;
    this.emittedAnything = false;
    this.atLineStart = true;
    this.droppingLine = false;
    this.afterThought = false;
  }

  private emit(text: string): void {
    if (!this.hideToolMarkup) {
      this.send(text);
      return;
    }
    if (this.muted) return;
    const pending = this.unsure + text;
    const starts = TOOL_MARKUP.map((mark) => pending.indexOf(mark)).filter((at) => at !== -1);
    if (starts.length > 0) {
      this.muted = true;
      this.unsure = "";
      this.send(pending.slice(0, Math.min(...starts)).trimEnd());
      return;
    }
    // Keep back an ending that could still grow into markup ("<tool" at a chunk boundary).
    let keep = 0;
    for (const mark of TOOL_MARKUP) {
      for (let size = Math.min(mark.length - 1, pending.length); size > keep; size--) {
        if (mark.startsWith(pending.slice(-size))) keep = size;
      }
    }
    this.unsure = pending.slice(pending.length - keep);
    this.send(pending.slice(0, pending.length - keep));
  }

  /** Thinking that slipped out is caught here, before any of it is shown. */
  private send(text: string): void {
    if (!this.watching) {
      // Too late to take back what came before; at least the mark itself is not shown.
      let plain = text.replaceAll(THOUGHT_END, "").replaceAll(THOUGHT_START, "");
      if (this.afterThought) {
        // The blank lines that followed the dropped thought belong to it.
        plain = plain.replace(/^\s+/, "");
        if (plain.length > 0) this.afterThought = false;
      }
      this.screen(plain);
      return;
    }
    this.watched += text;
    const end = this.watched.lastIndexOf(THOUGHT_END);
    if (end !== -1) {
      // Everything up to the mark was thought. What follows is the reply proper.
      const rest = this.watched.slice(end + THOUGHT_END.length).replace(/^\s+/, "");
      this.watched = "";
      this.watching = false;
      this.afterThought = rest.length === 0;
      this.screen(rest);
      return;
    }
    if (this.watched.length >= THOUGHT_WATCH_CHARS) this.releaseWatched();
  }

  private releaseWatched(): void {
    const text = this.watched.replaceAll(THOUGHT_START, "");
    this.watched = "";
    this.watching = false;
    this.screen(text);
  }

  /** Drops whole lines that imitate the app's own lines beside a message. */
  private screen(text: string): void {
    if (this.sideLine === null) {
      this.deliver(text);
      return;
    }
    let rest = text;
    while (rest.length > 0) {
      if (this.droppingLine) {
        const end = rest.indexOf("\n");
        if (end === -1) return;
        this.droppingLine = false;
        this.atLineStart = true;
        rest = rest.slice(end + 1);
        continue;
      }
      if (!this.atLineStart) {
        const end = rest.indexOf("\n");
        if (end === -1) {
          this.deliver(rest);
          return;
        }
        this.deliver(rest.slice(0, end + 1));
        this.atLineStart = true;
        rest = rest.slice(end + 1);
        continue;
      }
      // At the start of a line: wait until there is enough of it to tell.
      this.lineStart += rest;
      rest = "";
      const end = this.lineStart.indexOf("\n");
      const line = end === -1 ? this.lineStart : this.lineStart.slice(0, end);
      if (this.sideLine.test(line)) {
        this.droppingLine = end === -1;
        rest = end === -1 ? "" : this.lineStart.slice(end + 1);
        this.lineStart = "";
      } else if (
        end !== -1 ||
        line.length >= this.longestSideMark ||
        // One of the app's lines starts with a bracket; anything else is hers already.
        /^[ \t*_>-]*[^ \t*_>[-]/.test(line)
      ) {
        const start = this.lineStart;
        this.lineStart = "";
        if (end === -1) {
          this.atLineStart = false;
          this.deliver(start);
        } else {
          this.deliver(start.slice(0, end + 1));
          rest = start.slice(end + 1);
        }
      }
    }
  }

  /** The reply is over: a line start still being held is ordinary text unless it is a mark. */
  private endLine(): void {
    const start = this.lineStart;
    this.lineStart = "";
    if (start.length > 0 && !this.sideLine?.test(start)) this.deliver(start);
  }

  private deliver(text: string): void {
    let out = text;
    if (!this.emittedAnything) out = out.replace(/^\s+/, "");
    if (out.length === 0) return;
    this.emittedAnything = true;
    this.sink.text(out);
  }

  private drain(final: boolean): void {
    for (;;) {
      const open = this.held.indexOf("[[");
      if (open === -1) {
        // A lone "[" at the very end may be the first half of "[[".
        const keep = !final && this.held.endsWith("[") ? 1 : 0;
        this.emit(this.held.slice(0, this.held.length - keep));
        this.held = this.held.slice(this.held.length - keep);
        return;
      }

      this.emit(this.held.slice(0, open));
      this.held = this.held.slice(open);

      const close = this.held.indexOf("]]");
      if (close === -1) {
        if (!final && this.held.length < MAX_TAG_LENGTH) return; // wait for the rest of the tag
        // Too long to be a tag (or the reply ended): it is ordinary text.
        this.emit("[[");
        this.held = this.held.slice(2);
        continue;
      }

      const name = this.held.slice(2, close).trim().toLowerCase();
      // A small model sometimes invents a mood ("[[curious]]"). At the start of a reply any
      // single word in double brackets is meant as a mood, so it is dropped, not shown.
      const invented = !this.emittedAnything && INVENTED_MOOD.test(name);
      if (MOOD_SET.has(name) || invented) {
        this.sink.mood(
          MOOD_SET.has(name)
            ? (name as Mood)
            : Object.hasOwn(MOOD_ALIASES, name)
              ? (MOOD_ALIASES[name] ?? "neutral")
              : "neutral",
        );
        // Drop the tag and the single space or newline that usually follows it.
        this.held = this.held.slice(close + 2).replace(/^[ \t]?\r?\n?/, "");
      } else {
        this.emit(this.held.slice(0, close + 2));
        this.held = this.held.slice(close + 2);
      }
    }
  }
}
