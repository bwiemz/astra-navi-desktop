/**
 * Exact arithmetic, unit conversion and date sums. A small language model guesses at
 * numbers; this is what she uses instead. Nothing here runs code: expressions are
 * read by a small parser that knows numbers, operators and a fixed list of functions.
 */

const FUNCTIONS: ReadonlyMap<string, (...args: number[]) => number> = new Map(
  Object.entries({
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    abs: Math.abs,
    round: (value: number, places = 0) => Math.round(value * 10 ** places) / 10 ** places,
    floor: Math.floor,
    ceil: Math.ceil,
    min: Math.min,
    max: Math.max,
    ln: Math.log,
    log: (value: number, base = 10) => Math.log(value) / Math.log(base),
    log2: Math.log2,
    exp: Math.exp,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    avg: (...values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length,
    sum: (...values: number[]) => values.reduce((sum, value) => sum + value, 0),
  }),
);
/** How many numbers each function takes at most; the ones not listed take any number. */
const MOST_ARGUMENTS: ReadonlyMap<string, number> = new Map([
  ...[
    "sqrt",
    "cbrt",
    "abs",
    "floor",
    "ceil",
    "ln",
    "log2",
    "exp",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
  ].map((name) => [name, 1] as const),
  ["round", 2],
  ["log", 2],
]);
const CONSTANTS: ReadonlyMap<string, number> = new Map([
  ["pi", Math.PI],
  ["e", Math.E],
  ["tau", Math.PI * 2],
]);

class Parser {
  private readonly text: string;
  private at = 0;
  private insideCall = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): number {
    const value = this.sum();
    this.space();
    if (this.at < this.text.length) {
      throw new Error(`I do not understand "${this.text.slice(this.at)}" in that sum.`);
    }
    return value;
  }

  private space(): void {
    while (/\s/.test(this.text[this.at] ?? "")) this.at += 1;
  }

  private take(symbol: string): boolean {
    this.space();
    if (!this.text.startsWith(symbol, this.at)) return false;
    this.at += symbol.length;
    return true;
  }

  private sum(): number {
    let value = this.product();
    for (;;) {
      if (this.take("+")) value += this.percentOf(value, this.product());
      else if (this.take("-") || this.take("−")) value -= this.percentOf(value, this.product());
      else return value;
    }
  }

  /**
   * True when the term just read was a bare percentage. "80 + 15%" then means 15% of 80
   * is added, as on a pocket calculator.
   */
  private lastWasPercent = false;
  private percentOf(base: number, operand: number): number {
    const wasPercent = this.lastWasPercent;
    this.lastWasPercent = false;
    return wasPercent ? base * operand : operand;
  }

  private product(): number {
    let value = this.unary();
    for (;;) {
      const of = /^\s*of\b/i.exec(this.text.slice(this.at));
      if (this.take("*") || this.take("×") || this.take("·")) value *= this.unary();
      else if (this.take("/") || this.take("÷")) value /= this.unary();
      else if (of) {
        this.at += of[0].length;
        value *= this.unary();
      } else if (this.take("mod")) value %= this.unary();
      else return value;
      // Part of a larger product now, so no longer "a percentage of what came before".
      this.lastWasPercent = false;
    }
  }

  /** A minus sign binds looser than a power, as in mathematics: -2^2 is -4. */
  private unary(): number {
    if (this.take("-") || this.take("−")) return -this.unary();
    if (this.take("+")) return this.unary();
    return this.power();
  }

  /** Powers group from the right (2^3^2 is 2^9), and the exponent may carry its own sign. */
  private power(): number {
    const base = this.postfix();
    if (this.take("**") || this.take("^")) {
      const result = base ** this.unary();
      this.lastWasPercent = false;
      return result;
    }
    return base;
  }

  private postfix(): number {
    let value = this.atom();
    for (;;) {
      if (this.take("!")) value = factorial(value);
      else if (this.take("%")) {
        value /= 100;
        this.lastWasPercent = true;
      } else return value;
    }
  }

  private atom(): number {
    this.space();
    this.lastWasPercent = false;
    if (this.take("(")) {
      const value = this.sum();
      if (!this.take(")")) throw new Error("A bracket was opened and not closed.");
      this.lastWasPercent = false;
      return value;
    }
    // "1,234" is one number, except between a function's brackets, where commas separate.
    const whole =
      this.insideCall > 0 ? String.raw`\d[\d_]*` : String.raw`(?:\d{1,3}(?:,\d{3})+|\d[\d_]*)`;
    const number = new RegExp(String.raw`^(?:${whole}\.?\d*|\.\d+)(?:e[+-]?\d+)?`, "i").exec(
      this.text.slice(this.at),
    );
    if (number) {
      this.at += number[0].length;
      return Number(number[0].replace(/[,_]/g, ""));
    }
    const word = /^[a-z_][a-z0-9_]*/i.exec(this.text.slice(this.at));
    if (word) {
      const name = word[0].toLowerCase();
      this.at += word[0].length;
      const known = FUNCTIONS.get(name);
      if (known) {
        if (!this.take("(")) throw new Error(`${name} needs brackets, like ${name}(2).`);
        const args: number[] = [];
        this.insideCall += 1;
        if (!this.take(")")) {
          do args.push(this.sum());
          while (this.take(","));
          if (!this.take(")")) throw new Error("A bracket was opened and not closed.");
        }
        this.insideCall -= 1;
        if (args.length === 0) throw new Error(`${name} needs a number.`);
        const most = MOST_ARGUMENTS.get(name);
        if (most !== undefined && args.length > most) {
          throw new Error(
            `${name} takes ${most === 1 ? "one number" : `at most ${most} numbers`}.`,
          );
        }
        this.lastWasPercent = false;
        return known(...args);
      }
      const constant = CONSTANTS.get(name);
      if (constant !== undefined) return constant;
      throw new Error(`I do not know what "${word[0]}" is in a sum.`);
    }
    throw new Error(
      this.at >= this.text.length
        ? "The sum ends too soon."
        : `I do not understand "${this.text.slice(this.at)}" in that sum.`,
    );
  }
}

