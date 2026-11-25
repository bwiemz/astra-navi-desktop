import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ipcMain } from "electron";
import type { Config, ConfigStore } from "../core/config.ts";
import { generatePeerKeypair, PeerStateSyncEngine, syncWithLanPeer } from "../core/peerSync.ts";
import { PluginManifestSchema, type PluginManifest } from "../core/pluginSdk.ts";
import { isBroadPath, isPrivatePath } from "../core/riskRules.ts";
import { VaultRagIndex } from "../core/vaultRag.ts";
import { isPrivateLanHost } from "../core/workerMesh.ts";
import type {
  LanPeerPairInput,
  LanPeerView,
  VaultRootStatus,
  Wave2ActionResult,
  Wave2PluginView,
  Wave2Snapshot,
} from "../shared/wave2Control.ts";

/**
 * Backend IPC controller for Wave 2 (`v1.2`) management inside Workbench:
 * - Approve / revoke / reindex isolated Local Vault RAG directories (`.md`, `.pdf`, code)
 * - Pair / inspect / unpair LAN `PeerStateSyncEngine` nodes with private-LAN + Ed25519 enforcement
 * - Enable / disable Wave 2 & bundled opt-in plugins with manifest permission scope visibility
 */

export const WAVE2_PLUGIN_IDS = new Set([
  "local-vault-rag",
  "lan-game-copilot",
  "homelab-ops",
  "home-assistant-mqtt",
  "creative-pipeline",
]);

export interface Wave2IpcDeps {
  config: ConfigStore;
  workspaceDir: string;
  pluginsDir?: string;
  localNodeId?: string;
  isAuthorizedSender?(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
}

function fingerprintPem(pem: string): string {
  return createHash("sha256").update(pem.trim(), "utf8").digest("hex").slice(0, 16);
}

function validateVaultCandidate(
  candidateDir: string,
  workspaceDir: string,
): { ok: true; realPath: string } | { ok: false; reason: string } {
  const raw = candidateDir.trim();
  if (!raw) return { ok: false, reason: "Directory path cannot be empty." };
  const resolved = resolve(raw);
  if (resolve(resolved, "..") === resolved) {
    return { ok: false, reason: `Refused filesystem root "${resolved}".` };
  }
  if (!existsSync(resolved)) {
    return { ok: false, reason: `Directory "${resolved}" does not exist.` };
  }
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return { ok: false, reason: `Could not resolve realpath for "${resolved}".` };
  }
  if (!statSync(realPath).isDirectory()) {
    return { ok: false, reason: `Path "${realPath}" is not a directory.` };
  }
  if (isBroadPath(realPath, homedir())) {
    return { ok: false, reason: `Refused broad host directory "${realPath}". Pick a specific project/vault folder.` };
  }
  if (isPrivatePath(realPath, { workspace: workspaceDir })) {
    return { ok: false, reason: `Refused sensitive/private directory "${realPath}".` };
  }
  const probeRag = new VaultRagIndex({ approvedRoots: [realPath], policyContext: { workspace: workspaceDir } });
  const check = probeRag.isAllowedPath(realPath);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }
  return { ok: true, realPath };
}

function validateLanPeerInput(
  input: LanPeerPairInput,
): { ok: true; host: string; port: number; normalizedEndpoint: string } | { ok: false; reason: string } {
  const id = input.id.trim();
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(id)) {
    return { ok: false, reason: "Peer ID must be 2–64 alphanumeric/._- characters." };
  }
  if (!input.label.trim() || input.label.trim().length > 80) {
    return { ok: false, reason: "Peer label must be 1–80 characters." };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.endpoint.trim());
  } catch {
    return { ok: false, reason: "Endpoint must be a valid http:// or https:// URL." };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { ok: false, reason: `Unsupported protocol "${parsedUrl.protocol}" (use http: or https:).` };
  }
  if (parsedUrl.username || parsedUrl.password) {
    return { ok: false, reason: "Endpoint URL must not embed credentials." };
  }
  if (!isPrivateLanHost(parsedUrl.hostname)) {
    return {
      ok: false,
      reason: `Refused public/WAN host "${parsedUrl.hostname}": only private LAN, loopback, or Tailscale hosts are allowed.`,
    };
  }
  const port = parsedUrl.port
    ? Number(parsedUrl.port)
    : parsedUrl.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "Endpoint port must be between 1 and 65535." };
  }
  try {
    const pub = createPublicKey(input.publicKeyPem.trim());
    if (pub.asymmetricKeyType !== "ed25519") {
      return { ok: false, reason: `Unsupported key type "${pub.asymmetricKeyType}": expected Ed25519 PEM.` };
    }
  } catch {
    return { ok: false, reason: "Invalid Ed25519 public key PEM." };
  }
  return {
    ok: true,
    host: parsedUrl.hostname,
    port,
    normalizedEndpoint: `${parsedUrl.protocol}//${parsedUrl.hostname}:${port}`,
  };
}

