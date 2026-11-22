import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Who may use her station once a device is paired: one name and password, set by the
 * user at the PC and asked for every time the page or the phone app is opened.
 *
 * Pairing says "this device is one of mine". It does not say who is holding it: a phone
 * left on a table is still paired. Signing in says that, and it is what lets a device
 * be trusted with more than talking to her (see `canApprove` in the station).
 *
 * - The password is never kept, only a slow salted hash of it (scrypt), in a file that
 *   only this account can read. Reading her files does not yield a password.
 * - Signing in gives the device a session: a long random token held in the page's
 *   memory, never written down on the device, so closing the page or the app ends it.
 *   Here only a hash of it is held, in memory, for half an hour without use and twelve
 *   hours at most. Use means something the person did: a page left open is not use.
 *   Restarting her ends every session.
 * - A phone can be let back in by its own fingerprint or face check: it is given a
 *   second long random key, which the phone locks away behind that check. Only a hash
 *   is kept here. The key signs in that one device and nothing else, and is handed out
 *   only in the few minutes after the password was typed on that device.
 * - The password is set and changed at the PC only. A device can ask for a reset; that
 *   asks the person at the PC and does nothing else. Changing the password ends every
 *   session and throws away every such key.
 * - Wrong tries are counted per device; after a few, that device waits.
 */

/** What a name may be: letters, digits, dot, dash, underscore; 3 to 32 of them. */
export const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
export const MIN_PASSWORD_CHARS = 8;
export const MAX_PASSWORD_CHARS = 200;

/** A session unused this long is over. */
export const SESSION_IDLE_MS = 30 * 60_000;
/** However much it is used, a session ends after this long. */
export const SESSION_MOST_MS = 12 * 60 * 60_000;
/** Wrong tries a device may make in the window before it has to wait. */
export const WRONG_TRIES_ALLOWED = 5;
export const WRONG_TRIES_WINDOW_MS = 10 * 60_000;
/** Reset requests a device may send in an hour. */
const RESETS_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;
const MAX_SESSIONS = 24;
/**
 * How lately the password must have been typed on a device for it to be given a key of
 * its own. Such a key lasts until the password is changed, so a page left signed in on
 * a table must not be able to fetch one.
 */
export const KEY_WITHIN_MS = 5 * 60_000;

const ACCOUNT_FILE = "account.json";
/**
 * scrypt's cost (its N, with r = 8 and p = 1): about a third of a second and 128 MB a
 * try on a desktop processor. What a stolen copy of the file costs to guess against.
 */
export const PASSWORD_COST = 1 << 17;
/** What files written before the cost was kept in them were made with. */
const FIRST_COST = 1 << 15;
const LEAST_COST = 1 << 14;
const MOST_COST = 1 << 20;
const KEY_BYTES = 32;

const isACost = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isInteger(n) &&
  n >= LEAST_COST &&
  n <= MOST_COST &&
  (n & (n - 1)) === 0;

interface Stored {
  version: 1;
  username: string;
  /** Hex. */
  salt: string;
  /** Hex: scrypt of the password with that salt. */
  hash: string;
  changedAt: string;
  /** scrypt's N for that hash. Absent in files written before it was kept. */
  cost?: number;
  /** For each device that may sign in by its own check: SHA-256 of its key, in hex. */
  unlock: Record<string, string>;
}

interface Session {
  deviceId: string;
  openedAt: number;
  usedAt: number;
  /** How it was opened: by the password, or by the device's own check. */
  by: "password" | "unlock";
}

function slowHash(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_BYTES,
      { N: cost, r: 8, p: 1, maxmem: 160 * cost * 8 },
      (error, key) => (error ? fail(error) : done(key)),
    );
  });
}

const quickHash = (text: string): Buffer => createHash("sha256").update(text).digest();

/** Why a name or password will not do, in words for the person setting it; null when it will. */
export function whyNotThese(username: string, password: string): string | null {
  if (!USERNAME.test(username)) {
    return "The name needs 3 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.";
  }
  if (password.length < MIN_PASSWORD_CHARS) {
    return `The password needs at least ${MIN_PASSWORD_CHARS} characters.`;
  }
  if (password.length > MAX_PASSWORD_CHARS) return "That password is too long.";
  if (password.toLowerCase() === username.toLowerCase()) {
    return "The password may not be the same as the name.";
  }
  return null;
}

