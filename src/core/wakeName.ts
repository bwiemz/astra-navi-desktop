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
  "sir",
  "lady",
  "lord",
  "captain",
  "agent",
  "assistant",
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
 * character names (e.g. `"Lyra Vance"` -> `"Lyra"`), skipping short or stop-word prefixes
 * like `"The Navigator"` or `"Hey Jude"`.
 */
export function extractSafeLegacyFirstWordAlias(displayName: string | undefined): string | null {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed || BUILTIN_DEFAULT_NAMES.has(trimmed.toLowerCase())) return null;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const first = words[0] ?? "";
  if (first.length < 3) return null;
  const key = first.toLowerCase();
  if (BUILTIN_DEFAULT_NAMES.has(key) || LEGACY_FIRST_WORD_STOP_WORDS.has(key)) return null;
  return first;
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
  if (name.length === 1 && endsWithCjk) {
    // 1-character CJK wake names MUST be followed by a separator (comma/pause/space) or end of
    // utterance so words starting with that character (e.g. "星期" for "星") never misfire.
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
  const multiCharForms = aliases.filter((name) => name.length >= 2).map(buildAliasRegex);
  const singleCharCjkForms = aliases.filter((name) => name.length === 1).map(buildAliasRegex);
  // Order: multi-char custom aliases (longest first, e.g. "Astra-chan", "Lyra Vance") ->
  // built-in NAME_FORMS (so "星航，打开笔记" matches "星航" before 1-char "星") ->
  // 1-character CJK aliases (requiring a trailing separator).
  for (const form of [...multiCharForms, ...NAME_FORMS, ...singleCharCjkForms]) {
    const match = form.exec(heard);
    if (match) return heard.slice(match[0].length).trim();
  }
  return null;
}
