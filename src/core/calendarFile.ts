import { withoutUnseen } from "./unseen.ts";

/**
 * Reading a calendar file (iCalendar): its entries, their times and time zones, and the
 * rules by which some of them repeat. Nothing here touches a clock, a disk or the
 * network: text goes in, entries come out.
 *
 * The rule of the agenda holds here most of all (see `agenda.ts`): what cannot be
 * worked out exactly is left out and said to be left out, never guessed at.
 */

/** One thing on the agenda, at one time. A weekly meeting is one of these per week. */
export interface Occurrence {
  title: string;
  /** For a whole-day entry: midnight, by this computer's clock, at the start of its first day. */
  start: Date;
  /** Null when the calendar gave no end. For a whole-day entry: the midnight after its last day. */
  end: Date | null;
  /** A whole day (a birthday, a day off), not a time on it. */
  allDay: boolean;
  location: string;
  /** Which calendar it is from, by the name the user gave it; "AI-chan" for her own list. */
  calendar: string;
  /** True for an entry on her own list. Everything else was written by the user or by others. */
  own: boolean;
  /** Present for her own entries, so one can be taken off again. */
  id?: string;
}

/** A date and time as a calendar writes it: figures on a wall clock, and whose wall. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /**
   * "UTC"; a zone by name ("Europe/Berlin"); a fixed distance from UTC ("fixed:3600000");
   * or null for whatever zone the reader is in.
   */
  zone: string | null;
  dateOnly: boolean;
}

export interface CalendarEvent {
  uid: string;
  title: string;
  location: string;
  start: WallTime;
  end: WallTime | null;
  /** A length given outright, in milliseconds. */
  durationMs: number | null;
  rule: Rule | null;
  /** Occurrences taken out of a repeating event. */
  except: WallTime[];
  /** Set on an entry that replaces one occurrence of a repeating event. */
  replaces: WallTime | null;
  /** It replaces that occurrence and every one after it, which is not worked out here. */
  andAfter: boolean;
  /** Called off. Kept only to take its occurrence out of a repeating event. */
  cancelled: boolean;
  /** Worked out once and kept: see `lengthOf`, `isExcepted` and `walk`. */
  memo: {
    lengthMs?: number | null;
    exceptByDay?: Map<number, WallTime[]>;
    resume?: { period: number; made: number };
  };
}

export interface Rule {
  every: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: WallTime | null;
  /** Weekdays 0 (Sunday) to 6; `nth` is 0 for "every", 2 for "the second", -1 for "the last". */
  byDay: { weekday: number; nth: number }[];
  /** Days of the month; negative ones count from its end. */
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  /** The day a week starts on, 0 (Sunday) to 6. */
  weekStart: number;
}

