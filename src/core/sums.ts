import { calculate } from "./calc.ts";

/**
 * Checking the sums she states.
 *
 * She is told to use her calculator for every sum, and mostly does. When she does not,
 * a small model's arithmetic is right often enough to be believed and wrong often
 * enough to matter. So whatever she says, any sum written out in her reply ("18% of
 * 240 is 44", "26.2 miles is 42.2 km") is worked out again by the calculator itself,
 * which takes no model and no time. A wrong figure gets a note under the reply with
 * the right one. A right figure is left alone, however she came by it.
 *
 * Only plainly stated sums are read: two figures and a sign or its word, or a figure,
 * a unit and "is … in another unit". Anything it is not sure it has read correctly it
 * leaves be: a wrong correction would be worse than none.
 */

export interface WrongSum {
  /** The sum as she stated it, with her figure. */
  said: string;
  /** What it really comes to, as the calculator writes it. */
  right: string;
}

const NUMBER = String.raw`-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?`;
const COMES_TO = String.raw`(?:is|are|=|equals|comes to|makes|gives|works out (?:to|at)|converts to)`;
const ROUGHLY = String.raw`(?:(about|around|roughly|approximately|nearly|almost|just (?:over|under)|close to|exactly|precisely)\s+)?`;

/** The signs and words for each kind of sum, and how the calculator writes it. */
const OPERATORS: readonly [RegExp, string][] = [
  [/^(?:×|\*|times|multiplied by| x )$/i, "*"],
  [/^(?:\+|plus)$/i, "+"],
  [/^(?:−|minus)$/i, "-"],
  [/^(?:÷| \/ |divided by)$/i, "/"],
];

/** Units as she may write them, and as the calculator knows them. */
const UNITS: Record<string, string> = {
  mile: "miles",
  miles: "miles",
  mi: "miles",
  km: "km",
  kilometre: "km",
  kilometres: "km",
  kilometer: "km",
  kilometers: "km",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  kilo: "kg",
  kilos: "kg",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  ft: "ft",
  foot: "ft",
  feet: "ft",
  m: "m",
  metre: "m",
  metres: "m",
  meter: "m",
  meters: "m",
  cm: "cm",
  centimetre: "cm",
  centimetres: "cm",
  centimeter: "cm",
  centimeters: "cm",
  inch: "in",
  inches: "in",
  fahrenheit: "f",
  celsius: "c",
  "°f": "f",
  "°c": "c",
};
const UNIT_WORD = Object.keys(UNITS)
  .sort((a, b) => b.length - a.length)
  .map((unit) => unit.replace(/[°]/g, "°"))
  .join("|");

const PERCENT = new RegExp(
  String.raw`(${NUMBER})\s*(?:%|percent|per cent)\s+of\s+(${NUMBER})\s+${COMES_TO}\s+${ROUGHLY}(${NUMBER})`,
  "gi",
);
const BINARY = new RegExp(
  // A hyphen or dash between two figures is far more often a range ("pages 10 - 20") than
  // a subtraction, so taking away is only read from the word or from the true minus sign.
  String.raw`(${NUMBER})(\s*(?:×|\*|÷|\+|−)\s*| x | \/ |\s+(?:times|multiplied by|plus|minus|divided by)\s+)(${NUMBER})\s+${COMES_TO}\s+${ROUGHLY}(${NUMBER})`,
  "gi",
);
const CONVERSION = new RegExp(
  String.raw`(${NUMBER})\s*(${UNIT_WORD})\b\s+${COMES_TO}\s+${ROUGHLY}(${NUMBER})\s*(${UNIT_WORD})\b`,
  "gi",
);

function toNumber(text: string): number {
  return Number(text.replace(/,/g, ""));
}

