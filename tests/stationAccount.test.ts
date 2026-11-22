import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEY_WITHIN_MS,
  PASSWORD_COST,
  SESSION_IDLE_MS,
  SESSION_MOST_MS,
  StationAccount,
  WRONG_TRIES_ALLOWED,
  WRONG_TRIES_WINDOW_MS,
  whyNotThese,
} from "../src/core/stationAccount.ts";

const PASSWORD = "correct horse battery";
/** The least cost the account takes, so that these tests do not take a third of a second a try. */
const CHEAP = 1 << 14;

describe("the name and password for her station", () => {
  let dir: string;
  let now: number;
  let account: StationAccount;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-account-"));
    now = Date.UTC(2026, 10, 22, 12, 0, 0);
    account = new StationAccount({ dir, now: () => now, cost: CHEAP });
    await account.load();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("says what is wrong with a name or password that will not do", () => {
    expect(whyNotThese("captain", PASSWORD)).toBeNull();
    expect(whyNotThese("ab", PASSWORD)).toMatch(/3 to 32/);
    expect(whyNotThese("has space", PASSWORD)).toMatch(/3 to 32/);
    expect(whyNotThese("captain", "short")).toMatch(/at least 8/);
    expect(whyNotThese("captain", "x".repeat(201))).toMatch(/too long/);
    expect(whyNotThese("Captain1", "captain1")).toMatch(/not be the same/);
  });

  it("lets nobody in until one is set, and keeps no password on disk", async () => {
    expect(account.exists).toBe(false);
    expect(await account.signIn("phone", "captain", PASSWORD)).toBeNull();
    await account.set("captain", PASSWORD);
    expect(account.exists).toBe(true);
    expect(account.username).toBe("captain");
    const onDisk = await readFile(join(dir, "account.json"), "utf8");
    expect(onDisk).not.toContain(PASSWORD);
    expect((await stat(join(dir, "account.json"))).mode & 0o077).toBe(0);
    // Read back by another instance, as after a restart.
    const again = new StationAccount({ dir, now: () => now, cost: CHEAP });
    await again.load();
    expect(await again.signIn("phone", "captain", PASSWORD)).toMatch(/^[\w-]{43}$/);
  });

  it("signs in with the right name and password only, whatever the capitals of the name", async () => {
    await account.set("Captain", PASSWORD);
    expect(await account.signIn("phone", "captain", PASSWORD)).not.toBeNull();
    expect(await account.signIn("phone", " CAPTAIN ", PASSWORD)).not.toBeNull();
    expect(await account.signIn("phone", "captain", "Correct horse battery")).toBeNull();
    expect(await account.signIn("phone", "someone", PASSWORD)).toBeNull();
    expect(await account.signIn("phone", "captain", "")).toBeNull();
  });

  it("gives a session to the device that signed in, and to no other", async () => {
    await account.set("captain", PASSWORD);
    const token = await account.signIn("phone", "captain", PASSWORD);
    expect(account.check("phone", token ?? "")).toBe(true);
    expect(account.check("laptop", token ?? "")).toBe(false);
    expect(account.check("phone", "not-a-token")).toBe(false);
    expect(account.check("phone", undefined)).toBe(false);
    // Signing in again on the same device replaces the session before.
    const second = await account.signIn("phone", "captain", PASSWORD);
    expect(account.check("phone", token ?? "")).toBe(false);
    expect(account.check("phone", second ?? "")).toBe(true);
    account.signOut(second ?? "");
    expect(account.check("phone", second ?? "")).toBe(false);
  });

  it("ends a session left unused, and any session after half a day", async () => {
    await account.set("captain", PASSWORD);
    const idle = await account.signIn("phone", "captain", PASSWORD);
    now += SESSION_IDLE_MS - 1000;
    expect(account.check("phone", idle ?? "")).toBe(true);
    now += SESSION_IDLE_MS + 1000;
    expect(account.check("phone", idle ?? "")).toBe(false);

    const used = await account.signIn("phone", "captain", PASSWORD);
    for (let passed = 0; passed < SESSION_MOST_MS; passed += SESSION_IDLE_MS / 2) {
      now += SESSION_IDLE_MS / 2;
      if (passed + SESSION_IDLE_MS / 2 < SESSION_MOST_MS) {
        expect(account.check("phone", used ?? ""), String(passed)).toBe(true);
      }
    }
    now += 1000;
    expect(account.check("phone", used ?? "")).toBe(false);
  });

  it("does not count what the page does by itself as use", async () => {
    await account.set("captain", PASSWORD);
    const token = (await account.signIn("phone", "captain", PASSWORD)) ?? "";
    // Looked at every few seconds by an open connection, for longer than it may lie unused.
    for (let passed = 0; passed < SESSION_IDLE_MS - 60_000; passed += 25_000) {
      now += 25_000;
      expect(account.alive("phone", token)).toBe(true);
      expect(account.sessionOf("phone", token)?.by).toBe("password");
    }
    now += 2 * 60_000;
    expect(account.alive("phone", token)).toBe(false);
    expect(account.check("phone", token)).toBe(false);
    expect(account.alive("laptop", token)).toBe(false);
    expect(account.alive("phone", undefined)).toBe(false);
  });

  it("looks at one try at a time from a device, so that none slips past the count", async () => {
    await account.set("captain", PASSWORD);
    const tries = await Promise.all(
      Array.from({ length: 12 }, () => account.signIn("phone", "captain", "wrong password")),
    );
    expect(tries.every((token) => token === null)).toBe(true);
    expect(account.isTrying("phone")).toBe(false);
    // Twelve were sent and one was looked at: four more may still be made.
    for (let more = 1; more < WRONG_TRIES_ALLOWED; more += 1) {
      expect(account.mustWait("phone"), String(more)).toBe(0);
      expect(await account.signIn("phone", "captain", "wrong password")).toBeNull();
    }
    expect(account.mustWait("phone")).toBeGreaterThan(0);
    // A try on another device is not held up for good by it.
    expect(await account.signIn("laptop", "captain", PASSWORD)).not.toBeNull();
  });

  it("gives a device a key of its own only just after the password was typed there", async () => {
    await account.set("captain", PASSWORD);
    const token = (await account.signIn("phone", "captain", PASSWORD)) ?? "";
    now += KEY_WITHIN_MS + 1000;
    expect(account.check("phone", token)).toBe(true);
    expect(await account.issueUnlock("phone", token)).toBeNull();
    expect(account.hasUnlock("phone")).toBe(false);
    const again = (await account.signIn("phone", "captain", PASSWORD)) ?? "";
    const key = (await account.issueUnlock("phone", again)) ?? "";
    expect(key).toMatch(/^[\w-]{43}$/);
    // Signed in by the key, however lately, it cannot fetch another.
    const byKey = account.unlock("phone", key) ?? "";
    expect(await account.issueUnlock("phone", byKey)).toBeNull();
  });

  it("ends a device's session and key when its pairing moves, keeping its wrong tries", async () => {
    await account.set("captain", PASSWORD);
    expect(await account.signIn("phone", "captain", "wrong password")).toBeNull();
    const token = (await account.signIn("laptop", "captain", PASSWORD)) ?? "";
    const key = (await account.issueUnlock("laptop", token)) ?? "";
    await account.endAccess("laptop");
    expect(account.alive("laptop", token)).toBe(false);
    expect(account.hasUnlock("laptop")).toBe(false);
    expect(account.unlock("laptop", key)).toBeNull();
    const kept = JSON.parse(await readFile(join(dir, "account.json"), "utf8")) as {
      unlock: Record<string, string>;
    };
    expect(kept.unlock).toEqual({});
    // The other device is untouched: its one wrong try still stands.
    for (let more = 1; more < WRONG_TRIES_ALLOWED; more += 1) {
      expect(await account.signIn("phone", "captain", "wrong password")).toBeNull();
    }
    expect(account.mustWait("phone")).toBeGreaterThan(0);
  });

  it("keeps the cost the password was hashed at, and raises an old one at the next sign-in", async () => {
    await account.set("captain", PASSWORD);
    const file = join(dir, "account.json");
    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(written["cost"]).toBe(CHEAP);

    // A file from before the cost was kept in it: made at the first cost, and saying nothing.
    const old = new StationAccount({ dir, now: () => now, cost: 1 << 15 });
    await old.set("captain", PASSWORD);
    const before = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete before["cost"];
    await writeFile(file, JSON.stringify(before), "utf8");

    const today = new StationAccount({ dir, now: () => now });
    await today.load();
    expect(await today.signIn("phone", "captain", "wrong password")).toBeNull();
    const token = (await today.signIn("phone", "captain", PASSWORD)) ?? "";
    expect(today.check("phone", token)).toBe(true);
    // Hashed again at today's cost while the password was at hand; the session stands.
    let after: Record<string, unknown> = {};
    for (let tries = 0; tries < 200 && after["cost"] !== PASSWORD_COST; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    }
    expect(after["cost"]).toBe(PASSWORD_COST);
    expect(after["hash"]).not.toBe(before["hash"]);
    expect(today.check("phone", token)).toBe(true);
    const reread = new StationAccount({ dir, now: () => now });
    await reread.load();
    expect(await reread.signIn("laptop", "captain", PASSWORD)).not.toBeNull();
    expect(await reread.signIn("laptop", "captain", "wrong password")).toBeNull();
  });

  it("takes no cost from the file that is not one", async () => {
    await account.set("captain", PASSWORD);
    const file = join(dir, "account.json");
    const kept = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    for (const cost of [0, 3, 1 << 30, 1000, "32768", -16384]) {
      await writeFile(file, JSON.stringify({ ...kept, cost }), "utf8");
      const read = new StationAccount({ dir, now: () => now, cost: CHEAP });
      await read.load();
      // Read as the first cost, so the password (hashed at another) does not sign in: no crash, no way in.
      expect(read.exists, String(cost)).toBe(true);
      expect(await read.signIn("phone", "captain", PASSWORD), String(cost)).toBeNull();
    }
  });

  it("makes a device wait after a few wrong tries, and only that device", async () => {
    await account.set("captain", PASSWORD);
    for (let tries = 0; tries < WRONG_TRIES_ALLOWED; tries += 1) {
      expect(account.mustWait("phone")).toBe(0);
      expect(await account.signIn("phone", "captain", "wrong password")).toBeNull();
    }
    expect(account.mustWait("phone")).toBeGreaterThan(0);
    // Even the right password is not looked at while it waits.
    expect(await account.signIn("phone", "captain", PASSWORD)).toBeNull();
    expect(await account.signIn("laptop", "captain", PASSWORD)).not.toBeNull();
    now += WRONG_TRIES_WINDOW_MS + 1000;
    expect(account.mustWait("phone")).toBe(0);
    expect(await account.signIn("phone", "captain", PASSWORD)).not.toBeNull();
  });

  it("ends every session and every device's key when the password is changed", async () => {
    await account.set("captain", PASSWORD);
    const token = await account.signIn("phone", "captain", PASSWORD);
    const key = await account.issueUnlock("phone", token ?? "");
    expect(key).toMatch(/^[\w-]{43}$/);
    await account.set("captain", "a new password entirely");
    expect(account.check("phone", token ?? "")).toBe(false);
    expect(account.hasUnlock("phone")).toBe(false);
    expect(account.unlock("phone", key ?? "")).toBeNull();
    expect(await account.signIn("phone", "captain", PASSWORD)).toBeNull();
    expect(await account.signIn("phone", "captain", "a new password entirely")).not.toBeNull();
  });

  it("lets a device back in by its own key, which only a password session can obtain", async () => {
    await account.set("captain", PASSWORD);
    const token = await account.signIn("phone", "captain", PASSWORD);
    const key = (await account.issueUnlock("phone", token ?? "")) ?? "";
    expect(await readFile(join(dir, "account.json"), "utf8")).not.toContain(key);
    // The key signs in that device and no other.
    expect(account.unlock("laptop", key)).toBeNull();
    const byKey = account.unlock("phone", key);
    expect(account.check("phone", byKey ?? "")).toBe(true);
    // A session opened by the key cannot be used to make another key.
    expect(await account.issueUnlock("phone", byKey ?? "")).toBeNull();
    // Nor can a session of another device, or no session.
    expect(await account.issueUnlock("laptop", byKey ?? "")).toBeNull();
    expect(await account.issueUnlock("phone", undefined)).toBeNull();
    // Wrong keys count as wrong tries.
    for (let tries = 0; tries < WRONG_TRIES_ALLOWED; tries += 1)
      account.unlock("phone", "x".repeat(43));
    expect(account.unlock("phone", key)).toBeNull();
    now += WRONG_TRIES_WINDOW_MS + 1000;
    expect(account.unlock("phone", key)).not.toBeNull();
    await account.dropUnlock("phone");
    expect(account.unlock("phone", key)).toBeNull();
  });

  it("forgets a device's session and key when the device is unpaired", async () => {
    await account.set("captain", PASSWORD);
    const token = await account.signIn("phone", "captain", PASSWORD);
    const key = (await account.issueUnlock("phone", token ?? "")) ?? "";
    await account.forgetDevice("phone");
    expect(account.check("phone", token ?? "")).toBe(false);
    expect(account.unlock("phone", key)).toBeNull();
  });

  it("passes on a few requests for a reset an hour, and changes nothing by them", async () => {
    await account.set("captain", PASSWORD);
    expect(account.askForReset("phone")).toBe(true);
    expect(account.askForReset("phone")).toBe(true);
    expect(account.askForReset("phone")).toBe(true);
    expect(account.askForReset("phone")).toBe(false);
    expect(account.askForReset("laptop")).toBe(true);
    now += 60 * 60_000 + 1000;
    expect(account.askForReset("phone")).toBe(true);
    // The password still works: asking changes nothing.
    expect(await account.signIn("phone", "captain", PASSWORD)).not.toBeNull();
  });

  it("counts a file that is not an account as none set", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir, "account.json"),
      '{"version":1,"username":"x","salt":"zz","hash":"1"}',
    );
    await account.load();
    expect(account.exists).toBe(false);
  });
});