/** A calendar as read: its entries, and what in it could not be worked out. */
export interface ReadCalendar {
  events: CalendarEvent[];
  /** Fixed phrases, safe to pass on, for what was left out. */
  notes: string[];
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export const DAY_MS = 86_400_000;
/** A calendar file larger than this is not read: nobody's agenda needs more. */
export const MAX_CALENDAR_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 20_000;
/** A repeating entry may have this many dates taken out of it; more, and it is not worked out. */
const MAX_EXCEPTIONS = 2000;
/** A repeat "every N" with N beyond this is not a repeat anybody meant. */
const MAX_INTERVAL = 1000;
/**
 * How many steps through repeating entries one calendar may cost in one look. A real
 * calendar uses a few thousand; one written to stall her would use millions.
 */
export const WORK_PER_CALENDAR = 400_000;
/**
 * And how many one entry may cost. Eighty years of a daily entry fit; an entry written
 * to need more is left out by itself, and the rest of its calendar is still shown.
 */
export const WORK_PER_ENTRY = 60_000;
export const MAX_TEXT = 160;
/** No real time zone has a longer name; a longer one is not looked into at all. */
const MAX_ZONE_NAME = 64;
/** A rule for repeating is a few dozen characters. One much longer is not a rule anybody wrote. */
const MAX_RULE_CHARS = 600;
/** The longest line of taken-out dates that is read: room for all that are allowed, and no more. */
const MAX_EXCEPTION_CHARS = 80_000;

const NOTE_REPEATS = "some repeating entries could not be worked out";
const NOTE_ZONE = "some entries are in a time zone that could not be worked out";
const NOTE_TOO_MANY = "it has more entries than can be read";
export const NOTE_HEAVY = "some repeating entries take too much working out and are left out";

/**
 * Text made fit to keep and show. `own` is for what the user asked her to write down,
 * where an emoji or a word may need its joiners; a calendar's own text gets no such trust.
 */
export function clean(text: string, own = false): string {
  // Only the start can ever be shown, so only the start is gone through.
  const head = text.slice(0, MAX_TEXT * 8);
  const flat = withoutUnseen(head.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1"), {
    instead: " ",
    ownWriting: own,
  })
    .replace(/\s+/g, " ")
    .trim();
  const letters = [...flat];
  return letters.length > MAX_TEXT ? `${letters.slice(0, MAX_TEXT).join("")}…` : flat;
}

// ---------- time zones ----------

/**
 * The names Windows and Outlook give time zones, with the names everything else uses.
 * The common ones; a name not here is not guessed at.
 */
const WINDOWS_ZONES: Record<string, string> = {
  "dateline standard time": "Etc/GMT+12",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "pacific standard time (mexico)": "America/Tijuana",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "mountain standard time (mexico)": "America/Mazatlan",
  "central standard time": "America/Chicago",
  "central standard time (mexico)": "America/Mexico_City",
  "canada central standard time": "America/Regina",
  "central america standard time": "America/Guatemala",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indiana/Indianapolis",
  "sa pacific standard time": "America/Bogota",
  "venezuela standard time": "America/Caracas",
  "atlantic standard time": "America/Halifax",
  "sa western standard time": "America/La_Paz",
  "pacific sa standard time": "America/Santiago",
  "newfoundland standard time": "America/St_Johns",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Argentina/Buenos_Aires",
  "sa eastern standard time": "America/Cayenne",
  "greenland standard time": "America/Nuuk",
  "montevideo standard time": "America/Montevideo",
  "azores standard time": "Atlantic/Azores",
  "cape verde standard time": "Atlantic/Cape_Verde",
  utc: "UTC",
  "coordinated universal time": "UTC",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "morocco standard time": "Africa/Casablanca",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "romance standard time": "Europe/Paris",
  "central european standard time": "Europe/Warsaw",
  "w. central africa standard time": "Africa/Lagos",
  "gtb standard time": "Europe/Bucharest",
  "middle east standard time": "Asia/Beirut",
  "egypt standard time": "Africa/Cairo",
  "south africa standard time": "Africa/Johannesburg",
  "fle standard time": "Europe/Kyiv",
  "israel standard time": "Asia/Jerusalem",
  "e. europe standard time": "Europe/Chisinau",
  "jordan standard time": "Asia/Amman",
  "turkey standard time": "Europe/Istanbul",
  "arabic standard time": "Asia/Baghdad",
  "arab standard time": "Asia/Riyadh",
  "russian standard time": "Europe/Moscow",
  "e. africa standard time": "Africa/Nairobi",
  "iran standard time": "Asia/Tehran",
  "arabian standard time": "Asia/Dubai",
  "azerbaijan standard time": "Asia/Baku",
  "caucasus standard time": "Asia/Yerevan",
  "georgian standard time": "Asia/Tbilisi",
  "afghanistan standard time": "Asia/Kabul",
  "west asia standard time": "Asia/Tashkent",
  "pakistan standard time": "Asia/Karachi",
  "india standard time": "Asia/Kolkata",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Kathmandu",
  // Windows keeps this zone six hours ahead of UTC; Almaty itself moved to five in 2024.
  "central asia standard time": "Asia/Bishkek",
  "bangladesh standard time": "Asia/Dhaka",
  "myanmar standard time": "Asia/Yangon",
  "se asia standard time": "Asia/Bangkok",
  "china standard time": "Asia/Shanghai",
  "singapore standard time": "Asia/Singapore",
  "w. australia standard time": "Australia/Perth",
  "taipei standard time": "Asia/Taipei",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "cen. australia standard time": "Australia/Adelaide",
  "aus central standard time": "Australia/Darwin",
  "e. australia standard time": "Australia/Brisbane",
  "aus eastern standard time": "Australia/Sydney",
  "west pacific standard time": "Pacific/Port_Moresby",
  "tasmania standard time": "Australia/Hobart",
  "central pacific standard time": "Pacific/Guadalcanal",
  "new zealand standard time": "Pacific/Auckland",
  "fiji standard time": "Pacific/Fiji",
  "tonga standard time": "Pacific/Tongatapu",
  "samoa standard time": "Pacific/Apia",
};

