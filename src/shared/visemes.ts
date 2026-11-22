/**
 * Phoneme-to-Viseme alignment & co-articulation curves (Tier 10 §7.2).
 *
 * Shared across Node (`core/voice`) and browser (`renderer/stage.ts`) with zero
 * platform-specific dependencies.
 */

export type VowelViseme = "A" | "I" | "U" | "E" | "O";
export type VisemeKey = VowelViseme | "closed";

export interface VisemeFrame {
  timeMs: number;
  durationMs: number;
  viseme: VisemeKey;
  weight: number;
}

export type VisemeWeights = Record<VowelViseme, number>;

export const VISEME_MORPH_CANDIDATES: Record<VowelViseme, readonly string[]> = {
  A: ["あ", "a", "A"],
  I: ["い", "i", "I"],
  U: ["う", "u", "U"],
  E: ["え", "e", "E"],
  O: ["お", "o", "O"],
};

const KANA_A = /^[あかさたなはまやらわがざだばぱぁゃアカサタナハマヤラワガザダバパァャ]$/;
const KANA_I = /^[いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ]$/;
const KANA_U = /^[うくすつぬふむゆるぐずづぶぷぅゅウクスツヌフムユルグズヅブプゥュヴ]$/;
const KANA_E = /^[えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェ]$/;
const KANA_O = /^[おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョ]$/;
const KANA_CLOSED = /^[んっンッ]$/;
const CJK_CHAR = /\p{Script=Han}/u;
const CJK_CYCLE: readonly VowelViseme[] = ["A", "O", "I", "E", "U"];
const PUNCT_PAUSE = /^[.,!?;:、。！？…]$/;
const EN_BILABIAL = /^[mbpfv]$/;

interface RawSegment {
  viseme: VisemeKey;
  rawDuration: number;
  weight: number;
}

function emptyWeights(): VisemeWeights {
  return { A: 0, I: 0, U: 0, E: 0, O: 0 };
}

function kanaViseme(ch: string, lastVowel: VowelViseme): { viseme: VisemeKey; weight: number } {
  if (ch === "ー") return { viseme: lastVowel, weight: 0.75 };
  if (KANA_CLOSED.test(ch)) return { viseme: "closed", weight: 0 };
  if (KANA_A.test(ch)) return { viseme: "A", weight: 0.88 };
  if (KANA_I.test(ch)) return { viseme: "I", weight: 0.78 };
  if (KANA_U.test(ch)) return { viseme: "U", weight: 0.76 };
  if (KANA_E.test(ch)) return { viseme: "E", weight: 0.82 };
  if (KANA_O.test(ch)) return { viseme: "O", weight: 0.86 };
  return { viseme: "A", weight: 0.6 };
}

/**
 * Generates a time-aligned viseme sequence spanning `totalDurationMs` for a spoken sentence.
 */
export function textToVisemes(
  text: string,
  totalDurationMs: number,
  language?: string,
): VisemeFrame[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || !Number.isFinite(totalDurationMs) || totalDurationMs <= 0) return [];

  const chars = [...clean];
  const raw: RawSegment[] = [];
  let lastVowel: VowelViseme = "A";
  let cjkIndex = 0;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    const next = chars[i + 1] ?? "";
    const lower = ch.toLowerCase();
    const pair = lower + next.toLowerCase();

    if (ch === " ") {
      raw.push({ viseme: "closed", rawDuration: 0.5, weight: 0 });
      continue;
    }
    if (PUNCT_PAUSE.test(ch)) {
      raw.push({ viseme: "closed", rawDuration: 1.8, weight: 0 });
      continue;
    }

    if (
      KANA_A.test(ch) ||
      KANA_I.test(ch) ||
      KANA_U.test(ch) ||
      KANA_E.test(ch) ||
      KANA_O.test(ch) ||
      KANA_CLOSED.test(ch) ||
      ch === "ー"
    ) {
      const hit = kanaViseme(ch, lastVowel);
      if (hit.viseme !== "closed") lastVowel = hit.viseme;
      raw.push({ viseme: hit.viseme, rawDuration: ch === "ー" ? 1.1 : 1.0, weight: hit.weight });
      continue;
    }

    if (CJK_CHAR.test(ch)) {
      const v = CJK_CYCLE[cjkIndex % CJK_CYCLE.length] ?? "A";
      cjkIndex += 1;
      lastVowel = v;
      raw.push({ viseme: v, rawDuration: language === "zh" ? 1.2 : 1.1, weight: 0.72 });
      continue;
    }

    // English digraphs
    if (pair === "oo" || pair === "ou" || pair === "ow") {
      const v: VowelViseme = pair === "ow" ? "O" : "U";
      lastVowel = v;
      raw.push({ viseme: v, rawDuration: 1.3, weight: 0.84 });
      i += 1;
      continue;
    }
    if (pair === "ee" || pair === "ea") {
      lastVowel = "I";
      raw.push({ viseme: "I", rawDuration: 1.25, weight: 0.8 });
      i += 1;
      continue;
    }
    if (pair === "ai" || pair === "ay") {
      lastVowel = "E";
      raw.push({ viseme: "E", rawDuration: 1.25, weight: 0.82 });
      i += 1;
      continue;
    }

    if (lower === "a") {
      lastVowel = "A";
      raw.push({ viseme: "A", rawDuration: 1.05, weight: 0.88 });
    } else if (lower === "i" || lower === "y") {
      lastVowel = "I";
      raw.push({ viseme: "I", rawDuration: 0.95, weight: 0.78 });
    } else if (lower === "u") {
      lastVowel = "U";
      raw.push({ viseme: "U", rawDuration: 1.0, weight: 0.78 });
    } else if (lower === "e") {
      lastVowel = "E";
      raw.push({ viseme: "E", rawDuration: 0.95, weight: 0.8 });
    } else if (lower === "o") {
      lastVowel = "O";
      raw.push({ viseme: "O", rawDuration: 1.05, weight: 0.86 });
    } else if (EN_BILABIAL.test(lower)) {
      raw.push({ viseme: "closed", rawDuration: 0.48, weight: 0 });
    } else if (/[a-z0-9]/.test(lower)) {
      const semi = lower === "w" ? "U" : lower === "r" ? "O" : lastVowel;
      raw.push({
        viseme: semi,
        rawDuration: 0.42,
        weight: lower === "w" || lower === "r" ? 0.38 : 0.22,
      });
    }
  }

  // Collapse consecutive closed segments so whitespace/punctuation combine cleanly.
  const merged: RawSegment[] = [];
  for (const seg of raw) {
    const prev = merged.at(-1);
    if (prev && prev.viseme === "closed" && seg.viseme === "closed") {
      prev.rawDuration += seg.rawDuration;
    } else {
      merged.push({ ...seg });
    }
  }

  const totalUnits = merged.reduce((sum, seg) => sum + seg.rawDuration, 0);
  if (totalUnits <= 0) return [];

  const frames: VisemeFrame[] = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i += 1) {
    const seg = merged[i];
    if (!seg) continue;
    const isLast = i === merged.length - 1;
    const dur = isLast
      ? Math.max(1, totalDurationMs - cursor)
      : (seg.rawDuration / totalUnits) * totalDurationMs;
    frames.push({
      timeMs: cursor,
      durationMs: dur,
      viseme: seg.viseme,
      weight: seg.weight,
    });
    cursor += dur;
  }
  return frames;
}

