import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtPhoneApp } from "../src/core/reach.ts";
import { Station } from "../src/core/station.ts";
import { stationPage } from "../src/core/stationPage.ts";

/**
 * The station's part in the phone app: handing the app's file to a paired phone, and
 * letting the app take a pairing over from the browser without a second device appearing.
 */

let dir = "";
let station: Station;
let port = 0;
let appFile = "";
let offered = true;
const clock = { now: Date.parse("2026-11-21T12:00:00Z") };
const APP_BYTES = Buffer.from("PK\u0003\u0004 pretend this is an app package");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-app-"));
  appFile = join(dir, "ai-chan.apk");
  await writeFile(appFile, APP_BYTES);
  await writeFile(join(dir, "version"), "0.1.0\n");
  station = new Station({
    dir: join(dir, "station"),
    port: 0,
    onSay: () => true,
    onStop: () => undefined,
    now: () => clock.now,
    localAddresses: () => ["127.0.0.1"],
    phoneApp: () => (offered ? builtPhoneApp(appFile) : null),
    makeCertificate: async (target) => {
      await promisify(execFile)("openssl", [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", join(target, "key.pem"), "-out", join(target, "cert.pem"),
        "-days", "2", "-subj", "/CN=test",
      ]); // prettier-ignore
    },
  });
  await station.start();
  port = Number(new URL(station.addresses()[0] ?? "").port);
});

afterAll(async () => {
  await station.stop();
  await rm(dir, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  json: Record<string, unknown>;
}

function call(method: string, path: string, token?: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const asking = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(token && sessions.has(token) ? { "X-Session": sessions.get(token) ?? "" } : {}),
        },
      },
      (answer) => {
        const parts: Buffer[] = [];
        answer.on("data", (part: Buffer) => parts.push(part));
        answer.on("end", () => {
          const whole = Buffer.concat(parts);
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(whole.toString("utf8")) as Record<string, unknown>;
          } catch {
            // not every answer is JSON
          }
          resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body: whole, json });
        });
      },
    );
    asking.on("error", reject);
    asking.end(payload);
  });
}

/** The session of each token these tests have signed in. */
const sessions = new Map<string, string>();
const NAME = "captain";
const PASSWORD = "correct horse battery";

/** Signs in whoever holds this token, setting the name and password first when there are none. */
async function signIn(token: string): Promise<void> {
  if (!station.account.exists) await station.setAccount(NAME, PASSWORD);
  const answer = await call("POST", "/sign-in", token, { username: NAME, password: PASSWORD });
  expect(answer.status).toBe(200);
  sessions.set(token, String(answer.json["session"]));
}

async function pairDevice(name: string): Promise<{ token: string; id: string }> {
  const { code } = station.beginPairing();
  const paired = await call("POST", "/pair", undefined, { code, name });
  expect(paired.status).toBe(200);
  const device = paired.json["device"] as { id: string };
  const token = String(paired.json["token"]);
  await signIn(token);
  return { token, id: device.id };
}

/** Reads the first events of a device's stream and hangs up. */
function firstEvents(token: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const asking = request(
      {
        host: "127.0.0.1",
        port,
        path: "/events",
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(sessions.has(token) ? { "X-Session": sessions.get(token) ?? "" } : {}),
        },
      },
      (answer) => {
        let text = "";
        answer.on("data", (part: Buffer) => {
          text += part.toString("utf8");
          if (!text.includes('"recent"')) return;
          asking.destroy();
          resolve(
            text
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>),
          );
        });
        answer.on("error", () => undefined);
      },
    );
    asking.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
    asking.end();
  });
}

describe("handing the phone app to a paired phone", () => {
  it("tells a connecting device whether there is an app to be had", async () => {
    const { token } = await pairDevice("Phone A");
    offered = true;
    expect((await firstEvents(token))[0]).toMatchObject({ type: "hello", app: true });
    offered = false;
    expect((await firstEvents(token))[0]).toMatchObject({ type: "hello", app: false });
    offered = true;
  });

  it("gives a paired device a pass, and the app's file for that pass", async () => {
    const { token } = await pairDevice("Phone B");
    const pass = await call("POST", "/app-pass", token, {});
    expect(pass.status).toBe(200);
    expect(pass.json["version"]).toBe("0.1.0");
    const path = String(pass.json["path"]);
    expect(path).toMatch(/^\/app\/[A-Za-z0-9_-]{20,64}\/ai-chan\.apk$/);
    // The download itself carries no token: the phone's download manager fetches it bare.
    const file = await call("GET", path);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/vnd.android.package-archive");
    expect(file.headers["content-disposition"]).toContain('filename="ai-chan.apk"');
    expect(file.body.equals(APP_BYTES)).toBe(true);
    // A download manager may ask twice; the pass holds for its two minutes.
    expect((await call("GET", path)).status).toBe(200);
    clock.now += 2 * 60_000 + 1;
    expect((await call("GET", path)).status).toBe(404);
  });

  it("gives no pass without a token, and no file for a made-up pass", async () => {
    expect((await call("POST", "/app-pass", undefined, {})).status).toBe(401);
    expect((await call("GET", `/app/${"x".repeat(32)}/ai-chan.apk`)).status).toBe(404);
    expect((await call("GET", "/app/short/ai-chan.apk")).status).toBe(404);
  });

  it("says so when the app has not been built", async () => {
    const { token } = await pairDevice("Phone C");
    offered = false;
    const pass = await call("POST", "/app-pass", token, {});
    offered = true;
    expect(pass.status).toBe(404);
    expect(String(pass.json["error"])).toContain("has not been built");
  });

  it("knows a built app from a missing one", () => {
    expect(builtPhoneApp(appFile)).toEqual({ file: appFile, version: "0.1.0" });
    expect(builtPhoneApp(join(dir, "nothing.apk"))).toBeNull();
    expect(builtPhoneApp(undefined)).toBeNull();
  });
});

