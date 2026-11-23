import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isAllowedClient,
  MAX_DEVICES,
  namesAnAddress,
  Station,
  tidyDeviceName,
  type PairedDevice,
  type StationAlert,
  type StationDeps,
} from "../src/core/station.ts";
import { encodeWav16kMono, MAX_VOICE_BYTES } from "../src/core/voiceWav.ts";
import { KEY_WITHIN_MS, SESSION_IDLE_MS, WRONG_TRIES_ALLOWED } from "../src/core/stationAccount.ts";
import { stationPage } from "../src/core/stationPage.ts";
import type { PinnedMissionView } from "../src/core/missionPlan.ts";
import type { ShownTrace } from "../src/core/trace.ts";
import { UNOFFICIAL_NOTICE } from "../src/shared/ipc.ts";

let root = "";
/** A certificate made once, by the real openssl, and copied into each test's folder. */
let certDir = "";
let folders = 0;
const open: Station[] = [];

interface Harness {
  station: Station;
  dir: string;
  port: number;
  said: { text: string; device: PairedDevice }[];
  stopped: PairedDevice[];
  clock: { now: number };
}

async function startStation(overrides: Partial<StationDeps> = {}): Promise<Harness> {
  const dir = join(root, `station-${(folders += 1)}`);
  const said: Harness["said"] = [];
  const stopped: PairedDevice[] = [];
  const clock = { now: Date.parse("2026-11-21T12:00:00Z") };
  const station = new Station({
    dir,
    port: 0,
    onSay: (text, device) => {
      said.push({ text, device });
      return true;
    },
    onStop: (device) => stopped.push(device),
    now: () => clock.now,
    // The least the account takes: a third of a second a sign-in is too long here.
    passwordCost: 1 << 14,
    localAddresses: () => ["127.0.0.1"],
    makeCertificate: async (target) => {
      await copyFile(join(certDir, "cert.pem"), join(target, "cert.pem"));
      await copyFile(join(certDir, "key.pem"), join(target, "key.pem"));
    },
    ...overrides,
  });
  await station.start();
  open.push(station);
  const port = Number(new URL(station.addresses()[0] ?? "").port);
  return { station, dir, port, said, stopped, clock };
}

interface Answer {
  status: number;
  headers: IncomingMessage["headers"];
  text: string;
  json: Record<string, unknown>;
}

function call(
  port: number,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    raw?: string | Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload =
      options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        rejectUnauthorized: false,
        agent: false,
        headers: {
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          // A device these tests have signed in sends its session with everything.
          ...(options.token && sessions.has(options.token)
            ? { "X-Session": sessions.get(options.token) ?? "" }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // not every answer is JSON
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

/** The session of each device these tests have signed in, by the device's token. */
const sessions = new Map<string, string>();
const NAME = "captain";
const PASSWORD = "correct horse battery";

/**
 * Pairs a device and, unless told not to, signs it in, setting the name and password
 * first when the station has none: what every test about anything else starts from.
 */
async function pair(
  harness: Harness,
  name = "Phone",
  signIn = true,
): Promise<{ token: string; id: string }> {
  const { code } = harness.station.beginPairing();
  const answer = await call(harness.port, "POST", "/pair", { body: { code, name } });
  expect(answer.status).toBe(200);
  const device = answer.json["device"] as PairedDevice;
  const token = String(answer.json["token"]);
  if (signIn) await signInWith(harness, token);
  return { token, id: device.id };
}

/** Signs in whoever holds this token, setting the name and password first when there are none. */
async function signInWith(harness: Harness, token: string): Promise<string> {
  if (!harness.station.account.exists) await harness.station.setAccount(NAME, PASSWORD);
  sessions.delete(token);
  const signedIn = await call(harness.port, "POST", "/sign-in", {
    token,
    body: { username: NAME, password: PASSWORD },
  });
  expect(signedIn.status).toBe(200);
  const session = String(signedIn.json["session"]);
  sessions.set(token, session);
  return session;
}

interface Stream {
  status: Promise<number>;
  messages: Record<string, unknown>[];
  waitFor(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  closed: Promise<void>;
  close(): void;
}

function listen(port: number, token: string): Stream {
  const messages: Record<string, unknown>[] = [];
  const waiting: { match: (m: Record<string, unknown>) => boolean; done: (m: never) => void }[] =
    [];
  let ended: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (ended = resolve));
  let gotStatus: (status: number) => void = () => undefined;
  const status = new Promise<number>((resolve) => (gotStatus = resolve));
  const outgoing = request(
    {
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/events",
      rejectUnauthorized: false,
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(sessions.has(token) ? { "X-Session": sessions.get(token) ?? "" } : {}),
      },
    },
    (response) => {
      gotStatus(response.statusCode ?? 0);
      let buffer = "";
      response.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const message = JSON.parse(line.slice(6)) as Record<string, unknown>;
            messages.push(message);
            for (const entry of [...waiting]) {
              if (!entry.match(message)) continue;
              waiting.splice(waiting.indexOf(entry), 1);
              entry.done(message as never);
            }
          }
        }
      });
      response.on("close", ended);
    },
  );
  outgoing.on("error", () => ended());
  outgoing.end();
  return {
    status,
    messages,
    closed,
    close: () => outgoing.destroy(),
    waitFor: (match) => {
      const seen = messages.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiting.push({ match, done: resolve as (m: never) => void }));
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aichan-station-"));
  // The one start that goes through the real certificate maker.
  certDir = join(root, "made-by-openssl");
  const first = new Station({
    dir: certDir,
    port: 0,
    onSay: () => true,
    onStop: () => undefined,
    localAddresses: () => ["127.0.0.1"],
  });
  await first.start();
  await first.stop();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((station) => station.stop()));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("who may reach the station", () => {
  it("answers this computer and the local network, and nobody else", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "192.168.50.7",
      "::ffff:192.168.1.20",
      "10.0.0.4",
      "172.16.3.3",
      "172.31.255.1",
      "169.254.10.1",
      "100.100.1.1",
    ]) {
      expect(isAllowedClient(address), address).toBe(true);
    }
    for (const address of [
      undefined,
      "",
      "8.8.8.8",
      "::ffff:8.8.8.8",
      "172.32.0.1",
      "192.169.0.1",
      "100.128.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "2001:db8::1",
      "fe80::1",
      "fd00::1",
      "::ffff:c0a8:0101",
      "192.168.1.1.evil",
    ]) {
      expect(isAllowedClient(address), String(address)).toBe(false);
    }
  });

  it("only answers to a bare address or localhost as its name", () => {
    expect(namesAnAddress("192.168.50.40:47821")).toBe(true);
    expect(namesAnAddress("127.0.0.1")).toBe(true);
    expect(namesAnAddress("localhost:47821")).toBe(true);
    expect(namesAnAddress("[::1]:47821")).toBe(true);
    expect(namesAnAddress("evil.example:47821")).toBe(false);
    expect(namesAnAddress("192.168.50.40.evil.example")).toBe(false);
    expect(namesAnAddress(undefined)).toBe(false);
  });

  it("turns away a page that reaches it under another name", async () => {
    const harness = await startStation();
    const answer = await call(harness.port, "GET", "/", { headers: { Host: "evil.example" } });
    expect(answer.status).toBe(421);
  });
});

