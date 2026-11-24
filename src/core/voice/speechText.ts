import type { Gesture } from "../../shared/gestures.ts";
import type { ExpressiveCueFrame } from "../../shared/visemes.ts";

/**
 * Turns what the assistant wrote into what she should say: no markup, no code, nothing
 * that sounds wrong read aloud. Also cuts streamed text into sentences, so speech can
 * start before the reply is finished.
 */

const PROSODY_MARKER_RE = /\[(pause\s+\d+(?:ms|s)|sigh|whisper|emphasis|quiet)\]/gi;

/** Makes one piece of reply text speakable. Returns "" when nothing in it should be spoken. */
export function cleanForSpeech(text: string): string {
  return (
    text
      // Fenced code is never read out; inline code keeps its words.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[\[[a-z]{3,12}\]\]/gi, " ")
      .replace(PROSODY_MARKER_RE, " ")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " a link ")
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~|>#]/g, "")
      // File paths are noise aloud; keep the last part, which is usually the name that matters.
      .replace(/(?:~|\/)[\w.-]*(?:\/[\w.-]+)+/g, (path) => path.split("/").pop() ?? "")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export interface ProsodyPlan {
  speakText: string;
  gainScale: number;
  pausesMs: number[];
  gestureHints: Gesture[];
  cues: ExpressiveCueFrame[];
}

/**
 * Parses expressive vocal directives (`[pause 400ms]`, `[sigh]`, `[whisper]`, `[emphasis]`,
 * `[quiet]`, plus `lateNight` attenuation) into clean spoken text + synchronized avatar cues.
 */
export function parseProsodyScript(
  text: string,
  options: { lateNight?: boolean; baseDurationMs?: number } = {},
): ProsodyPlan {
  const pausesMs: number[] = [];
  const gestureSet = new Set<Gesture>();
  const cues: ExpressiveCueFrame[] = [];
  let gainScale = options.lateNight ? 0.55 : 1.0;

  const speakText = cleanForSpeech(text);
  const totalMs = Math.max(400, options.baseDurationMs ?? speakText.length * 55);

  let match: RegExpExecArray | null;
  const tagScanner = new RegExp(PROSODY_MARKER_RE.source, "gi");
  while ((match = tagScanner.exec(text)) !== null) {
    const token = (match[1] ?? "").toLowerCase().trim();
    const frac = text.length > 0 ? match.index / text.length : 0;
    const timeMs = Math.round(frac * totalMs);

    if (token.startsWith("pause")) {
      const msMatch = /(\d+)(ms|s)/i.exec(token);
      const rawVal = msMatch?.[1] ? Number.parseInt(msMatch[1], 10) : 350;
      const ms = msMatch?.[2]?.toLowerCase() === "s" ? rawVal * 1000 : rawVal;
      const clampedMs = Math.max(100, Math.min(2500, ms));
      pausesMs.push(clampedMs);
      cues.push({
        timeMs,
        durationMs: clampedMs,
        rmsEnergy: 0,
        pitchHz: 0,
        pitchNorm: 0,
        emphasis: 0,
        pause: true,
        laugh: 0,
        eyebrowRaise: 0.1,
        headTiltDeg: 3,
        nodDrive: 0,
        postureEnergy: 0.85,
      });
    } else if (token === "sigh") {
      gainScale = Math.min(gainScale, 0.72);
      gestureSet.add("perk");
      cues.push({
        timeMs,
        durationMs: 420,
        rmsEnergy: 0.04,
        pitchHz: 155,
        pitchNorm: 0.2,
        emphasis: 0.15,
        pause: false,
        laugh: 0,
        eyebrowRaise: 0.25,
        headTiltDeg: -6,
        nodDrive: 0.15,
        postureEnergy: 0.78,
      });
    } else if (token === "whisper" || token === "quiet") {
      gainScale = Math.min(gainScale, token === "whisper" ? 0.48 : 0.62);
      cues.push({
        timeMs,
        durationMs: 500,
        rmsEnergy: 0.025,
        pitchHz: 165,
        pitchNorm: 0.24,
        emphasis: 0.2,
        pause: false,
        laugh: 0,
        eyebrowRaise: 0.35,
        headTiltDeg: 5,
        nodDrive: 0.1,
        postureEnergy: 0.8,
      });
    } else if (token === "emphasis") {
      gestureSet.add("nod");
      cues.push({
        timeMs,
        durationMs: 320,
        rmsEnergy: 0.14,
        pitchHz: 255,
        pitchNorm: 0.52,
        emphasis: 0.9,
        pause: false,
        laugh: 0,
        eyebrowRaise: 0.75,
        headTiltDeg: 4,
        nodDrive: 0.72,
        postureEnergy: 1.28,
      });
    }
  }

  return {
    speakText,
    gainScale: Number(gainScale.toFixed(2)),
    pausesMs,
    gestureHints: [...gestureSet],
    cues,
  };
}

/** Abbreviations whose full stop does not end a sentence. */
const NOT_SENTENCE_END = /(?:\b(?:Mr|Mrs|Ms|Dr|vs|etc|e\.g|i\.e|approx|No)|\d)\.$/i;

/**
 * Collects streamed text and hands back whole sentences as they complete. A sentence
 * ends at . ! ? … or a line break, once the following character has arrived.
 */
export class SentenceSplitter {
  private pending = "";
  private insideCode = false;

  /** Adds text and returns the sentences that are now complete. */
  push(delta: string): string[] {
    this.pending += delta;
    const sentences: string[] = [];
    for (;;) {
      const cut = this.findBoundary();
      if (cut === -1) break;
      const sentence = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      this.collect(sentence, sentences);
    }
    return sentences;
  }

  /** Call at the end of the reply for whatever is left. */
  flush(): string[] {
    const sentences: string[] = [];
    this.collect(this.pending, sentences);
    this.pending = "";
    this.insideCode = false;
    return sentences;
  }

  private collect(raw: string, into: string[]): void {
    // Track code fences across sentences, so a block of code is skipped as a whole.
    const fences = raw.split("```").length - 1;
    const wasInside = this.insideCode;
    if (fences % 2 === 1) this.insideCode = !this.insideCode;
    if (wasInside && fences === 0) return;
    const speakable = cleanForSpeech(wasInside ? raw.slice(raw.indexOf("```") + 3) : raw);
    if (/[\p{L}\p{N}]/u.test(speakable)) into.push(speakable);
  }

  private findBoundary(): number {
    for (let i = 0; i < this.pending.length - 1; i++) {
      const char = this.pending[i] ?? "";
      const next = this.pending[i + 1] ?? "";
      if (char === "\n") return i + 1;
      // Full-width punctuation ends a sentence by itself; closing quotes after it belong to it.
      if ("。！？".includes(char)) {
        if ("」』”’）)".includes(next)) continue;
        return i + 1;
      }
      if ("」』”".includes(char) && "。！？".includes(this.pending[i - 1] ?? "")) return i + 1;
      if (!".!?…".includes(char) || !/\s/.test(next)) continue;
      if (char === "." && NOT_SENTENCE_END.test(this.pending.slice(0, i + 1))) continue;
      return i + 1;
    }
    return -1;
  }
}