function decimalsOf(text: string): number {
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * True when her figure is a fair way of writing the real one: the same number rounded
 * or cut to as many places as she gave, or, when she said "about", within one in a
 * hundred of it.
 */
function agrees(saidText: string, real: number, roughly: boolean): boolean {
  const said = toNumber(saidText);
  if (!Number.isFinite(said) || !Number.isFinite(real)) return true;
  const places = decimalsOf(saidText.replace(/,/g, ""));
  // More places than the calculator keeps: she is showing how a computer holds the
  // number ("0.30000000000000004"), which is not for this to judge.
  if (places > 10) return true;
  if (Number(said.toPrecision(12)) === Number(real.toPrecision(12))) return true;
  const step = 10 ** -places;
  const off = Math.abs(real - said);
  // Rounded to the places she gave, with a hair of slack for how computers hold decimals.
  if (off <= step * 0.5000001) return true;
  // Cut off at those places instead of rounded ("43" for 43.9 is poor, but not a wrong sum).
  if (Math.abs(Math.trunc(real / step) * step - said) <= step * 1e-6) return true;
  // With decimals, one out in the last place is a slip of rounding, not of arithmetic.
  if (places >= 1 && off <= step * 1.0000001) return true;
  return roughly && off <= Math.abs(real) * 0.01;
}

/** The calculator's answer as a number and as it writes it, or null when it cannot do the sum. */
function workOut(expression: string): { value: number; text: string } | null {
  try {
    const text = calculate(expression);
    const value = toNumber(/-?[\d,]+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(text)?.[0] ?? "");
    // Past these sizes the calculator answers to seven figures ("1.219326e17"), which
    // is less exact than what she may rightly have written out in full.
    const size = Math.abs(value);
    if (size >= 1e15 || (size !== 0 && size < 1e-6)) return null;
    return Number.isFinite(value) ? { value, text } : null;
  } catch {
    return null;
  }
}

/** The calculator's answer without the long tail of decimals a conversion can have. */
function tidy(answer: string): string {
  return answer.replace(/-?[\d,]+\.\d{5,}/, (figure) => {
    const rounded = Number(toNumber(figure).toFixed(4));
    return rounded.toLocaleString("en-US", { maximumFractionDigits: 4 });
  });
}

/**
 * True when what was found is a whole sum of its own, stated as her own and as a plain
 * number. Not when it is the tail of a longer sum ("2 + 3 + 4 is 9"), part of a time, a
 * decimal written with a comma or a figure grouped with spaces, when her figure goes on
 * (a percent sign, "million", "more than"), or when she is quoting somebody's mistake.
 */
function standsAlone(text: string, at: number, length: number): boolean {
  const before = text.slice(Math.max(0, at - 48), at);
  const after = text.slice(at + length, at + length + 24);
  // Something that belongs to the figures runs straight into them from the left.
  // (Touching them, that is: "1,5 + 2" or "9:15 + 30". A full stop and a space is just
  // the end of the sentence before.)
  if (/[\d.,:^²³√)\]]$/.test(before) || /\d\s+$/.test(before)) return false;
  if (/(?:[-+*×÷/^−–=]|\b(?:times|plus|minus|by|x))\s*$/i.test(before)) return false;
  // Her figure goes on: more digits, a unit of scale, a comparison, another sign.
  if (/^(?:[.,:]\d|\s?(?:%|percent|[-+*×÷/^−–]|:\d))/.test(after)) return false;
  if (/^\s?(?:k|m|bn|thousand|million|billion|trillion|more|less|fewer|times|x)\b/i.test(after)) {
    return false;
  }
  // Somebody else's sum, or one she is saying is wrong.
  if (
    /\b(?:said|says|wrote|thinks?|thinking|thought|mistake|wrong|claim(?:s|ed)?|common|not|never|isn't|if)\b[^.!?]*$/i.test(
      before,
    )
  ) {
    return false;
  }
  return !/^[\s,;:]*(?:but|actually|is wrong|which is wrong|not\b)/i.test(after);
}

/** A figure such as "1.250" could be one and a quarter, or one thousand two hundred and fifty. */
function asThousands(figure: string): string | null {
  return /^-?\d{1,3}(?:\.\d{3})+$/.test(figure) ? figure.replace(/\./g, "") : null;
}

/** Sums in her reply whose stated answer is not what they come to. */
export function wrongSums(reply: string): WrongSum[] {
  return sumsIn(reply).wrong;
}

/**
 * The same, with how many sums were found right: a figure the calculator has already
 * agreed with needs no second working-out by her.
 */
export function sumsIn(reply: string): { wrong: WrongSum[]; right: number } {
  // Without the emphasis and code marks she may have put round the figures.
  const text = reply.replace(/\*\*|__|`/g, "").replace(/[‘’]/g, "'");
  const wrong: WrongSum[] = [];
  let right = 0;
  const seen = new Set<string>();
  const check = (
    found: RegExpMatchArray,
    expression: string,
    stated: string,
    roughly: boolean,
    /** The same sum with full stops read as thousands marks, when it could be written that way. */
    otherReading?: { expression: string; stated: string },
  ): void => {
    const said = found[0];
    const key = said.toLowerCase();
    if (seen.has(key) || wrong.length >= 3) return;
    if (!standsAlone(text, found.index ?? 0, said.length)) return;
    seen.add(key);
    const real = workOut(expression);
    if (!real) return;
    if (agrees(stated, real.value, roughly)) {
      right += 1;
      return;
    }
    if (otherReading) {
      const other = workOut(otherReading.expression);
      if (other && agrees(otherReading.stated, other.value, roughly)) {
        right += 1;
        return;
      }
    }
    wrong.push({ said: said.replace(/\s+/g, " ").trim(), right: tidy(real.text) });
  };
  for (const found of text.matchAll(PERCENT)) {
    const [, percent, of, roughly, stated] = found;
    check(found, `${toNumber(percent ?? "")}% of ${toNumber(of ?? "")}`, stated ?? "", !!roughly);
  }
  for (const found of text.matchAll(BINARY)) {
    const [, left, sign, right, roughly, stated] = found;
    const spaced = sign ?? "";
    const operator = OPERATORS.find(([pattern]) =>
      pattern.test(/^ (?:x|\/) $/.test(spaced) ? spaced : spaced.trim()),
    )?.[1];
    if (!operator) continue;
    const figures = [left ?? "", right ?? "", stated ?? ""];
    const others = figures.map((figure) => asThousands(figure));
    const read = (index: number): string => others[index] ?? figures[index] ?? "";
    check(
      found,
      `${toNumber(left ?? "")} ${operator} ${toNumber(right ?? "")}`,
      stated ?? "",
      !!roughly,
      others.some((other) => other !== null)
        ? { expression: `${toNumber(read(0))} ${operator} ${toNumber(read(1))}`, stated: read(2) }
        : undefined,
    );
  }
  for (const found of text.matchAll(CONVERSION)) {
    const [, amount, from, roughly, stated, to] = found;
    const [source, target] = [UNITS[(from ?? "").toLowerCase()], UNITS[(to ?? "").toLowerCase()]];
    if (!source || !target || source === target) continue;
    check(found, `${toNumber(amount ?? "")} ${source} in ${target}`, stated ?? "", !!roughly);
  }
  return { wrong, right };
}

/** The note shown under a reply with a wrong sum in it. */
export function describeWrongSums(wrong: readonly WrongSum[]): string {
  const lines = wrong.map((sum) => `"${sum.said}" should be ${sum.right}`);
  return `Check the figures in that reply: ${lines.join("; ")}. (Worked out by the calculator, not by her.)`;
}