const FIXED = "fixed:";
/** One reader of clock times per zone, made once: making one is the costly part. */
const zoneClocks = new Map<string, Intl.DateTimeFormat | null>();

function clockFor(zone: string): Intl.DateTimeFormat | null {
  let clock = zoneClocks.get(zone);
  if (clock === undefined) {
    try {
      clock = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      clock = null; // a zone this computer has never heard of
    }
    if (zoneClocks.size > 600) zoneClocks.clear();
    zoneClocks.set(zone, clock);
  }
  return clock;
}

/**
 * The zone a calendar means by the name it gives, in a form `toInstant` can use, or
 * null when it cannot be told. `fixedZones` are the zones the calendar itself defines
 * as a single unchanging distance from UTC.
 */
function resolveZone(named: string, fixedZones: ReadonlyMap<string, number>): string | null {
  // A name is whatever the calendar wrote, and may be megabytes of it. Nothing below is
  // done to more than a real name's length.
  if (named.length > MAX_ZONE_NAME + 8) return null;
  const name = named.trim().replace(/^"|"$/g, "");
  if (name === "" || name.length > MAX_ZONE_NAME) return null;
  if (/^(?:utc|z|gmt|etc\/utc|etc\/gmt)$/i.test(name)) return "UTC";
  if (clockFor(name)) return name;
  // Thunderbird and friends write "/mozilla.org/20050126_1/Europe/Berlin": the zone is
  // the last two parts, or three for the likes of "America/Argentina/Buenos_Aires".
  const parts = name.split("/");
  for (const take of [3, 2]) {
    if (parts.length <= take) continue;
    const tail = parts.slice(-take).join("/");
    if (/^[A-Za-z0-9_+/-]+$/.test(tail) && clockFor(tail)) return tail;
  }
  const known = WINDOWS_ZONES[name.toLowerCase()];
  if (known && (known === "UTC" || clockFor(known))) return known;
  const fixed = fixedZones.get(name);
  if (fixed !== undefined) return `${FIXED}${fixed}`;
  return null;
}

/** How far the given zone's clocks are ahead of UTC at this instant, in milliseconds. */
function offsetOf(instant: number, zone: string): number {
  const clock = clockFor(zone);
  if (!clock) return 0;
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of clock.formatToParts(new Date(instant))) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "second") second = Number(part.value);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time names. Around a clock change a time can come twice or
 * not at all; the calendar standard says which is meant: the first of two, and for a
 * time that was skipped, the one reckoned as if the clocks had not yet moved.
 */
