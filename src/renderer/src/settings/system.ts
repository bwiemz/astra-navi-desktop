import type { SettingsPatch, SettingsView } from "../../../shared/settings.ts";
import { bridge, element, stamp } from "./dom.ts";

export function showSystem(view: SettingsView): void {
  const safe = view.safeModeNotice;
  const banner = element("safe-mode-banner");
  banner.hidden = !(safe?.active);
  element("safe-mode-reason").textContent =
    safe?.reason ??
    "Safe Mode active: optional background hooks are paused until you resume them.";

  element<HTMLSelectElement>("windowMode").value = view.windowMode;

  const ptt = element<HTMLInputElement>("hotkey-ptt");
  if (document.activeElement !== ptt) ptt.value = view.hotkeys.pushToTalk;
  const summon = element<HTMLInputElement>("hotkey-summon");
  if (document.activeElement !== summon) summon.value = view.hotkeys.summonHide;
  const click = element<HTMLInputElement>("hotkey-click");
  if (document.activeElement !== click) click.value = view.hotkeys.clickThrough;

  const updateBtn = element<HTMLButtonElement>("check-updates");
  const updateStatus = element("update-status");
  if (view.updatePolicy && !view.updatePolicy.standaloneChecksEnabled) {
    updateBtn.disabled = true;
    updateStatus.textContent = `Updates are managed automatically (${view.updatePolicy.channel === "standalone" ? "store edition" : view.updatePolicy.channel}).`;
  } else {
    updateBtn.disabled = false;
  }
}

export function wireSystem(
  onView: (fresh: SettingsView) => void,
  savePatch: (patch: SettingsPatch) => Promise<void>,
): void {
  element<HTMLButtonElement>("clear-safe-mode").addEventListener("click", () => {
    const btn = element<HTMLButtonElement>("clear-safe-mode");
    btn.disabled = true;
    void bridge
      .clearSafeMode()
      .then((fresh) => {
        onView(fresh);
        stamp("Safe mode cleared");
      })
      .catch(() => stamp("Could not clear safe mode.", true))
      .finally(() => {
        btn.disabled = false;
      });
  });

  element<HTMLSelectElement>("windowMode").addEventListener("change", (event) => {
    void savePatch({
      windowMode: (event.currentTarget as HTMLSelectElement).value as SettingsView["windowMode"],
    });
  });

  element<HTMLButtonElement>("hotkey-save").addEventListener("click", () => {
    const status = element("hotkey-status");
    const pushToTalk = element<HTMLInputElement>("hotkey-ptt").value.trim();
    const summonHide = element<HTMLInputElement>("hotkey-summon").value.trim();
    const clickThrough = element<HTMLInputElement>("hotkey-click").value.trim();
    status.textContent = "Applying shortcuts…";
    void savePatch({ hotkeys: { pushToTalk, summonHide, clickThrough } }).then(() => {
      status.textContent =
        pushToTalk || summonHide || clickThrough
          ? "Active."
          : "All global hotkeys cleared.";
    });
  });

  const checkUpdatesBtn = element<HTMLButtonElement>("check-updates");
  const updateStatus = element("update-status");
  checkUpdatesBtn.addEventListener("click", () => {
    checkUpdatesBtn.disabled = true;
    updateStatus.textContent = "Checking GitHub Releases…";
    void bridge
      .checkUpdates()
      .then((res) => {
        if (res.status === "update-available") {
          updateStatus.textContent = `Update available: v${res.latestVersion} — ${res.releaseUrl ?? ""}`;
        } else if (res.status === "up-to-date") {
          updateStatus.textContent = `Up to date (v${res.currentVersion}).`;
        } else {
          updateStatus.textContent = res.reason ?? "Could not check updates.";
        }
      })
      .catch((error: unknown) => {
        updateStatus.textContent = error instanceof Error ? error.message : "Update check failed.";
      })
      .finally(() => {
        checkUpdatesBtn.disabled = false;
      });
  });

  const exportProfileBtn = element<HTMLButtonElement>("export-profile");
  const importProfileBtn = element<HTMLButtonElement>("import-profile");
  const profileStatus = element("profile-status");
  exportProfileBtn.addEventListener("click", () => {
    exportProfileBtn.disabled = true;
    profileStatus.textContent = "Choosing archive destination…";
    void bridge
      .exportProfileBackup()
      .then((res) => {
        if (res.ok) {
          profileStatus.textContent = `Exported ${res.summary.files.length} files (${res.summary.totalBytes} B, SHA-256 verified): ${res.path}`;
          stamp("Exported profile");
        } else if (!res.canceled) {
          profileStatus.textContent = `Export failed: ${res.error ?? "Unknown error"}`;
        } else {
          profileStatus.textContent = "Export canceled.";
        }
      })
      .finally(() => {
        exportProfileBtn.disabled = false;
      });
  });

  importProfileBtn.addEventListener("click", () => {
    importProfileBtn.disabled = true;
    profileStatus.textContent = "Selecting profile archive…";
    void bridge
      .importProfileBackup()
      .then((res) => {
        if (res.ok) {
          profileStatus.textContent = `Restored ${res.result.restoredFiles.length} files. Restarting…`;
        } else if (!res.canceled) {
          profileStatus.textContent = `Restore failed: ${res.error ?? "Unknown error"}`;
        } else {
          profileStatus.textContent = "Restore canceled.";
        }
      })
      .finally(() => {
        importProfileBtn.disabled = false;
      });
  });

  const exportBundleBtn = element<HTMLButtonElement>("export-support-bundle");
  const supportBundleStatus = element("support-bundle-status");
  exportBundleBtn.addEventListener("click", () => {
    exportBundleBtn.disabled = true;
    supportBundleStatus.textContent = "Building redacted diagnostics bundle…";
    void bridge
      .exportSupportBundle()
      .then((result) => {
        supportBundleStatus.textContent = `Saved redacted bundle (${result.bytes} B, ${result.redactions} secrets/paths scrubbed): ${result.path}`;
      })
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        supportBundleStatus.textContent = `Could not export support bundle: ${msg}`;
      })
      .finally(() => {
        exportBundleBtn.disabled = false;
      });
  });
}
