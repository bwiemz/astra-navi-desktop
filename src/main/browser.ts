import { BrowserWindow, session, type Session } from "electron";
import { isPlainWebAddress, isPublicIp } from "../core/permissions.ts";
import { unwrapResultUrl, type SearchResult } from "../core/web.ts";

/**
 * The assistant's own web browser: a real browser window that she operates, the way a
 * person would, instead of fetching pages behind the scenes.
 *
 * It says what it is (the browser's name includes this app's), keeps nothing between
 * runs, cannot download, cannot reach this computer or the local network, and is given
 * no permissions. When a site asks for proof that a human is there, the window is shown
 * to the user to answer; nothing here tries to get around such a check.
 */
const LOAD_TIMEOUT_MS = 20_000;
const SCRIPT_TIMEOUT_MS = 8_000;
const HUMAN_CHECK_TIMEOUT_MS = 120_000;
const MAX_PAGE_CHARS = 6000;
/** A host found to be public is trusted for this long before being looked up again. */
const HOST_TRUST_MS = 60_000;

export interface BrowserDeckOptions {
  /** Tells the user why a browser window has just appeared. */
  onNeedsHuman(message: string): void;
  /** True once the app is closing, when the window must really close rather than hide. */
  isQuitting(): boolean;
}

interface RawResult {
  title: string;
  href: string;
  snippet: string;
}

const READ_RESULTS = `[...document.querySelectorAll(".result")].slice(0, 10).map((r) => ({
  title: String(r.querySelector(".result__a")?.innerText ?? "").slice(0, 300),
  href: String(r.querySelector(".result__a")?.getAttribute("href") ?? "").slice(0, 2000),
  snippet: String(r.querySelector(".result__snippet")?.innerText ?? "").slice(0, 600),
}))`;
const READ_PAGE = `({
  text: String((document.querySelector("main, article") ?? document.body)?.innerText ?? "").slice(0, 40000),
  url: String(location.href).slice(0, 2000),
  title: String(document.title).slice(0, 300),
})`;

