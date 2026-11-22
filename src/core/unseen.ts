/**
 * Characters that draw nothing, or redraw what is beside them.
 *
 * Text that reaches her or the user from outside (a notification, a program's name, a
 * calendar entry, what a check printed) is cleaned of these before it is shown or
 * handed on. They are how a line is made to read one way to a person and another way
 * to a program: an instruction written in letters nobody can see, or a file name that
 * displays backwards. Named by kind rather than listed one by one, so that the next
 * invisible character Unicode adds is covered too:
 *
 * - control characters, and format characters (zero-width spaces and joiners, the
 *   direction marks and overrides, the "tag" letters that mirror ASCII invisibly);
 * - the line and paragraph separators, and halves of a character pair left on their own;
 * - variation selectors, the combining grapheme joiner, the Hangul fillers, the blank
 *   Braille cell, two Khmer vowels and the object placeholder, which are letters or
 *   symbols by classification and blank on the page.
 */
const UNSEEN =
  // eslint-disable-next-line no-misleading-character-class -- each is matched on its own, on purpose
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Variation_Selector}\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0\ufffc]/gu;

/**
 * The few of those that ordinary writing needs: the joiners that make one emoji out of
 * several and shape Persian and Indic words, and the selectors that choose how a
 * character is drawn. In text the user wrote themselves they are kept where they sit
 * between two characters that show.
 */
const NEEDED_BETWEEN = /[\u200c\u200d\p{Variation_Selector}]/u;
/** More accents stacked on one letter than any language writes. */
const STACKED = /(\p{M}{3})\p{M}+/gu;

/** True when the text holds any character that does not show. Newlines and tabs count. */
export function hasUnseen(text: string): boolean {
  UNSEEN.lastIndex = 0;
  return UNSEEN.test(text);
}

export interface UnseenOptions {
  /** What each such character becomes: nothing, unless a space is wanted to keep words apart. */
  instead?: string;
  /** Leave newlines and tabs as they are. */
  keepBreaks?: boolean;
  /**
   * For text the user wrote themselves (a title, a name): keep joiners and variation
   * selectors that stand between two visible characters, so that an emoji or a Persian
   * word is not broken. Never for text from outside.
   */
  ownWriting?: boolean;
}

/** The text without what does not show, and without accents piled up to hide what is under them. */
export function withoutUnseen(text: string, options: UnseenOptions = {}): string {
  const instead = options.instead ?? "";
  const letters = Array.from(text);
  const shows = (char: string | undefined): boolean => {
    if (char === undefined) return false;
    UNSEEN.lastIndex = 0;
    return !UNSEEN.test(char) && !/^\s$/u.test(char);
  };
  return letters
    .map((char, at) => {
      UNSEEN.lastIndex = 0;
      if (!UNSEEN.test(char)) return char;
      if (options.keepBreaks && (char === "\n" || char === "\t")) return char;
      if (options.ownWriting && NEEDED_BETWEEN.test(char)) {
        // A selector follows the character it shapes; a joiner stands between two.
        const before = letters[at - 1];
        const selector = /\p{Variation_Selector}/u.test(char);
        if (shows(before) && (selector || shows(letters[at + 1]) || isSelector(letters[at + 1]))) {
          return char;
        }
        // After a selector ("heart, as an emoji, joined to fire") a joiner is still in place.
        if (!selector && isSelector(before) && shows(letters[at - 2])) return char;
      }
      return instead;
    })
    .join("")
    .replace(STACKED, "$1");
}

function isSelector(char: string | undefined): boolean {
  return char !== undefined && /^\p{Variation_Selector}$/u.test(char);
}

/** The first `max` characters of a text, never cutting one written as a pair in half. */
export function firstCharacters(text: string, max: number): string {
  const letters = Array.from(text);
  return letters.length > max ? letters.slice(0, max).join("") : text;
}