function factorial(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 170) {
    throw new Error("Factorials only work for whole numbers from 0 to 170.");
  }
  let result = 1;
  for (let i = 2; i <= value; i++) result *= i;
  return result;
}

/** Each unit as a multiple of its family's base unit. Temperature is handled apart. */
const UNITS = new Map<string, { family: string; factor: number }>();
function units(family: string, table: Record<string, number>): void {
  for (const [names, factor] of Object.entries(table)) {
    for (const name of names.split("|")) UNITS.set(name, { family, factor });
  }
}
units("length", {
  "mm|millimeter|millimeters|millimetre|millimetres": 0.001,
  "cm|centimeter|centimeters|centimetre|centimetres": 0.01,
  "m|meter|meters|metre|metres": 1,
  "km|kilometer|kilometers|kilometre|kilometres": 1000,
  "in|inch|inches": 0.0254,
  "ft|foot|feet": 0.3048,
  "yd|yard|yards": 0.9144,
  "mi|mile|miles": 1609.344,
  "nmi|nautical mile|nautical miles": 1852,
});
units("mass", {
  "mg|milligram|milligrams": 1e-6,
  "g|gram|grams": 0.001,
  "kg|kilogram|kilograms|kilo|kilos": 1,
  "t|tonne|tonnes": 1000,
  "oz|ounce|ounces": 0.028349523125,
  "lb|lbs|pound|pounds": 0.45359237,
  "st|stone": 6.35029318,
});
units("volume", {
  "ml|milliliter|milliliters|millilitre|millilitres": 0.001,
  "l|liter|liters|litre|litres": 1,
  "tsp|teaspoon|teaspoons": 0.00492892159375,
  "tbsp|tablespoon|tablespoons": 0.01478676478125,
  "floz|fl oz|fluid ounce|fluid ounces": 0.0295735295625,
  "cup|cups": 0.2365882365,
  "pt|pint|pints": 0.473176473,
  "qt|quart|quarts": 0.946352946,
  "gal|gallon|gallons": 3.785411784,
});
units("time", {
  "ms|millisecond|milliseconds": 0.001,
  "s|sec|secs|second|seconds": 1,
  "min|mins|minute|minutes": 60,
  "h|hr|hrs|hour|hours": 3600,
  "d|day|days": 86400,
  "wk|week|weeks": 604800,
  "yr|year|years": 31557600,
});
units("data", {
  "b|byte|bytes": 1,
  "kb|kilobyte|kilobytes": 1e3,
  "mb|megabyte|megabytes": 1e6,
  "gb|gigabyte|gigabytes": 1e9,
  "tb|terabyte|terabytes": 1e12,
  "kib|kibibyte|kibibytes": 1024,
  "mib|mebibyte|mebibytes": 1024 ** 2,
  "gib|gibibyte|gibibytes": 1024 ** 3,
  "tib|tebibyte|tebibytes": 1024 ** 4,
  "bit|bits": 0.125,
  "kbit|kilobit|kilobits": 125,
  "mbit|megabit|megabits": 125_000,
  "gbit|gigabit|gigabits": 125_000_000,
});
units("speed", {
  "m/s|mps": 1,
  "km/h|kph|kmh": 1 / 3.6,
  mph: 0.44704,
  "kn|knot|knots": 0.514444,
});
units("area", {
  "m2|sqm|square meter|square meters|square metre|square metres": 1,
  "km2|square kilometer|square kilometers": 1e6,
  "ft2|sqft|square foot|square feet": 0.09290304,
  "acre|acres": 4046.8564224,
  "ha|hectare|hectares": 10_000,
});
const TEMPERATURES: ReadonlyMap<string, "c" | "f" | "k"> = new Map([
  ["c", "c"],
  ["°c", "c"],
  ["celsius", "c"],
  ["centigrade", "c"],
  ["f", "f"],
  ["°f", "f"],
  ["fahrenheit", "f"],
  ["k", "k"],
  ["kelvin", "k"],
]);

