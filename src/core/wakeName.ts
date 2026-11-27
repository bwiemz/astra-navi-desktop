/**
 * Finding her name at the start of something that was said. With "only answer to her
 * name" switched on, speech that does not begin with it is not meant for her (the
 * television, someone else in the room) and is ignored.
 *
 * Matches Astra / Astra Navi (EN, JP, ZH) by default. Additional wake aliases can be
 * configured by the user via `otherNames`.
 */
const GREETING = String.raw`(?:(?:hey|hi|hello|ok|okay|yo)[\s,]+)?`;
const NAME_FORMS: readonly RegExp[] = [
  new RegExp(
    String.raw`^\s*${GREETING}(?:astra(?:[\s,-]*nav[iy])?|astro[\s,-]*nav[iy])\b[\s,.!?:;-]*`,
    "i",
  ),
  /^\s*(?:ねえ|ねぇ|おーい)?[、,\s]*アストラ(?:\s*ナビ)?[、。！？!?,.\s]*/i,
  /^\s*(?:嘿|喂|哎)?[，,\s]*(?:阿斯特拉|星航)(?:领航员)?[，。！？!?,.\s]*/i,
];

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const KANA_CHAR_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;
const LEGACY_PUNCTUATED_TITLE_RE = /^(?:dr|mr|mrs|ms|prof|st)\.$/i;

/** Common CJK conversational fillers/demonstratives that must always be followed by a pause/separator. */
const COMMON_CJK_FILLERS = new Set([
  "あの",
  "その",
  "この",
  "あれ",
  "それ",
  "これ",
  "ねえ",
  "ねぇ",
  "まあ",
  "でも",
  "じゃ",
  "では",
  "えっと",
  "那个",
  "这个",
  "然后",
  "就是",
  "其实",
  "已经",
  "因为",
  "所以",
]);

/** Common standalone words that can still cause false wakes even with word segmentation (warn in Settings). */
const AMBIGUOUS_WAKE_WORDS = new Set([
  ...COMMON_CJK_FILLERS,
  "天天",
  "明明",
  "好好",
  "看看",
  "大家",
  "今天",
  "明天",
  "昨天",
  "现在",
  "什么",
  "怎么",
  "可以",
  "真的",
  "但是",
  "如果",
  "ただ",
  "また",
  "いま",
  "ここ",
  "そこ",
  "あそこ",
]);

let cachedJaSegmenter: Intl.Segmenter | null | undefined;
let cachedZhSegmenter: Intl.Segmenter | null | undefined;

function getCjkSegmenter(locale: "ja" | "zh"): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  if (locale === "ja") {
    if (cachedJaSegmenter === undefined) {
      cachedJaSegmenter = new Intl.Segmenter("ja", { granularity: "word" });
    }
    return cachedJaSegmenter;
  }
  if (cachedZhSegmenter === undefined) {
    cachedZhSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
  }
  return cachedZhSegmenter;
}

/**
 * Checks that a CJK wake alias ends on an `Intl.Segmenter` word boundary so prefixes of
 * ordinary words (`アスファルト`, `リラックス`, `明明是`) never falsely wake, while real
 * commands without punctuation (`小星打开笔记`, `小星提醒我`, `リラノートを開いて`) match cleanly.
 */
function endsOnCjkWordBoundary(sliceFromAlias: string, aliasLen: number, alias: string): boolean {
  const sample = sliceFromAlias.slice(0, Math.min(sliceFromAlias.length, aliasLen + 16));
  const locale: "ja" | "zh" = KANA_CHAR_RE.test(alias) || KANA_CHAR_RE.test(sample) ? "ja" : "zh";
  const segmenter = getCjkSegmenter(locale);
  if (!segmenter) return false;
  for (const seg of segmenter.segment(sample)) {
    const end = seg.index + seg.segment.length;
    if (end === aliasLen) return true;
    if (end > aliasLen) return false;
  }
  return false;
}
const BUILTIN_DEFAULT_NAMES = new Set([
  "astra",
  "astra navi",
  "astra-navi",
  "astro navi",
  "astro-navi",
  "アストラ",
  "アストラナビ",
  "阿斯特拉",
  "星航",
]);
const LEGACY_FIRST_WORD_STOP_WORDS = new Set([
  "the",
  "hey",
  "hi",
  "hello",
  "ok",
  "okay",
  "yo",
  "my",
  "our",
  "your",
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "prof",
  "sir",
  "lady",
  "lord",
  "saint",
  "st",
  "captain",
  "commander",
  "agent",
  "assistant",
  "ai",
  "bot",
  "little",
  "big",
  "new",
  "old",
  "dear",
  "good",
  "this",
  "that",
]);

