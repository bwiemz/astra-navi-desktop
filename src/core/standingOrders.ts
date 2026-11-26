import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { replaceInternalCaptain } from "./characterLayer.ts";
import { isStatusCommand } from "./fleetRules.ts";
import type { HerStore } from "./store.ts";
import { firstCharacters, hasUnseen, withoutUnseen } from "./unseen.ts";
import { isReadOnlyCommand } from "./shell.ts";

/**
 * Standing orders: "keep an eye on the render folder and tell me when it has 240
 * files", "tell me if the NAS stops answering", "let me know when the service is back".
 *
 * An order is a check that is run again every few minutes and a condition on what it
 * prints. When the condition comes true she is told, and she tells the user. That is
 * all an order can do. In particular:
 *
 * - A check only ever looks. On this PC it must be a command the shell rules recognise
 *   as read-only; on another machine it must be one of the plain status commands; or it
 *   is a web address, of which only "did it answer, and with what number" is kept.
 *   This is checked when the order is made, again when it is read back from disk, and
 *   again every time it runs, so an order can never be a way of running something
 *   unattended that the user would have been asked about.
 * - Making an order is always put to the user, with the exact check and how often.
 * - What a check printed is text from outside. It reaches her clipped and marked as such,
 *   in a turn where she has no tools.
 * - Orders end: after they have spoken (unless they repeat), and after a week either way.
 */

export const TELL_WHEN = [
  "contains",
  "missing",
  "changes",
  "above",
  "below",
  "fails",
  "works",
] as const;
export type TellWhen = (typeof TELL_WHEN)[number];

const CheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    /** "here" for this PC, otherwise the id of one of the user's machines. */
    where: z.string(),
    /** The machine's name when the order was made, for telling the user. */
    whereName: z.string().max(80).default("this PC"),
    /**
     * Who she signs in as and where, when the order was made. The check runs only while
     * the machine of that id is still this one: an entry pointed at another server since
     * is not what the user agreed to.
     */
    target: z.string().max(200).default(""),
    command: z.string(),
  }),
  z.object({ kind: z.literal("address"), address: z.string() }),
]);
export type OrderCheck = z.infer<typeof CheckSchema>;

const OrderSchema = z.object({
  id: z.string(),
  /** What the user asked to be told, in their words. */
  title: z.string().min(1).max(140),
  check: CheckSchema,
  tellWhen: z.enum(TELL_WHEN),
  /** The words or the number the condition is about; empty where it needs none. */
  value: z.string().max(120).default(""),
  everyMinutes: z
    .number()
    .min(1)
    .max(24 * 60),
  /** Speak every time the condition comes true again, not just the first time. */
  repeat: z.boolean().default(false),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** What the check printed the first time, for "tell me when it changes". */
  baseline: z.string().nullable().default(null),
  /** Whether the condition held at the last look. Null before the first. */
  held: z.boolean().nullable().default(null),
  lastCheckedAt: z.string().nullable().default(null),
});
export type StandingOrder = z.infer<typeof OrderSchema>;
const FileSchema = z.object({ version: z.literal(1), orders: z.array(z.unknown()) });

export const MAX_ORDERS = 12;
export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 24 * 60;
/** A web address is somebody's server: it is not asked more often than this. */
export const MIN_ADDRESS_MINUTES = 2;
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TITLE_CHARS = 140;
const MAX_COMMAND_CHARS = 200;
const MAX_ADDRESS_CHARS = 300;
/** A question part longer than this is long enough to be carrying something out. */
const MAX_ADDRESS_QUERY_CHARS = 120;
/**
 * True for text with anything in it that does not show, or with any space but the
 * plain one: either could make the question put to the user read differently from the
 * check that runs.
 */
/** Text as an order keeps it: nothing that does not show, and plain spaces only. */
function plain(text: string): string {
  return withoutUnseen(text, { instead: " " }).replace(/\s+/gu, " ").trim();
}

function hidden(text: string): boolean {
  return hasUnseen(text) || /[^\S ]/u.test(text);
}
/** How much of what a check printed is kept and passed on. */
const EXCERPT_CHARS = 300;
/** The clock is looked at this often; see `ReminderStore` for why not one long timer. */
const TICK_MS = 20_000;

