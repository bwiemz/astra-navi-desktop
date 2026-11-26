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

/** Builds wake-name candidates from an active custom character name plus user-configured aliases. */
export function wakeAliasesWithCharacter(
  otherNames: readonly string[] = [],
  characterName?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | undefined): void => {
    const trimmed = (raw ?? "").trim();
    if (trimmed.length < 2) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  const custom = (characterName ?? "").trim();
  if (custom && custom.toLowerCase() !== "astra" && custom.toLowerCase() !== "astra navi") {
    push(custom);
    // Also recognize the first word of a multi-word character name (e.g. "Lyra Vance" -> "Lyra").
    const firstWord = custom.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 2 && firstWord.toLowerCase() !== custom.toLowerCase()) {
      push(firstWord);
    }
  }
  for (const name of otherNames) push(name);
  return out;
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
  const chosen = aliases.map(
    (name) =>
      new RegExp(
        String.raw`^\s*${GREETING}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, String.raw`[\s-]*`)}${/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(name) ? "" : String.raw`(?![\p{L}\p{N}])`}[\s,.!?:;、。！？-]*`,
        "iu",
      ),
  );
  // Check explicit character name + user aliases first (longest/most specific), then default Astra forms.
  for (const form of [...chosen, ...NAME_FORMS]) {
    const match = form.exec(heard);
    if (match) return heard.slice(match[0].length).trim();
  }
  return null;
}