describe("carrying a pairing over to the app", () => {
  it("moves the pairing: the app's token works, the browser's stops, and no device is added", async () => {
    const before = station.devices().length;
    const { token, id } = await pairDevice("Phone D");
    const handed = await call("POST", "/handover", token, {});
    expect(handed.status).toBe(200);
    expect(handed.json["at"]).toBe(`127.0.0.1:${port}`);
    expect(handed.json["fingerprint"]).toBe(station.fingerprint()?.replaceAll(":", ""));
    const code = String(handed.json["code"]);
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,64}$/);

    const taken = await call("POST", "/pair", undefined, { code });
    expect(taken.status).toBe(200);
    const appToken = String(taken.json["token"]);
    expect(appToken).not.toBe(token);
    expect((taken.json["device"] as { id: string; name: string }).id).toBe(id);
    expect(station.devices().length).toBe(before + 1);
    expect(station.devices().filter((device) => device.name === "Phone D")).toHaveLength(1);

    // The pairing was carried over, not who is signed in: the app signs in for itself.
    expect((await call("POST", "/app-pass", appToken, {})).status).toBe(401);
    await signIn(appToken);
    expect((await call("POST", "/app-pass", appToken, {})).status).toBe(200);
    expect((await call("POST", "/app-pass", token, {})).status).toBe(401);
    // The code worked once.
    expect((await call("POST", "/pair", undefined, { code })).status).toBe(403);
    // Neither token is written down anywhere.
    const kept = await readFile(join(dir, "station", "devices.json"), "utf8");
    expect(kept).not.toContain(appToken);
    expect(kept).not.toContain(token);
    await station.forget(id);
  });

  it("leaves the browser paired until the app has really used its token", async () => {
    const { token, id } = await pairDevice("Phone H");
    const code = String((await call("POST", "/handover", token, {})).json["code"]);
    const appToken = String((await call("POST", "/pair", undefined, { code })).json["token"]);
    // The answer may never have reached the app; the browser must not be stranded.
    expect((await call("POST", "/app-pass", token, {})).status).toBe(200);
    expect((await call("POST", "/app-pass", token, {})).status).toBe(200);
    // The app's first request settles it: its signing in.
    await signIn(appToken);
    expect((await call("POST", "/app-pass", appToken, {})).status).toBe(200);
    expect((await call("POST", "/app-pass", token, {})).status).toBe(401);
    expect((await call("POST", "/app-pass", appToken, {})).status).toBe(200);
    await station.forget(id);
  });

  it("drops a hand-over the app never took up", async () => {
    const { token, id } = await pairDevice("Phone I");
    const code = String((await call("POST", "/handover", token, {})).json["code"]);
    const appToken = String((await call("POST", "/pair", undefined, { code })).json["token"]);
    clock.now += 5 * 60_000 + 1;
    expect((await call("POST", "/app-pass", appToken, {})).status).toBe(401);
    expect((await call("POST", "/app-pass", token, {})).status).toBe(200);
    await station.forget(id);
  });

  it("refuses a handover code that has run out, or that belongs to a removed device", async () => {
    const first = await pairDevice("Phone E");
    const late = String((await call("POST", "/handover", first.token, {})).json["code"]);
    clock.now += 2 * 60_000 + 1;
    expect((await call("POST", "/pair", undefined, { code: late })).status).toBe(403);

    const second = await pairDevice("Phone F");
    const orphan = String((await call("POST", "/handover", second.token, {})).json["code"]);
    await station.forget(second.id);
    expect((await call("POST", "/pair", undefined, { code: orphan })).status).toBe(403);
    await station.forget(first.id);
  });

  it("keeps only the newest handover code for a device", async () => {
    const { token, id } = await pairDevice("Phone G");
    const older = String((await call("POST", "/handover", token, {})).json["code"]);
    const newer = String((await call("POST", "/handover", token, {})).json["code"]);
    expect((await call("POST", "/pair", undefined, { code: older })).status).toBe(403);
    expect((await call("POST", "/pair", undefined, { code: newer })).status).toBe(200);
    await station.forget(id);
  });

  it("gives no handover code without a token", async () => {
    expect((await call("POST", "/handover", undefined, {})).status).toBe(401);
  });
});

describe("her page and the app", () => {
  const page = stationPage("nonce");

  it("offers the app, and takes a carried-over pairing from the address", () => {
    expect(page).toContain('id="get-app"');
    expect(page).toContain("/app-pass");
    expect(page).toContain("/handover");
    expect(page).toContain("aichan://station?at=");
    expect(page).toContain("#pair=");
  });

  it("does not offer the app from inside the app", () => {
    expect(page).toContain("AIChanApp");
  });

  it("still loads nothing from anywhere else", () => {
    expect(page.match(/https?:\/\//g) ?? []).toEqual([]);
  });
});
