import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isPlainWebAddress, isPublicIp } from "./permissions.ts";

/**
 * Web access without any account or key: search results come from DuckDuckGo's plain
 * HTML pages, and pages are fetched directly and reduced to their text.
 */

/** Says plainly what is making the request; sites that do not want automated visitors can refuse. */
const USER_AGENT =
  "AI-chan-Desktop/0.1 (local desktop assistant; fetches pages a user asked about)";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 6000;
/**
 * How much of a page's markup is looked at. The patterns below can take time that grows
 * with the square of the input on a page built to make them, so the input is bounded.
 */
const MAX_MARKUP_CHARS = 400_000;
const MAX_REDIRECTS = 5;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Where the result came from, when several places were asked ("Wikipedia", "Stack Overflow"). */
  source?: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const known = Object.hasOwn(ENTITIES, name)
      ? ENTITIES[name]
      : Object.hasOwn(ENTITIES, name.toLowerCase())
        ? ENTITIES[name.toLowerCase()]
        : undefined;
    if (known !== undefined) return known;
    if (name.startsWith("#")) {
      const code =
        name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) return String.fromCodePoint(code);
    }
    return match;
  });
}

/*
 * Pages are written by strangers, some of them hostile, so nothing below may take time
 * that grows faster than the page does. Patterns that could rescan the rest of the page
 * from every "<" are bounded, and blocks are cut out by searching forward once.
 */

/** Removes tags, leaving their text. A "<" with no ">" within reach is left as it is. */
function dropTags(html: string): string {
  return html.replace(/<[^<>]{1,3000}>/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(dropTags(html)).replace(/\s+/g, " ").trim();
}

/** Cuts whole elements out (scripts, menus), from each opening tag to its closing tag. */
function dropBlocks(html: string, tags: readonly string[]): string {
  const lower = html.toLowerCase();
  const opening = new RegExp(`<(${tags.join("|")})\\b`, "g");
  let kept = "";
  let at = 0;
  for (;;) {
    opening.lastIndex = at;
    const found = opening.exec(lower);
    if (!found) break;
    kept += `${html.slice(at, found.index)} `;
    const closing = lower.indexOf(`</${found[1] ?? ""}`, found.index);
    // Never closed: everything after it belongs to it.
    if (closing === -1) return kept;
    const end = lower.indexOf(">", closing);
    if (end === -1) return kept;
    at = end + 1;
  }
  return kept + html.slice(at);
}

function dropComments(html: string): string {
  let kept = "";
  let at = 0;
  for (;;) {
    const start = html.indexOf("<!--", at);
    if (start === -1) break;
    kept += `${html.slice(at, start)} `;
    const end = html.indexOf("-->", start + 4);
    if (end === -1) return kept;
    at = end + 3;
  }
  return kept + html.slice(at);
}

/** The inside of the page's <main> or <article>, when it has one. */
function mainContent(html: string): string | null {
  const lower = html.toLowerCase();
  for (const tag of ["main", "article"]) {
    const open = lower.search(new RegExp(`<${tag}\\b`));
    if (open === -1) continue;
    const start = lower.indexOf(">", open);
    const end = lower.lastIndexOf(`</${tag}`);
    if (start !== -1 && end > start) return html.slice(start + 1, end);
  }
  return null;
}

const CLUTTER = ["script", "style", "noscript", "svg", "nav", "header", "footer", "form", "iframe", "template"]; // prettier-ignore

/** Turns a web page into readable text: no scripts, no menus, no markup. */
export function htmlToText(whole: string): string {
  const html = whole.slice(0, MAX_MARKUP_CHARS);
  const title = /<title[^<>]{0,200}>([^<]{0,500})<\/title>/i.exec(html)?.[1];
  // When the page marks its main content, read only that: it leaves out menus and sidebars.
  const body = dropTags(
    dropBlocks(dropComments(mainContent(html) ?? html), CLUTTER)
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>|<br\s{0,10}\/?>/gi, "\n")
      .replace(/<li[^<>]{0,500}>/gi, "- "),
  );
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .join("\n");
  return title ? `${stripTags(title)}\n\n${text}` : text;
}

export interface PageLink {
  text: string;
  url: string;
}

/**
 * The links in a page's main content that lead somewhere else: its sources and further
 * reading. Menus, share buttons, anchors within the page and the site's own pages are left out,
 * since those are navigation, not references.
 */
export function pageLinks(whole: string, pageUrl: string, limit = 14): PageLink[] {
  const html = whole.slice(0, MAX_MARKUP_CHARS);
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const content = dropBlocks(mainContent(html) ?? html, CLUTTER);
  const found: PageLink[] = [];
  const seen = new Set<string>();
  const anchor =
    /<a\b[^<>]{0,1500}?\bhref\s{0,5}=\s{0,5}["']([^"'#<>][^"'<>]{0,600})["'][^<>]{0,1500}>([\s\S]{0,400}?)<\/a>/gi;
  for (const match of content.matchAll(anchor)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[1] ?? ""), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || url.hostname === base.hostname) continue;
    url.hash = "";
    const address = url.toString();
    const text = stripTags(match[2] ?? "").slice(0, 90);
    if (seen.has(address) || address.length > 300 || !isPlainWebAddress(address)) continue;
    // A link with no words (an icon) or a bare number (a footnote marker) says nothing about where it goes.
    if (text.length < 4 || /^\[?\d+\]?$/.test(text)) continue;
    seen.add(address);
    found.push({ text, url: address });
    if (found.length >= limit) break;
  }
  return found;
}

