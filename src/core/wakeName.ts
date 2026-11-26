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

function buildAliasRegex(name: string): RegExp {
  const escaped = name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, String.raw`[\s-]*`);
  const endsWithCjk = CJK_CHAR_RE.test(name.slice(-1));
  if (endsWithCjk && name.length <= 2) {
    // 1- and 2-character CJK wake aliases (e.g. "星", "阿斯", "アス") MUST be followed by a
    // separator (comma/pause/space) or end of utterance so longer built-in names ("星航",
    // "阿斯特拉", "アストラ") and ordinary words ("星期", "アスファルト") never get hijacked.
    return new RegExp(
      String.raw`^\s*${GREETING}${escaped}(?:[\s,.!?:;、。！？，-]+|$)`,
      "iu",
    );
  }
  return new RegExp(
    String.raw`^\s*${GREETING}${escaped}${endsWithCjk ? "" : String.raw`(?![\p{L}\p{N}])`}[\s,.!?:;、。！？，-]*`,
    "iu",
  );
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
  const aliasForms = aliases.map(buildAliasRegex);

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
  for (const form of aliasForms) {
    const match = form.exec(heard);
    if (!match) continue;
    const len = match[0].length;
    if (len > bestLen || (len === bestLen && !bestIsBuiltin)) {
      bestLen = len;
      bestIsBuiltin = false;
    }
  }

  return bestLen >= 0 ? heard.slice(bestLen).trim() : null;
}