export class BrowserDeck {
  private readonly options: BrowserDeckOptions;
  private window: BrowserWindow | null = null;
  private session: Session | null = null;
  /** Hosts recently confirmed public, with when that confirmation runs out. */
  private readonly publicUntil = new Map<string, number>();
  /** One page at a time: the next request waits for the one before it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserDeckOptions) {
    this.options = options;
  }

  search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    return this.inTurn(() => this.runSearch(query, signal));
  }

  read(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; text: string; shortened: boolean }> {
    return this.inTurn(() => this.runRead(url, signal));
  }

  dispose(): void {
    this.discardWindow();
  }

  /** Runs one operation at a time, and leaves no page running afterwards. */
  private inTurn<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain
      .catch(() => undefined)
      .then(task)
      .finally(() => this.leavePage());
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * Navigates away once she has what she came for. A page left open would keep running
   * its scripts in the background, with time to try things a quick visit does not allow.
   */
  private async leavePage(): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.hide();
    await window.webContents.loadURL("about:blank").catch(() => undefined);
  }

  private discardWindow(): void {
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  /** True when a host is on the public internet right now. */
  private async isPublicHost(host: string): Promise<boolean> {
    const trustedUntil = this.publicUntil.get(host);
    if (trustedUntil !== undefined && trustedUntil > Date.now()) return true;
    this.publicUntil.delete(host);
    if (!isPlainWebAddress(`https://${host}/`)) return false;
    try {
      const resolved = await this.browsingSession().resolveHost(host);
      const isPublic =
        resolved.endpoints.length > 0 && resolved.endpoints.every((end) => isPublicIp(end.address));
      // Only a "yes" is remembered, and only briefly: a failed lookup must not lock the
      // host out for good, and a name must not keep its pass after it starts pointing elsewhere.
      if (isPublic) this.publicUntil.set(host, Date.now() + HOST_TRUST_MS);
      return isPublic;
    } catch {
      return false;
    }
  }

  private browsingSession(): Session {
    if (this.session) return this.session;
    // No "persist:" prefix: cookies and cache live in memory and vanish with the app.
    const browsing = session.fromPartition("aichan-browser");
    browsing.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browsing.setPermissionCheckHandler(() => false);
    browsing.on("will-download", (event) => event.preventDefault());
    browsing.webRequest.onBeforeRequest((details, callback) => {
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        callback({ cancel: true });
        return;
      }
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        callback({ cancel: false });
        return;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        callback({ cancel: true });
        return;
      }
      void this.isPublicHost(url.hostname).then((isPublic) => callback({ cancel: !isPublic }));
    });
    // The lookup in isPublicHost goes through this same session's resolver, so it sees
    // the answer the connection itself will use. A name cannot be switched to a private
    // address between the check and the connection without that cache entry expiring,
    // and no page is left open long enough for that: see leavePage.
    this.session = browsing;
    return browsing;
  }

  private browser(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      title: "AI-chan's browser",
      autoHideMenuBar: true,
      webPreferences: {
        session: this.browsingSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    // Without this a page could probe the local network over WebRTC, which the request filter never sees.
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    // Closing it only tucks it away again; she may need it for the next search.
    window.on("close", (event) => {
      if (this.window !== window || this.options.isQuitting()) return;
      event.preventDefault();
      window.hide();
    });
    this.window = window;
    return window;
  }

  private async load(url: string, signal?: AbortSignal): Promise<BrowserWindow> {
    const window = this.browser();
    const contents = window.webContents;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("The page took too long to load.")),
        LOAD_TIMEOUT_MS,
      );
      const onAbort = (): void => finish(new Error("Stopped."));
      const onLoaded = (): void => finish(null);
      const onGone = (): void => finish(new Error("The page was closed."));
      const onFailed = (
        _event: unknown,
        code: number,
        description: string,
        _url: string,
        isMainFrame: boolean,
      ): void => {
        // -3 is "aborted", which a redirect also produces; the next load event settles it.
        if (isMainFrame && code !== -3)
          finish(new Error(`The page could not be opened (${description}).`));
      };
      const finish = (error: Error | null): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!contents.isDestroyed()) {
          contents.off("did-finish-load", onLoaded);
          contents.off("did-fail-load", onFailed);
          contents.off("destroyed", onGone);
          if (error) contents.stop();
        }
        if (error) reject(error);
        else resolve();
      };
      if (signal?.aborted) {
        finish(new Error("Stopped."));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      contents.on("did-finish-load", onLoaded);
      contents.on("did-fail-load", onFailed);
      contents.once("destroyed", onGone);
      contents.loadURL(url).catch(() => undefined); // failures arrive through did-fail-load
    });
    return window;
  }

  /**
   * Runs a small script in the page and returns its result. A page that hangs (an endless
   * loop of its own) cannot hold her up: after a few seconds the window is thrown away.
   */
  private async inPage<T>(window: BrowserWindow, script: string, signal?: AbortSignal): Promise<T> {
    if (window.isDestroyed()) throw new Error("The page was closed.");
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        window.webContents.executeJavaScript(script) as Promise<T>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("The page stopped responding.")),
            SCRIPT_TIMEOUT_MS,
          );
          onAbort = () => reject(new Error("Stopped."));
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      this.discardWindow(); // a fresh window next time, whatever state this one was in
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  private async readResults(window: BrowserWindow, signal?: AbortSignal): Promise<SearchResult[]> {
    const raw = await this.inPage<RawResult[]>(window, READ_RESULTS, signal);
    const results: SearchResult[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const url = unwrapResultUrl(String(item.href));
      // Sponsored results point back at the search engine; skip them.
      if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
      results.push({
        title: String(item.title).replace(/\s+/g, " ").trim().slice(0, 200),
        url,
        snippet: String(item.snippet).replace(/\s+/g, " ").trim().slice(0, 400),
      });
      if (results.length >= 6) break;
    }
    return results;
  }

  private async runSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const window = await this.load(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      signal,
    );
    const results = await this.readResults(window, signal);
    if (results.length > 0) return results;

    const text = await this.inPage<string>(
      window,
      "String(document.body?.innerText ?? '').slice(0, 4000)",
      signal,
    );
    if (!/challenge|bots use|unusual traffic|captcha|human/i.test(String(text))) return [];

    // The site wants a person. Show it to one, and wait.
    this.options.onNeedsHuman(
      "The search engine wants proof that a person is here. Its question is in the browser window that just opened. Answer it and the search carries on; close the window to skip the search.",
    );
    window.show();
    const deadline = Date.now() + HUMAN_CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Stopped.");
      if (window.isDestroyed() || !window.isVisible()) {
        throw new Error(
          "The search engine's question was not answered, so the search was not done.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const now = await this.readResults(window, signal).catch(() => []);
      if (now.length > 0) return now;
    }
    throw new Error(
      "The search engine's question was not answered in time, so the search was not done.",
    );
  }

  private async runRead(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; text: string; shortened: boolean }> {
    if (!isPlainWebAddress(url)) {
      throw new Error(`Refusing to open "${url}": it is not an ordinary public web address.`);
    }
    const window = await this.load(url, signal);
    // Pages that build themselves with scripts need a moment after "loaded".
    await new Promise((resolve) => setTimeout(resolve, 700));
    const page = await this.inPage<{ text: string; url: string; title: string }>(
      window,
      READ_PAGE,
      signal,
    );
    const text = `${String(page.title)}\n\n${String(page.text)}`
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => /[\p{L}\p{N}]/u.test(line))
      .join("\n");
    return {
      url: String(page.url),
      text: text.slice(0, MAX_PAGE_CHARS),
      shortened: text.length > MAX_PAGE_CHARS,
    };
  }
}
