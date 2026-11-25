import type { Wave2Bridge, Wave2Snapshot } from "../../../shared/wave2Control.ts";
import { el } from "./dom.ts";

/**
 * Renders the Wave 2 (`v1.2`) Extensions, Local Vault RAG, and LAN Peer Sync
 * management tab inside `workbench.html` (`#panel-extensions`).
 */
export function renderWorkbenchWave2Panel(
  container: HTMLElement,
  snapshot: Wave2Snapshot,
  ops: {
    wave2: Wave2Bridge;
    setStatus(msg: string): void;
    refresh(): Promise<void>;
  },
): void {
  const wrap = el("div", "stack");

  // 1. Approved Local Vault RAG Directories
  const vaultCard = el("div", "card stack");
  const vaultHead = el("div", "card-header");
  const vaultTitle = el("div");
  vaultTitle.append(
    el("h2", undefined, "Local Vault & Codebase RAG Folders"),
    el(
      "p",
      "muted",
      "Opt-in only: approve specific Markdown, code, or PDF folders. Symlink escapes, .env, SSH keys, and broad home directories are always blocked.",
    ),
  );
  const reindexBtn = el("button", undefined, "Reindex All Approved");
  reindexBtn.type = "button";
  reindexBtn.dataset.action = "wave2-vault-reindex";
  reindexBtn.addEventListener("click", async () => {
    reindexBtn.disabled = true;
    try {
      const res = await ops.wave2.reindexVault();
      ops.setStatus(res.message);
      await ops.refresh();
    } finally {
      reindexBtn.disabled = false;
    }
  });
  vaultHead.append(vaultTitle, reindexBtn);
  vaultCard.append(vaultHead);

  if (snapshot.vaultRoots.length === 0) {
    vaultCard.append(el("div", "muted", "No Vault RAG directories approved yet."));
  } else {
    for (const root of snapshot.vaultRoots) {
      const row = el("div", "list-row row-between");
      const info = el("div");
      info.append(
        el("div", "mono", root.path),
        el(
          "div",
          "muted",
          root.valid
            ? `${root.filesIndexed} file(s) · ${root.totalChunks} chunk(s) · ${root.skippedUnsafe} blocked unsafe path(s)`
            : root.error ?? "Invalid vault directory",
        ),
      );
      const right = el("div", "btn-row");
      right.append(el("span", `badge ${root.valid ? "ok" : "critical"}`, root.valid ? "Approved" : "Blocked"));
      const removeBtn = el("button", "btn-danger", "Revoke");
      removeBtn.type = "button";
      removeBtn.addEventListener("click", async () => {
        const res = await ops.wave2.removeVaultRoot(root.path);
        ops.setStatus(res.message);
        await ops.refresh();
      });
      right.append(removeBtn);
      row.append(info, right);
      vaultCard.append(row);
    }
  }

  const vaultForm = el("div", "toolbar");
  const vaultInput = document.createElement("input");
  vaultInput.type = "text";
  vaultInput.placeholder = "/home/user/Documents/ObsidianVault";
  vaultInput.setAttribute("aria-label", "Vault directory path");
  const addVaultBtn = el("button", "btn-primary", "Approve Folder");
  addVaultBtn.type = "button";
  addVaultBtn.dataset.action = "wave2-vault-add";
  addVaultBtn.addEventListener("click", async () => {
    const res = await ops.wave2.addVaultRoot(vaultInput.value);
    ops.setStatus(res.message);
    if (res.ok) vaultInput.value = "";
    await ops.refresh();
  });
  vaultForm.append(vaultInput, addVaultBtn);
  vaultCard.append(vaultForm);

  // 2. Encrypted LAN PeerStateSyncEngine Nodes
  const syncCard = el("div", "card stack");
  const syncHead = el("div", "card-header");
  const syncTitle = el("div");
  syncTitle.append(
    el("h2", undefined, "Encrypted LAN PeerStateSyncEngine Nodes"),
    el(
      "p",
      "muted",
      `Local Node: ${snapshot.localNode.nodeId} · Key fp ${snapshot.localNode.publicKeyFingerprint} · ${snapshot.localNode.recordCount} CRDT record(s)`,
    ),
  );
  syncHead.append(syncTitle);
  syncCard.append(syncHead);

  const protectionsRow = el("div", "btn-row");
  for (const p of snapshot.localNode.protections) {
    protectionsRow.append(el("span", "badge ok", p));
  }
  syncCard.append(protectionsRow);

  if (snapshot.lanPeers.length === 0) {
    syncCard.append(el("div", "muted", "No LAN peers paired yet."));
  } else {
    for (const peer of snapshot.lanPeers) {
      const row = el("div", "list-row row-between");
      const info = el("div");
      info.append(
        el("strong", undefined, `${peer.label} (${peer.id})`),
        el("div", "mono muted", `${peer.endpoint} · Ed25519 fp ${peer.fingerprint}`),
      );
      const btns = el("div", "btn-row");
      btns.append(
        el("span", `badge ${peer.lanAllowed ? "ok" : "critical"}`, peer.lanAllowed ? "Private LAN" : "Blocked"),
      );
      const probeBtn = el("button", undefined, "Sync Probe");
      probeBtn.type = "button";
      probeBtn.addEventListener("click", async () => {
        const res = await ops.wave2.probeLanPeer(peer.id);
        ops.setStatus(res.message);
        await ops.refresh();
      });
      const unpairBtn = el("button", "btn-danger", "Unpair");
      unpairBtn.type = "button";
      unpairBtn.addEventListener("click", async () => {
        const res = await ops.wave2.removeLanPeer(peer.id);
        ops.setStatus(res.message);
        await ops.refresh();
      });
      btns.append(probeBtn, unpairBtn);
      row.append(info, btns);
      syncCard.append(row);
    }
  }

  const peerGrid = el("div", "stack");
  const peerRow1 = el("div", "toolbar");
  const peerIdInput = document.createElement("input");
  peerIdInput.type = "text";
  peerIdInput.placeholder = "Peer ID (e.g. proxmox-win11)";
  const peerLabelInput = document.createElement("input");
  peerLabelInput.type = "text";
  peerLabelInput.placeholder = "Label (e.g. Studio Workstation)";
  const peerEndpointInput = document.createElement("input");
  peerEndpointInput.type = "text";
  peerEndpointInput.placeholder = "http://192.168.50.2:48025";
  peerRow1.append(peerIdInput, peerLabelInput, peerEndpointInput);

  const peerPemInput = document.createElement("textarea");
  peerPemInput.rows = 3;
  peerPemInput.placeholder = "-----BEGIN PUBLIC KEY----- (Ed25519 SPKI PEM)";
  const pairBtn = el("button", "btn-primary", "Pair LAN Peer");
  pairBtn.type = "button";
  pairBtn.dataset.action = "wave2-peer-pair";
  pairBtn.addEventListener("click", async () => {
    const res = await ops.wave2.pairLanPeer({
      id: peerIdInput.value,
      label: peerLabelInput.value,
      endpoint: peerEndpointInput.value,
      publicKeyPem: peerPemInput.value,
    });
    ops.setStatus(res.message);
    if (res.ok) {
      peerIdInput.value = "";
      peerLabelInput.value = "";
      peerEndpointInput.value = "";
      peerPemInput.value = "";
    }
    await ops.refresh();
  });
  peerGrid.append(peerRow1, peerPemInput, pairBtn);
  syncCard.append(peerGrid);

  // 3. Opt-In Signed Plugins & Permission Scopes
  const pluginsCard = el("div", "card stack");
  const pluginsHead = el("div", "card-header");
  const pluginsTitle = el("div");
  pluginsTitle.append(
    el("h2", undefined, "Opt-In Plugins & Declared Permission Scopes"),
    el(
      "p",
      "muted",
      "Every Wave 2 plugin ships defaultEnabled=false. Inspect declared scopes and readOnly vs confirmation-gated tools before enabling.",
    ),
  );
  pluginsHead.append(pluginsTitle);
  pluginsCard.append(pluginsHead);

  for (const plugin of snapshot.plugins) {
    const item = el("div", "option-card stack");
    const top = el("div", "row-between");
    const left = el("div");
    left.append(
      el("strong", undefined, `${plugin.name} (${plugin.id} v${plugin.version})`),
      el("div", "muted", plugin.description),
    );
    const controls = el("div", "btn-row");
    controls.append(
      el("span", `badge ${plugin.enabled ? "ok" : "warn"}`, plugin.enabled ? "Enabled (Opt-In)" : "Disabled (Default Off)"),
    );
    const toggleBtn = el("button", plugin.enabled ? "btn-danger" : "btn-ok", plugin.enabled ? "Disable" : "Enable");
    toggleBtn.type = "button";
    toggleBtn.dataset.pluginId = plugin.id;
    toggleBtn.addEventListener("click", async () => {
      const res = await ops.wave2.togglePlugin(plugin.id, !plugin.enabled);
      ops.setStatus(res.message);
      await ops.refresh();
    });
    controls.append(toggleBtn);
    top.append(left, controls);

    const scopes = el("div", "btn-row");
    for (const scope of plugin.permissions) {
      scopes.append(el("span", "badge pinned", `scope: ${scope}`));
    }
    item.append(top, scopes);

    if (plugin.tools.length > 0) {
      const toolsList = el("div", "stack");
      for (const tool of plugin.tools) {
        toolsList.append(
          el(
            "div",
            "mono muted",
            `• ${tool.name} [${tool.readOnly ? "read-only" : "confirm-gated"} · scope=${tool.requiredScope}${tool.endpointHost ? ` · host=${tool.endpointHost}` : ""}] — ${tool.description}`,
          ),
        );
      }
      item.append(toolsList);
    }
    pluginsCard.append(item);
  }

  wrap.append(vaultCard, syncCard, pluginsCard);
  container.replaceChildren(wrap);
}
