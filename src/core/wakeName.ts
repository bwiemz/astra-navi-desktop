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
  new RegExp(String.raw`^\s*${GREETING}astra(?:[\s,-]+navi)?\b[\s,.!?:;-]*`, "i"),
  /^\s*(?:ねえ|ねぇ|おーい)?[、,\s]*アストラ(?:\s*ナビ)?[、。！？!?,.\s]*/i,
  /^\s*(?:嘿|喂|哎)?[，,\s]*(?:阿斯特拉|星航)(?:领航员)?[，。！？!?,.\s]*/i,
];

/**
 * @param otherNames Extra names the user has chosen for her, matched as written.
 * @returns What was said after her name (possibly nothing, for a bare "Astra?"), or
 *   null when the sentence does not start with her name.
 */
export function afterWakeName(heard: string, otherNames: readonly string[] = []): string | null {
  const chosen = otherNames
    .map((name) => name.trim())
    .filter((name) => name.length >= 2)
    .map(
      (name) =>
        new RegExp(
          String.raw`^\s*${GREETING}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, String.raw`[\s-]*`)}${/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(name) ? "" : String.raw`(?![\p{L}\p{N}])`}[\s,.!?:;、。！？-]*`,
          "iu",
        ),
    );
  for (const form of [...NAME_FORMS, ...chosen]) {
    const match = form.exec(heard);
    if (match) return heard.slice(match[0].length).trim();
  }
  return null;
}
