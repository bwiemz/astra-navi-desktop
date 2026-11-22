/**
 * Turns what the assistant wrote into what she should say: no markup, no code, nothing
 * that sounds wrong read aloud. Also cuts streamed text into sentences, so speech can
 * start before the reply is finished.
 */

/** Makes one piece of reply text speakable. Returns "" when nothing in it should be spoken. */
export function cleanForSpeech(text: string): string {
  return (
    text
      // Fenced code is never read out; inline code keeps its words.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[\[[a-z]{3,12}\]\]/gi, " ")
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