export interface AccountDeps {
  /** The station's private folder. */
  dir: string;
  now?(): number;
  /** scrypt's N for a password set from now on. For tests, which cannot wait a third of a second a try. */
  cost?: number;
}

export class StationAccount {
  private readonly deps: AccountDeps;
  private stored: Stored | null = null;
  /** By the hex SHA-256 of the session's token. */
  private readonly sessions = new Map<string, Session>();
  /** When each device's wrong tries were made. */
  private readonly wrong = new Map<string, number[]>();
  private readonly resets = new Map<string, number[]>();
  /** Devices with a sign-in being worked out: one try at a time each. */
  private readonly trying = new Set<string>();
  /** One slow hash at a time, whoever asks: each takes a processor and 128 MB. */
  private hashChain: Promise<unknown> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(deps: AccountDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private file(): string {
    return join(this.deps.dir, ACCOUNT_FILE);
  }

  private cost(): number {
    return isACost(this.deps.cost) ? this.deps.cost : PASSWORD_COST;
  }

  private hashed(password: string, salt: Buffer, cost: number): Promise<Buffer> {
    const mine = this.hashChain.catch(() => undefined).then(() => slowHash(password, salt, cost));
    this.hashChain = mine;
    return mine;
  }

  /** Reads the account from disk. A file that cannot be read as one counts as none set. */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file(), "utf8")) as Partial<Stored>;
      if (
        raw.version === 1 &&
        typeof raw.username === "string" &&
        USERNAME.test(raw.username) &&
        typeof raw.salt === "string" &&
        /^[a-f0-9]{32}$/.test(raw.salt) &&
        typeof raw.hash === "string" &&
        /^[a-f0-9]{64}$/.test(raw.hash)
      ) {
        const unlock: Record<string, string> = {};
        for (const [device, hash] of Object.entries(raw.unlock ?? {})) {
          if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) unlock[device] = hash;
        }
        this.stored = {
          version: 1,
          username: raw.username,
          salt: raw.salt,
          hash: raw.hash,
          changedAt: typeof raw.changedAt === "string" ? raw.changedAt : "",
          cost: isACost(raw.cost) ? raw.cost : FIRST_COST,
          unlock,
        };
        return;
      }
    } catch {
      // none yet, or not readable as one
    }
    this.stored = null;
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.stored, null, 2);
    const file = this.file();
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, file);
      });
    return this.saveChain;
  }

  /** True once a name and password have been set. */
  get exists(): boolean {
    return this.stored !== null;
  }

  get username(): string | null {
    return this.stored?.username ?? null;
  }

  get changedAt(): string | null {
    return this.stored?.changedAt || null;
  }

  /**
   * Sets the name and password, at the PC. Ends every session and throws away every
   * device's key: whoever was signed in signs in again with the new password.
   * Throws, in words for the user, when the name or password will not do.
   */
  async set(username: string, password: string): Promise<void> {
    const name = username.trim();
    const problem = whyNotThese(name, password);
    if (problem) throw new Error(problem);
    const salt = randomBytes(16);
    const cost = this.cost();
    const hash = await this.hashed(password, salt, cost);
    this.stored = {
      version: 1,
      username: name,
      salt: salt.toString("hex"),
      hash: hash.toString("hex"),
      changedAt: new Date(this.now()).toISOString(),
      cost,
      unlock: {},
    };
    this.sessions.clear();
    this.wrong.clear();
    await this.save();
  }

  // ---------- wrong tries ----------

  private tries(device: string): number[] {
    const now = this.now();
    const kept = (this.wrong.get(device) ?? []).filter((at) => now - at < WRONG_TRIES_WINDOW_MS);
    if (kept.length > 0) this.wrong.set(device, kept);
    else this.wrong.delete(device);
    return kept;
  }

  /** How long this device has to wait before it may try again, in milliseconds; 0 when it may. */
  mustWait(device: string): number {
    const kept = this.tries(device);
    if (kept.length < WRONG_TRIES_ALLOWED) return 0;
    return Math.max(0, (kept[0] ?? 0) + WRONG_TRIES_WINDOW_MS - this.now());
  }

  private noteWrong(device: string): void {
    const kept = this.tries(device);
    kept.push(this.now());
    this.wrong.set(device, kept);
  }

  // ---------- signing in ----------

  /**
   * Checks a name and password offered by a device. Takes the same time whether the
   * name, the password or both are wrong, and whether or not any account is set.
   * Returns a session token, or null: wrong, no account, or the device has to wait.
   */
  async signIn(device: string, username: string, password: string): Promise<string | null> {
    // One try at a time a device: several sent at once would all be past the count of
    // wrong tries before any of them was counted.
    if (this.mustWait(device) > 0 || this.trying.has(device)) return null;
    this.trying.add(device);
    try {
      return await this.tryToSignIn(device, username, password.slice(0, MAX_PASSWORD_CHARS));
    } finally {
      this.trying.delete(device);
    }
  }

  /** True while a sign-in from this device is being worked out. */
  isTrying(device: string): boolean {
    return this.trying.has(device);
  }

  private async tryToSignIn(
    device: string,
    username: string,
    password: string,
  ): Promise<string | null> {
    const stored = this.stored;
    // Always the slow hash, against a stand-in when there is nothing to compare with.
    const salt = Buffer.from(stored?.salt ?? "00".repeat(16), "hex");
    const offered = await this.hashed(password, salt, stored?.cost ?? this.cost());
    const expected = Buffer.from(stored?.hash ?? "00".repeat(KEY_BYTES), "hex");
    const passwordRight = timingSafeEqual(offered, expected);
    const nameRight = timingSafeEqual(
      quickHash(username.trim().toLowerCase()),
      quickHash((stored?.username ?? "\u0000").toLowerCase()),
    );
    // The account may have been changed while the hash was being worked out.
    if (!stored || this.stored !== stored || !passwordRight || !nameRight) {
      this.noteWrong(device);
      return null;
    }
    this.wrong.delete(device);
    const token = this.open(device, "password");
    if ((stored.cost ?? FIRST_COST) < this.cost()) void this.strengthen(stored, password);
    return token;
  }

  /**
   * A password kept at a lower cost than is used now is hashed again at today's, while
   * it is at hand: it is never at hand otherwise. Sessions and keys are left alone.
   */
  private async strengthen(stored: Stored, password: string): Promise<void> {
    try {
      const salt = randomBytes(16);
      const cost = this.cost();
      const hash = await this.hashed(password, salt, cost);
      if (this.stored !== stored) return;
      stored.salt = salt.toString("hex");
      stored.hash = hash.toString("hex");
      stored.cost = cost;
      await this.save();
    } catch (error) {
      console.warn("[station] the password could not be kept more strongly:", error);
    }
  }

  private open(device: string, by: Session["by"]): string {
    this.sweep();
    // One session a device: opening the page again replaces the one before.
    for (const [key, session] of this.sessions) {
      if (session.deviceId === device) this.sessions.delete(key);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    this.sessions.set(quickHash(token).toString("hex"), {
      deviceId: device,
      openedAt: now,
      usedAt: now,
      by,
    });
    return token;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (now - session.usedAt > SESSION_IDLE_MS || now - session.openedAt > SESSION_MOST_MS) {
        this.sessions.delete(key);
      }
    }
  }

  /** The live session this token names on this device, or null. Does not count as use. */
  private find(device: string, token: string | undefined): Session | null {
    if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
    const key = quickHash(token).toString("hex");
    const session = this.sessions.get(key);
    if (!session || session.deviceId !== device) return null;
    const now = this.now();
    if (now - session.usedAt > SESSION_IDLE_MS || now - session.openedAt > SESSION_MOST_MS) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  /**
   * True when this token is a live session of this device, and counts as using it: for
   * a request the person made. A session belongs to the device it was opened on and is
   * no use from another.
   */
  check(device: string, token: string | undefined): boolean {
    const session = this.find(device, token);
    if (!session) return false;
    session.usedAt = this.now();
    return true;
  }

  /**
   * True when this token is a live session of this device, without counting as use: for
   * what the page does by itself (its open connection, asking which screen to show).
   * Otherwise a page left open would never be signed out for want of use.
   */
  alive(device: string, token: string | undefined): boolean {
    return this.find(device, token) !== null;
  }

  /** When this device's session was opened and how, or null when it has none. Not use. */
  sessionOf(
    device: string,
    token: string | undefined,
  ): { openedAt: number; by: Session["by"] } | null {
    const session = this.find(device, token);
    return session ? { openedAt: session.openedAt, by: session.by } : null;
  }

  signOut(token: string | undefined): void {
    if (token) this.sessions.delete(quickHash(token).toString("hex"));
  }

  /** Ends whatever session a device has, and forgets its key: for a device that is unpaired. */
  async forgetDevice(device: string): Promise<void> {
    this.wrong.delete(device);
    this.resets.delete(device);
    await this.endAccess(device);
  }

  /**
   * Ends whatever session a device has and forgets its key, keeping the count of its
   * wrong tries: for a pairing that has moved to another holder (the browser's to the
   * app), who signs in with the password like anyone else.
   */
  async endAccess(device: string): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (session.deviceId === device) this.sessions.delete(key);
    }
    if (this.stored && this.stored.unlock[device] !== undefined) {
      this.stored.unlock = Object.fromEntries(
        Object.entries(this.stored.unlock).filter(([id]) => id !== device),
      );
      await this.save();
    }
  }

  /** Ends every session: for when the station is switched off. */
  signEveryoneOut(): void {
    this.sessions.clear();
  }

  // ---------- the device's own check (fingerprint, face) ----------

  /**
   * Gives a device a key of its own with which it can sign in again without the
   * password. Only for a session opened with the password, and only in the few minutes
   * after: a key cannot be used to make another, and a page left signed in cannot be
   * used to fetch one. Returns the key, which is never kept here.
   */
  async issueUnlock(device: string, token: string | undefined): Promise<string | null> {
    const session = this.sessionOf(device, token);
    if (!this.stored || session?.by !== "password") return null;
    if (this.now() - session.openedAt > KEY_WITHIN_MS) return null;
    const key = randomBytes(32).toString("base64url");
    this.stored.unlock = { ...this.stored.unlock, [device]: quickHash(key).toString("hex") };
    await this.save();
    return key;
  }

  /** True when this device has such a key. */
  hasUnlock(device: string): boolean {
    return this.stored?.unlock[device] !== undefined;
  }

  /** Throws a device's key away: it signs in with the password again. */
  async dropUnlock(device: string): Promise<void> {
    if (!this.stored || this.stored.unlock[device] === undefined) return;
    this.stored.unlock = Object.fromEntries(
      Object.entries(this.stored.unlock).filter(([id]) => id !== device),
    );
    await this.save();
  }

  /** Signs a device in by its key. Returns a session token, or null. */
  unlock(device: string, key: string): string | null {
    if (this.mustWait(device) > 0) return null;
    const known = this.stored?.unlock[device];
    const offered = quickHash(/^[A-Za-z0-9_-]{40,50}$/.test(key) ? key : "");
    const expected = Buffer.from(known ?? "00".repeat(32), "hex");
    if (!known || !timingSafeEqual(offered, expected)) {
      this.noteWrong(device);
      return null;
    }
    this.wrong.delete(device);
    return this.open(device, "unlock");
  }

  // ---------- asking for a reset ----------

  /**
   * Notes that a device asked for the password to be reset. True when the request is
   * to be passed on to the person at the PC; false when this device has asked too often.
   * Nothing about the account changes: only the PC can change it.
   */
  askForReset(device: string): boolean {
    const now = this.now();
    const kept = (this.resets.get(device) ?? []).filter((at) => now - at < HOUR_MS);
    if (kept.length >= RESETS_PER_HOUR) {
      this.resets.set(device, kept);
      return false;
    }
    kept.push(now);
    this.resets.set(device, kept);
    return true;
  }
}