describe("the certificate", () => {
  it("is made by openssl, kept private, and reused", async () => {
    const key = await stat(join(certDir, "key.pem"));
    expect(key.mode & 0o777).toBe(0o600);
    expect((await stat(certDir)).mode & 0o777).toBe(0o700);
    const cert = await readFile(join(certDir, "cert.pem"), "utf8");
    expect(cert).toContain("BEGIN CERTIFICATE");

    let made = 0;
    const harness = await startStation({
      dir: certDir,
      makeCertificate: () => {
        made += 1;
        return Promise.resolve();
      },
    });
    expect(made).toBe(0);
    expect(harness.station.fingerprint()).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(harness.station.addresses()).toEqual([`https://127.0.0.1:${harness.port}`]);
  });

  it("says so plainly when no certificate can be made", async () => {
    const station = new Station({
      dir: join(root, "no-cert"),
      port: 0,
      onSay: () => true,
      onStop: () => undefined,
      makeCertificate: () => Promise.reject(new Error('This needs "openssl".')),
    });
    await expect(station.start()).rejects.toThrow(/openssl/);
    expect(station.running).toBe(false);
    expect(station.addresses()).toEqual([]);
  });

  it("says which port is taken when another program has it", async () => {
    const first = await startStation();
    const second = new Station({
      dir: first.dir,
      port: first.port,
      onSay: () => true,
      onStop: () => undefined,
    });
    await expect(second.start()).rejects.toThrow(/already in use/);
    expect(second.running).toBe(false);
  });
});

describe("the page", () => {
  it("is one document with the unofficial notice and nothing from elsewhere", async () => {
    const harness = await startStation();
    const answer = await call(harness.port, "GET", "/");
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toContain("text/html");
    expect(answer.text).toContain(UNOFFICIAL_NOTICE);
    expect(answer.text).not.toMatch(/https?:\/\//);
    expect(answer.text).not.toMatch(/\s(?:src|href)\s*=/i);
    expect(answer.text).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(answer.headers["set-cookie"]).toBeUndefined();
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("lets only its own script and style run, under a nonce that changes every time", async () => {
    const harness = await startStation();
    const first = await call(harness.port, "GET", "/");
    const second = await call(harness.port, "GET", "/");
    const policy = String(first.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(15);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`style-src 'nonce-${nonce}'`);
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(first.text).toContain(`<script nonce="${nonce}">`);
    expect(first.text).toContain(`<style nonce="${nonce}">`);
    expect(String(second.headers["content-security-policy"])).not.toContain(nonce);
  });

  it("carries a script that parses", () => {
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(stationPage("abc"))?.[1] ?? "";
    expect(script.length).toBeGreaterThan(2000);
    // Parsed only, never run: there is no page here for it to run in.
    expect(() => new Function(script)).not.toThrow();
  });

  it("cannot have its nonce used to break out of the tag", () => {
    expect(stationPage('x"><script>alert(1)</script>')).not.toContain("<script>alert");
  });

  it("keeps its markup free of what the policy would refuse: handlers and styles on elements", () => {
    const markup = stationPage("abc")
      .replace(/<style[\s\S]*?<\/style>/, "")
      .replace(/<script[\s\S]*?<\/script>/, "");
    expect(markup).toContain("<body");
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
    expect(markup).not.toMatch(/\sstyle\s*=/i);
    expect(markup).not.toMatch(/javascript:/i);
  });

  it("says it is a local-first AI companion where it is always on screen, and in full on every view", () => {
    const page = stationPage("abc");
    const header = /<header[\s\S]*?<\/header>/.exec(page)?.[0] ?? "";
    expect(header).toContain("Local-first AI companion");
    // The pairing view, the empty thread and the sheet for this device each carry it whole.
    expect(page.split(UNOFFICIAL_NOTICE).length - 1).toBeGreaterThanOrEqual(3);
  });

  it("has a look for every mood she can be in, and for the dark, and for stillness", () => {
    const style = /<style nonce="[^"]*">([\s\S]*?)<\/style>/.exec(stationPage("abc"))?.[1] ?? "";
    for (const mood of ["happy", "excited", "thinking", "surprised", "worried", "smug", "sad"]) {
      expect(style).toContain(`body[data-mood="${mood}"]`);
    }
    expect(style).toContain("prefers-color-scheme: dark");
    expect(style).toContain("prefers-reduced-motion: reduce");
  });

  it("is laid out for a phone held in one hand", () => {
    const page = stationPage("abc");
    expect(page).toContain("viewport-fit=cover");
    expect(page).toContain("safe-area-inset-bottom");
    // The pairing code is typed on the number pad.
    expect(page).toMatch(/id="code"[^>]*inputmode="numeric"/);
  });

  it("tells whoever is holding the phone what she will not do from there", () => {
    const page = stationPage("abc");
    expect(page).toContain("What she asks you about in a conversation is asked at the PC only");
    expect(page).toContain(
      "a step that touches where passwords or keys are kept is asked at the PC",
    );
  });

  it("answers nothing else, and only GET and POST", async () => {
    const harness = await startStation();
    expect((await call(harness.port, "GET", "/devices.json")).status).toBe(404);
    expect((await call(harness.port, "GET", "/key.pem")).status).toBe(404);
    expect((await call(harness.port, "GET", "/say")).status).toBe(404);
    expect((await call(harness.port, "PUT", "/say", { body: { text: "hi" } })).status).toBe(405);
    expect((await call(harness.port, "OPTIONS", "/say")).status).toBe(405);
    expect((await call(harness.port, "DELETE", "/")).status).toBe(405);
  });
});

describe("pairing", () => {
  it("gives a device a token for the code shown on the PC, once", async () => {
    const harness = await startStation();
    const { code, expiresAt } = harness.station.beginPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(harness.clock.now + 5 * 60_000);

    const answer = await call(harness.port, "POST", "/pair", {
      body: { code: `${code.slice(0, 3)} ${code.slice(3)}`, name: "  Brandon's\u0007 phone\n " },
    });
    expect(answer.status).toBe(200);
    expect(String(answer.json["token"])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.json["device"]).toMatchObject({ name: "Brandon's phone" });
    expect(harness.station.devices()).toHaveLength(1);
    expect(harness.station.devices()[0]).not.toHaveProperty("tokenHash");

    // The code was used up.
    const again = await call(harness.port, "POST", "/pair", { body: { code, name: "Other" } });
    expect(again.status).toBe(403);
    expect(harness.station.devices()).toHaveLength(1);
  });

  it("says its list of devices changed when one is paired or forgotten, and not otherwise", async () => {
    let changes = 0;
    const harness = await startStation({ onDevicesChanged: () => (changes += 1) });
    const { code } = harness.station.beginPairing();
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await call(harness.port, "POST", "/pair", { body: { code: wrong } })).status).toBe(403);
    expect(changes).toBe(0);
    expect(
      (await call(harness.port, "POST", "/pair", { body: { code, name: "Phone" } })).status,
    ).toBe(200);
    expect(changes).toBe(1);
    const [device] = harness.station.devices();
    await harness.station.forget("no-such-device");
    expect(changes).toBe(1);
    await harness.station.forget(device?.id ?? "");
    expect(changes).toBe(2);
    expect(harness.station.devices()).toEqual([]);
  });

  it("refuses when no pairing was started", async () => {
    const harness = await startStation();
    const answer = await call(harness.port, "POST", "/pair", { body: { code: "000000" } });
    expect(answer.status).toBe(403);
    expect(answer.json["error"]).toBe("That code is wrong or has expired.");
  });

  it("stops the pairing after five wrong codes, without saying so", async () => {
    const harness = await startStation();
    const { code } = harness.station.beginPairing();
    const wrong = code === "111111" ? "222222" : "111111";
    for (let attempt = 0; attempt < 5; attempt++) {
      const answer = await call(harness.port, "POST", "/pair", { body: { code: wrong } });
      expect(answer.status).toBe(403);
      expect(answer.json["error"]).toBe("That code is wrong or has expired.");
    }
    const late = await call(harness.port, "POST", "/pair", { body: { code } });
    expect(late.status).toBe(403);
    expect(late.json["error"]).toBe("That code is wrong or has expired.");
    expect(harness.station.devices()).toHaveLength(0);
  });

  it("refuses a code that has run out", async () => {
    const harness = await startStation();
    const { code } = harness.station.beginPairing();
    harness.clock.now += 5 * 60_000 + 1;
    expect((await call(harness.port, "POST", "/pair", { body: { code } })).status).toBe(403);
    expect(harness.station.devices()).toHaveLength(0);
  });

  it("refuses a cancelled code and anything that is not six digits", async () => {
    const harness = await startStation();
    const { code } = harness.station.beginPairing();
    for (const bad of [code.slice(0, 5), `${code}0`, "", null, 123456, { code }]) {
      expect((await call(harness.port, "POST", "/pair", { body: { code: bad } })).status).toBe(403);
    }
    const fresh = harness.station.beginPairing();
    harness.station.cancelPairing();
    expect((await call(harness.port, "POST", "/pair", { body: { code: fresh.code } })).status).toBe(
      403,
    );
  });

  it("slows down an address that keeps guessing", async () => {
    const harness = await startStation();
    for (let attempt = 0; attempt < 10; attempt++) {
      harness.station.beginPairing();
      expect((await call(harness.port, "POST", "/pair", { body: { code: "abcdef" } })).status).toBe(
        403,
      );
    }
    const { code } = harness.station.beginPairing();
    expect((await call(harness.port, "POST", "/pair", { body: { code } })).status).toBe(429);
    harness.clock.now += 61_000;
    expect((await call(harness.port, "POST", "/pair", { body: { code } })).status).toBe(200);
  });

  it("pairs at most six devices", async () => {
    const harness = await startStation();
    for (let count = 0; count < MAX_DEVICES; count++) await pair(harness, `Device ${count}`);
    const { code } = harness.station.beginPairing();
    const answer = await call(harness.port, "POST", "/pair", { body: { code, name: "Seventh" } });
    expect(answer.status).toBe(409);
    expect(String(answer.json["error"])).toMatch(/already paired/);
    expect(harness.station.devices()).toHaveLength(MAX_DEVICES);
  });

  it("keeps only a hash of the token, in a file nobody else can read", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const file = join(harness.dir, "devices.json");
    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain(token);
    expect(saved).toMatch(/"tokenHash": "[0-9a-f]{64}"/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(harness.dir)).mode & 0o777).toBe(0o700);
  });

  it("still knows a paired device after a restart", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    await harness.station.stop();
    const again = await startStation({ dir: harness.dir });
    expect(again.station.devices()).toHaveLength(1);
    // Still paired, and the name and password are still set; but nobody is signed in
    // any more, so the device signs in again before it can say anything.
    const refused = await call(again.port, "POST", "/say", { token, body: { text: "hi" } });
    expect(refused.status).toBe(401);
    expect(refused.json["need"]).toBe("sign-in");
    await signInWith(again, token);
    expect((await call(again.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      202,
    );
  });

  it("ignores a devices file that has been tampered into nonsense", async () => {
    const dir = join(root, "tampered");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "devices.json"),
      JSON.stringify({ devices: [{ id: "x", name: "Fake", tokenHash: "short" }, "junk"] }),
    );
    const harness = await startStation({ dir });
    expect(harness.station.devices()).toEqual([]);
  });

  it("tidies device names", () => {
    expect(tidyDeviceName("  My\tphone ‮ ")).toBe("My phone");
    expect(tidyDeviceName("")).toBe("A device");
    expect(tidyDeviceName(42)).toBe("A device");
    expect(tidyDeviceName("x".repeat(90))).toHaveLength(40);
  });
});

