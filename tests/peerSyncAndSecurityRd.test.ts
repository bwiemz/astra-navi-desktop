import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMultiTurnSimulator } from "../evals/multiTurnSim.ts";
import { ActionLog, verifyActionChain } from "../src/core/actionLog.ts";
import {
  generatePeerKeypair,
  PeerStateSyncEngine,
  syncWithLanPeer,
  type EncryptedSyncEnvelope,
} from "../src/core/peerSync.ts";
import { HerStore } from "../src/core/store.ts";

describe("Post-v1 P2P LAN Sync, Hash-Chained ActionLog & Multi-Turn Security (Tracks 5 & 6)", () => {
  it("merges LWW CRDT state over encrypted/signed LAN envelopes and rejects tampering/WAN hosts", async () => {
    const secret = randomBytes(32);
    const kpA = generatePeerKeypair("node-a");
    const kpB = generatePeerKeypair("node-b");
    const trusted = { [kpA.nodeId]: kpA.publicKeyPem, [kpB.nodeId]: kpB.publicKeyPem };

    const engineA = new PeerStateSyncEngine({
      nodeId: kpA.nodeId,
      sharedSecret: secret,
      privateKeyPem: kpA.privateKeyPem,
      publicKeyPem: kpA.publicKeyPem,
      trustedPeers: trusted,
    });
    const engineB = new PeerStateSyncEngine({
      nodeId: kpB.nodeId,
      sharedSecret: secret,
      privateKeyPem: kpB.privateKeyPem,
      publicKeyPem: kpB.publicKeyPem,
      trustedPeers: trusted,
    });

    const t0 = Date.now();
    engineA.put("theme", "ui", "dark", t0);
    engineA.exportSanitizedHandoff(
      {
        summary: "Finish script sk-live-secret987654321 and Bearer abcdefghijklmnop",
        screenCapture: "PRIVATE_SCREENSHOT",
      },
      "hand-1",
    );
    engineB.put("theme", "ui", "oled-black", t0 + 1000);

    const server = createServer((req, res) => {
      void engineB.handleHttpRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const synced = await syncWithLanPeer({ engine: engineA, host: "127.0.0.1", port });
      expect(synced.ok).toBe(true);
      expect(engineA.get("ui", "theme")?.value).toBe("oled-black");
      expect(engineB.get("ui", "theme")?.value).toBe("oled-black");

      const handoffVal = JSON.stringify(engineB.get("handoff", "handoff:hand-1")?.value);
      expect(handoffVal).not.toContain("sk-live-secret987654321");
      expect(handoffVal).not.toContain("PRIVATE_SCREENSHOT");
      expect(handoffVal).toContain("[redacted-secret]");

      // Reject bit-flipped ciphertext even before returning 200
      const env = engineA.exportEncryptedEnvelope();
      const raw = Buffer.from(env.ciphertextB64, "base64");
      raw[0] = (raw[0] ?? 0) ^ 0xff;
      const forged: EncryptedSyncEnvelope = { ...env, ciphertextB64: raw.toString("base64") };
      expect(engineB.importEncryptedEnvelope(forged).ok).toBe(false);

      // Block public WAN host
      await expect(syncWithLanPeer({ engine: engineA, host: "8.8.8.8", port })).rejects.toThrow(
        /private LAN/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maintains tamper-evident SHA-256 ActionLog hash chains across JSONL and SQLite and detects tampering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astra-action-chain-"));
    try {
      const logFile = join(dir, "actions.jsonl");
      const jsonlLog = new ActionLog(logFile, 100);
      jsonlLog.add({
        at: "2026-11-23T10:00:00.000Z",
        tool: "read_file",
        detail: "README.md",
        outcome: "done",
        asked: false,
        by: "her",
      });
      jsonlLog.add({
        at: "2026-11-23T10:01:00.000Z",
        tool: "run_command",
        detail: "npm test",
        outcome: "done",
        asked: true,
        by: "her",
        approvalSig: "desktop-ok",
      });
      await jsonlLog.flush();

      expect(jsonlLog.verifyChain().ok).toBe(true);
      expect(jsonlLog.exportChainProof().verified).toBe(true);
      expect(jsonlLog.exportChainProof().headSeq).toBe(2);

      // Tamper detail in line 1 on disk -> reload & verifyChain detects modification
      const lines = readFileSync(logFile, "utf8").trim().split("\n");
      const row0 = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      row0["detail"] = "tampered-secret";
      writeFileSync(logFile, `${JSON.stringify(row0)}\n${lines[1] ?? ""}\n`, "utf8");
      const reloaded = new ActionLog(logFile, 100);
      await reloaded.load();
      expect(reloaded.verifyChain().ok).toBe(false);

      // SQLite HerStore hash chain + mid-chain deletion detection
      const store = new HerStore(join(dir, "her.sqlite"));
      const sqlLog = new ActionLog(join(dir, "unused.jsonl"), 50, store);
      sqlLog.add({ at: "2026-11-23T11:00:00Z", tool: "a", detail: "1", outcome: "done", asked: false, by: "her" });
      sqlLog.add({ at: "2026-11-23T11:01:00Z", tool: "b", detail: "2", outcome: "done", asked: false, by: "her" });
      sqlLog.add({ at: "2026-11-23T11:02:00Z", tool: "c", detail: "3", outcome: "done", asked: false, by: "her" });
      expect(sqlLog.verifyChain().ok).toBe(true);

      // Removing middle row breaks seq continuity
      store.run("DELETE FROM actions WHERE tool = ?", "b");
      expect(sqlLog.verifyChain().ok).toBe(false);
      store.close();

      // Reordered array caught directly by verifyActionChain
      const validTwo = jsonlLog.recent(2).reverse();
      expect(verifyActionChain(validTwo).ok).toBe(true);
      const swapped = [validTwo[1], validTwo[0]].filter((x): x is NonNullable<typeof x> => x !== undefined);
      expect(verifyActionChain(swapped).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes all scenarios in the Multi-Turn Synthetic User Simulator", async () => {
    const report = await runMultiTurnSimulator();
    expect(report.passedScenarios).toBe(report.totalScenarios);
    expect(report.totalTurns).toBeGreaterThanOrEqual(40);
  });
});