export function toInstant(wall: WallTime): number {
  const { year, month, day, hour, minute, second, zone } = wall;
  if (zone === null) return new Date(year, month - 1, day, hour, minute, second).getTime();
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (zone === "UTC") return asUtc;
  if (zone.startsWith(FIXED)) return asUtc - Number(zone.slice(FIXED.length));
  const before = offsetOf(asUtc - DAY_MS, zone);
  const after = offsetOf(asUtc + DAY_MS, zone);
  if (before === after) return asUtc - before;
  // A change of clocks lies within a day of this. Two readings are possible.
  const early = asUtc - Math.max(before, after);
  const late = asUtc - Math.min(before, after);
  if (offsetOf(early, zone) === asUtc - early) return early;
  if (offsetOf(late, zone) === asUtc - late) return late;
  return asUtc - before;
}

// ---------- reading a calendar file ----------

/** A count of days since 1970, for stepping through dates without touching a clock. */
export function dayNumber(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function dateOf(number: number): { year: number; month: number; day: number } {
  const date = new Date(number * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekdayOfNumber(number: number): number {
  // 1 January 1970 was a Thursday.
  return (((number + 4) % 7) + 7) % 7;
}

/** A date and time as written in a calendar, or null when it is not one, or names no real date. */
function parseWall(value: string, zone: string | null, dateOnly: boolean): WallTime | null {
  if (value.length > 40) return null;
  const found = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!found) return null;
  const [year, month, day] = [Number(found[1]), Number(found[2]), Number(found[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  const timed = found[4] !== undefined && !dateOnly;
  const [hour, minute, second] = timed
    ? [Number(found[4]), Number(found[5]), Number(found[6] ?? "0")]
    : [0, 0, 0];
  if (hour > 23 || minute > 59 || second > 60) return null;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second: Math.min(second, 59),
    zone: !timed ? null : found[7] ? "UTC" : zone,
    dateOnly: !timed,
  };
}

function parseDuration(value: string): number | null {
  if (value.length > 60) return null;
  const found =
    /^([+-])?P(?:(\d{1,6})W)?(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/.exec(
      value.trim(),
    );
  if (!found) return null;
  const [weeks, days, hours, minutes, seconds] = found.slice(2).map((part) => Number(part ?? "0"));
  const total =
    ((((weeks ?? 0) * 7 + (days ?? 0)) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60_000 +
    (seconds ?? 0) * 1000;
  return found[1] === "-" ? null : total;
}

function wholeNumbers(text: string, least: number, most: number): number[] | null {
  const out: number[] = [];
  for (const word of text.split(",")) {
    if (!/^[+-]?\d{1,4}$/.test(word.trim())) return null;
    const value = Number(word);
    if (value === 0 || value < least || value > most) return null;
    out.push(value);
  }
  return out;
}

/**
 * A rule for repeating, or null when it is one this does not work out exactly. Null is
 * not "no rule": the entry is then shown once, at its first date, and the calendar is
 * named as not fully read. Every part of the rule has to be understood, since each
 * part changes which days it lands on.
 */
function parseRule(value: string, start: WallTime): Rule | null {
  if (value.length > MAX_RULE_CHARS) return null;
  const fields = new Map<string, string>();
  for (const part of value.trim().split(";")) {
    if (part === "") continue;
    const at = part.indexOf("=");
    if (at <= 0) return null;
    const key = part.slice(0, at).toUpperCase();
    if (fields.has(key)) return null;
    fields.set(key, part.slice(at + 1).trim());
  }
  const KNOWN = [
    "FREQ",
    "INTERVAL",
    "COUNT",
    "UNTIL",
    "BYDAY",
    "BYMONTHDAY",
    "BYMONTH",
    "BYSETPOS",
    "WKST",
  ];
  for (const key of fields.keys()) if (!KNOWN.includes(key)) return null;
  const every = fields.get("FREQ")?.toUpperCase();
  if (every !== "DAILY" && every !== "WEEKLY" && every !== "MONTHLY" && every !== "YEARLY") {
    return null;
  }
  let interval = 1;
  if (fields.has("INTERVAL")) {
    if (!/^\d{1,9}$/.test(fields.get("INTERVAL") ?? "")) return null;
    interval = Number(fields.get("INTERVAL"));
    if (interval < 1 || interval > MAX_INTERVAL) return null;
  }
  let count: number | null = null;
  if (fields.has("COUNT")) {
    if (!/^\d{1,9}$/.test(fields.get("COUNT") ?? "")) return null;
    count = Number(fields.get("COUNT"));
    if (count < 1) return null;
  }
  let until: WallTime | null = null;
  if (fields.has("UNTIL")) {
    const wall = parseWall(fields.get("UNTIL") ?? "", start.zone, false);
    if (!wall) return null;
    // A day given without a time means through the end of that day, where the entry is.
    until = wall.dateOnly
      ? { ...wall, hour: 23, minute: 59, second: 59, zone: start.zone, dateOnly: false }
      : wall;
  }
  const byDay: Rule["byDay"] = [];
  if (fields.has("BYDAY")) {
    for (const word of (fields.get("BYDAY") ?? "").split(",")) {
      const found = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(word.trim());
      if (!found) return null;
      const nth = found[1] ? Number(found[1]) : 0;
      if (found[1] && (nth === 0 || Math.abs(nth) > 5)) return null;
      byDay.push({ weekday: WEEKDAYS.indexOf((found[2] ?? "").toUpperCase()), nth });
    }
  }
  const list = (key: string, least: number, most: number): number[] | null =>
    fields.has(key) ? wholeNumbers(fields.get(key) ?? "", least, most) : [];
  const byMonthDay = list("BYMONTHDAY", -31, 31);
  const byMonth = list("BYMONTH", 1, 12);
  const bySetPos = list("BYSETPOS", -366, 366);
  if (!byMonthDay || !byMonth || !bySetPos) return null;
  let weekStart = 1; // Monday, unless the calendar says otherwise
  if (fields.has("WKST")) {
    weekStart = WEEKDAYS.indexOf((fields.get("WKST") ?? "").toUpperCase());
    if (weekStart === -1) return null;
  }
  const numbered = byDay.some((entry) => entry.nth !== 0);
  // What each kind of repeat may be combined with, and still be worked out exactly here.
  if (every === "DAILY" && (numbered || bySetPos.length > 0)) return null;
  if (every === "WEEKLY" && (numbered || byMonthDay.length > 0 || bySetPos.length > 0)) return null;
  if (every === "YEARLY") {
    // "The fourth Thursday of November" is worked out; "the 20th Monday of the year" is not.
    if ((byDay.length > 0 || byMonthDay.length > 0) && byMonth.length === 0) return null;
    if (bySetPos.length > 0 && byMonth.length !== 1) return null;
  }
  if (bySetPos.length > 0 && byDay.length === 0 && byMonthDay.length === 0) return null;
  return { every, interval, count, until, byDay, byMonthDay, byMonth, bySetPos, weekStart };
}

interface Field {
  params: Map<string, string>;
  value: string;
}

/** The place of the first `mark` that is not inside quotes, or -1. */
function splitAt(line: string, mark: string): number {
  let quoted = false;
  for (let at = 0; at < line.length; at++) {
    if (line[at] === '"') quoted = !quoted;
    else if (line[at] === mark && !quoted) return at;
  }
  return -1;
}

/** The parts of a line's head, cut at each ";" that is not inside quotes. One pass, however long. */
function splitParams(head: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let from = 0;
  for (let at = 0; at < head.length; at++) {
    if (head[at] === '"') quoted = !quoted;
    else if (head[at] === ";" && !quoted) {
      // No real line has more parts than this; the rest of one that does is not read.
      if (parts.length >= 16) return parts;
      parts.push(head.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(head.slice(from));
  return parts;
}

function fieldOf(line: string): { key: string; field: Field } | null {
  const colon = splitAt(line, ":");
  if (colon === -1) return null;
  const [name, ...paramWords] = splitParams(line.slice(0, colon));
  const params = new Map<string, string>();
  for (const word of paramWords) {
    const at = word.indexOf("=");
    if (at > 0) params.set(word.slice(0, at).toUpperCase(), word.slice(at + 1).replace(/"/g, ""));
  }
  return { key: (name ?? "").toUpperCase(), field: { params, value: line.slice(colon + 1) } };
}

/** A distance from UTC as a calendar writes it: "+0100", "-0530". */
function parseOffset(value: string): number | null {
  if (value.length > 20) return null;
  const found = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (!found) return null;
  const size = (Number(found[2]) * 3600 + Number(found[3]) * 60 + Number(found[4] ?? "0")) * 1000;
  return found[1] === "-" ? -size : size;
}

/**
 * Reads a calendar file (the iCalendar form every calendar program can write), and
 * says what in it could not be worked out.
 */
export function readCalendar(text: string): ReadCalendar {
  // A long line is broken and carried on with a space; put those back together first.
  const lines = text
    .slice(0, MAX_CALENDAR_BYTES)
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");

  // First the zones the calendar defines for itself. Only one kind is taken from there:
  // a zone that never changes its clocks, which is a single number. One with summer
  // time is a set of rules, and is known by its name or not at all.
  const fixedZones = new Map<string, number>();
  let zoneName: string | null = null;
  let zoneOffsets: Set<number> | null = null;
  let zoneSound = true;
  let zoneGoesTo = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VTIMEZONE") {
      zoneName = null;
      zoneOffsets = new Set();
      zoneSound = true;
      zoneGoesTo = false;
    } else if (upper === "END:VTIMEZONE") {
      if (
        zoneName !== null &&
        zoneSound &&
        zoneGoesTo &&
        zoneOffsets?.size === 1 &&
        fixedZones.size < 200
      ) {
        fixedZones.set(zoneName, [...zoneOffsets][0] ?? 0);
      }
      zoneOffsets = null;
    } else if (zoneOffsets !== null) {
      // By the property's whole name: "TZID-ALIAS-OF" and its like are not the zone's name.
      const read = upper.startsWith("TZID") || upper.startsWith("TZOFFSET") ? fieldOf(line) : null;
      if (read?.key === "TZID") {
        const given = read.field.value.trim();
        zoneName = given.length > 0 && given.length <= MAX_ZONE_NAME ? given : null;
      } else if (read?.key === "TZOFFSETTO" || read?.key === "TZOFFSETFROM") {
        // Where the clocks go to and where they come from must be one and the same
        // distance: a zone that has ever moved its clocks is not a single number.
        const offset = parseOffset(read.field.value);
        if (offset === null) zoneSound = false;
        else {
          zoneOffsets.add(offset);
          if (read.key === "TZOFFSETTO") zoneGoesTo = true;
        }
      }
    }
  }

  const events: CalendarEvent[] = [];
  const notes = new Set<string>();
  let open: Map<string, Field[]> | null = null;
  let nested = 0;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      open = new Map();
      nested = 0;
      continue;
    }
    if (open === null) continue;
    // An alarm inside an event has a description and a trigger of its own; not ours.
    if (upper.startsWith("BEGIN:")) {
      nested += 1;
      continue;
    }
    if (upper.startsWith("END:") && upper !== "END:VEVENT") {
      nested = Math.max(0, nested - 1);
      continue;
    }
    if (upper === "END:VEVENT") {
      if (events.length >= MAX_EVENTS) notes.add(NOTE_TOO_MANY);
      else {
        const made = makeEvent(open, fixedZones, notes);
        if (made) events.push(made);
      }
      open = null;
      continue;
    }
    if (nested > 0) continue;
    const read = fieldOf(line);
    if (!read) continue;
    const list = open.get(read.key) ?? [];
    // One entry cannot be made to hold more lines of a kind than any real one has.
    if (list.length <= MAX_EXCEPTIONS) list.push(read.field);
    open.set(read.key, list);
  }
  return { events, notes: [...notes] };
}

/** The entries of a calendar file. See `readCalendar` for what could not be worked out. */
export function parseCalendar(text: string): CalendarEvent[] {
  return readCalendar(text).events;
}

function makeEvent(
  fields: Map<string, Field[]>,
  fixedZones: ReadonlyMap<string, number>,
  notes: Set<string>,
): CalendarEvent | null {
  const one = (key: string): Field | undefined => fields.get(key)?.[0];
  /** A time field read with its zone. "unknown" when the zone it names cannot be told. */
  const wallOf = (field: Field | undefined, value?: string): WallTime | null | "unknown" => {
    if (!field) return null;
    const named = field.params.get("TZID");
    const zone = named === undefined ? null : resolveZone(named, fixedZones);
    const wall = parseWall(
      value ?? field.value,
      zone,
      field.params.get("VALUE")?.toUpperCase() === "DATE",
    );
    // Only a time with no "Z" of its own leans on the zone named beside it.
    if (wall && named !== undefined && zone === null && !wall.dateOnly && wall.zone === null) {
      return "unknown";
    }
    return wall;
  };
  const start = wallOf(one("DTSTART"));
  if (start === "unknown") {
    notes.add(NOTE_ZONE);
    return null;
  }
  if (!start) return null;
  let end = wallOf(one("DTEND"));
  if (end === "unknown") {
    notes.add(NOTE_ZONE);
    return null;
  }
  // An end of another kind than the start (a day against a time) says nothing usable.
  if (end && end.dateOnly !== start.dateOnly) end = null;
  const durationMs = one("DURATION") ? parseDuration(one("DURATION")?.value ?? "") : null;

  const cancelled = (one("STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED";
  const replacedField = one("RECURRENCE-ID");
  const replaces = wallOf(replacedField);
  if (replaces === "unknown") {
    notes.add(NOTE_ZONE);
    return null;
  }
  // Called off altogether: nothing to show. Called off as one date of a repeating
  // entry: kept, to take that date out.
  if (cancelled && !replaces) return null;

  let rule: Rule | null = null;
  const ruleText = one("RRULE")?.value;
  if (ruleText !== undefined) {
    rule = parseRule(ruleText, start);
    if (!rule) notes.add(NOTE_REPEATS);
  }
  // Dates added one by one, a second rule, or dates ruled out by a rule: not worked out.
  if (fields.has("RDATE") || fields.has("EXRULE") || (fields.get("RRULE")?.length ?? 0) > 1) {
    notes.add(NOTE_REPEATS);
    if ((fields.get("RRULE")?.length ?? 0) > 1 || fields.has("EXRULE")) rule = null;
  }

  const except: WallTime[] = [];
  for (const field of fields.get("EXDATE") ?? []) {
    if (field.value.length > MAX_EXCEPTION_CHARS) {
      notes.add(NOTE_REPEATS);
      rule = null;
      break;
    }
    for (const word of field.value.split(",")) {
      const wall = wallOf(field, word);
      if (wall === "unknown" || except.length >= MAX_EXCEPTIONS) {
        // Which dates are taken out cannot be told, so the repeats are not shown at all.
        notes.add(wall === "unknown" ? NOTE_ZONE : NOTE_REPEATS);
        rule = null;
        break;
      }
      if (wall) except.push(wall);
    }
  }
  const andAfter = replacedField?.params.get("RANGE")?.toUpperCase() === "THISANDFUTURE";
  if (andAfter) notes.add(NOTE_REPEATS);
  return {
    uid: (one("UID")?.value ?? "").slice(0, 300).trim(),
    title: clean(one("SUMMARY")?.value ?? "") || "(no title)",
    location: clean(one("LOCATION")?.value ?? ""),
    start,
    end,
    durationMs,
    rule,
    except,
    replaces,
    andAfter,
    cancelled,
    memo: {},
  };
}