describe("talking to her from a device", () => {
  it("needs a token, and refuses a made-up one", async () => {
    const harness = await startStation();
    await pair(harness);
    const forged = "A".repeat(43);
    expect((await call(harness.port, "POST", "/say", { body: { text: "hi" } })).status).toBe(401);
    expect(
      (await call(harness.port, "POST", "/say", { token: forged, body: { text: "hi" } })).status,
    ).toBe(401);
    expect((await call(harness.port, "POST", "/stop", { token: forged, body: {} })).status).toBe(
      401,
    );
    expect((await call(harness.port, "GET", "/events", { token: forged })).status).toBe(401);
    expect((await call(harness.port, "GET", "/events")).status).toBe(401);
    expect(harness.said).toEqual([]);
    expect(harness.stopped).toEqual([]);
  });

  it("shuts out an address after ten refused tokens in a minute", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (await call(harness.port, "POST", "/stop", { token: "B".repeat(43), body: {} })).status,
      ).toBe(401);
    }
    expect((await call(harness.port, "POST", "/stop", { token, body: {} })).status).toBe(429);
    harness.clock.now += 61_000;
    expect((await call(harness.port, "POST", "/stop", { token, body: {} })).status).toBe(202);
  });

  it("passes on what was said, with the device it came from", async () => {
    const harness = await startStation();
    const { token, id } = await pair(harness, "Kitchen tablet");
    const answer = await call(harness.port, "POST", "/say", {
      token,
      body: { text: "  what's the weather?  " },
    });
    expect(answer.status).toBe(202);
    expect(harness.said).toHaveLength(1);
    expect(harness.said[0]?.text).toBe("what's the weather?");
    expect(harness.said[0]?.device).toMatchObject({ id, name: "Kitchen tablet" });
    expect(harness.said[0]?.device).not.toHaveProperty("tokenHash");

    expect((await call(harness.port, "POST", "/stop", { token, body: {} })).status).toBe(202);
    expect(harness.stopped.map((device) => device.id)).toEqual([id]);
  });

  it("refuses an empty message, one that is too long, and one that is not text", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    for (const text of ["", "   ", "x".repeat(2001), 5, null, ["hi"]]) {
      expect((await call(harness.port, "POST", "/say", { token, body: { text } })).status).toBe(
        400,
      );
    }
    expect(
      (await call(harness.port, "POST", "/say", { token, body: { text: "x".repeat(2000) } }))
        .status,
    ).toBe(202);
    expect(harness.said).toHaveLength(1);
  });

  it("refuses a body over 8 KB, one that is not JSON, and one not sent as JSON", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const big = await call(harness.port, "POST", "/say", {
      token,
      body: { text: "hi", padding: "x".repeat(9000) },
    });
    expect(big.status).toBe(413);
    // The same when the length is not announced up front.
    const trickled = await call(harness.port, "POST", "/say", {
      token,
      raw: JSON.stringify({ text: "hi", padding: "x".repeat(20_000) }),
      headers: { "Transfer-Encoding": "chunked" },
    });
    expect(trickled.status).toBe(413);
    const broken = await call(harness.port, "POST", "/say", { token, raw: "{text:" });
    expect(broken.status).toBe(400);
    const form = await call(harness.port, "POST", "/say", {
      token,
      raw: "text=hi",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(415);
    const plain = await call(harness.port, "POST", "/say", {
      token,
      raw: JSON.stringify({ text: "hi" }),
      headers: { "Content-Type": "text/plain" },
    });
    expect(plain.status).toBe(415);
    const pairing = await call(harness.port, "POST", "/pair", {
      raw: "code=123456",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(pairing.status).toBe(415);
    expect(harness.said).toEqual([]);
  });

  it("allows twelve messages a minute from one device", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const other = await pair(harness, "Laptop");
    for (let count = 0; count < 12; count++) {
      expect(
        (await call(harness.port, "POST", "/say", { token, body: { text: `message ${count}` } }))
          .status,
      ).toBe(202);
    }
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "13" } })).status).toBe(
      429,
    );
    // Another device has its own allowance.
    expect(
      (await call(harness.port, "POST", "/say", { token: other.token, body: { text: "hi" } }))
        .status,
    ).toBe(202);
    harness.clock.now += 61_000;
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "14" } })).status).toBe(
      202,
    );
    expect(harness.said).toHaveLength(14);
  });

  it("holds to twelve a minute when many messages arrive at the same moment", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    // All sent before any has been answered: each must be counted as it arrives, not once
    // its body has been read, or every one of them would find the count still at nought.
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, count) =>
        call(harness.port, "POST", "/say", { token, body: { text: `burst ${count}` } }),
      ),
    );
    const statuses = answers.map((answer) => answer.status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(12);
    expect(statuses.filter((status) => status === 429)).toHaveLength(28);
    expect(harness.said).toHaveLength(12);
  });

  it("counts a message against the allowance even when it turns out to be no good", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    for (let count = 0; count < 12; count++) {
      expect((await call(harness.port, "POST", "/say", { token, body: { text: "" } })).status).toBe(
        400,
      );
    }
    expect(
      (await call(harness.port, "POST", "/say", { token, body: { text: "a real one" } })).status,
    ).toBe(429);
    expect(harness.said).toHaveLength(0);
  });

  it("records when a device was last seen, at most once a minute", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const first = harness.station.devices()[0]?.lastSeenAt;
    harness.clock.now += 30_000;
    await call(harness.port, "POST", "/stop", { token, body: {} });
    expect(harness.station.devices()[0]?.lastSeenAt).toBe(first);
    harness.clock.now += 31_000;
    await call(harness.port, "POST", "/stop", { token, body: {} });
    expect(harness.station.devices()[0]?.lastSeenAt).toBe(
      new Date(harness.clock.now).toISOString(),
    );
  });
});