/**
 * Reads a unit name. Capitals are ignored except where they change the meaning: "Mb" is
 * megabits and "MB" megabytes, by long convention.
 */
function unitName(written: string): string {
  const trimmed = written.trim();
  const bits = /^([KMGT])b$/.exec(trimmed);
  if (bits) return `${(bits[1] ?? "").toLowerCase()}bit`;
  return trimmed.toLowerCase();
}

function convertUnits(value: number, from: string, to: string): number | null {
  const a = unitName(from);
  const b = unitName(to);
  const hot = TEMPERATURES.get(a);
  const cold = TEMPERATURES.get(b);
  if (hot && cold) {
    const celsius = hot === "c" ? value : hot === "f" ? ((value - 32) * 5) / 9 : value - 273.15;
    return cold === "c" ? celsius : cold === "f" ? (celsius * 9) / 5 + 32 : celsius + 273.15;
  }
  const source = UNITS.get(a);
  const target = UNITS.get(b);
  if (!source || !target) return null;
  if (source.family !== target.family) {
    throw new Error(`${from} and ${to} measure different things, so one cannot become the other.`);
  }
  return (value * source.factor) / target.factor;
}

/** Writes a number the way a person would: no stray digits from binary rounding, no "1e+21" for ordinary sizes. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value))
      throw new Error("That sum has no answer (for example 0 divided by 0).");
    throw new Error("That sum has no finite answer (for example a division by zero).");
  }
  // Whole numbers are exact as far as they go; anything else is trimmed of binary dust.
  const rounded = Number.isSafeInteger(value) ? value : Number(value.toPrecision(12));
  if (Math.abs(rounded) >= 1e15 || (rounded !== 0 && Math.abs(rounded) < 1e-6)) {
    return rounded.toExponential(6).replace(/\.?0+e/, "e");
  }
  const [whole = "0", fraction] = String(rounded).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function parseDay(text: string, today: Date): Date | null {
  const word = text.trim().toLowerCase();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (word === "today" || word === "now") return start;
  if (word === "tomorrow") return new Date(start.getTime() + 86_400_000);
  if (word === "yesterday") return new Date(start.getTime() - 86_400_000);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(word);
  if (!iso) return null;
  const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return date.getMonth() === Number(iso[2]) - 1 ? date : null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function writeDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${WEEKDAYS[date.getDay()]} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Sums about days: how long until a date, between two dates, or which date is so many days away. */