/**
 * The only characters a check on this PC may be written with: words, paths, options,
 * quotes, a pipe, and the plain space. Nothing the shell would expand or chain (no $, backtick, wildcard,
 * semicolon, ampersand, redirection or bracket), so that the command the user is shown
 * is, letter for letter, all that will ever run.
 */
const PLAIN_COMMAND = /^[\w ./:=,@%+~|"'-]+$/;

/** What one run of a check came to. */
export interface Reading {
  /** The command ended with success, or the address answered below 400. */
  ok: boolean;
  /** What it printed, or for an address its status line. */
  text: string;
}

/** What the user asked for, as the tool receives it. */
export interface OrderRequest {
  title: string;
  /** "here", empty, or a machine's name. */
  where?: string;
  command?: string;
  address?: string;
  tellWhen: string;
  value?: string;
  everyMinutes?: number;
  repeat?: boolean;
}

/** One of the user's machines, as far as an order needs to know it. */
export interface OrderMachine {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
}

/** Who she signs in as and where on a machine, as one word to compare and to show. */
export function machineTarget(machine: Pick<OrderMachine, "host" | "port" | "user">): string {
  return `${machine.user}@${machine.host}${machine.port === 22 ? "" : `:${machine.port}`}`;
}

function firstNumber(text: string): number | null {
  const found = /-?\d+(?:[.,]\d+)?/.exec(text.replace(/(\d),(?=\d{3}\b)/g, "$1"));
  if (!found) return null;
  const value = Number(found[0].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** Why this check may not be a standing order, or null when it may. */
export function whyNotThisCheck(check: OrderCheck): string | null {
  if (check.kind === "address") {
    if (check.address.length > MAX_ADDRESS_CHARS) return "That address is too long.";
    if (hidden(check.address)) return "That address has characters that do not show.";
    let url: URL;
    try {
      url = new URL(check.address);
    } catch {
      return "That is not a web address. Give it in full, starting with http:// or https://.";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Only http and https addresses can be watched.";
    }
    if (url.username !== "" || url.password !== "") {
      return "That address has a name or password in it. A standing order may not carry one.";
    }
    // The whole address goes to that server at every look. Nothing may ride along in it.
    if (url.hash !== "") return "Leave the part after # off the address.";
    if (url.search.length > MAX_ADDRESS_QUERY_CHARS) {
      return "The part of that address after the ? is too long for a standing order. Watch the plain address.";
    }
    return null;
  }
  const command = check.command.trim();
  if (command === "") return "There is nothing to check: give a command or a web address.";
  if (command.length > MAX_COMMAND_CHARS) {
    return "That check is too long for a standing order. Keep it to one short command.";
  }
  if (hidden(command)) return "That check has characters that do not show.";
  if (check.where === "here") {
    if (!PLAIN_COMMAND.test(command) || !isReadOnlyCommand(command)) {
      return "A standing order may only look. That command might change something, or uses shell tricks that hide what it does. Use a plain command that only reads (ls, cat, df, systemctl is-active …).";
    }
    return null;
  }
  if (!isStatusCommand(command)) {
    return "On another machine a standing order may only run one of the plain status checks (uptime, df -h, systemctl is-active <unit>, qm status <id>, zpool status -x, docker ps …).";
  }
  return null;
}

/** The user's request made into an order, or the reason it cannot be one, in words for her. */
export function makeOrder(
  request: OrderRequest,
  machines: readonly OrderMachine[],
  now: Date,
): { order: StandingOrder } | { problem: string } {
  const title = withoutUnseen(request.title, { instead: " ", ownWriting: true })
    .replace(/[^\S ]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (title === "") return { problem: "Say in a few words what Captain wants to be told (title)." };
  const tellWhen = request.tellWhen.trim().toLowerCase();
  if (!TELL_WHEN.includes(tellWhen as TellWhen)) {
    return { problem: `tell_me_when must be one of: ${TELL_WHEN.join(", ")}.` };
  }
  const command = (request.command ?? "").trim();
  const address = (request.address ?? "").trim();
  if (command !== "" && address !== "") {
    return { problem: "Give either a command or a web address to check, not both." };
  }
  let check: OrderCheck;
  if (address !== "") {
    check = { kind: "address", address };
  } else {
    const wanted = (request.where ?? "").trim().toLowerCase();
    if (wanted === "" || wanted === "here" || wanted === "this pc" || wanted === "local") {
      check = { kind: "command", where: "here", whereName: "this PC", target: "", command };
    } else {
      const machine = machines.find((entry) => entry.name.toLowerCase() === wanted);
      if (!machine) {
        return {
          problem:
            machines.length === 0
              ? 'No other machines have been added, so the check has to run here: set where to "here".'
              : `No machine is called "${request.where ?? ""}". Known machines: ${machines.map((entry) => entry.name).join(", ")}. Or set where to "here".`,
        };
      }
      check = {
        kind: "command",
        where: machine.id,
        whereName: firstCharacters(plain(machine.name), 80),
        target: machineTarget(machine),
        command,
      };
    }
  }
  const refused = whyNotThisCheck(check);
  if (refused) return { problem: refused };

  // Cleaned the way it will be checked when read back from disk, so that an order
  // that was taken is never one that is thrown out at the next start.
  const value = plain(request.value ?? "");
  const when = tellWhen as TellWhen;
  if ((when === "contains" || when === "missing") && value === "") {
    return { problem: `For "${when}", say in value which words to look for.` };
  }
  if ((when === "above" || when === "below") && firstNumber(value) === null) {
    return { problem: `For "${when}", value must be a number.` };
  }
  // "test -f final.mp4" answers by succeeding or not and prints nothing, so an order
  // that waits for words in its output would wait for ever and never tell.
  if (
    check.kind === "command" &&
    /^["']?test["']?\s/.test(check.command) &&
    !check.command.includes("|") &&
    when !== "works" &&
    when !== "fails"
  ) {
    return {
      problem:
        'The command "test" prints nothing, so there is never any output to look in. Set tell_me_when to "works" to be told when the test comes true (or "fails" for when it stops being true), with value empty. Or use a command that prints, like ls.',
    };
  }
  const least = check.kind === "address" ? MIN_ADDRESS_MINUTES : MIN_EVERY_MINUTES;
  const asked = request.everyMinutes;
  const every =
    typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(MAX_EVERY_MINUTES, Math.max(least, Math.round(asked)))
      : 5;
  return {
    order: {
      id: `w-${randomBytes(3).toString("hex")}`,
      title: title.slice(0, MAX_TITLE_CHARS),
      check,
      tellWhen: when,
      value: value.slice(0, 120),
      everyMinutes: every,
      repeat: request.repeat === true,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LIFETIME_MS).toISOString(),
      baseline: null,
      held: null,
      lastCheckedAt: null,
    },
  };
}

/** Whether the order's condition holds for this reading. */
export function conditionHolds(order: StandingOrder, reading: Reading): boolean {
  const text = reading.text;
  switch (order.tellWhen) {
    // Compared as cleaned text on both sides, since the value was cleaned when it was
    // taken: a tick written with its emoji selector still matches one written without.
    case "contains":
      return reading.ok && plain(text).toLowerCase().includes(order.value.toLowerCase());
    case "missing":
      return reading.ok && !plain(text).toLowerCase().includes(order.value.toLowerCase());
    case "changes":
      return order.baseline !== null && reading.ok && text.trim() !== order.baseline.trim();
    case "above":
    case "below": {
      const seen = firstNumber(text);
      const limit = firstNumber(order.value);
      if (!reading.ok || seen === null || limit === null) return false;
      return order.tellWhen === "above" ? seen > limit : seen < limit;
    }
    case "fails":
      return !reading.ok;
    case "works":
      return reading.ok;
  }
}

/** The check in a few plain words, for the question put to the user and for lists. */
export function describeCheck(check: OrderCheck): string {
  if (check.kind === "address") return `ask ${check.address} whether it answers`;
  const place = check.target === "" ? check.whereName : `${check.whereName} (${check.target})`;
  return `run \`${check.command}\` on ${place}`;
}

export function describeCondition(order: Pick<StandingOrder, "tellWhen" | "value">): string {
  switch (order.tellWhen) {
    case "contains":
      return `the answer contains "${order.value}"`;
    case "missing":
      return `the answer no longer contains "${order.value}"`;
    case "changes":
      return "the answer changes";
    case "above":
      return `the number in the answer goes above ${order.value}`;
    case "below":
      return `the number in the answer goes below ${order.value}`;
    case "fails":
      return "the check fails or gets no answer";
    case "works":
      return "the check works";
  }
}

/** "every minute", "every 5 minutes". */
export function everyMinutes(minutes: number): string {
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

export function describeOrder(order: StandingOrder): string {
  return `[${order.id}] "${order.title}": every ${order.everyMinutes} min, ${describeCheck(order.check)}; tells you when ${describeCondition(order)}${order.repeat ? ", each time" : ""}. Ends ${order.expiresAt.slice(0, 10)}.`;
}

/** True for an order read back from disk that could have been made by `makeOrder`. */
function isSoundOrder(order: StandingOrder): boolean {
  if (whyNotThisCheck(order.check) !== null) return false;
  if (order.check.kind === "address" && order.everyMinutes < MIN_ADDRESS_MINUTES) return false;
  if (hidden(order.title) || hidden(order.value)) return false;
  if (order.check.kind === "command" && hidden(order.check.whereName + order.check.target)) {
    return false;
  }
  const made = Date.parse(order.createdAt);
  const ends = Date.parse(order.expiresAt);
  // An order always ends within a week of being made; one that says otherwise was edited.
  return (
    Number.isFinite(made) && Number.isFinite(ends) && ends - made <= LIFETIME_MS && ends > made
  );
}

/** What a check printed, cut down and with anything that does not show made visible. */
export function excerpt(text: string): string {
  // Spaces of the unusual kinds become plain ones; line breaks stay.
  const flat = withoutUnseen(text, { keepBreaks: true })
    .replace(/[^\S\n\t ]/gu, " ")
    .trim();
  const cut = firstCharacters(flat, EXCERPT_CHARS);
  return cut === flat ? flat : `${cut} …`;
}

/** What she is told when a check would read somewhere private. */
export const PRIVATE_CHECK =
  "A standing order may not look into a private place (keys, passwords, browser or chat data, your own records) or run anything Captain would be asked about. Use a check that only reads ordinary files or the state of the system.";

export interface OrderDeps {
  /** SQLite records store, when used in place of the standalone JSON file. */
  store?: HerStore;
  /** Runs a check and says what came of it. Must never throw for a check that merely failed. */
  read(check: OrderCheck, signal: AbortSignal): Promise<Reading>;
  /**
   * True when the check is one she could make directly without a question being put:
   * it reads no private place. Asked again before every run, as the same path can come
   * to point somewhere else. Left out: only the rules in this file apply.
   */
  mayLook?(check: OrderCheck): Promise<boolean>;
  /**
   * Called when an order's condition has come true, or when an order has run out. The
   * text is for her to retell; `outside` is the clipped answer of the check; `plain` is
   * the same news in words for the user's own eyes, for when it is shown without her.
   */
  onNews(news: {
    order: StandingOrder;
    text: string;
    outside: string;
    plain: string;
    reason?: "matched" | "expired" | "stopped";
  }): void;
  userAddress?(): string;
  now?(): Date;
}

/**
 * The standing orders in force. Kept on disk, so an order outlives a restart; checked
 * again when read back, so a file that was edited cannot make her run something else.
 */
export class StandingOrders {
  private readonly file: string;
  private readonly deps: OrderDeps;
  private orders: StandingOrder[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly looking = new Set<string>();
  /** The looks under way, so that something can wait for them. */
  private readonly running = new Set<Promise<void>>();
  private readonly stop = new AbortController();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(file: string, deps: OrderDeps) {
    this.file = file;
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private insertOrder(store: HerStore, order: StandingOrder): void {
    store.run(
      `INSERT INTO standing_orders (
        id, title, check_json, tell_when, value, every_minutes, repeat,
        created_at, expires_at, baseline, held, last_checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      order.id,
      order.title,
      JSON.stringify(order.check),
      order.tellWhen,
      order.value,
      order.everyMinutes,
      order.repeat ? 1 : 0,
      order.createdAt,
      order.expiresAt,
      order.baseline,
      order.held === null ? null : order.held ? 1 : 0,
      order.lastCheckedAt,
    );
  }

  private parseLegacyOrders(raw: string): StandingOrder[] {
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn(
        "[orders] the saved standing orders are not in a usable form; starting fresh.",
      );
      return [];
    }
    return parsed.data.orders
      .map((entry) => OrderSchema.safeParse(entry))
      .flatMap((entry) => (entry.success ? [entry.data] : []))
      .filter(isSoundOrder)
      .slice(0, MAX_ORDERS);
  }

  async start(): Promise<void> {
    if (this.deps.store) {
      const store = this.deps.store;
      if (store.isOpen) {
        if (!store.wasBroughtOver("standing-orders.json")) {
          let imported: StandingOrder[] = [];
          try {
            imported = this.parseLegacyOrders(await readFile(this.file, "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              console.warn("[orders] could not read the standing orders:", error);
            }
          }
          store.together(() => {
            for (const order of imported) this.insertOrder(store, order);
            store.noteBroughtOver("standing-orders.json", this.now());
          });
        }
        const rows = store.all<{
          id: string;
          title: string;
          check_json: string;
          tell_when: string;
          value: string;
          every_minutes: number;
          repeat: number;
          created_at: string;
          expires_at: string;
          baseline: string | null;
          held: number | null;
          last_checked_at: string | null;
        }>("SELECT * FROM standing_orders");
        const loaded: StandingOrder[] = [];
        for (const row of rows) {
          try {
            const parsed = OrderSchema.safeParse({
              id: row.id,
              title: row.title,
              check: JSON.parse(row.check_json) as unknown,
              tellWhen: row.tell_when,
              value: row.value,
              everyMinutes: row.every_minutes,
              repeat: row.repeat === 1,
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              baseline: row.baseline,
              held: row.held === null ? null : row.held === 1,
              lastCheckedAt: row.last_checked_at,
            });
            if (parsed.success && isSoundOrder(parsed.data)) loaded.push(parsed.data);
          } catch {
            // a damaged row is skipped, the rest stand
          }
        }
        this.orders = loaded.slice(0, MAX_ORDERS);
      }
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref();
      return;
    }

    try {
      this.orders = this.parseLegacyOrders(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[orders] could not read the standing orders:", error);
      }
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stop.abort();
  }

  list(): readonly StandingOrder[] {
    return this.orders;
  }

  /**
   * Takes on a new order: looks once straight away, so that "already so" is said at
   * once instead of never (the condition would not *come* true later), and so that
   * "tell me when it changes" has something to compare with.
   */
  async add(order: StandingOrder): Promise<{ alreadySo: boolean; first: Reading }> {
    if (this.orders.length >= MAX_ORDERS) {
      throw new Error(
        `There are already ${MAX_ORDERS} standing orders. Cancel one first (reminders lists them).`,
      );
    }
    const refused = whyNotThisCheck(order.check);
    if (refused) throw new Error(refused);
    if (this.deps.mayLook && !(await this.deps.mayLook(order.check)))
      throw new Error(PRIVATE_CHECK);
    const first = await this.deps.read(order.check, this.stop.signal);
    const taken: StandingOrder = {
      ...order,
      baseline: first.ok ? first.text.trim().slice(0, 4000) : null,
      lastCheckedAt: this.now().toISOString(),
    };
    const alreadySo = conditionHolds(taken, first);
    taken.held = alreadySo;
    // Already so, and to be told once: there is nothing left to wait for.
    if (!(alreadySo && !taken.repeat)) {
      // Looked at again: another order may have been taken on while this one's check ran.
      if (this.orders.length >= MAX_ORDERS) {
        throw new Error(`There are already ${MAX_ORDERS} standing orders. Cancel one first.`);
      }
      this.orders.push(taken);
      await this.save();
    }
    return { alreadySo, first };
  }

  async cancel(id: string): Promise<boolean> {
    const before = this.orders.length;
    this.orders = this.orders.filter((order) => order.id !== id.trim());
    if (this.orders.length === before) return false;
    await this.save();
    return true;
  }

  /** Looks at every order that is due. Public so that tests can drive the clock. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const order of [...this.orders]) {
      if (now.getTime() >= Date.parse(order.expiresAt)) {
        this.orders = this.orders.filter((entry) => entry.id !== order.id);
        await this.save();
        const userAddr = this.deps.userAddress?.();
        const tellExpired = replaceInternalCaptain(
          "Tell Captain, and that they can ask you to watch again.",
          userAddr,
        );
        this.deps.onNews({
          order,
          text: `Your standing order "${order.title}" has run for a week without the thing happening, so you have stopped watching. ${tellExpired}`,
          outside: "",
          plain: `Standing order "${order.title}": a week has passed without it happening, so it is no longer being watched.`,
          reason: "expired",
        });
        continue;
      }
      const last = order.lastCheckedAt === null ? 0 : Date.parse(order.lastCheckedAt);
      if (now.getTime() - last < order.everyMinutes * 60_000 || this.looking.has(order.id)) {
        continue;
      }
      const run = this.look(order.id);
      this.running.add(run);
      void run.finally(() => this.running.delete(run));
    }
  }

  /** Resolves once every look that has been started is over. For shutdown, and for tests. */
  async whenQuiet(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private async look(id: string): Promise<void> {
    const order = this.orders.find((entry) => entry.id === id);
    if (!order || this.looking.has(id)) return;
    this.looking.add(id);
    // Checked every time: nothing may run under an order that could not be made today.
    let allowed = whyNotThisCheck(order.check) === null;
    if (allowed && this.deps.mayLook) {
      try {
        allowed = await this.deps.mayLook(order.check);
      } catch (error) {
        // Not knowing is not a no: this look is skipped and the next one asks again.
        console.warn("[orders] could not tell whether a check is still allowed:", error);
        this.looking.delete(id);
        return;
      }
    }
    if (!allowed) {
      this.looking.delete(id);
      if (await this.cancel(id)) {
        const userAddr = this.deps.userAddress?.();
        const stoppedTail = replaceInternalCaptain(
          "its check is no longer one you may make without asking Captain (what it looks at has changed). Tell Captain it is no longer being watched.",
          userAddr,
        );
        this.deps.onNews({
          order,
          text: `You have stopped your standing order "${order.title}": ${stoppedTail}`,
          outside: "",
          plain: `Standing order "${order.title}" has been stopped: what its check looks at has changed, so it may no longer be made without asking you.`,
          reason: "stopped",
        });
      }
      return;
    }
    try {
      const reading = await this.deps.read(order.check, this.stop.signal);
      if (this.stop.signal.aborted) return;
      const current = this.orders.find((entry) => entry.id === id);
      if (!current) return; // cancelled while the check ran
      const holds = conditionHolds(current, reading);
      const news = holds && current.held !== true;
      current.held = holds;
      current.lastCheckedAt = this.now().toISOString();
      if (current.baseline === null && reading.ok) {
        current.baseline = reading.text.trim().slice(0, 4000);
      }
      if (news && !current.repeat) {
        this.orders = this.orders.filter((entry) => entry.id !== id);
      } else if (news && current.tellWhen === "changes" && reading.ok) {
        // The new answer is what the next change is measured from.
        current.baseline = reading.text.trim().slice(0, 4000);
        current.held = false;
      }
      await this.save();
      if (news) {
        const userAddr = this.deps.userAddress?.();
        const watchingLead = replaceInternalCaptain("You were keeping watch for Captain:", userAddr);
        const tellPlain = replaceInternalCaptain("Tell Captain plainly.", userAddr);
        this.deps.onNews({
          order: current,
          text: `${watchingLead} "${current.title}". It has happened: ${describeCondition(current)} (the check was to ${describeCheck(current.check)}).${current.repeat ? " You are still watching." : " That standing order is now finished."} ${tellPlain}`,
          outside: excerpt(reading.text),
          plain: `Standing order "${current.title}": it has happened (${describeCondition(current)}).${current.repeat ? " Still watching." : ""}`,
          reason: "matched",
        });
      }
    } catch (error) {
      console.warn("[orders] a check could not be made:", error);
    } finally {
      this.looking.delete(id);
    }
  }

  private save(): Promise<void> {
    if (this.deps.store) {
      const store = this.deps.store;
      if (!store.isOpen) return Promise.resolve();
      store.together(() => {
        store.run("DELETE FROM standing_orders");
        for (const order of this.orders) this.insertOrder(store, order);
      });
      return Promise.resolve();
    }

    const payload = JSON.stringify({ version: 1, orders: this.orders }, null, 2);
    const file = this.file;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((error: unknown) => console.warn("[orders] could not save:", error));
    return this.writeChain;
  }
}
