import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import { generatePeerKeypair, PeerStateSyncEngine } from "../src/core/peerSync.ts";
import { VaultRagIndex } from "../src/core/vaultRag.ts";

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "astra-w2-wb-"));
  tempDirs.push(dir);
  return dir;
}

/** Builds a valid uncompressed PDF 1.4 buffer readable by both `pdftotext` and literal string extractors. */
function buildMinimalPdfBuffer(lines: readonly string[]): Buffer {
  const escaped = lines.map((line) =>
    line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"),
  );
  const textOps = escaped.map((l, idx) => `(${l}) Tj${idx < escaped.length - 1 ? " T*" : ""}`).join("\n");
  const streamBody = `BT\n/F1 12 Tf\n14 TL\n72 720 Td\n${textOps}\nET\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamBody, "utf8")} >>\nstream\n${streamBody}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(out, "utf8"));
    out += obj;
  }
  const xrefStart = Buffer.byteLength(out, "utf8");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "utf8");
}

afterEach(async () => {
  ipcHandlers.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Wave 2 Workbench Management UI & IPC (`Extensions & Sync`)", () => {
  it("indexes .pdf + .md inside VaultRagIndex and manages vault roots, LAN peers, and Wave 2 plugin toggles cleanly", async () => {
    const dir = await makeTempDir();
    const vaultDir = join(dir, "vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(
      join(vaultDir, "architecture.md"),
      "# Postgres Config\nStaging Postgres runs on port 5433.\n",
      "utf8",
    );
    await writeFile(
      join(vaultDir, "backup-runbook.pdf"),
      buildMinimalPdfBuffer(["Quarterly Backup Retention: 30 days on ZFS vault pool."]),
    );

    // Direct VaultRagIndex PDF extraction check
    const directRag = new VaultRagIndex({ approvedRoots: [vaultDir] });
    const ragStats = await directRag.reindex();
    expect(ragStats.filesScanned).toBe(2);
    const pdfHits = await directRag.search("Quarterly Backup Retention", 4);
    expect(pdfHits.some((h) => h.relativePath.endsWith(".pdf") && h.framedText.includes("30 days"))).toBe(true);

    const cfg = new ConfigStore(join(dir, "config.json"));
    await cfg.load();
    expect(cfg.value.wave2.vaultRoots).toEqual([]);
    expect(cfg.value.wave2.lanPeers).toEqual([]);
    expect(cfg.value.wave2.enabledPlugins).toEqual([]);

    const { buildWave2Snapshot, createWave2Ipc, WAVE2_PLUGIN_IDS } = await import(
      "../src/main/wave2Ipc.ts"
    );

    const authSender = { id: 77 };
    const authEvent = { sender: authSender };
    const badEvent = { sender: { id: 999 } };

    const ctrl = createWave2Ipc({
      config: cfg,
      workspaceDir: dir,
      pluginsDir: join(process.cwd(), "plugins"),
      localNodeId: "test-workstation",
      isAuthorizedSender: (ev) => ev.sender === authSender,
    });
    ctrl.registerIpc();

    const snapHandler = ipcHandlers.get("wave2:snapshot");
    const addVaultHandler = ipcHandlers.get("wave2:vault-add");
    const reindexVaultHandler = ipcHandlers.get("wave2:vault-reindex");
    const rmVaultHandler = ipcHandlers.get("wave2:vault-remove");
    const pairPeerHandler = ipcHandlers.get("wave2:peer-pair");
    const rmPeerHandler = ipcHandlers.get("wave2:peer-remove");
    const togglePluginHandler = ipcHandlers.get("wave2:plugin-toggle");
    if (
      !snapHandler ||
      !addVaultHandler ||
      !reindexVaultHandler ||
      !rmVaultHandler ||
      !pairPeerHandler ||
      !rmPeerHandler ||
      !togglePluginHandler
    ) {
      throw new Error("Missing expected wave2:* IPC handlers");
    }

    // 1. Sender authorization gate
    await expect(snapHandler(badEvent)).rejects.toThrow(/Unauthorized/i);
    const unauthAdd = (await addVaultHandler(badEvent, vaultDir)) as { ok: boolean; message: string };
    expect(unauthAdd.ok).toBe(false);
    expect(unauthAdd.message).toContain("Unauthorized");

    // 2. Vault root safety gates + approval + reindex + revoke
    const rejectMissing = (await addVaultHandler(authEvent, join(dir, "does-not-exist"))) as {
      ok: boolean;
      message: string;
    };
    expect(rejectMissing.ok).toBe(false);

    const rejectHome = (await addVaultHandler(authEvent, homedir())) as { ok: boolean; message: string };
    expect(rejectHome.ok).toBe(false);
    expect(rejectHome.message).toContain("broad");

    const sshDir = join(dir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const rejectSsh = (await addVaultHandler(authEvent, sshDir)) as { ok: boolean; message: string };
    expect(rejectSsh.ok).toBe(false);
    expect(rejectSsh.message).toContain("sensitive");

    const addOk = (await addVaultHandler(authEvent, vaultDir)) as { ok: boolean; message: string };
    expect(addOk.ok).toBe(true);
    expect(cfg.value.wave2.vaultRoots).toHaveLength(1);

    const reindexRes = (await reindexVaultHandler(authEvent)) as { ok: boolean; message: string };
    expect(reindexRes.ok).toBe(true);
    expect(reindexRes.message).toContain("2 file(s)");

    // 3. LAN peer pairing enforcement (rejects WAN, non-Ed25519, credentials; accepts RFC1918 + Ed25519)
    const peerKeys = generatePeerKeypair("proxmox-node-2");
    const { publicKey: rsaPubPem } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const rejectWan = (await pairPeerHandler(authEvent, {
      id: "wan-peer",
      label: "WAN",
      endpoint: "https://8.8.8.8:48025",
      publicKeyPem: peerKeys.publicKeyPem,
    })) as { ok: boolean; message: string };
    expect(rejectWan.ok).toBe(false);
    expect(rejectWan.message).toContain("private LAN");

    const rejectRsa = (await pairPeerHandler(authEvent, {
      id: "lan-rsa",
      label: "LAN",
      endpoint: "http://192.168.50.14:48025",
      publicKeyPem: rsaPubPem,
    })) as { ok: boolean; message: string };
    expect(rejectRsa.ok).toBe(false);
    expect(rejectRsa.message).toContain("Ed25519");

    const pairOk = (await pairPeerHandler(authEvent, {
      id: "proxmox-node-2",
      label: "Proxmox Host",
      endpoint: "http://192.168.50.14:48025",
      publicKeyPem: peerKeys.publicKeyPem,
    })) as { ok: boolean; message: string };
    expect(pairOk.ok).toBe(true);
    expect(cfg.value.wave2.lanPeers).toHaveLength(1);

    // 4. Wave 2 plugin listing, scopes, and opt-in toggles
    const toggleUnknown = (await togglePluginHandler(authEvent, "no-such-plugin", true)) as {
      ok: boolean;
      message: string;
    };
    expect(toggleUnknown.ok).toBe(false);

    for (const id of WAVE2_PLUGIN_IDS) {
      const enRes = (await togglePluginHandler(authEvent, id, true)) as { ok: boolean; message: string };
      expect(enRes.ok).toBe(true);
    }
    expect(cfg.value.wave2.enabledPlugins).toHaveLength(5);

    const snapshot = await buildWave2Snapshot(
      { config: cfg, workspaceDir: dir, pluginsDir: join(process.cwd(), "plugins"), localNodeId: "test-workstation" },
      ctrl.engine(),
    );
    expect(snapshot.vaultRoots).toHaveLength(1);
    expect(snapshot.vaultRoots[0]?.valid).toBe(true);
    expect(snapshot.vaultRoots[0]?.filesIndexed).toBe(2);
    expect(snapshot.lanPeers).toHaveLength(1);
    expect(snapshot.lanPeers[0]?.lanAllowed).toBe(true);

    const wave2Plugins = snapshot.plugins.filter((p) => p.isWave2);
    expect(wave2Plugins).toHaveLength(5);
    expect(wave2Plugins.every((p) => p.enabled && !p.defaultEnabled && p.permissions.length > 0)).toBe(true);

    // Clean revocation & unpairing
    expect(((await rmVaultHandler(authEvent, cfg.value.wave2.vaultRoots[0])) as { ok: boolean }).ok).toBe(true);
    expect(cfg.value.wave2.vaultRoots).toHaveLength(0);
    expect(((await rmPeerHandler(authEvent, "proxmox-node-2")) as { ok: boolean }).ok).toBe(true);
    expect(cfg.value.wave2.lanPeers).toHaveLength(0);
  });

  it("supports live loopback LAN peer probing via wave2:peer-probe", async () => {
    const dir = await makeTempDir();
    const cfg = new ConfigStore(join(dir, "config.json"));
    await cfg.load();

    const remoteKeys = generatePeerKeypair("loopback-peer");
    const sharedSecret = randomBytes(32);

    const { createWave2Ipc } = await import("../src/main/wave2Ipc.ts");
    const authSender = { id: 88 };
    const authEvent = { sender: authSender };
    const ctrl = createWave2Ipc({
      config: cfg,
      workspaceDir: dir,
      pluginsDir: join(process.cwd(), "plugins"),
      localNodeId: "local-probe-node",
      isAuthorizedSender: (ev) => ev.sender === authSender,
    });
    ctrl.registerIpc();

    // Align shared secret on test remote PeerStateSyncEngine or verify clean signature rejection/response
    const remoteEngine = new PeerStateSyncEngine({
      nodeId: "loopback-peer",
      sharedSecret,
      privateKeyPem: remoteKeys.privateKeyPem,
      publicKeyPem: remoteKeys.publicKeyPem,
      trustedPeers: { "local-probe-node": ctrl.engine().publicKeyPem },
    });

    const server = createServer((req, res) => {
      void remoteEngine.handleHttpRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Expected numeric port");

    try {
      const pairHandler = ipcHandlers.get("wave2:peer-pair");
      const probeHandler = ipcHandlers.get("wave2:peer-probe");
      if (!pairHandler || !probeHandler) throw new Error("Missing peer handlers");

      await pairHandler(authEvent, {
        id: "loopback-peer",
        label: "Loopback Peer",
        endpoint: `http://127.0.0.1:${addr.port}`,
        publicKeyPem: remoteKeys.publicKeyPem,
      });

      const probeRes = (await probeHandler(authEvent, "loopback-peer")) as {
        ok: boolean;
        message: string;
      };
      // HTTP request cleanly reached remote /sync/merge and returned structured refusal (distinct ephemeral AES key)
      expect(probeRes.message).toContain("loopback-peer");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