function dateSum(text: string, today: Date): string | null {
  const day = String.raw`(\d{4}-\d{1,2}-\d{1,2}|today|tomorrow|yesterday|now)`;
  const until = new RegExp(String.raw`^(?:days?\s+)?(?:until|till|to|before)\s+${day}$`, "i").exec(
    text,
  );
  const since = new RegExp(String.raw`^(?:days?\s+)?since\s+${day}$`, "i").exec(text);
  const between =
    new RegExp(
      String.raw`^(?:days?\s+)?(?:between|from)\s+${day}\s+(?:and|to|until)\s+${day}$`,
      "i",
    ).exec(text) ?? new RegExp(String.raw`^${day}\s*(?:-|−|to|until)\s*${day}$`, "i").exec(text);
  const shifted = new RegExp(
    String.raw`^${day}\s*([+\-−])\s*(\d+)\s*(day|week|month|year)s?$`,
    "i",
  ).exec(text);
  const weekday = new RegExp(
    String.raw`^(?:what\s+)?(?:week)?day\s+(?:is|was|of)\s+${day}$`,
    "i",
  ).exec(text);

  const daysApart = (from: Date, to: Date): number =>
    Math.round((to.getTime() - from.getTime()) / 86_400_000);
  const need = (value: string | undefined): Date => {
    const date = parseDay(value ?? "", today);
    if (!date) throw new Error(`"${value}" is not a date I can read. Write it as 2027-04-01.`);
    return date;
  };
  const say = (days: number): string =>
    `${formatNumber(days)} day${Math.abs(days) === 1 ? "" : "s"}`;

  if (until) {
    const target = need(until[1]);
    return `${say(daysApart(parseDay("today", today) ?? today, target))} until ${writeDay(target)}`;
  }
  if (since) {
    const from = need(since[1]);
    return `${say(daysApart(from, parseDay("today", today) ?? today))} since ${writeDay(from)}`;
  }
  if (between) {
    const from = need(between[1]);
    const to = need(between[2]);
    const days = daysApart(from, to);
    const weeks =
      Math.abs(days) >= 14 ? ` (${formatNumber(Math.round((days / 7) * 10) / 10)} weeks)` : "";
    return `${say(days)}${weeks} from ${writeDay(from)} to ${writeDay(to)}`;
  }
  if (shifted) {
    const from = need(shifted[1]);
    const amount = Number(shifted[3]) * (shifted[2] === "+" ? 1 : -1);
    const unit = (shifted[4] ?? "day").toLowerCase();
    const result = new Date(from);
    if (unit === "day") result.setDate(result.getDate() + amount);
    else if (unit === "week") result.setDate(result.getDate() + amount * 7);
    else if (unit === "month") result.setMonth(result.getMonth() + amount);
    else result.setFullYear(result.getFullYear() + amount);
    return writeDay(result);
  }
  if (weekday) return writeDay(need(weekday[1]));
  // A date by itself: say which day of the week it is, not "2026 minus 11 minus 21".
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return writeDay(need(text));
  return null;
}

/**
 * Works out a sum, a unit conversion or a date sum and returns the answer as text.
 * Throws an Error with a plain explanation when it cannot.
 * @param today Injected so date sums can be tested.
 */
export function calculate(input: string, today: Date = new Date()): string {
  const text = input
    .trim()
    .replace(/[=?]+\s*$/, "")
    .replace(/^(?:what\s+is|what's|calculate|compute|how\s+much\s+is)\s+/i, "")
    .trim();
  if (text.length === 0) throw new Error("There is nothing to work out.");
  if (text.length > 300) throw new Error("That sum is too long.");

  const dated = dateSum(text, today);
  if (dated !== null) return dated;

  // "5 miles in km", "72 f to c", "(3 + 4) cups to ml"
  const conversion =
    /^(.+?)\s*([a-z°][a-z0-9°/ ]*?)\s+(?:in|to|as|into)\s+([a-z°][a-z0-9°/ ]*)$/i.exec(text);
  if (conversion) {
    const [, amount = "", from = "", to = ""] = conversion;
    let value: number | undefined;
    try {
      value = new Parser(amount).parse();
    } catch {
      value = undefined; // not a conversion after all; read it as a plain sum below
    }
    if (value !== undefined) {
      const converted = convertUnits(value, from, to);
      if (converted !== null) return `${formatNumber(converted)} ${to.trim()}`;
    }
  }
  return formatNumber(new Parser(text).parse());
}
