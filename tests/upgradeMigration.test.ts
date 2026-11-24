import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ActionLog } from "../src/core/actionLog.ts";
import { ConversationArchive } from "../src/core/archive.ts";
import { ConfigStore } from "../src/core/config.ts";
import { EpisodicGraph } from "../src/core/episodic.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { MissionBoard } from "../src/core/missionPlan.ts";
import { exportProfileBackup, importProfileBackup, inspectProfileBackup } from "../src/core/profileBackup.ts";
import { StandingOrders } from "../src/core/standingOrders.ts";
import { HerStore, LAYOUT_VERSION, StoreFromTheFuture } from "../src/core/store.ts";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures", "v1.0-profile");
const tempDirs: string[] = [];

function copyFixtureToTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "astranavi-upgrade-"));
  tempDirs.push(dir);
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("v1.0 -> v1.1 Upgrade & Data-Migration Suite", () => {
  it("migrates frozen v1.0 SQLite DB (layout 3 -> 4) with zero data loss across turns, FTS5, actions, standing orders, and episodes", async () => {
    const dir = copyFixtureToTemp();
    const dbPath = join(dir, "her.db");

    const pre = new DatabaseSync(dbPath, { readOnly: true });
    expect(Number(pre.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0)).toBe(3);
    pre.close();

    const store = new HerStore(dbPath);
    try {
      const versionAfter = Number(
        store.one<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0,
      );
      expect(versionAfter).toBe(LAYOUT_VERSION);

      // Verify upgraded actions schema columns exist alongside preserved rows
      const cols = store
        .all<{ name: string }>("PRAGMA table_info(actions)")
        .map((r) => r.name);
      expect(cols).toEqual(expect.arrayContaining(["seq", "prev_hash", "entry_hash", "approval_sig"]));

      // 1. ConversationArchive turns + FTS5 preserved
      const archive = new ConversationArchive(
        join(dir, "conversations.jsonl"),
        { embed: async () => [] },
        4000,
        store,
      );
      expect(archive.count).toBe(2);
      expect(archive.latest(2).map((t) => t.said)).toEqual([
        "Where is the NAS backup hosted?",
        "Check uptime cleanly.",
      ]);
      const hits = await archive.search("proxmox backup hosted", 3);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.turn.reply).toContain("192.168.50.3");

      // 2. EpisodicGraph events & thresholds preserved + v1.1 listing/deletion works
      const episodic = new EpisodicGraph(store);
      const episodes = episodic.listRecent(10);
      expect(episodes).toHaveLength(1);
      expect(episodes[0]?.summary).toBe("v1.0 disk threshold alert");
      const thresholds = episodic.listThresholds();
      expect(thresholds).toHaveLength(1);
      expect(thresholds[0]?.contextBucket).toBe("afternoon:focus:code");
      expect(thresholds[0]?.tauAct).toBeCloseTo(0.56, 2);

      // 3. Standing orders preserved in SQLite
      const orders = new StandingOrders(join(dir, "standing-orders.json"), {
        store,
        read: async () => ({ ok: true, text: "42%" }),
        onNews: () => undefined,
      });
      await orders.start();
      expect(orders.list()).toHaveLength(1);
      expect(orders.list()[0]?.title).toBe("Legacy Disk Threshold");
      await orders.cancel(orders.list()[0]?.id ?? "");
      expect(orders.list()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("preserves unchained v1.0 actions while starting valid v1.1 SHA-256 hash chaining (both SQLite & legacy JSONL import)", async () => {
    const dir = copyFixtureToTemp();
    const store = new HerStore(join(dir, "her.db"));
    try {
      const log = new ActionLog(join(dir, "actions.jsonl"), 3000, store);
      await log.load();
      expect(log.recent(10)).toHaveLength(2);
      expect(log.verifyChain()).toEqual({ ok: true, checked: 0, firstBrokenIndex: null, reason: null });

      log.add({
        at: "2026-11-24T12:00:00.000Z",
        tool: "weather",
        detail: "Toronto",
        outcome: "done",
        asked: false,
        by: "her",
      });
      log.add({
        at: "2026-11-24T12:01:00.000Z",
        tool: "reminders",
        detail: "list upcoming",
        outcome: "done",
        asked: false,
        by: "her",
      });

      const entries = log.recent(10);
      expect(entries).toHaveLength(4);
      const chainedProof = log.exportChainProof();
      expect(chainedProof.verified).toBe(true);
      expect(chainedProof.headSeq).toBe(4);
      expect(log.verifyChain()).toEqual({ ok: true, checked: 2, firstBrokenIndex: null, reason: null });

      // Simulate retrospective DB tampering and confirm chain detects it
      store.run("UPDATE actions SET detail = 'tampered' WHERE seq = 3");
      const tampered = log.verifyChain();
      expect(tampered.ok).toBe(false);
      expect(tampered.firstBrokenIndex).toBe(2);
    } finally {
      store.close();
    }

    // Separate fresh DB importing non-chained v1.0 actions.jsonl from disk
    const freshDir = mkdtempSync(join(tmpdir(), "astranavi-jsonl-imp-"));
    tempDirs.push(freshDir);
    cpSync(join(FIXTURE_DIR, "actions.jsonl"), join(freshDir, "actions.jsonl"));
    const freshStore = new HerStore(join(freshDir, "her.db"));
    try {
      const importedLog = new ActionLog(join(freshDir, "actions.jsonl"), 3000, freshStore);
      await importedLog.load();
      expect(freshStore.wasBroughtOver("actions.jsonl")).toBe(true);
      expect(importedLog.recent(10)).toHaveLength(2);
      importedLog.add({
        at: "2026-11-24T12:05:00.000Z",
        tool: "ship_status",
        detail: "host health",
        outcome: "done",
        asked: false,
        by: "her",
      });
      expect(importedLog.recent(10)).toHaveLength(3);
      expect(importedLog.verifyChain().ok).toBe(true);
    } finally {
      freshStore.close();
    }
  });

  it("loads v1.0 config, memory, missions, and standing-orders JSON cleanly and enables v1.1 features", async () => {
    const dir = copyFixtureToTemp();

    const cfg = new ConfigStore(join(dir, "config.json"));
    const loadedCfg = await cfg.load();
    expect(loadedCfg.brain).toBe("standard");
    expect(loadedCfg.onboardingComplete).toBe(true);
    expect(loadedCfg.firstMetAt).toBe("2026-10-01T12:00:00.000Z");
    expect(loadedCfg.tier10.modelCascade).toBe(false);
    expect(loadedCfg.tier10.fullDuplexVoice).toBe(false);

    const memory = new MemoryStore(join(dir, "memory.json"));
    await memory.load();
    expect(memory.all()).toHaveLength(2);
    const pinned = await memory.pin("v10mem01", true);
    expect(pinned?.pinned).toBe(true);
    expect(memory.get("v10mem02")?.text).toContain("Celsius");

    const board = new MissionBoard({
      file: join(dir, "missions.json"),
      judge: async () => ({ decision: "allow" }),
      fingerprint: (s) => `${s.where}:${s.command}`,
      run: async () => ({ ok: true, output: "ok" }),
      ask: async () => ({ allowed: false, by: { from: "pc" } }),
      tell: () => undefined,
    });
    await board.load();
    const m = board.get("m-1a2b3c");
    expect(m?.title).toBe("v1.0 Weekly Maintenance");
    expect(m?.steps[0]?.state).toBe("done");
    expect(m?.steps[1]?.state).toBe("waiting");
    expect(await board.rollback("m-1a2b3c")).toBe(true);
    expect(board.get("m-1a2b3c")?.state).toBe("blocked");
    await board.dispose();
  });

  it("inspects and restores v1.0 profileBackup archive over both blank and existing v1.1 profiles", async () => {
    const dir = copyFixtureToTemp();
    const archivePath = join(dir, "v1.0-profile.astranavi-backup");

    const info = await inspectProfileBackup(archivePath);
    expect(info.version).toBe(1);
    expect(info.files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["config.json", "memory.json", "missions.json", "standing-orders.json", "her.db"]),
    );

    // Seed an existing v1.1 profile to verify pre-restore-backups snapshot is created
    const restoreDir = mkdtempSync(join(tmpdir(), "astranavi-restore-"));
    tempDirs.push(restoreDir);
    const prevCfg = new ConfigStore(join(restoreDir, "config.json"));
    await prevCfg.load();
    await prevCfg.update({ brain: "large", onboardingComplete: true });
    writeFileSync(join(restoreDir, "memory.json"), JSON.stringify({ version: 1, memories: [] }));

    const result = await importProfileBackup(archivePath, restoreDir);
    expect(result.restoredFiles).toEqual(
      expect.arrayContaining(["config.json", "memory.json", "her.db"]),
    );
    expect(result.backupSnapshotDir).not.toBeNull();
    expect(existsSync(join(result.backupSnapshotDir ?? "", "config.json"))).toBe(true);
    expect(
      (JSON.parse(readFileSync(join(result.backupSnapshotDir ?? "", "config.json"), "utf8")) as { brain: string }).brain,
    ).toBe("large");

    // Restored v1.0 DB upgrades seamlessly under v1.1 HerStore
    const restoredCfg = new ConfigStore(join(restoreDir, "config.json"));
    expect((await restoredCfg.load()).brain).toBe("standard");
    const restoredStore = new HerStore(join(restoreDir, "her.db"));
    try {
      expect(
        Number(restoredStore.one<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0),
      ).toBe(LAYOUT_VERSION);
      expect(
        restoredStore.all<{ id: number }>("SELECT id FROM turns"),
      ).toHaveLength(2);
    } finally {
      restoredStore.close();
    }

    // Export from restored state produces a valid v1.1 archive too
    const reExport = join(restoreDir, "v1.1-after-upgrade.astranavi-backup");
    const reSummary = await exportProfileBackup(restoreDir, reExport);
    expect(reSummary.files.some((f) => f.name === "her.db")).toBe(true);
  });

  it("rolls back cleanly on mid-migration failure and refuses future layouts or corrupted backups without losing existing data", async () => {
    const dir = copyFixtureToTemp();
    const dbPath = join(dir, "her.db");

    // Inject mid-migration failure in step 4 (LAYOUT[3]): pre-create column `seq` while keeping user_version=3
    // so `ALTER TABLE actions ADD COLUMN prev_hash` / `seq` fails inside HerStore's transaction
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec("ALTER TABLE actions ADD COLUMN seq INTEGER;");
    rawDb.exec("PRAGMA user_version = 3;");
    rawDb.close();

    expect(() => new HerStore(dbPath)).toThrow();

    // Confirm user_version remained 3, partial columns (prev_hash/entry_hash) were rolled back, and all rows stayed intact
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(Number(verify.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0)).toBe(3);
      const colNames = (verify.prepare("PRAGMA table_info(actions)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(colNames).not.toContain("prev_hash");
      expect(colNames).not.toContain("entry_hash");
      expect(verify.prepare("SELECT COUNT(*) AS c FROM turns").get()?.["c"]).toBe(2);
      expect(verify.prepare("SELECT COUNT(*) AS c FROM actions").get()?.["c"]).toBe(2);
    } finally {
      verify.close();
    }

    // Future layout DB (> LAYOUT_VERSION) throws StoreFromTheFuture and leaves rows untouched
    const futureDir = copyFixtureToTemp();
    const futureDbPath = join(futureDir, "her.db");
    const fDb = new DatabaseSync(futureDbPath);
    fDb.exec("PRAGMA user_version = 99;");
    fDb.close();
    expect(() => new HerStore(futureDbPath)).toThrow(StoreFromTheFuture);

    // Corrupted backup archive aborts BEFORE touching target directory
    const targetDir = mkdtempSync(join(tmpdir(), "astranavi-corrupt-"));
    tempDirs.push(targetDir);
    const sentinel = join(targetDir, "config.json");
    writeFileSync(sentinel, JSON.stringify({ sentinel: true }));
    const badArchive = join(targetDir, "bad.astranavi-backup");
    const bytes = Buffer.from(readFileSync(join(dir, "v1.0-profile.astranavi-backup")));
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0xff;
    writeFileSync(badArchive, bytes);

    await expect(importProfileBackup(badArchive, targetDir)).rejects.toThrow();
    expect(readFileSync(sentinel, "utf8")).toBe('{"sentinel":true}');
    expect(existsSync(join(targetDir, "pre-restore-backups"))).toBe(false);
  });
});