/** DuckDuckGo wraps result links in a redirect; this recovers the real address. */
export function unwrapResultUrl(href: string): string | null {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(absolute, "https://duckduckgo.com");
    const target = url.hostname.endsWith("duckduckgo.com")
      ? url.searchParams.get("uddg")
      : url.toString();
    return target && /^https?:\/\//i.test(target) ? target : null;
  } catch {
    return null;
  }
}

export function parseSearchResults(html: string, limit = 6): SearchResult[] {
  const results: SearchResult[] = [];
  const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [
    ...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi),
  ];
  let index = 0;
  for (const match of html.matchAll(link)) {
    const url = unwrapResultUrl(decodeEntities(match[1] ?? ""));
    const snippet = stripTags(snippets[index]?.[1] ?? "");
    index += 1;
    // Sponsored results point back at the search engine; skip them.
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    results.push({ title: stripTags(match[2] ?? ""), url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * A public-looking name can still point at this computer or the local network
 * (`127.0.0.1.nip.io`). This looks the name up, refuses those, and returns the address
 * to connect to, so the connection cannot be sent somewhere else by a second lookup.
 */
async function resolvePublicHost(url: URL, allowLocal = false): Promise<PinnedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await lookup(host, { all: true });
  const first = addresses[0];
  if (!first || (!allowLocal && addresses.some((entry) => !isPublicIp(entry.address)))) {
    throw new Error(
      `Refusing to open "${url.href}": that name leads to this computer or the local network.`,
    );
  }
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** One GET request to exactly the address that was checked. */
function get(
  url: URL,
  pinned: PinnedAddress,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: "GET",
        signal,
        headers: {
          "user-agent": USER_AGENT,
          "accept-language": "en-US,en;q=0.9",
          accept: "text/html,*/*;q=0.8",
          "accept-encoding": "gzip, br",
          ...extraHeaders,
        },
        // Called in place of a DNS lookup: always answers with the address already vetted.
        lookup: (_host, options, callback) => {
          if (typeof options === "object" && options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

/** Reads a response body as text, undoing compression and stopping at the size limit. */
async function readLimited(response: IncomingMessage): Promise<string> {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
  const body: Readable =
    encoding === "gzip"
      ? response.pipe(createGunzip())
      : encoding === "br"
        ? response.pipe(createBrotliDecompress())
        : encoding === "deflate"
          ? response.pipe(createInflate())
          : response;
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      parts.push(chunk);
      total += chunk.length;
      if (total >= MAX_BYTES) break;
    }
  } finally {
    response.destroy();
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(parts).subarray(0, MAX_BYTES));
}

/**
 * @param trusted The address was built by this program (the search engine's), so the
 *   limits meant for addresses the model supplies do not apply to the first request.
 */
async function fetchText(
  target: string,
  signal?: AbortSignal,
  trusted = false,
  options: { headers?: Record<string, string>; timeoutMs?: number; allowLocal?: boolean } = {},
): Promise<{ text: string; url: string }> {
  let address = target;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Checked on every hop, so a public page cannot bounce the request to this computer or network.
    if (!(trusted && hop === 0) && !isPlainWebAddress(address)) {
      throw new Error(`Refusing to open "${address}": it is not an ordinary public web address.`);
    }
    const url = new URL(address);
    // Extra headers (an API key, say) go only to the address they were meant for, never on after a redirect.
    const response = await get(
      url,
      // A service the user runs themselves may be on this computer; nothing else may.
      await resolvePublicHost(url, options.allowLocal === true && hop === 0),
      stop,
      hop === 0 ? options.headers : undefined,
    );
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.destroy();
      address = new URL(location, url).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`The site answered with error ${status}.`);
    }
    const type = String(response.headers["content-type"] ?? "");
    if (!/text\/|json|xml/i.test(type)) {
      response.destroy();
      throw new Error(`That address is not a text page (${type || "unknown type"}).`);
    }
    return { text: await readLimited(response), url: address };
  }
  throw new Error("Too many redirects.");
}

/**
 * Asks a service that is meant to be used by programs for JSON. The address is built by
 * this app, never by the model.
 */
export async function fetchJson(
  address: string,
  options: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    timeoutMs?: number;
    /** The address is one the user typed into their settings, so it may be on this computer. */
    allowLocal?: boolean;
  } = {},
): Promise<unknown> {
  const { text } = await fetchText(address, options.signal, true, {
    headers: { accept: "application/json", ...options.headers },
    timeoutMs: options.timeoutMs,
    allowLocal: options.allowLocal,
  });
  return JSON.parse(text) as unknown;
}

/**
 * Searches the web through DuckDuckGo's plain HTML page, which needs no account or key.
 * It sometimes answers with a "prove you are human" check instead of results, usually
 * after many searches in a short time. That is reported as a refusal, not as "nothing
 * found", and no attempt is made to get around it.
 */
export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const address = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { text } = await fetchText(address, signal, true);
  const results = parseSearchResults(text);
  if (results.length === 0 && /challenge|anomaly|captcha|unusual traffic/i.test(text)) {
    throw new Error(
      "The search engine is refusing automated searches right now. Try again in a few minutes.",
    );
  }
  return results;
}

/** Fetches a page and returns its text, shortened to a size a small model can read. */
export async function readWebPage(
  address: string,
  signal?: AbortSignal,
): Promise<{ url: string; text: string; shortened: boolean; links?: PageLink[] }> {
  const { text, url } = await fetchText(address, signal);
  const isHtml = /<html|<body|<div|<p[\s>]/i.test(text);
  const readable = isHtml ? htmlToText(text) : text;
  return {
    url,
    text: readable.slice(0, MAX_PAGE_CHARS),
    shortened: readable.length > MAX_PAGE_CHARS,
    links: isHtml ? pageLinks(text, url) : [],
  };
}