/**
 * Evaluates smooth co-articulated vowel morph weights at playback time `elapsedMs`.
 */
export function sampleVisemeWeights(
  frames: readonly VisemeFrame[],
  elapsedMs: number,
): VisemeWeights {
  const out = emptyWeights();
  if (frames.length === 0 || elapsedMs < 0) return out;
  const last = frames[frames.length - 1];
  if (!last || elapsedMs > last.timeMs + last.durationMs + 45) return out;

  let closureFactor = 1;
  for (const frame of frames) {
    const start = frame.timeMs;
    const end = frame.timeMs + frame.durationMs;
    const coart = Math.min(35, Math.max(8, frame.durationMs * 0.45));
    if (elapsedMs < start - coart || elapsedMs > end + coart) continue;

    let env: number;
    if (elapsedMs < start) {
      const p = (elapsedMs - (start - coart)) / coart;
      env = 0.5 - 0.5 * Math.cos(p * Math.PI);
    } else if (elapsedMs > end) {
      const p = (elapsedMs - end) / coart;
      env = 0.5 + 0.5 * Math.cos(p * Math.PI);
    } else {
      const within = (elapsedMs - start) / Math.max(1, frame.durationMs);
      env = 0.72 + 0.28 * Math.sin(within * Math.PI);
    }

    if (frame.viseme === "closed") {
      if (elapsedMs >= start && elapsedMs <= end) {
        closureFactor = Math.min(closureFactor, 0.15);
      } else {
        closureFactor = Math.min(closureFactor, Math.max(0.25, 1 - 0.65 * env));
      }
      continue;
    }

    const contrib = Math.max(0, Math.min(1, frame.weight * env));
    if (contrib > out[frame.viseme]) {
      out[frame.viseme] = contrib;
    }
  }

  out.A *= closureFactor;
  out.I *= closureFactor;
  out.U *= closureFactor;
  out.E *= closureFactor;
  out.O *= closureFactor;
  return out;
}

/**
 * Estimates which prefix of `text` was heard before playback stopped at `elapsedMs`.
 */
export function estimateSpokenOffset(
  text: string,
  elapsedMs: number,
  durationMs: number,
): { heardText: string; spokenWordOffset: number; ratio: number } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { heardText: "", spokenWordOffset: 0, ratio: 0 };

  const ratio =
    durationMs <= 0 ? (elapsedMs > 0 ? 1 : 0) : Math.max(0, Math.min(1, elapsedMs / durationMs));
  if (ratio <= 0) return { heardText: "", spokenWordOffset: 0, ratio: 0 };

  if (!clean.includes(" ")) {
    const chars = [...clean];
    const count = ratio >= 1 ? chars.length : Math.max(1, Math.round(chars.length * ratio));
    return {
      heardText: chars.slice(0, count).join(""),
      spokenWordOffset: count,
      ratio,
    };
  }

  const words = clean.split(" ");
  if (ratio >= 1) {
    return { heardText: clean, spokenWordOffset: words.length, ratio: 1 };
  }
  const targetChars = clean.length * ratio;
  let consumed = 0;
  let wordCount = 0;
  for (const word of words) {
    if (wordCount > 0 && consumed + 1 > targetChars) break;
    consumed += (wordCount > 0 ? 1 : 0) + word.length;
    wordCount += 1;
    if (consumed >= targetChars) break;
  }
  return {
    heardText: words.slice(0, wordCount).join(" "),
    spokenWordOffset: wordCount,
    ratio,
  };
}