/** True when a wake alias is long enough to match safely (≥2 chars, or ≥1 CJK character). */
export function isValidWakeAlias(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) return true;
  return trimmed.length === 1 && CJK_CHAR_RE.test(trimmed);
}

/**
 * Extracts a safe first-word alias for one-time migration of existing multi-word custom
 * character names (e.g. `"Lyra Vance"` -> `"Lyra"`), skipping punctuated titles (`"Mr."`,
 * `"Dr."`), short prefixes, or stop-words like `"The Navigator"` or `"Hey Jude"`.
 */
export function extractSafeLegacyFirstWordAlias(displayName: string | undefined): string | null {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed || BUILTIN_DEFAULT_NAMES.has(trimmed.toLowerCase())) return null;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const rawFirst = words[0] ?? "";
  // Strip surrounding punctuation so "Mr." -> "Mr", "Dr." -> "Dr", "(The)" -> "The".
  const cleaned = rawFirst.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (cleaned.length < 3) return null;
  const key = cleaned.toLowerCase();
  if (BUILTIN_DEFAULT_NAMES.has(key) || LEGACY_FIRST_WORD_STOP_WORDS.has(key)) return null;
  return cleaned;
}

/** Builds wake-name candidates from an active custom character name plus user-configured aliases. */
export function wakeAliasesWithCharacter(
  otherNames: readonly string[] = [],
  characterName?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | undefined): void => {
    const trimmed = (raw ?? "").trim();
    if (!isValidWakeAlias(trimmed)) return;
    const key = trimmed.toLowerCase();
    // Skip duplicating built-in Astra/Astra Navi forms ahead of NAME_FORMS, which already match
    // the longer "Astra Navi" form before bare "Astra".
    if (BUILTIN_DEFAULT_NAMES.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  // Never synthesize an automatic first-word alias (e.g. "The Navigator" -> "The" or
  // "Hey Jude" -> "Hey"), which triggers on normal speech; users can add short aliases in otherNames.
  push(characterName);
  for (const name of otherNames) push(name);
  // Match longer/more specific aliases first so "Lyra Vance" takes precedence over "Lyra".
  out.sort((a, b) => b.length - a.length);
  return out;
}

/**
 * One-time cleanup for malformed auto-migrated wake aliases from earlier releases
 * (e.g. `"Dr."`, `"Mr."`, or trailing commas like `"Lyra,"` -> `"Lyra"`).
 * Preserves Unicode combining marks (`\p{M}` — Hindi `"प्रिया"`, Thai `"มะลิ"`,
 * Vietnamese `"Hà"`), symbols (`"C++"`), and non-title initials (`"K."`).
 */
export function sanitizeLegacyWakeAliases(otherNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of otherNames) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Drop only the punctuated English title tokens produced by the legacy whitespace split.
    if (LEGACY_PUNCTUATED_TITLE_RE.test(trimmed)) continue;
    // Strip only leading/trailing ASCII list punctuation (never `\p{M}`, `+`, or `.` on `"K."`).
    const cleaned = trimmed.replace(/^[,;:!?]+|[,;:!?]+$/g, "").trim();
    if (!isValidWakeAlias(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/**
 * Returns non-blocking Settings warnings for wake aliases that are common standalone words
 * (e.g. `"天天"`, `"あの"`, `"the"`) or single-character CJK names requiring a pause.
 */
export function wakeAliasWarnings(
  otherNames: readonly string[] = [],
  characterName?: string,
): string[] {
  const aliases = wakeAliasesWithCharacter(otherNames, characterName);
  const warnings: string[] = [];
  for (const alias of aliases) {
    const lower = alias.toLowerCase();
    if (CJK_CHAR_RE.test(alias) && alias.length === 1) {
      warnings.push(
        `“${alias}” is a single CJK character and only wakes when followed by a pause or punctuation.`,
      );
    } else if (AMBIGUOUS_WAKE_WORDS.has(alias) || LEGACY_FIRST_WORD_STOP_WORDS.has(lower)) {
      warnings.push(
        `“${alias}” is also an ordinary word and may trigger false wakes — consider a more distinct name or pause after it.`,
      );
    }
  }
  return warnings;
}

interface CompiledAlias {
  name: string;
  endsWithCjk: boolean;
  regex: RegExp;
}

function compileAlias(name: string): CompiledAlias {
  const escaped = name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, String.raw`[\s-]*`);
  const endsWithCjk = CJK_CHAR_RE.test(name.slice(-1));
  return {
    name,
    endsWithCjk,
    regex: new RegExp(
      String.raw`^\s*${GREETING}(${escaped})([\s,.!?:;、。！？，-]*)`,
      "iu",
    ),
  };
}

/**
 * @param otherNames Extra names the user has chosen for her, matched as written.
 * @param characterName Optional active custom character display name (e.g. from Settings or an imported card/bundle).
 * @returns What was said after her name (possibly nothing, for a bare "Astra?"), or
 *   null when the sentence does not start with her name.
 */
export function afterWakeName(
  heard: string,
  otherNames: readonly string[] = [],
  characterName?: string,
): string | null {
  const aliases = wakeAliasesWithCharacter(otherNames, characterName);
  const compiledAliases = aliases.map(compileAlias);

  // Pick the LONGEST actual match in the utterance (breaking ties in favor of built-in NAME_FORMS)
  // so aliases like "Hey Astra" can never cut "Hey Astra Navi, open notes" and short CJK aliases
  // ("星", "阿斯", "アス") can never hijack "星航", "阿斯特拉", or "アストラ".
  let bestLen = -1;
  let bestIsBuiltin = false;

  for (const form of NAME_FORMS) {
    const match = form.exec(heard);
    if (match && match[0].length > bestLen) {
      bestLen = match[0].length;
      bestIsBuiltin = true;
    }
  }
  for (const { name, endsWithCjk, regex } of compiledAliases) {
    const match = regex.exec(heard);
    if (!match) continue;
    const matchedAlias = match[1] ?? "";
    const sep = match[2] ?? "";
    const len = match[0].length;
    const aliasEnd = len - sep.length;
    const aliasStart = aliasEnd - matchedAlias.length;
    const nextCp = heard.codePointAt(aliasEnd);
    const nextChar = nextCp === undefined ? "" : String.fromCodePoint(nextCp);

    if (endsWithCjk) {
      if (name.length === 1 || COMMON_CJK_FILLERS.has(name)) {
        // 1-char CJK aliases ("星") and common CJK fillers ("あの") always require a separator or end.
        if (sep.length === 0 && aliasEnd < heard.length) continue;
      } else if (sep.length === 0 && aliasEnd < heard.length && CJK_CHAR_RE.test(nextChar)) {
        // Multi-char CJK aliases followed directly by CJK require an `Intl.Segmenter` word boundary.
        if (!endsOnCjkWordBoundary(heard.slice(aliasStart), matchedAlias.length, name)) {
          continue;
        }
      }
    } else if (sep.length === 0 && aliasEnd < heard.length && WORD_CHAR_RE.test(nextChar)) {
      // Non-CJK aliases must not cut inside a word (respecting letters, digits, AND combining marks).
      continue;
    }

    if (len > bestLen || (len === bestLen && !bestIsBuiltin)) {
      bestLen = len;
      bestIsBuiltin = false;
    }
  }

  return bestLen >= 0 ? heard.slice(bestLen).trim() : null;
}
