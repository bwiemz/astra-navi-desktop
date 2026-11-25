import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stationPage } from "../src/core/stationPage.ts";
import { STATION_STYLE } from "../src/core/stationPageStyle.ts";

/**
 * The station page's own script, run here against a stand-in for a browser page: just
 * enough of one for the script to start, connect, lose its connection and be tapped.
 * Nothing is drawn; what is checked is what the script does.
 */

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  hidden = false;
  value = "";
  checked = false;
  disabled = false;
  className = "";
  open = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetWidth = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  box = { left: 0, top: 0, right: 0, bottom: 0 };
  /** Every value the element's text has been given, in order. */
  written: string[] = [];
  private text = "";
  private readonly listeners = new Map<string, Listener[]>();
  private readonly attributes = new Map<string, string>();
  private readonly classes = new Set<string>();
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
    this.written.push(value);
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  readonly classList = {
    add: (name: string): void => void this.classes.add(name),
    remove: (name: string): void => void this.classes.delete(name),
    contains: (name: string): boolean => this.classes.has(name),
    toggle: (name: string, on?: boolean): void => {
      if (on ?? !this.classes.has(name)) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    const full = { target: this, preventDefault: () => undefined, ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(full);
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((other) => other !== child);
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } {
    return this.box;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  click(): void {
    this.fire("click");
  }
  focus(): void {}
  requestSubmit(): void {}
  setSelectionRange(): void {}
  closest(): FakeElement | null {
    return null;
  }
}

/** One request for the stream of events, and the means to answer it or feed it. */
interface StreamCall {
  signal: AbortSignal | undefined;
  /** Answers the request with an open stream. */
  open(): void;
  /** Sends one event down the stream, as the station would. */
  send(message: Record<string, unknown>): void;
  /** Sends several in one piece, as they arrive when the station wrote them close together. */
  sendTogether(messages: Record<string, unknown>[]): void;
  bodyCancelled: boolean;
  readerCancelled: boolean;
}

/** One request other than for the stream, as the page made it. */
interface Asked {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface Reply {
  status: number;
  data: Record<string, unknown>;
}

/** The phone app, as the page sees it, with what the page asked of it written down. */
interface FakeApp {
  canUnlock(): boolean;
  hasKey(): boolean;
  keepKey(key: string): void;
  unlock(): void;
  forgetKey(): void;
  canPollAlerts?(): boolean;
  isAlertPollingOn?(): boolean;
  setAlertPolling?(on: boolean, token: string): void;
  canRecordVoice?(): boolean;
  startVoice?(): void;
  stopVoice?(): void;
  cancelVoice?(): void;
  takeNativeOutbox?(): string;
  kept: string | null;
  prompts: number;
}

interface Page {
  byId(id: string): FakeElement;
  fireOnDocument(type: string): void;
  streams: StreamCall[];
  /** When true, every request fails as it does with the PC switched off. */
  down: boolean;
  /** Every request but those for the stream, in order. */
  asked: Asked[];
  /** What the station answers, by "METHOD /path". Changed by a test to stand for another state of things. */
  answers: Record<string, (asked: Asked) => Reply>;
  /** When set, a request for the stream is refused with this in place of being left open. */
  streamRefusal: Reply | null;
  /** What the page hung on the window: the calls the phone app makes into it. */
  window: Record<string, (...given: unknown[]) => void>;
  /** Everything the page ever put in storage, by key. */
  storedEver: Map<string, string[]>;
  signIn(name?: string, password?: string): Promise<void>;
}

const SESSION = "s".repeat(43);
const KEY = "k".repeat(43);

function fakeApp(kept: string | null = null): FakeApp {
  const app: FakeApp = {
    kept,
    prompts: 0,
    canUnlock: () => true,
    hasKey: () => app.kept !== null,
    keepKey: (key) => {
      app.kept = key;
    },
    unlock: () => {
      app.prompts += 1;
    },
    forgetKey: () => {
      app.kept = null;
    },
  };
  return app;
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

function openPage(options: { paired: boolean; app?: FakeApp; account?: Reply["data"] }): Page {
  const html = stationPage("abc");
  const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const elements = new Map<string, FakeElement>();
  // Every element the page names starts as the markup has it: there, or hidden.
  for (const tag of html.matchAll(/<([a-z0-9]+)\b([^>]*\sid="([^"]+)"[^>]*)>/g)) {
    const found = new FakeElement(tag[1] ?? "div");
    found.hidden = /\shidden(\s|$)/.test(tag[2] ?? "");
    elements.set(tag[3] ?? "", found);
  }
  const body = new FakeElement("body");
  const documentListeners = new Map<string, Listener[]>();
  const page: Page = {
    byId: (id) => {
      const found = elements.get(id);
      if (!found) throw new Error(`the page has no #${id}`);
      return found;
    },
    fireOnDocument: (type) => {
      for (const listener of documentListeners.get(type) ?? []) listener({});
    },
    streams: [],
    down: false,
    asked: [],
    streamRefusal: null,
    window: {},
    storedEver: new Map(),
    answers: {
      "GET /account": () => ({
        status: 200,
        data: options.account ?? { set: true, signedIn: false, unlock: false, wait: 0 },
      }),
      "POST /sign-in": (asked) =>
        asked.body["password"] === "correct horse"
          ? { status: 200, data: { session: SESSION, unlock: false } }
          : {
              status: 401,
              data: { error: "That name or password is not right.", need: "sign-in" },
            },
      "POST /sign-out": () => ({ status: 200, data: { ok: true } }),
      "POST /reset": () => ({ status: 202, data: { ok: true } }),
      "POST /unlock": (asked) =>
        asked.body["key"] === KEY
          ? { status: 200, data: { session: SESSION, unlock: true } }
          : {
              status: 401,
              data: { error: "This device has to sign in with the password.", need: "sign-in" },
            },
      "POST /unlock-key": () => ({ status: 200, data: { key: KEY } }),
      "POST /unlock-key/forget": () => ({ status: 200, data: { ok: true } }),
      "POST /say": () => ({ status: 202, data: { ok: true } }),
      "POST /stop": () => ({ status: 202, data: { ok: true } }),
    },
    signIn: async (name = "captain", password = "correct horse") => {
      page.byId("sign-name").value = name;
      page.byId("sign-password").value = password;
      page.byId("sign-form").fire("submit");
      await settle();
    },
  };
  if (options.app) (page.window as Record<string, unknown>)["AiChanApp"] = options.app;
  const fakeDocument = {
    body,
    hidden: false,
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => {
      const node = new FakeElement("#text");
      node.textContent = text;
      return node;
    },
    addEventListener: (type: string, listener: Listener) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
  };
  const store = new Map<string, string>();
  if (options.paired) store.set("aichan.station.token", "token-of-this-device");
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
      page.storedEver.set(key, [...(page.storedEver.get(key) ?? []), value]);
    },
    removeItem: (key: string) => void store.delete(key),
  };
  const fakeFetch = (
    path: string,
    asked: {
      signal?: AbortSignal;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<unknown> => {
    if (page.down) return Promise.reject(new Error("no route to host"));
    const answered = (reply: Reply): unknown => ({
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: () => Promise.resolve(reply.data),
    });
    if (path !== "/events") {
      const made: Asked = {
        method: asked.method ?? "GET",
        path,
        headers: asked.headers ?? {},
        body:
          typeof asked.body === "string"
            ? (JSON.parse(asked.body) as Record<string, unknown>)
            : asked.body
              ? { bytes: (asked.body as { byteLength?: number }).byteLength ?? 0 }
              : {},
      };
      page.asked.push(made);
      const answer = page.answers[`${made.method} ${path}`];
      if (!answer) return Promise.reject(new Error(`unexpected request for ${path}`));
      return Promise.resolve(answered(answer(made)));
    }
    if (page.streamRefusal) return Promise.resolve(answered(page.streamRefusal));
    let answer: (response: unknown) => void = () => undefined;
    const waiting: ((part: { done: boolean; value?: Uint8Array }) => void)[] = [];
    const call: StreamCall = {
      signal: asked.signal,
      bodyCancelled: false,
      readerCancelled: false,
      open: () =>
        answer({
          status: 200,
          ok: true,
          body: {
            cancel: () => {
              call.bodyCancelled = true;
              return Promise.resolve();
            },
            getReader: () => ({
              read: () =>
                new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
                  waiting.push(resolve);
                }),
              cancel: () => {
                call.readerCancelled = true;
                return Promise.resolve();
              },
            }),
          },
        }),
      send: (message) => {
        const bytes = new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`);
        waiting.shift()?.({ done: false, value: bytes });
      },
      sendTogether: (messages) => {
        const text = messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join("");
        waiting.shift()?.({ done: false, value: new TextEncoder().encode(text) });
      },
    };
    page.streams.push(call);
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const run = new Function(
    "document",
    "window",
    "navigator",
    "location",
    "localStorage",
    "history",
    "fetch",
    script,
  ) as (...globals: unknown[]) => void;
  run(
    fakeDocument,
    page.window,
    { userAgent: "Mozilla/5.0 (Linux; Android 16) Mobile" },
    { hash: "", host: "192.168.1.20:8765", href: "" },
    fakeStorage,
    { replaceState: () => undefined },
    fakeFetch,
  );
  return page;
}

/** A paired page whose user has signed in: where everything about the conversation starts. */
async function openSignedIn(): Promise<Page> {
  const page = openPage({ paired: true });
  await settle();
  await page.signIn();
  return page;
}

describe("the station page's link to the PC", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the stream once, after signing in", async () => {
    const page = openPage({ paired: true });
    await settle();
    // Paired is not signed in: nothing of the conversation is asked for yet.
    expect(page.streams).toHaveLength(0);
    expect(page.byId("talk").hidden).toBe(true);
    await page.signIn();
    expect(page.streams).toHaveLength(1);
    expect(page.byId("talk").hidden).toBe(false);
  });

  it("ends a try that is still on its way before starting another", async () => {
    const page = await openSignedIn();
    const first = page.streams[0];
    page.byId("retry").click();
    expect(page.streams).toHaveLength(2);
    expect(first?.signal?.aborted).toBe(true);
    // The first answer turns up late all the same: it is closed unread, and the page is
    // not "linked" on the strength of it.
    first?.open();
    await settle();
    expect(first?.bodyCancelled).toBe(true);
    expect(page.byId("link").dataset["state"]).not.toBe("on");
    page.streams[1]?.open();
    await settle();
    expect(page.byId("link").dataset["state"]).toBe("on");
  });

  it("never listens to two streams: what an old one sends is ignored", async () => {
    const page = await openSignedIn();
    const first = page.streams[0];
    first?.open();
    await settle();
    first?.send({ type: "said", text: "one", from: "" });
    await settle();
    const thread = page.byId("thread");
    const saidSoFar = thread.children.filter((item) => item.className.startsWith("said")).length;
    expect(saidSoFar).toBe(1);

    // Looked at again after the phone slept, and "Try now" tapped as well.
    page.byId("link").dataset["state"] = "lost";
    page.fireOnDocument("visibilitychange");
    page.byId("retry").click();
    expect(page.streams).toHaveLength(3);
    expect(first?.readerCancelled).toBe(true);
    expect(page.streams[1]?.signal?.aborted).toBe(true);
    page.streams[2]?.open();
    await settle();

    first?.send({ type: "said", text: "from the stream that was dropped", from: "" });
    await settle();
    expect(thread.children.filter((item) => item.className.startsWith("said"))).toHaveLength(1);
    page.streams[2]?.send({ type: "said", text: "two", from: "" });
    await settle();
    expect(thread.children.filter((item) => item.className.startsWith("said"))).toHaveLength(2);
    // And no retry was left ticking by any of the dropped ones.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.streams).toHaveLength(3);
  });

  it("says once that she is not answering, while the seconds tick for the eye only", async () => {
    const page = await openSignedIn();
    page.down = true;
    page.streams[0]?.open();
    await settle();
    const words = page.byId("offline-words");
    const count = page.byId("offline-count");
    words.written = [];
    count.written = [];
    // The PC goes away: the stream ends, and every retry fails.
    page.byId("retry").click();
    await settle();
    expect(page.byId("offline").hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(words.written).toEqual(["She is not answering. The PC may be off or asleep."]);
    expect(count.written.length).toBeGreaterThan(5);
    expect(count.written.every((text) => text.startsWith("Trying again"))).toBe(true);

    const html = stationPage("abc");
    expect(html).toMatch(/id="offline-words" role="status"/);
    expect(html).toMatch(/id="offline-count" aria-hidden="true"/);
  });

  it("says it again the next time she goes quiet, after she has been back", async () => {
    const page = await openSignedIn();
    const words = page.byId("offline-words");
    page.down = true;
    page.byId("retry").click();
    await settle();
    expect(words.textContent).toContain("She is not answering");
    page.down = false;
    page.byId("retry").click();
    page.streams[page.streams.length - 1]?.open();
    await settle();
    expect(page.byId("offline").hidden).toBe(true);
    expect(words.textContent).toBe("");
  });
});

describe("the station page's sheet for this device", () => {
  function openSheet(): { page: Page; sheet: FakeElement } {
    const page = openPage({ paired: false });
    const sheet = page.byId("sheet");
    sheet.box = { left: 20, top: 200, right: 380, bottom: 700 };
    page.byId("menu-open").click();
    expect(sheet.open).toBe(true);
    return { page, sheet };
  }

  it("stays open for a tap on its own padding", () => {
    const { sheet } = openSheet();
    sheet.fire("click", { clientX: 24, clientY: 204 });
    expect(sheet.open).toBe(true);
  });

  it("stays open for a tap on something inside it", () => {
    const { page, sheet } = openSheet();
    sheet.fire("click", { target: page.byId("sheet-device"), clientX: 100, clientY: 300 });
    expect(sheet.open).toBe(true);
  });

  it("closes for a tap on the dimmed page behind it", () => {
    const { sheet } = openSheet();
    sheet.fire("click", { clientX: 200, clientY: 80 });
    expect(sheet.open).toBe(false);
  });
});

describe("signing in on the station page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sent = (page: Page, path: string): Asked[] =>
    page.asked.filter((asked) => asked.path === path);

  it("says to set a name and password on the PC when none are set, and looks again when asked", async () => {
    const page = openPage({
      paired: true,
      account: { set: false, signedIn: false, unlock: false, wait: 0 },
    });
    await settle();
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("no-account").hidden).toBe(false);
    expect(page.byId("sign-in").hidden).toBe(true);
    expect(page.streams).toHaveLength(0);
    // Still not set: said so, and the screen stays.
    page.byId("account-check").click();
    await settle();
    expect(page.byId("account-note").textContent).toContain("Not yet");
    // Set on the PC meanwhile: the sign-in form takes its place.
    page.answers["GET /account"] = () => ({
      status: 200,
      data: { set: true, signedIn: false, unlock: false, wait: 0 },
    });
    page.byId("account-check").click();
    await settle();
    expect(page.byId("no-account").hidden).toBe(true);
    expect(page.byId("sign-in").hidden).toBe(false);
  });

  it("signs in with the name and password, sends the session with what follows, and empties the password box", async () => {
    const page = openPage({ paired: true });
    await settle();
    expect(page.byId("sign-in").hidden).toBe(false);
    await page.signIn("captain", "correct horse");
    const signIn = sent(page, "/sign-in")[0];
    expect(signIn?.body).toEqual({ username: "captain", password: "correct horse" });
    expect(signIn?.headers["Authorization"]).toBe("Bearer token-of-this-device");
    expect(page.byId("sign-password").value).toBe("");
    expect(page.byId("sign").hidden).toBe(true);
    expect(page.byId("talk").hidden).toBe(false);

    page.byId("say").value = "hello";
    page.byId("say-form").fire("submit");
    await settle();
    expect(sent(page, "/say")[0]?.headers["X-Session"]).toBe(SESSION);
  });

  it("shows what the PC says about a wrong password, and how long to wait after too many", async () => {
    const page = openPage({ paired: true });
    await settle();
    await page.signIn("captain", "not it");
    expect(page.byId("sign-problem").textContent).toBe("That name or password is not right.");
    expect(page.byId("sign-password").value).toBe("");
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.streams).toHaveLength(0);

    const waiting = openPage({
      paired: true,
      account: { set: true, signedIn: false, unlock: false, wait: 540 },
    });
    await settle();
    expect(waiting.byId("sign-problem").textContent).toContain("Wait 9 minutes");
  });

  it("never writes the session, the name or the password to storage", async () => {
    const page = openPage({ paired: true });
    await settle();
    await page.signIn("captain", "correct horse");
    const everything = JSON.stringify([...page.storedEver.entries()]);
    expect(everything).not.toContain(SESSION);
    expect(everything).not.toContain("correct horse");
    expect(everything).not.toContain("captain");
    // And the page's own script never names a second place to keep things.
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(stationPage("abc"))?.[1] ?? "";
    expect(script).not.toMatch(/sessionStorage|document\.cookie|indexedDB/);
  });

  it("goes back to the sign-in screen when the PC says the session is over, keeping what was typed", async () => {
    const page = await openSignedIn();
    page.streams[0]?.open();
    await settle();
    page.answers["POST /say"] = () => ({
      status: 401,
      data: { error: "Sign in first.", need: "sign-in" },
    });
    page.byId("say").value = "half a thought";
    page.byId("say-form").fire("submit");
    await settle();
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("talk").hidden).toBe(true);
    expect(page.byId("sign-problem").textContent).toContain("Sign in again");
    expect(page.byId("say").value).toBe("half a thought");
    // The stream it had is closed, and nothing is retried behind the sign-in screen.
    expect(page.streams[0]?.readerCancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.streams).toHaveLength(1);
    // Signing in again picks the conversation back up.
    page.answers["POST /say"] = () => ({ status: 202, data: { ok: true } });
    await page.signIn();
    expect(page.streams).toHaveLength(2);
    expect(page.byId("say").value).toBe("half a thought");
  });

  it("does the same when the stream itself says so, or is refused", async () => {
    const page = await openSignedIn();
    page.streams[0]?.open();
    await settle();
    page.streams[0]?.send({ type: "signed-out" });
    await settle();
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("sign-problem").textContent).toContain("You were signed out");

    const refusedPage = openPage({ paired: true });
    await settle();
    refusedPage.streamRefusal = { status: 401, data: { error: "Sign in first.", need: "sign-in" } };
    await refusedPage.signIn();
    expect(refusedPage.byId("sign").hidden).toBe(false);
    expect(refusedPage.byId("talk").hidden).toBe(true);
  });

  it("tells a device that is no longer paired from one that is only signed out", async () => {
    const page = await openSignedIn();
    page.answers["POST /say"] = () => ({
      status: 401,
      data: { error: "This device is not paired with her." },
    });
    page.byId("say").value = "hello";
    page.byId("say-form").fire("submit");
    await settle();
    expect(page.byId("pair").hidden).toBe(false);
    expect(page.byId("sign").hidden).toBe(true);
    expect(page.byId("pair-problem").textContent).toContain("no longer paired");
  });

  it("signs out when asked: the PC is told while the session is still held", async () => {
    const page = await openSignedIn();
    page.byId("menu-open").click();
    page.byId("sign-out").click();
    await settle();
    expect(sent(page, "/sign-out")[0]?.headers["X-Session"]).toBe(SESSION);
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("sheet").open).toBe(false);
    // What follows no longer carries it.
    page.byId("reset").click();
    await settle();
    expect(sent(page, "/reset")[0]?.headers["X-Session"]).toBeUndefined();
  });

  it("asks the PC for a reset and says where the password is changed", async () => {
    const page = openPage({ paired: true });
    await settle();
    page.byId("reset").click();
    await settle();
    expect(sent(page, "/reset")).toHaveLength(1);
    expect(page.byId("reset-note").textContent).toContain("Change the password there");
    page.answers["POST /reset"] = () => ({
      status: 429,
      data: { error: "A reset has been asked for several times already." },
    });
    page.byId("reset").click();
    await settle();
    expect(page.byId("reset-note").textContent).toBe(
      "A reset has been asked for several times already.",
    );
  });

  it("tells the PC it is still in use when it is touched, at most once a minute, and never by itself", async () => {
    const page = await openSignedIn();
    page.answers["POST /active"] = () => ({ status: 200, data: { ok: true } });
    // Signing in was use enough for the first minute.
    page.fireOnDocument("pointerdown");
    await settle();
    expect(sent(page, "/active")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    // A page lying open says nothing, however long.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent(page, "/active")).toHaveLength(0);

    page.fireOnDocument("pointerdown");
    page.fireOnDocument("keydown");
    page.fireOnDocument("wheel");
    await settle();
    expect(sent(page, "/active")).toHaveLength(1);
    expect(sent(page, "/active")[0]?.method).toBe("POST");
    expect(sent(page, "/active")[0]?.headers["Authorization"]).toBe("Bearer token-of-this-device");
    expect(sent(page, "/active")[0]?.headers["X-Session"]).toBe(SESSION);

    await vi.advanceTimersByTimeAsync(59_000);
    page.fireOnDocument("keydown");
    await settle();
    expect(sent(page, "/active")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    page.fireOnDocument("keydown");
    await settle();
    expect(sent(page, "/active")).toHaveLength(2);
    expect(page.byId("talk").hidden).toBe(false);
  });

  it("says nothing of the kind before signing in, and signs out when the PC says the session is over", async () => {
    const page = openPage({ paired: true });
    await settle();
    page.answers["POST /active"] = () => ({
      status: 401,
      data: { error: "Sign in first.", need: "sign-in" },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    page.fireOnDocument("pointerdown");
    page.fireOnDocument("keydown");
    await settle();
    expect(sent(page, "/active")).toHaveLength(0);

    await page.signIn();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    page.fireOnDocument("pointerdown");
    await settle();
    expect(sent(page, "/active")).toHaveLength(1);
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("talk").hidden).toBe(true);
    expect(page.byId("sign-problem").textContent).toContain("Sign in again");
    // Signed out: a touch says nothing more.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    page.fireOnDocument("pointerdown");
    await settle();
    expect(sent(page, "/active")).toHaveLength(1);
  });

  it("carries on when the PC could not be reached to be told", async () => {
    const page = await openSignedIn();
    await vi.advanceTimersByTimeAsync(61_000);
    page.down = true;
    page.fireOnDocument("pointerdown");
    await settle();
    expect(page.byId("talk").hidden).toBe(false);
  });
});

describe("the phone's own check, in the app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sent = (page: Page, path: string): Asked[] =>
    page.asked.filter((asked) => asked.path === path);

  it("offers nothing of it in a plain browser", async () => {
    const page = await openSignedIn();
    page.byId("menu-open").click();
    expect(page.byId("unlock-setting").hidden).toBe(true);
    expect(page.byId("unlock-box").hidden).toBe(true);
  });

  it("switches on: a key from the PC is handed to the phone, and kept only if the phone says so", async () => {
    const app = fakeApp();
    const page = openPage({ paired: true, app });
    await settle();
    await page.signIn();
    page.byId("menu-open").click();
    expect(page.byId("unlock-setting").hidden).toBe(false);
    const toggle = page.byId("unlock-switch");
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.fire("change");
    await settle();
    expect(sent(page, "/unlock-key")).toHaveLength(1);
    expect(app.kept).toBe(KEY);
    page.window["aiChanKeyKept"]?.(true);
    expect(page.byId("unlock-note").textContent).toContain("On.");
    expect(toggle.checked).toBe(true);
    // Nowhere but in the phone's own keeping.
    expect(JSON.stringify([...page.storedEver.entries()])).not.toContain(KEY);
  });

  it("throws the PC's half away when the phone could not keep the key", async () => {
    const app = fakeApp();
    const page = openPage({ paired: true, app });
    await settle();
    await page.signIn();
    page.byId("menu-open").click();
    const toggle = page.byId("unlock-switch");
    toggle.checked = true;
    toggle.fire("change");
    await settle();
    page.window["aiChanKeyKept"]?.(false);
    await settle();
    expect(sent(page, "/unlock-key/forget")).toHaveLength(1);
    expect(toggle.checked).toBe(false);
    expect(page.byId("unlock-note").textContent).toContain("could not be switched on");
  });

  it("says what the PC says when the password was not typed just now, and stays signed in", async () => {
    const app = fakeApp();
    const page = openPage({ paired: true, app });
    await settle();
    await page.signIn();
    page.answers["POST /unlock-key"] = () => ({
      status: 403,
      data: {
        error: "Sign out, sign in with the password, and switch this on within five minutes.",
        need: "password",
      },
    });
    page.byId("menu-open").click();
    const toggle = page.byId("unlock-switch");
    toggle.checked = true;
    toggle.fire("change");
    await settle();
    expect(toggle.checked).toBe(false);
    expect(app.kept).toBeNull();
    expect(page.byId("unlock-note").textContent).toContain("within five minutes");
    expect(toggle.disabled).toBe(false);
    // Still signed in: being refused a new key is not being signed out.
    expect(page.byId("talk").hidden).toBe(false);
    expect(sent(page, "/sign-out")).toHaveLength(0);
  });

  it("goes to the sign-in screen when the session was over by the time it was switched on", async () => {
    const app = fakeApp();
    const page = openPage({ paired: true, app });
    await settle();
    await page.signIn();
    page.answers["POST /unlock-key"] = () => ({
      status: 401,
      data: { error: "Sign in first.", need: "sign-in" },
    });
    const toggle = page.byId("unlock-switch");
    toggle.checked = true;
    toggle.fire("change");
    await settle();
    expect(toggle.checked).toBe(false);
    expect(app.kept).toBeNull();
    expect(page.byId("sign").hidden).toBe(false);
  });

  it("puts up the phone's check at once on opening, and signs in with the key it hands back", async () => {
    const app = fakeApp(KEY);
    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    expect(page.byId("unlock-box").hidden).toBe(false);
    expect(app.prompts).toBe(1);
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    expect(sent(page, "/unlock")[0]?.body).toEqual({ key: KEY });
    expect(page.byId("talk").hidden).toBe(false);
    expect(page.streams).toHaveLength(1);
  });

  it("leaves the password form, and the button to try again, when the check is cancelled", async () => {
    const app = fakeApp(KEY);
    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlockFailed"]?.();
    expect(page.byId("sign-in").hidden).toBe(false);
    expect(page.byId("unlock-box").hidden).toBe(false);
    // Not put up again by itself; tapping the button does.
    expect(app.prompts).toBe(1);
    page.byId("unlock").click();
    expect(app.prompts).toBe(2);
    // The password still works.
    await page.signIn();
    expect(page.byId("talk").hidden).toBe(false);
  });

  it("forgets a key the PC no longer takes, and asks for the password", async () => {
    const app = fakeApp("an old key that was thrown away on the PC, 43ch");
    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlocked"]?.(app.kept);
    await settle();
    expect(app.kept).toBeNull();
    expect(page.byId("unlock-box").hidden).toBe(true);
    expect(page.byId("sign-problem").textContent).toBe(
      "This device has to sign in with the password.",
    );
    expect(page.byId("sign").hidden).toBe(false);
  });

  it("switches off: both halves are thrown away", async () => {
    const app = fakeApp(KEY);
    const page = openPage({ paired: true, app });
    await settle();
    await page.signIn();
    page.byId("menu-open").click();
    const toggle = page.byId("unlock-switch");
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.fire("change");
    await settle();
    expect(sent(page, "/unlock-key/forget")).toHaveLength(1);
    expect(app.kept).toBeNull();
    expect(page.byId("unlock-note").textContent).toContain("Off.");
  });

  it("locks when the app leaves the foreground, and asks again when it is back in front", async () => {
    const app = fakeApp(KEY);
    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    page.streams[0]?.open();
    await settle();
    page.byId("say").value = "written before the phone was put down";

    page.window["aiChanLock"]?.();
    await settle();
    expect(sent(page, "/sign-out")[0]?.headers["X-Session"]).toBe(SESSION);
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("talk").hidden).toBe(true);
    expect(page.streams[0]?.readerCancelled).toBe(true);
    // Nothing is put up while the app is out of sight.
    expect(app.prompts).toBe(1);

    page.window["aiChanShown"]?.();
    await settle();
    expect(app.prompts).toBe(2);
    expect(page.byId("unlock-box").hidden).toBe(false);
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    expect(page.byId("talk").hidden).toBe(false);
    expect(page.byId("say").value).toBe("written before the phone was put down");
  });

  it("does not answer a signing out by hand with the phone's check", async () => {
    const app = fakeApp(KEY);
    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    page.byId("menu-open").click();
    page.byId("sign-out").click();
    await settle();
    expect(page.byId("sign").hidden).toBe(false);
    expect(app.prompts).toBe(1);
    // The button is there for when it is wanted.
    expect(page.byId("unlock-box").hidden).toBe(false);
  });
});

describe("a mission's step, asked on the station page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sent = (page: Page, path: string): Asked[] =>
    page.asked.filter((asked) => asked.path === path);

  const FIRST = "Qm9yZWQtb2YtdGhpcy0x";
  const SECOND = "c2Vjb25kLXF1ZXN0aW9u";

  const card = (given: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: FIRST,
    mission: "Tidy the downloads folder",
    missionId: "mission-1",
    step: 2,
    steps: 5,
    title: "Delete the old installers",
    where: "this PC",
    command: "rm -- /home/captain/Downloads/setup-1.2.run",
    reason: "It deletes files, which cannot be undone.",
    askedAt: 1_700_000_000_000,
    ...given,
  });

  /** The cards on the page, in the order shown. */
  const shown = (page: Page): FakeElement[] =>
    page.byId("asks").children.filter((child) => child.className === "ask");

  const within = (root: FakeElement, name: string): FakeElement => {
    const search = (from: FakeElement): FakeElement | null => {
      if (from.className === name) return from;
      for (const child of from.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    const found = search(root);
    if (!found) throw new Error(`the card has no .${name}`);
    return found;
  };

  const buttonsOf = (root: FakeElement): { allow: FakeElement; deny: FakeElement } => {
    const all = within(root, "ask-buttons").children;
    const allow = all.find((button) => button.textContent === "Allow this step");
    const deny = all.find((button) => button.textContent === "Do not allow");
    if (!allow || !deny || all.length !== 2) throw new Error("the card has not its two buttons");
    return { allow, deny };
  };

  const theCard = (page: Page, at = 0): FakeElement => {
    const found = shown(page)[at];
    if (!found) throw new Error(`no card is shown at ${at}`);
    return found;
  };

  /** Signed in, the stream open and greeted, as it is before any question arrives. */
  const openListening = async (page?: Page): Promise<Page> => {
    const opened = page ?? (await openSignedIn());
    const stream = opened.streams[opened.streams.length - 1];
    stream?.open();
    await settle();
    stream?.send({ type: "hello", device: "Phone" });
    await settle();
    return opened;
  };

  /** How long a new card's buttons take no tap, as the page has it. */
  const CARD_WAKES_MS = 800;

  /**
   * Sends one event down the stream. A question is given the moment its buttons need
   * before they take a tap, unless `asleep` asks to see it as it first appears.
   */
  const say = async (
    page: Page,
    message: Record<string, unknown>,
    asleep = false,
  ): Promise<void> => {
    page.streams[page.streams.length - 1]?.send(message);
    await settle();
    if (message["type"] === "approval" && !asleep) {
      await vi.advanceTimersByTimeAsync(CARD_WAKES_MS);
    }
  };

  it("takes no room until a question arrives, and then shows all of it", async () => {
    const page = await openListening();
    expect(page.byId("asks").hidden).toBe(true);
    expect(shown(page)).toHaveLength(0);

    await say(page, { type: "approval", card: card() });
    expect(page.byId("asks").hidden).toBe(false);
    expect(shown(page)).toHaveLength(1);
    const root = theCard(page);
    expect(within(root, "ask-mission").textContent).toBe("Tidy the downloads folder, step 2 of 5");
    expect(within(root, "ask-title").textContent).toBe("Delete the old installers");
    expect(within(root, "ask-where").textContent).toBe("Runs on this PC:");
    expect(within(root, "ask-command").textContent).toBe(
      "rm -- /home/captain/Downloads/setup-1.2.run",
    );
    expect(within(root, "ask-command").tagName).toBe("PRE");
    expect(within(root, "ask-reason").textContent).toBe(
      "It deletes files, which cannot be undone.",
    );
    const { allow, deny } = buttonsOf(root);
    expect(allow.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
    // Nothing has been answered by its arriving.
    expect(sent(page, "/approve")).toHaveLength(0);
  });

  it("shows several at once, each with its own machine and the whole of a long command", async () => {
    const page = await openListening();
    const long = `ssh nas 'find /tank/backups -name "*.tar" -mtime +90 -print -delete' ${"&& echo next ".repeat(60)}`;
    await say(page, { type: "approval", card: card() });
    await say(page, {
      type: "approval",
      card: card({ id: SECOND, where: "nas", command: long, step: 3 }),
    });
    expect(shown(page)).toHaveLength(2);
    // How many there are is said above them, since the second may be out of sight.
    expect(within(page.byId("asks"), "asks-head").textContent).toBe(
      "2 steps are waiting for your answer",
    );
    expect(within(theCard(page, 1), "ask-where").textContent).toBe("Runs on nas:");
    expect(within(theCard(page, 1), "ask-command").textContent).toBe(long);
    // The same question told twice is one card.
    await say(page, { type: "approval", card: card() });
    expect(shown(page)).toHaveLength(2);
  });

  it("puts text that looks like markup on the card as text", async () => {
    const page = await openListening();
    const sly = "<img src=x onerror=\"fetch('/approve')\"><b>ok</b>";
    await say(page, {
      type: "approval",
      card: card({ mission: sly, title: sly, where: sly, command: sly, reason: sly }),
    });
    const root = theCard(page);
    for (const name of ["ask-mission", "ask-title", "ask-where", "ask-command", "ask-reason"]) {
      const piece = within(root, name);
      expect(piece.textContent).toContain(sly);
      // Written as one run of text: nothing was made out of it.
      expect(piece.children).toHaveLength(0);
    }
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(stationPage("abc"))?.[1] ?? "";
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("allows a step when its button is tapped, with both keys, and waits for the answer", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    await say(page, { type: "approval", card: card() });
    const { allow, deny } = buttonsOf(theCard(page));

    allow.click();
    // Until the PC answers, neither button can be tapped again.
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    deny.click();
    allow.click();
    await settle();
    const asked = sent(page, "/approve");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.method).toBe("POST");
    expect(asked[0]?.body).toEqual({ id: FIRST, allow: true });
    expect(asked[0]?.headers["Authorization"]).toBe("Bearer token-of-this-device");
    expect(asked[0]?.headers["X-Session"]).toBe(SESSION);

    // It says what was answered, and cannot be answered a second time.
    expect(within(theCard(page), "ask-note").textContent).toContain("Allowed");
    expect(within(theCard(page), "ask-buttons").hidden).toBe(true);
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    deny.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(1);

    await say(page, { type: "approval-gone", id: FIRST });
    expect(shown(page)).toHaveLength(0);
    expect(page.byId("asks").hidden).toBe(true);
  });

  it("refuses a step when the other button is tapped, and clears the card after a moment", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    await say(page, { type: "approval", card: card() });
    await say(page, { type: "approval", card: card({ id: SECOND }) });

    buttonsOf(theCard(page, 1)).deny.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(1);
    expect(sent(page, "/approve")[0]?.body).toEqual({ id: SECOND, allow: false });
    expect(within(theCard(page, 1), "ask-note").textContent).toContain("Not allowed");
    // The other question is untouched.
    expect(buttonsOf(theCard(page, 0)).allow.disabled).toBe(false);
    expect(within(theCard(page, 0), "ask-note").textContent).toBe("");

    // Should the stream never say it is gone, the card goes by itself.
    await vi.advanceTimersByTimeAsync(4000);
    expect(shown(page)).toHaveLength(1);
    expect(theCard(page).dataset["id"]).toBe(FIRST);
    expect(page.byId("asks").hidden).toBe(false);
    expect(within(page.byId("asks"), "asks-head").textContent).toBe("Waiting for your answer");
  });

  it("is not answered by anything but its own buttons", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    await say(page, { type: "approval", card: card() });
    page.byId("say").value = "yes";
    page.byId("say").fire("keydown", { key: "Enter" });
    page.byId("say-form").fire("submit");
    page.byId("asks").click();
    theCard(page).click();
    within(theCard(page), "ask-command").click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(0);
    expect(shown(page)).toHaveLength(1);
    // The buttons are plain ones, in no form, so Enter elsewhere cannot press them.
    const html = stationPage("abc");
    expect(html).toMatch(
      /<section class="asks" id="asks"[^>]*hidden><\/section>\s*<div class="scroll"/,
    );
    const { allow, deny } = buttonsOf(theCard(page));
    expect((allow as unknown as { type: string }).type).toBe("button");
    expect((deny as unknown as { type: string }).type).toBe("button");
  });

  it("says so and clears the card when the question was answered somewhere else", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({
      status: 409,
      data: { error: "That question has been answered already, or is no longer asked." },
    });
    await say(page, { type: "approval", card: card() });
    buttonsOf(theCard(page)).allow.click();
    await settle();
    expect(within(theCard(page), "ask-note").textContent).toContain("answered already");
    expect(buttonsOf(theCard(page)).allow.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(shown(page)).toHaveLength(0);
    expect(page.byId("asks").hidden).toBe(true);
  });

  it("takes no tap for a moment after it appears, so a finger on its way elsewhere answers nothing", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    await say(page, { type: "approval", card: card() }, true);
    const { allow, deny } = buttonsOf(theCard(page));
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    // A tap that lands all the same (the finger was already coming down) does nothing.
    allow.click();
    deny.click();
    await vi.advanceTimersByTimeAsync(CARD_WAKES_MS - 1);
    allow.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(0);
    expect(allow.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(allow.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
    allow.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(1);
  });

  it("puts a card back to sleep when the page comes back into view", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    await say(page, { type: "approval", card: card() });
    const { allow, deny } = buttonsOf(theCard(page));
    expect(allow.disabled).toBe(false);
    // It woke while the phone was in a pocket. Whoever looks now sees it for the first time.
    page.fireOnDocument("visibilitychange");
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    allow.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CARD_WAKES_MS);
    expect(allow.disabled).toBe(false);
    allow.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(1);
  });

  it("waits again each time a card is put up anew: after a new stream, and after signing in", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    await say(page, { type: "approval", card: card() });
    expect(buttonsOf(theCard(page)).allow.disabled).toBe(false);

    // The stream starts again from the top: the same question is a new card.
    await say(page, { type: "hello", device: "Phone" });
    await say(page, { type: "approval", card: card() }, true);
    const again = buttonsOf(theCard(page));
    expect(again.allow.disabled).toBe(true);
    again.allow.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(0);
    // The card that was dropped does not wake the new one early, nor itself.
    await vi.advanceTimersByTimeAsync(CARD_WAKES_MS - 1);
    expect(again.allow.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(again.allow.disabled).toBe(false);

    // A second card arriving does not put the first back to sleep, and sleeps itself.
    await say(page, { type: "approval", card: card({ id: SECOND }) }, true);
    expect(buttonsOf(theCard(page, 0)).allow.disabled).toBe(false);
    expect(buttonsOf(theCard(page, 1)).allow.disabled).toBe(true);
  });

  it("goes to the sign-in screen when the session is over, and signing in answers nothing", async () => {
    const page = await openListening();
    page.answers["POST /approve"] = () => ({
      status: 401,
      data: { error: "Sign in first.", need: "sign-in" },
    });
    await say(page, { type: "approval", card: card() });
    buttonsOf(theCard(page)).allow.click();
    await settle();

    // Signed out like after any other request: the sign-in screen, and no card behind it.
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("talk").hidden).toBe(true);
    expect(page.byId("sign-problem").textContent).toContain("Sign in again");
    expect(shown(page)).toHaveLength(0);
    expect(sent(page, "/approve")).toHaveLength(1);

    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    await page.signIn();
    expect(page.byId("talk").hidden).toBe(false);
    await openListening(page);
    await say(page, { type: "approval", card: card() });
    await vi.advanceTimersByTimeAsync(10_000);
    // Signing in answered nothing: the question is there, and still open.
    expect(sent(page, "/approve")).toHaveLength(1);
    expect(shown(page)).toHaveLength(1);
    expect(buttonsOf(theCard(page)).allow.disabled).toBe(false);
    expect(within(theCard(page), "ask-note").textContent).toBe("");

    // Only a tap answers it.
    buttonsOf(theCard(page)).allow.click();
    await settle();
    expect(sent(page, "/approve")).toHaveLength(2);
    expect(sent(page, "/approve")[1]?.body).toEqual({ id: FIRST, allow: true });
  });

  it("answers nothing by the phone's own check either, in the app", async () => {
    const app = fakeApp(KEY);
    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    await openListening(page);
    expect(app.prompts).toBe(1);
    page.answers["POST /approve"] = () => ({
      status: 401,
      data: { error: "Sign in first.", need: "sign-in" },
    });
    await say(page, { type: "approval", card: card() });
    buttonsOf(theCard(page)).deny.click();
    await settle();
    // Signed out: the button for the phone's check is there, and no card behind the screen.
    expect(page.byId("sign").hidden).toBe(false);
    expect(page.byId("unlock-box").hidden).toBe(false);
    expect(shown(page)).toHaveLength(0);

    page.answers["POST /approve"] = () => ({ status: 200, data: { ok: true } });
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    await openListening(page);
    await say(page, { type: "approval", card: card() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.byId("talk").hidden).toBe(false);
    expect(sent(page, "/approve")).toHaveLength(1);
    expect(buttonsOf(theCard(page)).deny.disabled).toBe(false);
  });

  it("handles nothing that arrives in the same piece after the session was ended", async () => {
    const page = await openListening();
    page.streams[page.streams.length - 1]?.sendTogether([
      { type: "signed-out" },
      { type: "approval", card: card() },
      { type: "said", text: "not for a signed-out page", from: "Laptop" },
    ]);
    await settle();
    await vi.advanceTimersByTimeAsync(CARD_WAKES_MS);
    expect(page.byId("sign").hidden).toBe(false);
    expect(shown(page)).toHaveLength(0);
    expect(page.byId("asks").hidden).toBe(true);
    expect(page.byId("thread").children).toHaveLength(0);
  });

  it("gives the buttons back, saying why, when the PC could not be reached", async () => {
    const page = await openListening();
    await say(page, { type: "approval", card: card() });
    page.down = true;
    buttonsOf(theCard(page)).allow.click();
    await settle();
    expect(buttonsOf(theCard(page)).allow.disabled).toBe(false);
    expect(buttonsOf(theCard(page)).deny.disabled).toBe(false);
    expect(within(theCard(page), "ask-note").textContent).toContain("could not be reached");
    expect(shown(page)).toHaveLength(1);
  });

  it("drops every card when the session ends, however it ends", async () => {
    const byHand = await openListening();
    await say(byHand, { type: "approval", card: card() });
    await say(byHand, { type: "approval", card: card({ id: SECOND }) });
    byHand.byId("menu-open").click();
    byHand.byId("sign-out").click();
    await settle();
    expect(shown(byHand)).toHaveLength(0);
    expect(byHand.byId("asks").hidden).toBe(true);
    // Signing in again brings back what is still open, from the stream.
    await byHand.signIn();
    await openListening(byHand);
    expect(shown(byHand)).toHaveLength(0);
    await say(byHand, { type: "approval", card: card({ id: SECOND }) });
    expect(shown(byHand)).toHaveLength(1);

    const byThePc = await openListening();
    await say(byThePc, { type: "approval", card: card() });
    await say(byThePc, { type: "signed-out" });
    expect(shown(byThePc)).toHaveLength(0);
    expect(byThePc.byId("asks").hidden).toBe(true);

    const app = fakeApp(KEY);
    const locked = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    locked.window["aiChanUnlocked"]?.(KEY);
    await settle();
    await openListening(locked);
    await say(locked, { type: "approval", card: card() });
    expect(shown(locked)).toHaveLength(1);
    locked.window["aiChanLock"]?.();
    await settle();
    expect(shown(locked)).toHaveLength(0);
    expect(locked.byId("asks").hidden).toBe(true);

    const unpaired = await openListening();
    await say(unpaired, { type: "approval", card: card() });
    unpaired.answers["POST /approve"] = () => ({
      status: 401,
      data: { error: "This device is not paired with her." },
    });
    buttonsOf(theCard(unpaired)).allow.click();
    await settle();
    expect(unpaired.byId("pair").hidden).toBe(false);
    expect(shown(unpaired)).toHaveLength(0);
  });

  it("starts afresh on a new stream: an answer that came while it was away is not left standing", async () => {
    const page = await openListening();
    await say(page, { type: "approval", card: card() });
    await say(page, { type: "approval", card: card({ id: SECOND }) });
    // The stream is told again from the top, and only one question is still open.
    await say(page, { type: "hello", device: "Phone" });
    expect(shown(page)).toHaveLength(0);
    await say(page, { type: "approval", card: card({ id: SECOND }) });
    expect(shown(page)).toHaveLength(1);
    expect(theCard(page).dataset["id"]).toBe(SECOND);
    // A question with no proper id is not put up at all.
    await say(page, { type: "approval", card: card({ id: "<b>" }) });
    await say(page, { type: "approval" });
    expect(shown(page)).toHaveLength(1);
  });
});

describe("pinned mission bridge and mobile trace drawer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sent = (page: Page, path: string): Asked[] =>
    page.asked.filter((asked) => asked.path === path);

  const openListening = async (page?: Page): Promise<Page> => {
    const opened = page ?? (await openSignedIn());
    const stream = opened.streams[opened.streams.length - 1];
    stream?.open();
    await settle();
    stream?.send({ type: "hello", device: "Phone" });
    await settle();
    return opened;
  };

  const say = async (page: Page, message: Record<string, unknown>): Promise<void> => {
    page.streams[page.streams.length - 1]?.send(message);
    await settle();
  };

  const pinnedSample = {
    id: "m-a1b2c3",
    title: "Deploy release",
    goal: "Deploy release",
    state: "running",
    wake: null,
    notBefore: null,
    note: null,
    runs: 0,
    createdAt: "2026-11-22T12:00:00.000Z",
    finishedAt: null,
    steps: [
      {
        title: "Build",
        where: "this PC",
        command: "npm run build",
        state: "done",
        tried: 1,
        retries: 0,
        outputPreview: "built",
        artifacts: [],
        finishedAt: "2026-11-22T12:00:10.000Z",
      },
      {
        title: "Restart",
        where: "proxmox",
        command: "systemctl restart app",
        state: "waiting",
        tried: 0,
        retries: 0,
        outputPreview: "",
        artifacts: [],
        finishedAt: null,
      },
    ],
    thread: [
      {
        id: "t-112233",
        at: "2026-11-22T12:00:00.000Z",
        by: { from: "pc" },
        kind: "state",
        text: "Start deploy",
      },
    ],
  };

  const childText = (node: { textContent: string; children: unknown[] }): string =>
    [
      node.textContent,
      ...node.children.map((c) => childText(c as { textContent: string; children: unknown[] })),
    ]
      .filter(Boolean)
      .join(" ");

  it("renders pinned-mission, submits steer-form, confirms two-tap pinned-stop, and clears on sign-out", async () => {
    const page = await openListening();
    await say(page, { type: "pinned-mission", mission: pinnedSample });

    const pinnedBox = page.byId("pinned");
    expect(pinnedBox.hidden).toBe(false);
    expect(page.byId("pinned-title").textContent).toContain("Deploy release");

    // Submit steer note via steer-form using #steer-input
    page.answers["POST /mission/steer"] = (asked: Asked) => ({
      status: 200,
      data: {
        mission: {
          ...pinnedSample,
          thread: [
            ...pinnedSample.thread,
            {
              id: "t-445566",
              at: "2026-11-22T12:01:00.000Z",
              by: { from: "device", name: "Phone" },
              kind: "note",
              text: asked.body["note"],
            },
          ],
        },
      },
    });
    const steerInput = page.byId("steer-input");
    steerInput.value = "check health first";
    page.byId("steer-form").fire("submit");
    await settle();
    expect(sent(page, "/mission/steer")).toHaveLength(1);
    expect(sent(page, "/mission/steer")[0]?.body).toEqual({
      missionId: "m-a1b2c3",
      note: "check health first",
    });

    // Two-tap pinned-stop: first tap arms confirmation, second sends POST /mission/stop
    page.answers["POST /mission/stop"] = () => ({ status: 200, data: { ok: true } });
    page.byId("pinned-stop").click();
    expect(sent(page, "/mission/stop")).toHaveLength(0);
    page.byId("pinned-stop").click();
    await settle();
    expect(sent(page, "/mission/stop")).toHaveLength(1);
    expect(sent(page, "/mission/stop")[0]?.body).toEqual({ missionId: "m-a1b2c3" });

    // Clears and hides on signed-out SSE
    await say(page, { type: "pinned-mission", mission: pinnedSample });
    expect(page.byId("pinned").hidden).toBe(false);
    await say(page, { type: "signed-out" });
    expect(page.byId("pinned").hidden).toBe(true);
    expect(page.byId("pinned-title").textContent).toBe("");
  });

  it("loads GET /traces in #trace-drawer, renders tokens/tools/gate/latencies as text, and clears on lock & unpair", async () => {
    const app = fakeApp(KEY);
    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    await openListening(page);

    page.answers["GET /traces"] = () => ({
      status: 200,
      data: {
        traces: [
          {
            at: "2026-11-22T12:00:00.000Z",
            kind: "user",
            said: "Check server <img src=x onerror=1>",
            reply: "All healthy.",
            brain: "Standard (9B)",
            summary: "1 call",
            offered: 2,
            offeredTools: ["fleet_check", "desktop_look"],
            picked: [{ tool: "fleet_check", why: "named in what you said" }],
            calls: [
              {
                tool: "fleet_check",
                ended: "worked",
                asked: false,
                ms: 20,
                gate: "allowed automatically",
                gateReason: "read-only command",
                input: "{}",
                result: "ok",
              },
            ],
            checks: [],
            withheld: false,
            tokens: { read: 50, written: 14, held: 64, prompt: 640 },
            ms: { whole: 250, firstWord: 60, stt: 110, llm: 45, tools: 20, tts: 75 },
          },
        ],
      },
    });

    page.byId("menu-open").click();
    const drawer = page.byId("trace-drawer");
    drawer.open = true;
    drawer.fire("toggle");
    await settle();

    expect(sent(page, "/traces")).toHaveLength(1);
    const traceList = page.byId("trace-list");
    const firstEntry = traceList.children[0] as FakeElement | undefined;
    expect(firstEntry).toBeDefined();
    // HTML-looking text is preserved as textContent rather than parsed as markup elements
    expect(firstEntry?.children[0]?.children).toHaveLength(0);
    const drawerText = childText(traceList);
    expect(drawerText).toContain("<img src=x onerror=1>");
    expect(drawerText).toContain("640");
    expect(drawerText).toContain("fleet_check");
    expect(drawerText).toContain("allowed automatically");
    expect(drawerText).toContain("read-only command");
    expect(drawerText).toContain("110");

    // Lock clears trace drawer and pinned card
    await say(page, { type: "pinned-mission", mission: pinnedSample });
    page.window["aiChanLock"]?.();
    await settle();
    expect(page.byId("pinned").hidden).toBe(true);
    expect(page.byId("trace-drawer").open).toBe(false);
    expect(page.byId("trace-list").children).toHaveLength(0);

    // Unpaired response on /mission/steer also clears both views
    const unpaired = await openListening();
    unpaired.answers["GET /traces"] = page.answers["GET /traces"];
    unpaired.byId("menu-open").click();
    unpaired.byId("trace-drawer").open = true;
    unpaired.byId("trace-drawer").fire("toggle");
    await settle();
    await say(unpaired, { type: "pinned-mission", mission: pinnedSample });
    unpaired.answers["POST /mission/steer"] = () => ({
      status: 401,
      data: { error: "This device is not paired with her." },
    });
    unpaired.byId("steer-input").value = "hello";
    unpaired.byId("steer-form").fire("submit");
    await settle();
    expect(unpaired.byId("pair").hidden).toBe(false);
    expect(unpaired.byId("pinned").hidden).toBe(true);
    expect(unpaired.byId("trace-drawer").open).toBe(false);
    expect(unpaired.byId("trace-list").children).toHaveLength(0);
  });

  it("queues offline messages in #outbox, drains native+web queue FIFO on hello, and clears on Clear", async () => {
    const app = fakeApp(KEY);
    let nativeQueue = "[]";
    app.takeNativeOutbox = () => {
      const copy = nativeQueue;
      nativeQueue = "[]";
      return copy;
    };

    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    await openListening(page);

    // Network fails on /say -> message is saved to outbox and persisted in localStorage
    page.down = true;
    page.byId("say").value = "check backups";
    page.byId("say-form").fire("submit");
    await settle();

    // Native offline screen also queued a message while away from LAN
    nativeQueue = JSON.stringify(["from native screen"]);

    expect(page.byId("say").value).toBe("");
    expect(page.byId("outbox").hidden).toBe(false);
    expect(page.byId("outbox-count").textContent).toContain("1 queued");
    expect(page.storedEver.get("aichan.station.outbox")?.at(-1)).toContain("check backups");

    // Reconnect hello pulls native queue and drains all queued messages FIFO
    page.down = false;
    await say(page, { type: "hello", device: "Phone", app: true });
    await settle();

    expect(sent(page, "/say").map((c) => c.body["text"])).toEqual([
      "check backups",
      "from native screen",
    ]);
    expect(page.byId("outbox").hidden).toBe(true);

    // Queue when offline banner visible, then clear manually
    page.byId("offline").hidden = false;
    page.byId("say").value = "never send me";
    page.byId("say-form").fire("submit");
    await settle();
    expect(page.byId("outbox").hidden).toBe(false);
    page.byId("outbox-clear").click();
    expect(page.byId("outbox").hidden).toBe(true);
  });

  it("renders SSE standing-order alerts, toggles background alert polling, and sends hold-to-talk voice notes", async () => {
    const app = fakeApp(KEY);
    let alertsEnabled = false;
    let alertToken = "";
    let startedVoice = 0;
    let stoppedVoice = 0;

    app.canPollAlerts = () => true;
    app.isAlertPollingOn = () => alertsEnabled;
    app.setAlertPolling = (on, tok) => {
      alertsEnabled = on;
      alertToken = tok;
    };
    app.canRecordVoice = () => true;
    app.startVoice = () => {
      startedVoice += 1;
    };
    app.stopVoice = () => {
      stoppedVoice += 1;
    };

    const page = openPage({
      paired: true,
      app,
      account: { set: true, signedIn: false, unlock: true, wait: 0 },
    });
    await settle();
    page.window["aiChanUnlocked"]?.(KEY);
    await settle();
    await openListening(page);

    page.answers["POST /voice"] = () => ({
      status: 202,
      data: { ok: true, transcript: "check sensors" },
    });

    // SSE alert event renders safe text note
    await say(page, {
      type: "alert",
      alert: {
        id: "a-1",
        kind: "order",
        title: "Temp",
        body: "CPU > 80C <script>alert(1)</script>",
        at: "2026-11-22T12:00:00.000Z",
      },
    });
    const threadText = childText(page.byId("thread"));
    expect(threadText).toContain("Temp: CPU > 80C <script>alert(1)</script>");

    // Background alert toggle in sheet passes device token to native bridge
    page.byId("menu-open").click();
    expect(page.byId("alerts-setting").hidden).toBe(false);
    page.byId("alerts-switch").checked = true;
    page.byId("alerts-switch").fire("change");
    expect(alertsEnabled).toBe(true);
    expect(alertToken).toBe("token-of-this-device");

    // Hold-to-talk voice note suppresses mobile long-press selection/callouts and posts base64 WAV
    expect(STATION_STYLE).toContain("user-select: none;");
    expect(STATION_STYLE).toContain("-webkit-user-select: none;");
    expect(STATION_STYLE).toContain("-webkit-touch-callout: none;");
    expect(STATION_STYLE).toContain("touch-action: none;");
    for (const evtType of ["contextmenu", "selectstart", "touchstart"]) {
      let prevented = false;
      page.byId("voice-hold").fire(evtType, {
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented, `${evtType} must call preventDefault()`).toBe(true);
    }

    page.byId("voice-hold").fire("pointerdown");
    expect(startedVoice).toBe(1);
    expect(page.byId("voice-hold").dataset["recording"]).toBe("yes");
    page.byId("voice-hold").fire("pointerup");
    expect(stoppedVoice).toBe(1);

    page.window["aiChanVoiceReady"]?.(Buffer.from("RIFFxxxxWAVEfmt ").toString("base64"));
    await settle();
    const voiceReqs = sent(page, "/voice");
    expect(voiceReqs).toHaveLength(1);
    expect(voiceReqs[0]?.headers["Authorization"]).toBe("Bearer token-of-this-device");
    expect(voiceReqs[0]?.headers["X-Session"]).toBe(SESSION);
    expect(voiceReqs[0]?.headers["Content-Type"]).toBe("audio/wav");
  });
});
