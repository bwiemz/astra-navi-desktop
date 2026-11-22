import type { LanguageCode } from "./languages.ts";
import { decodeEntities, fetchJson, type SearchResult } from "./web.ts";

/**
 * Looking things up without an account or a key. Search engines made for people turn
 * automated visitors away, so her everyday lookups go to places that publish an
 * interface for programs and ask only for a polite, honest client: Wikipedia,
 * DuckDuckGo's instant answers, Stack Overflow, the Arch Linux wiki, Hacker News and
 * Open-Meteo. A search engine is asked as well when the user has set one up, and her
 * own browser is the last resort.
 */

const SOURCE_TIMEOUT_MS = 7000;

type Json = Record<string, unknown>;
function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
/** Search excerpts come with highlighting markup; this leaves the words. */
function plain(html: string, max = 300): string {
  const flat = decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const WIKIPEDIA_HOST: Record<LanguageCode, string> = {
  en: "en.wikipedia.org",
  ja: "ja.wikipedia.org",
  zh: "zh.wikipedia.org",
};

export function readWikipedia(body: unknown, host: string): SearchResult[] {
  if (!isObject(body)) return [];
  return list(body["pages"]).map((page) => ({
    title: text(page["title"]),
    url: `https://${host}/wiki/${encodeURIComponent(text(page["key"]))}`,
    snippet: [text(page["description"]), plain(text(page["excerpt"]))].filter(Boolean).join(": "),
    source: "Wikipedia",
  }));
}

export function readInstantAnswer(body: unknown): SearchResult[] {
  if (!isObject(body)) return [];
  const results: SearchResult[] = [];
  const answer = plain(text(body["Answer"]));
  const abstract = plain(text(body["AbstractText"]), 500);
  const url = text(body["AbstractURL"]);
  if (answer)
    results.push({ title: "Direct answer", url: "", snippet: answer, source: "DuckDuckGo" });
  if (abstract && /^https?:\/\//.test(url)) {
    results.push({
      title: text(body["Heading"]) || "Summary",
      url,
      snippet: abstract,
      source: text(body["AbstractSource"]) || "DuckDuckGo",
    });
  }
  // The subject's own website, when there is one: the best place to read further.
  for (const official of list(body["Results"]).slice(0, 1)) {
    const address = text(official["FirstURL"]);
    if (/^https?:\/\//.test(address)) {
      results.push({
        title: `${text(body["Heading"]) || "Official site"} (official site)`,
        url: address,
        snippet: plain(text(official["Text"])) || "The subject's own website.",
        source: "DuckDuckGo",
      });
    }
  }
  return results;
}

export function readStackOverflow(body: unknown): SearchResult[] {
  if (!isObject(body)) return [];
  return list(body["items"])
    .filter((item) => item["is_answered"] === true && Number(item["score"]) >= 1)
    .map((item) => ({
      title: plain(text(item["title"])),
      url: text(item["link"]),
      snippet: `Answered question, score ${Number(item["score"])}, tags: ${
        Array.isArray(item["tags"]) ? item["tags"].slice(0, 4).join(", ") : ""
      }`,
      source: "Stack Overflow",
    }))
    .filter((result) => /^https:\/\/stackoverflow\.com\//.test(result.url));
}

/** Reads the Arch wiki's answer to "which pages have a title starting with this word?". */
export function readArchWiki(body: unknown): SearchResult[] {
  if (!Array.isArray(body)) return [];
  const titles: unknown = body[1];
  const addresses: unknown = body[3];
  if (!Array.isArray(titles) || !Array.isArray(addresses)) return [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  titles.forEach((title, index) => {
    const url = text(addresses[index]);
    const name = text(title);
    // Translations of a page ("PipeWire (Italiano)") and a second spelling of one title are left out.
    if (!name || /\([^)]+\)/.test(name) || seen.has(name.toLowerCase())) return;
    if (!/^https:\/\/wiki\.archlinux\.org\//.test(url)) return;
    seen.add(name.toLowerCase());
    results.push({
      title: name,
      url,
      snippet: "The Arch Linux wiki's page on this: set-up, configuration and troubleshooting.",
      source: "Arch Wiki",
    });
  });
  return results;
}

export function readHackerNews(body: unknown): SearchResult[] {
  if (!isObject(body)) return [];
  return list(body["hits"])
    .map((hit) => ({
      title: plain(text(hit["title"])),
      url: /^https?:\/\//.test(text(hit["url"]))
        ? text(hit["url"])
        : `https://news.ycombinator.com/item?id=${text(hit["objectID"])}`,
      snippet: `${text(hit["created_at"]).slice(0, 10)}, ${Number(hit["points"]) || 0} points on Hacker News`,
      source: "Hacker News",
    }))
    .filter((result) => result.title.length > 0);
}

export function readSearxng(body: unknown): SearchResult[] {
  if (!isObject(body)) return [];
  return list(body["results"])
    .map((result) => ({
      title: plain(text(result["title"])),
      url: text(result["url"]),
      snippet: plain(text(result["content"])),
    }))
    .filter((result) => /^https?:\/\//.test(result.url));
}

export function readBrave(body: unknown): SearchResult[] {
  if (!isObject(body) || !isObject(body["web"])) return [];
  return list(body["web"]["results"])
    .map((result) => ({
      title: plain(text(result["title"])),
      url: text(result["url"]),
      snippet: plain(text(result["description"])),
    }))
    .filter((result) => /^https?:\/\//.test(result.url));
}

const FILLER: ReadonlySet<string> = new Set(
  (
    "a an and are as at be best better between but by can compare compared comparison could did " +
    "differ difference differences different do does for from good has have how i if in into is it " +
    "its me my of on or reason reasons run should so still than that the their there these they " +
    "this to today use used using versus vs was what when where which who why will with would you your any"
  ).split(" "),
);

/**
 * The few words of a question that a keyword search can work with. The open sources
 * match words, not meaning: asked "how does PipeWire differ from PulseAudio on Linux",
 * they find nothing, and asked "PipeWire PulseAudio" they find the right pages.
 * Names (words with a capital or a digit inside the sentence) are preferred.
 */
export function keyTerms(query: string, most = 4): string {
  // Languages written without spaces are left as they are.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)) return query;
  const words: string[] = query.match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [];
  const meaningful = words.filter((word) => !FILLER.has(word.toLowerCase()));
  // A capital inside a word, a digit, or a capital on a word that does not start the sentence.
  const names = meaningful.filter(
    (word) =>
      /\d/.test(word) || /^.+[A-Z]/.test(word) || (/^[A-Z]/.test(word) && word !== words[0]),
  );
  const chosen = [...new Set(names.length >= 2 ? names : meaningful)].slice(0, most);
  return chosen.length > 0 ? chosen.join(" ") : query;
}

export interface SearchSetup {
  language: LanguageCode;
  /** Ask the Arch Linux wiki too (worth it on Arch and its relatives). */
  linux: boolean;
  /** The user's own SearXNG, if they run one: its base address. */
  searxngUrl?: string | null;
  /** The user's own Brave Search API key, if they have one. */
  braveApiKey?: string | null;
  /**
   * Asked before each search sent to Brave. False means this month's allowance is
   * spent, and the search goes to the open sources only. Left out: no limit.
   */
  mayAskBrave?(): boolean;
  /** Her own browser, as a last resort: it may put a "prove you are human" window on screen. */
  browser?: (query: string, signal?: AbortSignal) => Promise<SearchResult[]>;
}

const LOOKS_RECENT =
  /\b(?:news|latest|newest|recent|release[ds]?|announce[ds]?|this (?:week|month|year)|20[2-9]\d)\b/i;
const ENOUGH = 3;

/**
 * Searches every place available and returns the results together, each marked with
 * where it came from. A source that fails or is slow is left out, not waited for.
 */
export async function searchEverywhere(
  query: string,
  setup: SearchSetup,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  // Keyword sources get the key words; a real search engine gets the question as asked.
  const terms = encodeURIComponent(keyTerms(query));
  const ask = async (
    address: string,
    read: (body: unknown) => SearchResult[],
    limit: number,
    headers?: Record<string, string>,
    allowLocal = false,
  ): Promise<SearchResult[]> => {
    try {
      return read(
        await fetchJson(address, { signal, headers, timeoutMs: SOURCE_TIMEOUT_MS, allowLocal }),
      ).slice(0, limit);
    } catch {
      return [];
    }
  };

  // A real search engine first, when the user has given her one.
  const engines: Promise<SearchResult[]>[] = [];
  if (setup.searxngUrl) {
    const base = setup.searxngUrl.replace(/\/+$/, "");
    engines.push(ask(`${base}/search?q=${q}&format=json`, readSearxng, 6, undefined, true));
  }
  if (setup.braveApiKey && (setup.mayAskBrave?.() ?? true)) {
    engines.push(
      ask(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=6`, readBrave, 6, {
        "X-Subscription-Token": setup.braveApiKey,
      }),
    );
  }

  const host = WIKIPEDIA_HOST[setup.language];
  const open: Promise<SearchResult[]>[] = [
    ask(
      `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
      readInstantAnswer,
      3,
    ),
    ask(
      `https://${host}/w/rest.php/v1/search/page?q=${terms}&limit=3`,
      (body) => readWikipedia(body, host),
      3,
    ),
    ask(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${terms}&site=stackoverflow&pagesize=4`,
      readStackOverflow,
      2,
    ),
  ];
  if (setup.linux) {
    // Its search wants a page title, so each of the two main words is tried by itself.
    for (const term of keyTerms(query, 2).split(" ").slice(0, 2)) {
      if (term.length < 3) continue;
      open.push(
        ask(
          `https://wiki.archlinux.org/api.php?action=opensearch&search=${encodeURIComponent(term)}&limit=4&format=json`,
          readArchWiki,
          1,
        ),
      );
    }
  }
  if (LOOKS_RECENT.test(query)) {
    open.push(
      ask(
        `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=3`,
        readHackerNews,
        3,
      ),
    );
  }

  const found = (await Promise.all([...engines, ...open])).flat();
  const seen = new Set<string>();
  const results = found.filter((result) => {
    const key = result.url || result.snippet;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (results.length >= ENOUGH || !setup.browser || signal?.aborted) return results;
  try {
    return [...results, ...(await setup.browser(query, signal))];
  } catch (error) {
    // What the open sources found is still worth having; with nothing at all, say why.
    if (results.length > 0) return results;
    throw error;
  }
}

/** What the weather service's numbered conditions mean. */
const CONDITIONS: ReadonlyMap<number, string> = new Map([
  [0, "clear"],
  [1, "mostly clear"],
  [2, "partly cloudy"],
  [3, "overcast"],
  [45, "fog"],
  [48, "freezing fog"],
  [51, "light drizzle"],
  [53, "drizzle"],
  [55, "heavy drizzle"],
  [56, "freezing drizzle"],
  [57, "freezing drizzle"],
  [61, "light rain"],
  [63, "rain"],
  [65, "heavy rain"],
  [66, "freezing rain"],
  [67, "freezing rain"],
  [71, "light snow"],
  [73, "snow"],
  [75, "heavy snow"],
  [77, "snow grains"],
  [80, "light showers"],
  [81, "showers"],
  [82, "violent showers"],
  [85, "snow showers"],
  [86, "heavy snow showers"],
  [95, "thunderstorm"],
  [96, "thunderstorm with hail"],
  [99, "thunderstorm with heavy hail"],
]);

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function degrees(celsius: unknown): string {
  const value = Number(celsius);
  if (!Number.isFinite(value)) return "?";
  return `${Math.round(value)}°C (${Math.round((value * 9) / 5 + 32)}°F)`;
}

/** Writes the weather service's answer as a few plain lines. */
export function describeWeather(place: string, body: unknown): string {
  if (!isObject(body) || !isObject(body["current"]) || !isObject(body["daily"])) {
    throw new Error("The weather service sent something unreadable.");
  }
  const { current, daily } = body;
  const condition = (code: unknown): string => CONDITIONS.get(Number(code)) ?? "unsettled";
  const lines = [
    `Weather for ${place} (from Open-Meteo):`,
    `Now: ${degrees(current["temperature_2m"])}, feels like ${degrees(current["apparent_temperature"])}, ${condition(current["weather_code"])}, wind ${Math.round(Number(current["wind_speed_10m"]) || 0)} km/h, humidity ${Math.round(Number(current["relative_humidity_2m"]) || 0)}%.`,
  ];
  const days = Array.isArray(daily["time"]) ? daily["time"] : [];
  const column = (name: string, index: number): unknown =>
    Array.isArray(daily[name]) ? (daily[name] as unknown[])[index] : undefined;
  days.forEach((day, index) => {
    // The weekday is spelled out: left to work it out from a date, a small model gets it wrong.
    const when = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(day));
    const weekday = when
      ? WEEKDAYS[new Date(Number(when[1]), Number(when[2]) - 1, Number(when[3])).getDay()]
      : "";
    const dated = [weekday, text(day)].filter(Boolean).join(" ");
    const label = index === 0 ? `Today (${dated})` : index === 1 ? `Tomorrow (${dated})` : dated;
    lines.push(
      `${label}: ${condition(column("weather_code", index))}, ${degrees(column("temperature_2m_min", index))} to ${degrees(column("temperature_2m_max", index))}, ${Math.round(Number(column("precipitation_probability_max", index)) || 0)}% chance of rain or snow.`,
    );
  });
  return lines.join("\n");
}

/**
 * The weather now and for the next few days in a named town.
 * @param place A town or city, optionally with a region or country ("Springfield, Illinois").
 */
export async function weatherReport(
  place: string,
  days: number,
  signal?: AbortSignal,
): Promise<string> {
  const wanted = place.trim().slice(0, 80);
  if (!/^[\p{L}\p{M}\p{N} .,'’-]+$/u.test(wanted)) {
    throw new Error("That does not look like the name of a place.");
  }
  // The geocoder matches on the town alone; a region or country after a comma narrows the choice.
  const [town = "", ...rest] = wanted.split(",").map((part) => part.trim());
  // The geocoder matches names in one language at a time, a two-character name must
  // match exactly, and Japanese and Chinese cities are listed with their suffix
  // ("京都市", "北京市"). So a name in those scripts is tried each way.
  const eastAsian = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(town);
  const attempts: [name: string, language: string][] = eastAsian
    ? [
        [town, "ja"],
        [`${town}市`, "ja"],
        [town, "zh"],
        [`${town}市`, "zh"],
      ]
    : [[town, "en"]];
  let candidates: Json[] = [];
  for (const [name, language] of attempts) {
    const found = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=${language}`,
      { signal, timeoutMs: SOURCE_TIMEOUT_MS },
    );
    candidates = isObject(found) ? list(found["results"]) : [];
    if (candidates.length > 0) break;
  }
  const hint = rest.join(" ").toLowerCase();
  const match =
    candidates.find(
      (candidate) =>
        hint.length > 0 &&
        [candidate["admin1"], candidate["country"], candidate["country_code"]].some(
          (part) => text(part).toLowerCase() === hint || text(part).toLowerCase().startsWith(hint),
        ),
    ) ?? candidates[0];
  if (!match)
    throw new Error(`No place called "${wanted}" was found. Try the nearest larger town.`);
  const name = [text(match["name"]), text(match["admin1"]), text(match["country"])]
    .filter(Boolean)
    .join(", ");
  const forecast = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${Number(match["latitude"])}&longitude=${Number(match["longitude"])}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      `&forecast_days=${Math.min(7, Math.max(1, Math.round(days)))}&timezone=auto`,
    { signal, timeoutMs: SOURCE_TIMEOUT_MS },
  );
  return describeWeather(name, forecast);
}