function loadBundledPluginManifests(pluginsDir: string): PluginManifest[] {
  if (!existsSync(pluginsDir)) return [];
  const manifests: PluginManifest[] = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(pluginsDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const parsed = PluginManifestSchema.safeParse(
        JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
      );
      if (parsed.success) manifests.push(parsed.data);
    } catch {
      // Skip unreadable/malformed plugin manifest cleanly
    }
  }
  return manifests.sort((a, b) => {
    const aw = WAVE2_PLUGIN_IDS.has(a.id) ? 0 : 1;
    const bw = WAVE2_PLUGIN_IDS.has(b.id) ? 0 : 1;
    return aw !== bw ? aw - bw : a.id.localeCompare(b.id);
  });
}

function createSyncEngine(deps: Wave2IpcDeps): PeerStateSyncEngine {
  const nodeId = deps.localNodeId ?? `desktop-${createHash("sha1").update(deps.workspaceDir).digest("hex").slice(0, 8)}`;
  const keypair = generatePeerKeypair(nodeId);
  const trustedPeers: Record<string, string> = {};
  for (const peer of deps.config.value.wave2.lanPeers) {
    trustedPeers[peer.id] = peer.publicKeyPem;
  }
  return new PeerStateSyncEngine({
    nodeId,
    sharedSecret: randomBytes(32),
    privateKeyPem: keypair.privateKeyPem,
    publicKeyPem: keypair.publicKeyPem,
    trustedPeers,
  });
}

/** Builds a serializable snapshot of Wave 2 Vault RAG roots, LAN Sync peers, and opt-in plugins. */
export async function buildWave2Snapshot(
  deps: Pick<Wave2IpcDeps, "config" | "workspaceDir" | "pluginsDir" | "localNodeId">,
  syncEngine?: PeerStateSyncEngine,
  now = new Date(),
): Promise<Wave2Snapshot> {
  const cfg = deps.config.value;
  const wave2 = cfg.wave2;
  const pluginsDir = deps.pluginsDir ?? join(process.cwd(), "plugins");
  const engine = syncEngine ?? createSyncEngine(deps);

  const vaultRoots: VaultRootStatus[] = [];
  for (const rootPath of wave2.vaultRoots) {
    const check = validateVaultCandidate(rootPath, deps.workspaceDir);
    if (!check.ok) {
      vaultRoots.push({
        path: rootPath,
        valid: false,
        filesIndexed: 0,
        totalChunks: 0,
        skippedUnsafe: 0,
        error: check.reason,
      });
      continue;
    }
    const rag = new VaultRagIndex({
      approvedRoots: [check.realPath],
      policyContext: { workspace: deps.workspaceDir },
    });
    const stats = await rag.reindex();
    vaultRoots.push({
      path: check.realPath,
      valid: true,
      filesIndexed: stats.filesScanned,
      totalChunks: stats.totalChunks,
      skippedUnsafe: stats.filesSkippedUnsafe,
    });
  }

  const lanPeers: LanPeerView[] = wave2.lanPeers.map((peer) => {
    const lanAllowed = (() => {
      try {
        return isPrivateLanHost(new URL(peer.endpoint).hostname);
      } catch {
        return false;
      }
    })();
    return {
      id: peer.id,
      label: peer.label,
      endpoint: peer.endpoint,
      fingerprint: fingerprintPem(peer.publicKeyPem),
      publicKeyPem: peer.publicKeyPem,
      pairedAt: peer.pairedAt,
      lanAllowed,
    };
  });

  const enabledSet = new Set(wave2.enabledPlugins);
  const plugins: Wave2PluginView[] = loadBundledPluginManifests(pluginsDir).map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    defaultEnabled: manifest.defaultEnabled ?? false,
    enabled: enabledSet.has(manifest.id),
    isWave2: WAVE2_PLUGIN_IDS.has(manifest.id),
    permissions: [...manifest.permissions],
    tools: (manifest.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      requiredScope: t.requiredScope,
      readOnly: t.readOnly,
      ...(t.endpointHost ? { endpointHost: t.endpointHost } : {}),
    })),
  }));

  return {
    generatedAt: now.toISOString(),
    vaultRoots,
    localNode: {
      nodeId: engine.nodeId,
      publicKeyFingerprint: fingerprintPem(engine.publicKeyPem),
      publicKeyPem: engine.publicKeyPem,
      recordCount: engine.allRecords(true).length,
      protections: [
        "AES-256-GCM AEAD + Ed25519 sender signatures",
        "Replay-nonce cache (4,096 bounded, +/-5 min skew)",
        "Private RFC1918 / loopback / Tailscale host gate",
        "Automated secret & raw-capture redaction",
      ],
    },
    lanPeers,
    plugins,
  };
}