describe("the stream of what she says", () => {
  it("opens with the recent conversation, then carries what happens", async () => {
    const harness = await startStation({
      recent: () =>
        Array.from({ length: 14 }, (_, index) => ({
          said: `question ${index}`,
          reply: `answer ${index}`,
          at: "2026-11-21T11:00:00Z",
        })),
    });
    const { token } = await pair(harness, "Phone");
    const stream = listen(harness.port, token);
    expect(await stream.status).toBe(200);
    const hello = await stream.waitFor((message) => message["type"] === "hello");
    expect(hello["device"]).toBe("Phone");
    const recent = await stream.waitFor((message) => message["type"] === "recent");
    const exchanges = recent["exchanges"] as { said: string }[];
    expect(exchanges).toHaveLength(10);
    expect(exchanges[0]?.said).toBe("question 4");

    harness.station.broadcast({ type: "status", state: "thinking" });
    harness.station.broadcast({ type: "reply-start" });
    harness.station.broadcast({ type: "text", delta: "Hello, " });
    harness.station.broadcast({ type: "text", delta: "Captain!\n\n</script>" });
    harness.station.broadcast({ type: "needs-captain", title: "Run this command?" });
    const needs = await stream.waitFor((message) => message["type"] === "needs-captain");
    expect(needs["title"]).toBe("Run this command?");
    const texts = stream.messages.filter((message) => message["type"] === "text");
    expect(texts.map((message) => message["delta"]).join("")).toBe("Hello, Captain!\n\n</script>");

    // A second device joining in the middle is caught up on the reply so far.
    const late = await pair(harness, "Laptop");
    const second = listen(harness.port, late.token);
    const caughtUp = await second.waitFor((message) => message["type"] === "text");
    expect(caughtUp["delta"]).toBe("Hello, Captain!\n\n</script>");
    expect(second.messages.some((m) => m["type"] === "status" && m["state"] === "thinking")).toBe(
      true,
    );
    stream.close();
    second.close();
  });

  it("shows a device's own message to every device", async () => {
    const harness = await startStation();
    const phone = await pair(harness, "Phone");
    const laptop = await pair(harness, "Laptop");
    const stream = listen(harness.port, laptop.token);
    await stream.waitFor((message) => message["type"] === "recent");
    await call(harness.port, "POST", "/say", { token: phone.token, body: { text: "hello" } });
    const said = await stream.waitFor((message) => message["type"] === "said");
    expect(said).toMatchObject({ text: "hello", from: "Phone" });
    stream.close();
  });

  it("shows the message before anything her reply sends", async () => {
    // As in the app: taking the message only puts it in line; her reply starts later.
    const harness: Harness = await startStation({
      onSay: () => {
        setImmediate(() => harness.station.broadcast({ type: "status", state: "thinking" }));
        return true;
      },
    });
    const { token } = await pair(harness);
    const stream = listen(harness.port, token);
    await stream.waitFor((message) => message["type"] === "recent");
    const before = stream.messages.length;
    await call(harness.port, "POST", "/say", { token, body: { text: "hello" } });
    await stream.waitFor(
      (message) => message["type"] === "status" && message["state"] === "thinking",
    );
    expect(stream.messages.slice(before).map((message) => message["type"])).toEqual([
      "said",
      "status",
    ]);
    stream.close();
  });

  it("does not show a message she could not take, and says why", async () => {
    let taking = false;
    const harness = await startStation({ onSay: () => taking });
    const { token } = await pair(harness);
    const stream = listen(harness.port, token);
    await stream.waitFor((message) => message["type"] === "recent");
    const before = stream.messages.length;
    const refused = await call(harness.port, "POST", "/say", { token, body: { text: "one" } });
    expect(refused.status).toBe(429);
    expect(refused.json["error"]).toBe(
      "She already has a few messages waiting. Give her a moment.",
    );
    // Then one she does take, so there is something to wait for on the stream.
    taking = true;
    expect(
      (await call(harness.port, "POST", "/say", { token, body: { text: "two" } })).status,
    ).toBe(202);
    await stream.waitFor((message) => message["type"] === "said");
    const shown = stream.messages.slice(before).filter((message) => message["type"] === "said");
    expect(shown.map((message) => message["text"])).toEqual(["two"]);
    stream.close();
  });

  it("closes a forgotten device's stream and refuses its token from then on", async () => {
    const harness = await startStation();
    const { token, id } = await pair(harness);
    const stream = listen(harness.port, token);
    await stream.waitFor((message) => message["type"] === "recent");
    await harness.station.forget(id);
    await stream.closed;
    expect(harness.station.devices()).toEqual([]);
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      401,
    );
    expect((await call(harness.port, "GET", "/events", { token })).status).toBe(401);
    expect(await readFile(join(harness.dir, "devices.json"), "utf8")).not.toContain(id);
  });

  it("keeps two streams for one device and lets the oldest go", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const first = listen(harness.port, token);
    await first.waitFor((message) => message["type"] === "recent");
    const second = listen(harness.port, token);
    await second.waitFor((message) => message["type"] === "recent");
    const third = listen(harness.port, token);
    await third.waitFor((message) => message["type"] === "recent");
    await first.closed;
    harness.station.broadcast({ type: "caution", message: "still here" });
    await second.waitFor((message) => message["type"] === "caution");
    await third.waitFor((message) => message["type"] === "caution");
    expect(first.messages.some((message) => message["type"] === "caution")).toBe(false);
    second.close();
    third.close();
  });

  it("closes every stream when it stops", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const stream = listen(harness.port, token);
    await stream.waitFor((message) => message["type"] === "recent");
    await harness.station.stop();
    await stream.closed;
    expect(harness.station.running).toBe(false);
    expect(harness.station.addresses()).toEqual([]);
    await expect(call(harness.port, "GET", "/")).rejects.toThrow();
  });
});

