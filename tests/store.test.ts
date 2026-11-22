import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionLog } from "../src/core/actionLog.ts";
import { ConversationArchive } from "../src/core/archive.ts";
import type { Embedder } from "../src/core/embedder.ts";
import { GameWatch } from "../src/core/gameWatch.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { Recall } from "../src/core/recall.ts";
import { makeOrder, StandingOrders } from "../src/core/standingOrders.ts";
import {
  ftsQuery,
  HerStore,
  LAYOUT_VERSION,
  packVector,
  StoreFromTheFuture,
  unpackVector,
} from "../src/core/store.ts";

describe("her records in one database", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-store-"));
    file = join(dir, "kept", "her.db");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes the file, for this account only, and keeps what is put in it", () => {
    const store = new HerStore(file);
    const id = store.run(
      "INSERT INTO actions (at, tool, detail, outcome) VALUES (?, ?, ?, ?)",
      "2026-11-22T10:00:00.000Z",
      "run_command",
      "ls",
      "done",
    );
    expect(id).toBe(1);
    // The side files too: they hold the same words for a while.
    for (const name of readdirSync(join(dir, "kept"))) {
      expect(statSync(join(dir, "kept", name)).mode & 0o777, name).toBe(0o600);
    }
    expect(statSync(join(dir, "kept")).mode & 0o777).toBe(0o700);
    store.close();

    const again = new HerStore(file);
    expect(again.all<{ tool: string }>("SELECT tool FROM actions")).toEqual([
      { tool: "run_command" },
    ]);
    expect(again.one<{ tool: string }>("SELECT tool FROM actions WHERE id = ?", 99)).toBe(
      undefined,
    );
    again.close();
    // Closing twice is nothing.
    again.close();
  });

  it("does all of a piece of work or none of it", () => {
    const store = new HerStore(":memory:");
    const add = (tool: string): number =>
      store.run(
        "INSERT INTO actions (at, tool, detail, outcome) VALUES ('t', ?, '', 'done')",
        tool,
      );
    expect(
      store.together(() => {
        add("one");
        return add("two");
      }),
    ).toBe(2);
    expect(() =>
      store.together(() => {
        add("three");
        throw new Error("half-way");
      }),
    ).toThrow("half-way");
    expect(store.all<{ tool: string }>("SELECT tool FROM actions ORDER BY id")).toEqual([
      { tool: "one" },
      { tool: "two" },
    ]);
    store.close();
  });

  it("finds words through the index", () => {
    const store = new HerStore(":memory:");
    store.run("INSERT INTO turn_words (rowid, words) VALUES (?, ?)", 7, "launch date third march");
    store.run("INSERT INTO turn_words (rowid, words) VALUES (?, ?)", 8, "weather is fine today");
    const found = store.all<{ rowid: number }>(
      "SELECT rowid FROM turn_words WHERE turn_words MATCH ?",
      '"launch" OR "nothing"',
    );
    expect(found).toEqual([{ rowid: 7 }]);
    store.run("DELETE FROM turn_words WHERE rowid = ?", 7);
    expect(store.all("SELECT rowid FROM turn_words WHERE turn_words MATCH ?", '"launch"')).toEqual(
      [],
    );
    store.close();
  });

  it("leaves nothing of what was forgotten in any of its files", () => {
    const store = new HerStore(file);
    const secret = "the-surprise-party-is-on-saturday";
    for (let filler = 0; filler < 50; filler += 1) {
      store.run(
        "INSERT INTO turns (at, said, reply) VALUES ('t', ?, ?)",
        `${secret} ${filler}`,
        `noted ${secret}`,
      );
    }
    store.settle();
    const holds = (): boolean =>
      readdirSync(join(dir, "kept")).some((name) =>
        readFileSync(join(dir, "kept", name)).includes(secret),
      );
    expect(holds()).toBe(true);
    store.run("DELETE FROM turns");
    store.settle();
    expect(holds()).toBe(false);
    store.close();
    expect(holds()).toBe(false);
  });

  it("takes one forgotten entry's words out of the index there and then", () => {
    const store = new HerStore(file);
    for (let row = 1; row <= 300; row += 1) {
      store.run(
        "INSERT INTO turn_words (rowid, words) VALUES (?, ?)",
        row,
        row === 150 ? "the zanzibarquokka party" : `ordinary words number ${row} about the weather`,
      );
    }
    store.settle();
    const holds = (word: string): boolean =>
      readdirSync(join(dir, "kept")).some((name) =>
        readFileSync(join(dir, "kept", name)).includes(word),
      );
    expect(holds("zanzibarquokka")).toBe(true);
    store.run("DELETE FROM turn_words WHERE rowid = ?", 150);
    store.settle();
    expect(holds("zanzibarquokka")).toBe(false);
    // The rest is still there and still found.
    expect(holds("ordinary")).toBe(true);
    expect(
      store.all("SELECT rowid FROM turn_words WHERE turn_words MATCH ?", '"number"'),
    ).toHaveLength(299);
    store.close();
  });

  it("remembers which older files were brought over", () => {
    const store = new HerStore(file);
    expect(store.wasBroughtOver("conversations.jsonl")).toBe(false);
    store.noteBroughtOver("conversations.jsonl", new Date("2026-11-22T10:00:00Z"));
    store.close();
    const again = new HerStore(file);
    expect(again.wasBroughtOver("conversations.jsonl")).toBe(true);
    expect(again.wasBroughtOver("actions.jsonl")).toBe(false);
    again.close();
  });

  it("will not open records written by a newer version of her, and leaves them as they are", () => {
    new HerStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${LAYOUT_VERSION + 1}`);
    raw.exec("CREATE TABLE from_later (x)");
    raw.close();
    expect(() => new HerStore(file)).toThrow(StoreFromTheFuture);
    const after = new DatabaseSync(file);
    expect(after.prepare("PRAGMA user_version").get()).toEqual({
      user_version: LAYOUT_VERSION + 1,
    });
    after.close();
  });

  it("brings a v1 database up to v2 without losing existing rows", () => {
    mkdirSync(dirname(file), { recursive: true });
    const v1 = new DatabaseSync(file);
    v1.exec(`
      CREATE TABLE turns (id INTEGER PRIMARY KEY, at TEXT NOT NULL, said TEXT NOT NULL, reply TEXT NOT NULL, outside INTEGER NOT NULL DEFAULT 0, vector BLOB);
      CREATE VIRTUAL TABLE turn_words USING fts5(words, tokenize = "unicode61 remove_diacritics 0");
      CREATE TABLE actions (id INTEGER PRIMARY KEY, at TEXT NOT NULL, tool TEXT NOT NULL, detail TEXT NOT NULL, outcome TEXT NOT NULL, asked INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL DEFAULT 'her');
      CREATE TABLE brought_over (what TEXT PRIMARY KEY, at TEXT NOT NULL);
      INSERT INTO actions (at, tool, detail, outcome) VALUES ('2026-11-22T09:00:00Z', 'calculate', '2+2', 'done');
      PRAGMA user_version = 1;
    `);
    v1.close();

    const migrated = new HerStore(file);
    expect(migrated.one<{ user_version: number }>("PRAGMA user_version")).toEqual({
      user_version: LAYOUT_VERSION,
    });
    expect(migrated.all<{ tool: string; detail: string }>("SELECT tool, detail FROM actions")).toEqual([
      { tool: "calculate", detail: "2+2" },
    ]);
    const tables = migrated
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "play_sessions",
        "play_open",
        "standing_orders",
        "memory_vectors",
        "memory_words",
      ]),
    );
    migrated.close();
  });

  it("builds safe FTS queries and round-trips vectors even with non-zero byte offsets", () => {
    expect(ftsQuery([])).toBeNull();
    expect(ftsQuery(["   ", ""])).toBeNull();
    expect(ftsQuery(['hello', 'say "hi"', "hello", "world"])).toBe('"hello" OR "say ""hi""" OR "world"');
    const many = Array.from({ length: 40 }, (_, i) => `tok${i}`);
    expect(ftsQuery(many)?.split(" OR ")).toHaveLength(24);

    // Sliced Float32Array and unaligned Uint8Array view
    const source = new Float32Array([99, 0.25, -0.5, 0.75]);
    const sliced = source.subarray(1, 4);
    const packed = packVector(sliced);
    const unaligned = new Uint8Array(packed.byteLength + 1);
    unaligned.set(packed, 1);
    const view = unaligned.subarray(1);
    expect(view.byteOffset).toBe(1);
    expect([...(unpackVector(view) ?? [])]).toEqual([0.25, -0.5, 0.75]);
    expect(unpackVector(null)).toBeNull();
    expect(unpackVector(new Uint8Array(0))).toBeNull();
    expect(unpackVector(new Uint8Array(3))).toBeNull();
  });
});

function makeTestEmbedder(): Embedder & { calls: number; broken: boolean } {
  const vec = (text: string): Float32Array => {
    const lower = text.toLowerCase();
    // 2D normalized vectors along distinct axes for distinct topics
    const lighting =
      lower.includes("lantern") || lower.includes("light") || lower.includes("moonlight") ? 1 : 0;
    const cooking = lower.includes("pasta") || lower.includes("aglio") ? 1 : 0;
    const raw = new Float32Array([
      lighting > 0 ? 0.99 : cooking > 0 ? 0.05 : 0.4,
      cooking > 0 ? 0.99 : lighting > 0 ? 0.05 : 0.4,
      0.1,
    ]);
    const norm = Math.hypot(raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0) || 1;
    return new Float32Array([(raw[0] ?? 0) / norm, (raw[1] ?? 0) / norm, (raw[2] ?? 0) / norm]);
  };
  return {
    calls: 0,
    broken: false,
    async embed(texts) {
      if (this.broken) throw new Error("embedder offline");
      this.calls += 1;
      return texts.map(vec);
    },
  };
}

describe("records backed by HerStore", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-sqlite-"));
    dbFile = join(dir, "kept", "her.db");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("imports, searches (hybrid + FTS5 fallback), trims, and securely wipes ConversationArchive", async () => {
    const legacy = join(dir, "conversations.jsonl");
    await writeFile(
      legacy,
      `${JSON.stringify({ at: "2026-11-20T10:00:00Z", said: "Legacy chat entry", reply: "Imported from jsonl" })}\n`,
    );
    const embedder = makeTestEmbedder();
    const store = new HerStore(dbFile);
    const archive = new ConversationArchive(legacy, embedder, 4, store);
    await archive.load();
    expect(archive.count).toBe(1);
    expect(store.wasBroughtOver("conversations.jsonl")).toBe(true);
    expect(archive.latest(1)[0]?.reply).toBe("Imported from jsonl");

    const secret = "obsidian-falcon-secret-passphrase";
    await archive.add({
      at: "2026-11-21T09:00:00Z",
      said: "How should I light my night level?",
      reply: "Blue moonlight and orange lanterns.",
      outside: false,
    });
    await archive.add({
      at: "2026-11-21T10:00:00Z",
      said: `Remember ${secret}`,
      reply: "Kept.",
      outside: false,
    });
    await archive.add({
      at: "2026-11-21T11:00:00Z",
      said: "What pasta should I cook?",
      reply: "Aglio e olio.",
      outside: false,
    });
    expect(archive.count).toBe(4);

    // Hybrid semantic + FTS5 search
    const semantic = await archive.search("lantern lighting");
    expect(semantic[0]?.turn.reply).toContain("lanterns");

    // FTS5 fallback when embedder is unavailable
    embedder.broken = true;
    const lexical = await archive.search(secret);
    expect(lexical).toHaveLength(1);
    expect(lexical[0]?.turn.said).toContain(secret);
    embedder.broken = false;

    // Trimming drops oldest from turns and turn_words
    await archive.add({
      at: "2026-11-22T12:00:00Z",
      said: "Newest message",
      reply: "Ack",
      outside: false,
    });
    expect(archive.count).toBe(4);
    expect(archive.latest(10).map((t) => t.said)).toEqual([
      "How should I light my night level?",
      `Remember ${secret}`,
      "What pasta should I cook?",
      "Newest message",
    ]);

    // Clearing overwrites SQLite/WAL and deletes legacy file so nothing remains on disk
    await archive.clear();
    expect(archive.count).toBe(0);
    store.close();
    const remainsOnDisk = readdirSync(join(dir, "kept")).some((name) =>
      readFileSync(join(dir, "kept", name)).includes(secret),
    );
    expect(remainsOnDisk).toBe(false);

    const reopened = new HerStore(dbFile);
    const archive2 = new ConversationArchive(legacy, embedder, 3, reopened);
    await archive2.load();
    expect(archive2.count).toBe(0);
    reopened.close();
  });

  it("imports ActionLog (including mission entries), queries by host/prefix/outcome, and trims", async () => {
    const legacy = join(dir, "actions.jsonl");
    await writeFile(
      legacy,
      [
        JSON.stringify({
          at: "2026-11-20T08:00:00Z",
          tool: "fleet_status",
          detail: "proxmox: uptime",
          outcome: "done",
          asked: false,
          by: "mission",
        }),
        JSON.stringify({
          at: "2026-11-21T09:00:00Z",
          tool: "fleet_write",
          detail: "nas:/etc/app.conf",
          outcome: "declined",
          asked: true,
          by: "her",
        }),
      ].join("\n") + "\n",
    );
    const store = new HerStore(dbFile);
    const log = new ActionLog(legacy, 3, store);
    await log.load();
    log.add({
      at: "2026-11-22T10:00:00Z",
      tool: "fleet_run",
      detail: "Proxmox: systemctl restart nginx",
      outcome: "failed",
      asked: true,
      by: "mission",
    });

    expect(log.query({ by: "mission" }).map((e) => e.tool)).toEqual(["fleet_run", "fleet_status"]);
    expect(log.query({ toolPrefix: "fleet_", host: "proxmox" }).map((e) => e.tool)).toEqual([
      "fleet_run",
      "fleet_status",
    ]);
    expect(log.query({ outcome: "declined", since: "2026-11-21T00:00:00Z" })).toHaveLength(1);

    log.add({
      at: "2026-11-22T11:00:00Z",
      tool: "calculate",
      detail: "1+1",
      outcome: "done",
      asked: false,
      by: "her",
    });
    expect(log.recent(10)).toHaveLength(3);
    expect(log.recent(10).map((e) => e.tool)).toEqual(["calculate", "fleet_run", "fleet_write"]);
    store.close();
  });

  it("persists GameWatch in SQLite, recovers crashed sittings, and aggregates weekly play", async () => {
    const legacy = join(dir, "play-log.json");
    let now = new Date("2026-11-22T12:00:00.000Z");
    await writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        sessions: [
          // 10 days ago: in 60-day log, outside 7-day weekly window
          {
            game: "OldGame",
            startedAt: "2026-11-12T10:00:00.000Z",
            endedAt: "2026-11-12T12:00:00.000Z",
          },
          // 2 days ago: 90 minutes inside weekly window
          {
            game: "Civ7",
            startedAt: "2026-11-20T18:00:00.000Z",
            endedAt: "2026-11-20T19:30:00.000Z",
          },
        ],
      }),
    );

    const store = new HerStore(dbFile);
    let card: string | null = "Hades2";
    const first = new GameWatch({
      file: legacy,
      store,
      look: () => Promise.resolve(card),
      now: () => now,
    });
    await first.start();
    await first.look(); // starts Hades2 immediately on firstLook
    now = new Date("2026-11-22T12:45:00.000Z");
    await first.look(); // updates play_open.last_seen_at to 12:45
    // Simulate crash (no stop() called) and restart with a fresh HerStore
    store.close();

    now = new Date("2026-11-22T15:00:00.000Z");
    card = null;
    const reopened = new HerStore(dbFile);
    const second = new GameWatch({
      file: legacy,
      store: reopened,
      look: () => Promise.resolve(card),
      now: () => now,
    });
    await second.start();
    expect(second.log().map((s) => s.game)).toEqual(["OldGame", "Civ7", "Hades2"]);
    expect(second.minutesThisWeek()).toEqual([
      { game: "Civ7", minutes: 90, sessions: 1 },
      { game: "Hades2", minutes: 45, sessions: 1 },
    ]);
    expect(second.describeWeek()).toContain('Play this week: 2 h 15 min ("Civ7" 1 h 30 min, "Hades2" 45 min)');
    await second.stop();
    reopened.close();
  });

  it("stores StandingOrders in SQLite, imports legacy JSON, and drops tampered DB rows", async () => {
    const now = new Date("2026-11-22T10:00:00.000Z");
    const legacy = join(dir, "standing-orders.json");
    const made = makeOrder(
      { title: "Check disk", where: "here", command: "df -h", tellWhen: "contains", value: "/" },
      [],
      now,
    );
    if ("problem" in made) throw new Error(made.problem);
    await writeFile(legacy, JSON.stringify({ version: 1, orders: [made.order] }));

    const store = new HerStore(dbFile);
    const first = new StandingOrders(legacy, {
      store,
      read: () => Promise.resolve({ ok: true, text: "/dev/nvme 50%" }),
      onNews: () => undefined,
      now: () => now,
    });
    await first.start();
    expect(first.list().map((o) => o.id)).toEqual([made.order.id]);
    first.dispose();

    // Inject a tampered command directly into SQLite
    store.run(
      `INSERT INTO standing_orders (
        id, title, check_json, tell_when, value, every_minutes, repeat, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "w-evil",
      "Bad order",
      JSON.stringify({ kind: "command", where: "here", whereName: "this PC", target: "", command: "rm -rf ~" }),
      "works",
      "",
      5,
      0,
      now.toISOString(),
      new Date(now.getTime() + 86_400_000).toISOString(),
    );

    const second = new StandingOrders(legacy, {
      store,
      read: () => Promise.resolve({ ok: true, text: "ok" }),
      onNews: () => undefined,
      now: () => now,
    });
    await second.start();
    expect(second.list().map((o) => o.id)).toEqual([made.order.id]);
    second.dispose();
    store.close();
  });

  it("caches Recall embeddings in SQLite across restarts and wipes forgotten notes", async () => {
    const memFile = join(dir, "memory.json");
    const memories = new MemoryStore(memFile);
    const secret = "topsecretcodename99";
    const { memory: lighting } = await memories.save({
      kind: "project",
      text: "Night level uses blue moonlight lanterns",
    });
    const { memory: hidden } = await memories.save({
      kind: "fact",
      text: `Secret token ${secret}`,
    });

    const embedder = makeTestEmbedder();
    const store1 = new HerStore(dbFile);
    const recall1 = new Recall(memories, embedder, store1);
    await recall1.warm();
    expect(embedder.calls).toBe(1);
    const found = await recall1.relevant("lantern moonlight lighting");
    expect(found.map((entry) => entry.memory.id)).toEqual([lighting.id]);
    expect(embedder.calls).toBe(2); // 1 for warm(), 1 for query
    store1.close();

    // Restart with a fresh Recall & HerStore: warm() must reuse cached embeddings without calling embedder.embed
    const embedder2 = makeTestEmbedder();
    const store2 = new HerStore(dbFile);
    const recall2 = new Recall(memories, embedder2, store2);
    await recall2.warm();
    expect(embedder2.calls).toBe(0);

    // Forget the secret note and verify zero bytes remain in memory_vectors / memory_words / DB files
    await memories.forget(hidden.id);
    await recall2.warm();
    expect(store2.all("SELECT id FROM memory_vectors WHERE id = ?", hidden.id)).toEqual([]);
    expect(store2.all("SELECT id FROM memory_words WHERE id = ?", hidden.id)).toEqual([]);
    store2.close();
    const holdsSecret = readdirSync(join(dir, "kept")).some((name) =>
      readFileSync(join(dir, "kept", name)).includes(secret),
    );
    expect(holdsSecret).toBe(false);
  });
});
