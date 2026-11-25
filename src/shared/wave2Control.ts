import type { PluginPermissionScope } from "../core/pluginSdk.ts";

/**
 * Shared IPC & UI view contracts for Wave 2 (`v1.2`) management inside `workbench.html`:
 * Local Vault RAG folder approval, LAN PeerStateSyncEngine pairing, and opt-in plugin
 * toggling with explicit permission scope visibility.
 */

export interface VaultRootStatus {
  path: string;
  valid: boolean;
  filesIndexed: number;
  totalChunks: number;
  skippedUnsafe: number;
  error?: string;
}

export interface LanPeerView {
  id: string;
  label: string;
  endpoint: string;
  fingerprint: string;
  publicKeyPem: string;
  pairedAt: string;
  lanAllowed: boolean;
}

export interface Wave2PluginToolView {
  name: string;
  description: string;
  requiredScope: PluginPermissionScope;
  readOnly: boolean;
  endpointHost?: string;
}

export interface Wave2PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  enabled: boolean;
  isWave2: boolean;
  permissions: PluginPermissionScope[];
  tools: Wave2PluginToolView[];
}

export interface Wave2Snapshot {
  generatedAt: string;
  vaultRoots: VaultRootStatus[];
  localNode: {
    nodeId: string;
    publicKeyFingerprint: string;
    publicKeyPem: string;
    recordCount: number;
    protections: string[];
  };
  lanPeers: LanPeerView[];
  plugins: Wave2PluginView[];
}

export interface LanPeerPairInput {
  id: string;
  label: string;
  endpoint: string;
  publicKeyPem: string;
}

export interface Wave2ActionResult {
  ok: boolean;
  message: string;
  detail?: unknown;
}

export interface Wave2Bridge {
  getSnapshot(): Promise<Wave2Snapshot>;
  addVaultRoot(dirPath: string): Promise<Wave2ActionResult>;
  removeVaultRoot(dirPath: string): Promise<Wave2ActionResult>;
  reindexVault(): Promise<Wave2ActionResult>;
  pairLanPeer(input: LanPeerPairInput): Promise<Wave2ActionResult>;
  removeLanPeer(peerId: string): Promise<Wave2ActionResult>;
  probeLanPeer(peerId: string): Promise<Wave2ActionResult>;
  togglePlugin(pluginId: string, enabled: boolean): Promise<Wave2ActionResult>;
}