describe("signing in", () => {
  it("lets a paired device do nothing until a name and password are set at the PC", async () => {
    const harness = await startStation();
    const { token } = await pair(harness, "Phone", false);
    const state = await call(harness.port, "GET", "/account", { token });
    expect(state.json).toEqual({ set: false, signedIn: false, unlock: false, wait: 0 });
    for (const [method, path] of [
      ["POST", "/say"],
      ["POST", "/stop"],
      ["GET", "/events"],
      ["POST", "/app-pass"],
      ["POST", "/handover"],
    ] as const) {
      const refused = await call(harness.port, method, path, {
        token,
        ...(method === "POST" ? { body: { text: "hi" } } : {}),
      });
      expect(refused.status, path).toBe(403);
      expect(refused.json["need"], path).toBe("account");
    }
    const tried = await call(harness.port, "POST", "/sign-in", {
      token,
      body: { username: NAME, password: PASSWORD },
    });
    expect(tried.status).toBe(403);
    expect(harness.said).toEqual([]);
  });

  it("asks a paired device to sign in, and takes the right name and password only", async () => {
    const harness = await startStation();
    const { token } = await pair(harness, "Phone", false);
    await harness.station.setAccount(NAME, PASSWORD);
    const refused = await call(harness.port, "POST", "/say", { token, body: { text: "hi" } });
    expect(refused.status).toBe(401);
    expect(refused.json["need"]).toBe("sign-in");
    const wrong = await call(harness.port, "POST", "/sign-in", {
      token,
      body: { username: NAME, password: "not the password" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.json["error"]).toBe("That name or password is not right.");
    // Not paired at all: the name and password are not even looked at.
    const stranger = await call(harness.port, "POST", "/sign-in", {
      token: "x".repeat(43),
      body: { username: NAME, password: PASSWORD },
    });
    expect(stranger.status).toBe(401);
    expect(stranger.json["need"]).toBeUndefined();

    const session = await signInWith(harness, token);
    expect(session).toMatch(/^[\w-]{43}$/);
    expect((await call(harness.port, "GET", "/account", { token })).json).toMatchObject({
      set: true,
      signedIn: true,
    });
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      202,
    );
    // Neither the password nor the session is written down.
    const kept = await readFile(join(harness.dir, "account.json"), "utf8");
    expect(kept).not.toContain(PASSWORD);
    expect(kept).not.toContain(session);
  });

  it("keeps one device's session from being used by another", async () => {
    const harness = await startStation();
    const phone = await pair(harness, "Phone");
    const laptop = await pair(harness, "Laptop", false);
    const borrowed = await call(harness.port, "POST", "/say", {
      token: laptop.token,
      body: { text: "hi" },
      headers: { "X-Session": sessions.get(phone.token) ?? "" },
    });
    expect(borrowed.status).toBe(401);
    expect(harness.said).toEqual([]);
  });

  it("makes a device wait after five wrong tries", async () => {
    const harness = await startStation();
    const { token } = await pair(harness, "Phone", false);
    await harness.station.setAccount(NAME, PASSWORD);
    for (let tries = 0; tries < 5; tries += 1) {
      const wrong = await call(harness.port, "POST", "/sign-in", {
        token,
        body: { username: NAME, password: `wrong ${tries}` },
      });
      expect(wrong.status).toBe(401);
    }
    const locked = await call(harness.port, "POST", "/sign-in", {
      token,
      body: { username: NAME, password: PASSWORD },
    });
    expect(locked.status).toBe(429);
    expect(locked.json["error"]).toMatch(/Wait 10 minutes/);
    expect((await call(harness.port, "GET", "/account", { token })).json["wait"]).toBeGreaterThan(
      0,
    );
    harness.clock.now += 10 * 60_000 + 1000;
    await signInWith(harness, token);
  });

  it("ends a session on signing out, and everyone's when the password is changed", async () => {
    const harness = await startStation();
    const phone = await pair(harness, "Phone");
    const laptop = await pair(harness, "Laptop");
    const watching = listen(harness.port, laptop.token);
    await watching.waitFor((message) => message["type"] === "hello");

    expect(
      (await call(harness.port, "POST", "/sign-out", { token: phone.token, body: {} })).status,
    ).toBe(200);
    expect(
      (await call(harness.port, "POST", "/say", { token: phone.token, body: { text: "hi" } }))
        .status,
    ).toBe(401);

    await harness.station.setAccount(NAME, "another password now");
    // The open page is told, and its connection ends.
    await watching.waitFor((message) => message["type"] === "signed-out");
    await watching.closed;
    expect(
      (await call(harness.port, "POST", "/say", { token: laptop.token, body: { text: "hi" } }))
        .status,
    ).toBe(401);
    const old = await call(harness.port, "POST", "/sign-in", {
      token: laptop.token,
      body: { username: NAME, password: PASSWORD },
    });
    expect(old.status).toBe(401);
  });

  it("lets a phone back in by a key of its own, given only to a password session", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const issued = await call(harness.port, "POST", "/unlock-key", { token, body: {} });
    expect(issued.status).toBe(200);
    const key = String(issued.json["key"]);
    expect(key).toMatch(/^[\w-]{43}$/);
    expect(await readFile(join(harness.dir, "account.json"), "utf8")).not.toContain(key);
    expect((await call(harness.port, "GET", "/account", { token })).json["unlock"]).toBe(true);

    // Opened again later: no session, but the key lets it in.
    sessions.delete(token);
    const unlocked = await call(harness.port, "POST", "/unlock", { token, body: { key } });
    expect(unlocked.status).toBe(200);
    sessions.set(token, String(unlocked.json["session"]));
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      202,
    );
    // A session opened by the key cannot be used to make another key.
    expect((await call(harness.port, "POST", "/unlock-key", { token, body: {} })).status).toBe(403);
    // A wrong key is refused, and another device's key is no use.
    const other = await pair(harness, "Laptop", false);
    expect(
      (await call(harness.port, "POST", "/unlock", { token: other.token, body: { key } })).status,
    ).toBe(401);
    // Switching it off throws the key away.
    expect(
      (await call(harness.port, "POST", "/unlock-key/forget", { token, body: {} })).status,
    ).toBe(200);
    sessions.delete(token);
    expect((await call(harness.port, "POST", "/unlock", { token, body: { key } })).status).toBe(
      401,
    );
  });

  it("signs out a page left open and unused: an open connection is not use", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const stream = listen(harness.port, token);
    await stream.waitFor((message) => message["type"] === "hello");
    // The page asking which screen to show is not use either.
    harness.clock.now += SESSION_IDLE_MS - 60_000;
    expect((await call(harness.port, "GET", "/account", { token })).json["signedIn"]).toBe(true);
    harness.clock.now += 2 * 60_000;
    expect((await call(harness.port, "GET", "/account", { token })).json["signedIn"]).toBe(false);
    // The next thing that would have gone to the page tells it so instead, and nothing else.
    harness.station.broadcast({ type: "said", text: "a secret", from: "PC" });
    await stream.waitFor((message) => message["type"] === "signed-out");
    await stream.closed;
    expect(stream.messages.some((message) => message["text"] === "a secret")).toBe(false);
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      401,
    );
  });

  it("does not take the page opening its connection again for use", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    // A phone asleep on a table: the network drops the connection now and then and the
    // page picks it up again by itself, for longer than a session may lie unused.
    for (let passed = 0; passed < SESSION_IDLE_MS - 5 * 60_000; passed += 5 * 60_000) {
      harness.clock.now += 5 * 60_000;
      const stream = listen(harness.port, token);
      expect(await stream.status).toBe(200);
      stream.close();
      await stream.closed;
    }
    harness.clock.now += 6 * 60_000;
    expect(await listen(harness.port, token).status).toBe(401);
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      401,
    );
  });

  it("keeps a page signed in while its user is there", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    harness.clock.now += SESSION_IDLE_MS - 60_000;
    expect((await call(harness.port, "POST", "/active", { token, body: {} })).status).toBe(200);
    harness.clock.now += SESSION_IDLE_MS - 60_000;
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      202,
    );
    // Saying so needs a session like anything else.
    sessions.delete(token);
    expect((await call(harness.port, "POST", "/active", { token, body: {} })).status).toBe(401);
  });

  it("hands out a phone's own key only in the minutes after the password was typed", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    harness.clock.now += KEY_WITHIN_MS + 1000;
    const late = await call(harness.port, "POST", "/unlock-key", { token, body: {} });
    expect(late.status).toBe(403);
    expect(late.json["need"]).toBe("password");
    expect((await call(harness.port, "GET", "/account", { token })).json["unlock"]).toBe(false);
    // It is still signed in for everything else.
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      202,
    );
    await signInWith(harness, token);
    expect((await call(harness.port, "POST", "/unlock-key", { token, body: {} })).status).toBe(200);
  });

  it("looks at one sign-in at a time from a device", async () => {
    const harness = await startStation();
    const { token } = await pair(harness, "Phone", false);
    await harness.station.setAccount(NAME, PASSWORD);
    const tries = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(harness.port, "POST", "/sign-in", {
          token,
          body: { username: NAME, password: "not the password" },
        }),
      ),
    );
    const looked = tries.filter((answer) => answer.status === 401);
    expect(looked.length).toBeGreaterThanOrEqual(1);
    expect(looked.length).toBeLessThanOrEqual(WRONG_TRIES_ALLOWED);
    expect(tries.every((answer) => answer.status === 401 || answer.status === 429)).toBe(true);
  });

  it("leaves nothing of the old holder's when a pairing moves to the app", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    const oldSession = sessions.get(token) ?? "";
    const key = String(
      (await call(harness.port, "POST", "/unlock-key", { token, body: {} })).json["key"],
    );
    const code = String(
      (await call(harness.port, "POST", "/handover", { token, body: {} })).json["code"],
    );
    const taken = await call(harness.port, "POST", "/pair", { body: { code } });
    const appToken = String(taken.json["token"]);
    // The app's first request settles the move. The key the browser was given opens nothing.
    const byKey = await call(harness.port, "POST", "/unlock", { token: appToken, body: { key } });
    expect(byKey.status).toBe(401);
    // Nor does the browser's session, offered with the app's token.
    const carried = await call(harness.port, "POST", "/say", {
      token: appToken,
      body: { text: "hi" },
      headers: { "X-Session": oldSession },
    });
    expect(carried.status).toBe(401);
    expect((await call(harness.port, "GET", "/account", { token: appToken })).json["unlock"]).toBe(
      false,
    );
    // The password does.
    await signInWith(harness, appToken);
    expect(
      (await call(harness.port, "POST", "/say", { token: appToken, body: { text: "hi" } })).status,
    ).toBe(202);
  });

  it("passes a request for a reset to the PC, changes nothing, and tires of being asked", async () => {
    const asked: string[] = [];
    const harness = await startStation({ onResetAsked: (device) => asked.push(device.name) });
    const { token } = await pair(harness, "Kitchen tablet", false);
    await harness.station.setAccount(NAME, PASSWORD);
    for (let times = 0; times < 3; times += 1) {
      expect((await call(harness.port, "POST", "/reset", { token, body: {} })).status).toBe(202);
    }
    expect((await call(harness.port, "POST", "/reset", { token, body: {} })).status).toBe(429);
    expect(asked).toEqual(["Kitchen tablet", "Kitchen tablet", "Kitchen tablet"]);
    // A device that is not paired cannot ask.
    expect((await call(harness.port, "POST", "/reset", { body: {} })).status).toBe(401);
    // Asking changed nothing: the password still signs in.
    await signInWith(harness, token);
  });

  it("signs a device out for good when it is unpaired", async () => {
    const harness = await startStation();
    const { token, id } = await pair(harness);
    const key = String(
      (await call(harness.port, "POST", "/unlock-key", { token, body: {} })).json["key"],
    );
    await harness.station.forget(id);
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      401,
    );
    expect(await readFile(join(harness.dir, "account.json"), "utf8")).not.toContain(id);
    expect(key).toHaveLength(43);
  });
});