export interface Wave2IpcController {
  registerIpc(): void;
  engine(): PeerStateSyncEngine;
}

export function createWave2Ipc(deps: Wave2IpcDeps): Wave2IpcController {
  let ipcRegistered = false;
  const pluginsDir = deps.pluginsDir ?? join(process.cwd(), "plugins");
  const syncEngine = createSyncEngine(deps);

  function fromAuthorized(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    return deps.isAuthorizedSender ? deps.isAuthorizedSender(event) : false;
  }

  function registerIpc(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle("wave2:snapshot", async (event): Promise<Wave2Snapshot> => {
      if (!fromAuthorized(event)) {
        throw new Error("Unauthorized IPC sender for Wave 2 Control.");
      }
      return buildWave2Snapshot({ ...deps, pluginsDir }, syncEngine);
    });

    ipcMain.handle(
      "wave2:vault-add",
      async (event, dirPath: string): Promise<Wave2ActionResult> => {
        if (!fromAuthorized(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const check = validateVaultCandidate(String(dirPath ?? ""), deps.workspaceDir);
        if (!check.ok) {
          return { ok: false, message: check.reason };
        }
        const existing = deps.config.value.wave2.vaultRoots;
        if (existing.includes(check.realPath)) {
          return { ok: true, message: `Vault folder "${check.realPath}" is already approved.` };
        }
        if (existing.length >= 16) {
          return { ok: false, message: "Maximum of 16 approved Vault RAG folders reached." };
        }
        const rag = new VaultRagIndex({
          approvedRoots: [check.realPath],
          policyContext: { workspace: deps.workspaceDir },
        });
        const stats = await rag.reindex();
        const nextWave2: Config["wave2"] = {
          ...deps.config.value.wave2,
          vaultRoots: [...existing, check.realPath],
        };
        await deps.config.update({ wave2: nextWave2 });
        return {
          ok: true,
          message: `Approved Vault folder "${check.realPath}" (${stats.filesScanned} file(s), ${stats.totalChunks} chunk(s), ${stats.filesSkippedUnsafe} blocked unsafe path(s)).`,
          detail: stats,
        };
      },
    );

    ipcMain.handle(
      "wave2:vault-remove",
      async (event, dirPath: string): Promise<Wave2ActionResult> => {
        if (!fromAuthorized(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const target = String(dirPath ?? "").trim();
        const nextRoots = deps.config.value.wave2.vaultRoots.filter((r) => r !== target);
        if (nextRoots.length === deps.config.value.wave2.vaultRoots.length) {
          return { ok: false, message: `Vault folder "${target}" is not in the approved list.` };
        }
        await deps.config.update({
          wave2: { ...deps.config.value.wave2, vaultRoots: nextRoots },
        });
        return { ok: true, message: `Revoked Vault RAG folder "${target}".` };
      },
    );

    ipcMain.handle("wave2:vault-reindex", async (event): Promise<Wave2ActionResult> => {
      if (!fromAuthorized(event)) {
        return { ok: false, message: "Unauthorized caller." };
      }
      const validRoots: string[] = [];
      for (const candidate of deps.config.value.wave2.vaultRoots) {
        const check = validateVaultCandidate(candidate, deps.workspaceDir);
        if (check.ok) validRoots.push(check.realPath);
      }
      if (validRoots.length === 0) {
        return { ok: true, message: "No valid approved Vault folders to reindex." };
      }
      const rag = new VaultRagIndex({
        approvedRoots: validRoots,
        policyContext: { workspace: deps.workspaceDir },
      });
      const stats = await rag.reindex();
      return {
        ok: true,
        message: `Indexed ${stats.filesScanned} file(s) -> ${stats.totalChunks} chunk(s) across ${validRoots.length} root(s) (${stats.filesSkippedUnsafe} unsafe skipped).`,
        detail: stats,
      };
    });

    ipcMain.handle(
      "wave2:peer-pair",
      async (event, input: LanPeerPairInput): Promise<Wave2ActionResult> => {
        if (!fromAuthorized(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const validated = validateLanPeerInput(input);
        if (!validated.ok) {
          return { ok: false, message: validated.reason };
        }
        const id = input.id.trim();
        const pem = input.publicKeyPem.trim();
        const entry = {
          id,
          label: input.label.trim(),
          endpoint: validated.normalizedEndpoint,
          publicKeyPem: pem,
          pairedAt: new Date().toISOString(),
        };
        const remaining = deps.config.value.wave2.lanPeers.filter((p) => p.id !== id);
        if (remaining.length >= 24) {
          return { ok: false, message: "Maximum of 24 paired LAN nodes reached." };
        }
        syncEngine.trustPeer(id, pem);
        await deps.config.update({
          wave2: {
            ...deps.config.value.wave2,
            lanPeers: [...remaining, entry],
          },
        });
        return {
          ok: true,
          message: `Paired LAN peer "${id}" (${validated.normalizedEndpoint}, fp ${fingerprintPem(pem)}).`,
        };
      },
    );

    ipcMain.handle(
      "wave2:peer-remove",
      async (event, peerId: string): Promise<Wave2ActionResult> => {
        if (!fromAuthorized(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const target = String(peerId ?? "").trim();
        const nextPeers = deps.config.value.wave2.lanPeers.filter((p) => p.id !== target);
        if (nextPeers.length === deps.config.value.wave2.lanPeers.length) {
          return { ok: false, message: `Peer "${target}" not found.` };
        }
        await deps.config.update({
          wave2: { ...deps.config.value.wave2, lanPeers: nextPeers },
        });
        return { ok: true, message: `Unpaired LAN peer "${target}".` };
      },
    );

    ipcMain.handle(
      "wave2:peer-probe",
      async (event, peerId: string): Promise<Wave2ActionResult> => {
        if (!fromAuthorized(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const peer = deps.config.value.wave2.lanPeers.find((p) => p.id === peerId.trim());
        if (!peer) {
          return { ok: false, message: `Peer "${peerId}" is not paired.` };
        }
        let parsed: URL;
        try {
          parsed = new URL(peer.endpoint);
        } catch {
          return { ok: false, message: `Peer "${peer.id}" has malformed endpoint "${peer.endpoint}".` };
        }
        const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
        syncEngine.trustPeer(peer.id, peer.publicKeyPem);
        try {
          const res = await syncWithLanPeer({
            engine: syncEngine,
            host: parsed.hostname,
            port,
            timeoutMs: 4000,
          });
          return {
            ok: res.ok,
            message: res.ok
              ? `Synced cleanly with "${peer.id}": applied ${res.appliedFromPeer} record(s), local total ${res.totalLocal}.`
              : `Peer "${peer.id}" sync refused (${res.reason ?? "unknown"}).`,
            detail: res,
          };
        } catch (error) {
          return {
            ok: false,
            message: `Peer "${peer.id}" probe failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    );

    ipcMain.handle(
      "wave2:plugin-toggle",
      async (event, pluginId: string, enabled: boolean): Promise<Wave2ActionResult> => {
        if (!fromAuthorized(event)) {
          return { ok: false, message: "Unauthorized caller." };
        }
        const cleanId = String(pluginId ?? "").trim();
        const available = loadBundledPluginManifests(pluginsDir);
        const manifest = available.find((m) => m.id === cleanId);
        if (!manifest) {
          return { ok: false, message: `Unknown plugin "${cleanId}".` };
        }
        const nextSet = new Set(deps.config.value.wave2.enabledPlugins);
        if (enabled) nextSet.add(cleanId);
        else nextSet.delete(cleanId);
        await deps.config.update({
          wave2: { ...deps.config.value.wave2, enabledPlugins: [...nextSet].sort() },
        });
        return {
          ok: true,
          message: `Plugin "${manifest.name}" (${cleanId}) ${enabled ? "enabled (opt-in)" : "disabled"} — scopes: ${manifest.permissions.join(", ")}.`,
        };
      },
    );
  }

  return {
    registerIpc,
    engine: () => syncEngine,
  };
}