describe("answering a mission's question from a device", () => {
  const card = {
    id: "q".repeat(22),
    mission: "Update the server",
    missionId: "m-abc123",
    step: 2,
    steps: 3,
    title: "Upgrade",
    where: "proxmox",
    command: "apt-get -y upgrade",
    reason: "It changes that machine.",
    askedAt: "2026-11-21T12:00:00.000Z",
  };

  it("shows a signed-in device the open questions, and takes its yes or no once", async () => {
    const answers: string[] = [];
    let open = [card];
    const harness = await startStation({
      approvals: {
        cards: () => open,
        answer: (id, allowed, device) => {
          if (!open.some((entry) => entry.id === id)) return false;
          open = [];
          answers.push(`${id.slice(0, 3)} ${allowed} ${device.name}`);
          return true;
        },
      },
    });
    const { token } = await pair(harness, "Galaxy");
    const stream = listen(harness.port, token);
    const shown = await stream.waitFor((message) => message["type"] === "approval");
    expect(shown["card"]).toMatchObject({
      command: "apt-get -y upgrade",
      where: "proxmox",
      step: 2,
    });
    const yes = await call(harness.port, "POST", "/approve", {
      token,
      body: { id: card.id, allow: true },
    });
    expect(yes.status).toBe(200);
    expect(answers).toEqual(["qqq true Galaxy"]);
    // Answered already: a second answer is refused, whatever it says.
    const again = await call(harness.port, "POST", "/approve", {
      token,
      body: { id: card.id, allow: false },
    });
    expect(again.status).toBe(409);
    // Taken down everywhere.
    harness.station.withdrawApproval(card.id);
    await stream.waitFor((message) => message["type"] === "approval-gone");
    stream.close();
  });

  it("takes no answer from a device that is not signed in, and one from any that is", async () => {
    const answers: string[] = [];
    const harness = await startStation({
      approvals: { cards: () => [card], answer: (id) => answers.push(id) > 0 },
    });
    const { token } = await pair(harness, "Galaxy");
    const body = { id: card.id, allow: true };
    // Paired, but no session offered.
    const session = sessions.get(token) ?? "";
    sessions.delete(token);
    expect((await call(harness.port, "POST", "/approve", { token, body })).status).toBe(401);
    // Not paired at all.
    expect((await call(harness.port, "POST", "/approve", { body })).status).toBe(401);
    expect(answers).toEqual([]);
    // Signed in a good while ago and used since: still signed in, so it may answer.
    sessions.set(token, session);
    harness.clock.now += 20 * 60_000;
    expect((await call(harness.port, "POST", "/say", { token, body: { text: "hi" } })).status).toBe(
      202,
    );
    harness.clock.now += 20 * 60_000;
    expect((await call(harness.port, "POST", "/approve", { token, body })).status).toBe(200);
    expect(answers).toEqual([card.id]);
  });

  it("takes no answer from a device left unused for half an hour", async () => {
    const answers: string[] = [];
    const harness = await startStation({
      approvals: {
        cards: () => [card],
        answer: (id) => {
          answers.push(id);
          return true;
        },
      },
    });
    const { token } = await pair(harness, "Galaxy");
    harness.clock.now += SESSION_IDLE_MS + 1000;
    const late = await call(harness.port, "POST", "/approve", {
      token,
      body: { id: card.id, allow: true },
    });
    expect(late.status).toBe(401);
    expect(late.json["need"]).toBe("sign-in");
    expect(answers).toEqual([]);
  });

  it("refuses an answer that is not one, and offers nothing when nothing is wired", async () => {
    const harness = await startStation();
    const { token } = await pair(harness);
    for (const body of [{ id: "short", allow: true }, { id: card.id, allow: "yes" }, {}]) {
      expect((await call(harness.port, "POST", "/approve", { token, body })).status).toBe(400);
    }
    expect(
      (await call(harness.port, "POST", "/approve", { token, body: { id: card.id, allow: true } }))
        .status,
    ).toBe(409);
  });
});

describe("pinned mission bridge and away trace inspector", () => {
  const samplePinned: PinnedMissionView = {
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

  it("enforces auth on GET /mission, POST /mission/steer, POST /mission/stop, and handles 400/409/200 + SSE broadcasts", async () => {
    let current: PinnedMissionView | null = {
      ...samplePinned,
      steps: [...samplePinned.steps],
      thread: [...samplePinned.thread],
    };
    const harness = await startStation({
      pinnedMission: {
        current: () => current,
        steer: async (missionId, note, device) => {
          if (!current || current.id !== missionId) return null;
          current = {
            ...current,
            thread: [
              ...current.thread,
              {
                id: "t-445566",
                at: "2026-11-22T12:01:00.000Z",
                by: { from: "device", name: device.name },
                kind: "note",
                text: note,
              },
            ],
          };
          return current;
        },
        stop: async (missionId) => {
          if (!current || current.id !== missionId) return false;
          current = null;
          return true;
        },
      },
    });

    const { token } = await pair(harness, "Pixel");
    const session = sessions.get(token) ?? "";

    // Stream receives initial pinned-mission event
    const stream = listen(harness.port, token);
    const initial = await stream.waitFor((msg) => msg["type"] === "pinned-mission");
    expect(initial["mission"]).toMatchObject({ id: "m-a1b2c3", title: "Deploy release" });

    // Unsigned-in / unpaired rejected (401)
    sessions.delete(token);
    expect([401, 403]).toContain((await call(harness.port, "GET", "/mission", { token })).status);
    expect([401, 403]).toContain(
      (
        await call(harness.port, "POST", "/mission/steer", {
          token,
          body: { missionId: "m-a1b2c3", note: "check logs" },
        })
      ).status,
    );
    expect([401, 403]).toContain(
      (
        await call(harness.port, "POST", "/mission/stop", {
          token,
          body: { missionId: "m-a1b2c3" },
        })
      ).status,
    );
    expect([401, 403]).toContain((await call(harness.port, "GET", "/mission", {})).status);

    // Signed in: GET /mission returns pinned mission
    sessions.set(token, session);
    const fetched = await call(harness.port, "GET", "/mission", { token });
    expect(fetched.status).toBe(200);
    expect(fetched.json["mission"]).toMatchObject({ id: "m-a1b2c3", title: "Deploy release" });

    // Malformed missionId or empty note returns 400
    expect(
      (
        await call(harness.port, "POST", "/mission/steer", {
          token,
          body: { missionId: "bad-id", note: "hi" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(harness.port, "POST", "/mission/steer", {
          token,
          body: { missionId: "m-a1b2c3", note: "   " },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(harness.port, "POST", "/mission/stop", {
          token,
          body: { missionId: "bad-id" },
        })
      ).status,
    ).toBe(400);

    // Non-pinned id returns 409
    expect(
      (
        await call(harness.port, "POST", "/mission/steer", {
          token,
          body: { missionId: "m-deadbe", note: "nope" },
        })
      ).status,
    ).toBe(409);

    // Pinned steer returns 200 and appends note
    const steered = await call(harness.port, "POST", "/mission/steer", {
      token,
      body: { missionId: "m-a1b2c3", note: "Wait for green healthcheck" },
    });
    expect(steered.status).toBe(200);
    expect((steered.json["mission"] as { thread?: unknown[] })?.thread).toHaveLength(2);

    // updatePinnedMission broadcasts over SSE
    const updated: PinnedMissionView = { ...samplePinned, goal: "Deploy v2" };
    harness.station.updatePinnedMission(updated);
    const sseUpdate = await stream.waitFor(
      (msg) =>
        msg["type"] === "pinned-mission" &&
        (msg["mission"] as { goal?: string } | null)?.goal === "Deploy v2",
    );
    expect(sseUpdate["mission"]).toMatchObject({ goal: "Deploy v2" });

    // Stop pinned succeeds (200), and subsequent stop returns 409
    expect(
      (
        await call(harness.port, "POST", "/mission/stop", {
          token,
          body: { missionId: "m-a1b2c3" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(harness.port, "POST", "/mission/stop", {
          token,
          body: { missionId: "m-a1b2c3" },
        })
      ).status,
    ).toBe(409);

    stream.close();
  });

  it("requires session for GET /traces and returns 404 for remote pin/unpin/resume routes", async () => {
    const sampleTrace: ShownTrace = {
      at: "2026-11-22T12:00:00.000Z",
      kind: "user",
      said: "Check server",
      reply: "Server is up.",
      brain: "Standard (9B)",
      summary: "1 call",
      offered: 1,
      offeredTools: ["fleet_check"],
      picked: [{ tool: "fleet_check", why: "used or called for a moment ago" }],
      calls: [
        {
          tool: "fleet_check",
          ended: "worked",
          asked: false,
          ms: 15,
          gate: "allowed automatically",
          gateReason: "read-only",
          input: "{}",
          result: "ok",
        },
      ],
      checks: [],
      withheld: false,
      tokens: { read: 40, written: 12, held: 52, prompt: 410 },
      ms: { whole: 190, firstWord: 55, llm: 35, tools: 15, stt: 80, tts: 60 },
    };
    const harness = await startStation({
      traces: () => [sampleTrace],
    });
    const { token } = await pair(harness, "Pixel");
    const session = sessions.get(token) ?? "";

    // Unauthenticated GET /traces rejected
    sessions.delete(token);
    expect([401, 403]).toContain((await call(harness.port, "GET", "/traces", { token })).status);
    expect([401, 403]).toContain((await call(harness.port, "GET", "/traces", {})).status);

    // Authenticated GET /traces returns away traces
    sessions.set(token, session);
    const tracesRes = await call(harness.port, "GET", "/traces", { token });
    expect(tracesRes.status).toBe(200);
    expect(tracesRes.json["traces"]).toHaveLength(1);
    expect((tracesRes.json["traces"] as unknown[])[0]).toMatchObject({
      said: "Check server",
      offeredTools: ["fleet_check"],
    });

    // Remote pin/unpin/resume are strictly non-existent (404)
    for (const path of ["/mission/pin", "/mission/unpin", "/mission/resume"]) {
      expect(
        (await call(harness.port, "POST", path, { token, body: { id: "m-a1b2c3" } })).status,
      ).toBe(404);
      expect((await call(harness.port, "GET", path, { token })).status).toBe(404);
    }
  });

  it("serves GET /alerts to paired devices without an active session and pushes SSE alerts", async () => {
    const store: StationAlert[] = [
      {
        id: "alert-1",
        kind: "order",
        title: "Disk space",
        body: "Root filesystem above 90%",
        at: "2026-11-22T12:00:00.000Z",
      },
      {
        id: "alert-2",
        kind: "order",
        title: "Render done",
        body: "Blender finished frame 120",
        at: "2026-11-22T12:05:00.000Z",
      },
    ];
    const harness = await startStation({
      alerts: (sinceId) => {
        if (!sinceId) return [...store];
        const idx = store.findIndex((entry) => entry.id === sinceId);
        return idx === -1 ? store.slice(-10) : store.slice(idx + 1);
      },
    });
    const { token } = await pair(harness, "Pixel");
    const session = sessions.get(token) ?? "";

    // Unpaired caller gets 401
    expect((await call(harness.port, "GET", "/alerts", {})).status).toBe(401);

    // Paired device without X-Session succeeds (for Android Work/Job background polling)
    sessions.delete(token);
    const all = await call(harness.port, "GET", "/alerts", { token });
    expect(all.status).toBe(200);
    expect(all.json["alerts"]).toHaveLength(2);

    const delta = await call(harness.port, "GET", "/alerts?since=alert-1", { token });
    expect(delta.status).toBe(200);
    expect(delta.json["alerts"]).toHaveLength(1);
    expect((delta.json["alerts"] as StationAlert[])[0]?.id).toBe("alert-2");

    // Signed-in SSE receives pushed alerts
    sessions.set(token, session);
    const stream = listen(harness.port, token);
    await stream.waitFor((m) => m["type"] === "hello");
    const live: StationAlert = {
      id: "alert-3",
      kind: "order",
      title: "Build",
      body: "APK succeeded",
      at: "2026-11-22T12:10:00.000Z",
    };
    harness.station.pushAlert(live);
    const evt = await stream.waitFor((m) => m["type"] === "alert");
    expect(evt["alert"]).toEqual(live);
    stream.close();
  });

  it("transcribes POST /voice WAV uploads into onSay + SSE said and enforces validation limits", async () => {
    let nextTranscript = "check GPU temperature";
    const harness = await startStation({
      onVoice: async (samples) => {
        expect(samples.length).toBeGreaterThanOrEqual(800);
        return nextTranscript;
      },
    });
    const { token } = await pair(harness, "Phone");
    const wav = encodeWav16kMono(new Float32Array(3200));

    // Rejects wrong content-type (415)
    const badMime = await call(harness.port, "POST", "/voice", {
      token,
      raw: wav,
      headers: { "Content-Type": "application/json" },
    });
    expect(badMime.status).toBe(415);

    // Rejects oversized payload via Content-Length (413)
    const tooLarge = await call(harness.port, "POST", "/voice", {
      token,
      raw: Buffer.alloc(MAX_VOICE_BYTES + 16),
      headers: { "Content-Type": "audio/wav" },
    });
    expect(tooLarge.status).toBe(413);

    // Accepts valid signed-in WAV upload
    const stream = listen(harness.port, token);
    await stream.waitFor((m) => m["type"] === "hello");

    const ok = await call(harness.port, "POST", "/voice", {
      token,
      raw: wav,
      headers: { "Content-Type": "audio/wav" },
    });
    expect(ok.status).toBe(202);
    expect(ok.json["transcript"]).toBe("check GPU temperature");
    expect(harness.said).toHaveLength(1);
    expect(harness.said[0]?.text).toBe("check GPU temperature");

    const saidEvt = await stream.waitFor((m) => m["type"] === "said");
    expect(saidEvt["text"]).toBe("check GPU temperature");

    // Empty transcription returns 422
    nextTranscript = "   ";
    const empty = await call(harness.port, "POST", "/voice", {
      token,
      raw: wav,
      headers: { "Content-Type": "audio/wav" },
    });
    expect(empty.status).toBe(422);

    // Requires active session
    sessions.delete(token);
    expect(
      (
        await call(harness.port, "POST", "/voice", {
          token,
          raw: wav,
          headers: { "Content-Type": "audio/wav" },
        })
      ).status,
    ).toBe(401);

    stream.close();
  });

  it("handles POST /webhook with paired auth, default-off 503, topic validation, and 202 delivery", async () => {
    const offHarness = await startStation();
    const { token: offTok } = await pair(offHarness, "UPS", false);
    expect(
      (
        await call(offHarness.port, "POST", "/webhook", {
          token: offTok,
          body: { topic: "ups/battery", data: { load: 30 } },
        })
      ).status,
    ).toBe(503);

    const events: { topic: string; data: Record<string, unknown>; device: string }[] = [];
    const onHarness = await startStation({
      onWebhook: (ev) => {
        events.push({ topic: ev.topic, data: ev.data, device: ev.device.name });
        return true;
      },
    });
    const { token } = await pair(onHarness, "CI-Runner", false);

    // Unpaired refused with 401
    expect(
      (await call(onHarness.port, "POST", "/webhook", { body: { topic: "ci/done" } })).status,
    ).toBe(401);

    // Invalid topic returns 400
    expect(
      (
        await call(onHarness.port, "POST", "/webhook", {
          token,
          body: { topic: "bad topic!!" },
        })
      ).status,
    ).toBe(400);

    // Paired daemon without interactive session succeeds with 202
    const ok = await call(onHarness.port, "POST", "/webhook", {
      token,
      body: { topic: "ci/build.passed", data: { branch: "main" } },
    });
    expect(ok.status).toBe(202);
    expect(events).toEqual([
      { topic: "ci/build.passed", data: { branch: "main" }, device: "CI-Runner" },
    ]);
  });
});
