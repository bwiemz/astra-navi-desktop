import type {
  ModelDownloadStatusView,
  SettingsPatch,
  SettingsView,
} from "../../../shared/settings.ts";
import { bridge, element, fill } from "./dom.ts";

const BUNDLED_VOICE_NAMES: readonly string[] = ["aria", "bright", "perky"];

let latestView: SettingsView | null = null;
let wizardStep = 1;
let wizardOpenedOnce = false;
let wizardDismissed = false;
let activePreviewAudio: HTMLAudioElement | null = null;
let latestDownloadStatus: ModelDownloadStatusView | null = null;

function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "estimating…";
  if (seconds < 60) return `${seconds}s left`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins < 60 ? `${mins}m ${secs}s left` : `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}

export function refreshDiskSpaceWizard(): void {
  const diskEl = element("wiz-disk-status");
  const tier = element<HTMLSelectElement>("wiz-brain-select").value || "auto";
  diskEl.textContent = "Checking free disk space…";
  void bridge
    .checkDiskSpace(tier)
    .then((info) => {
      if (info.alreadyDownloaded) {
        diskEl.textContent = `Model "${info.label}" is already downloaded on disk (${formatGb(info.availableBytes)} free).`;
        diskEl.classList.remove("disk-warn");
      } else if (info.enough) {
        diskEl.textContent = `Disk space: ${formatGb(info.availableBytes)} free (need ${formatGb(info.requiredBytes)} including headroom — OK).`;
        diskEl.classList.remove("disk-warn");
      } else {
        diskEl.textContent = `Low disk space: ${formatGb(info.availableBytes)} free, need ${formatGb(info.requiredBytes)} for "${info.label}".`;
        diskEl.classList.add("disk-warn");
      }
    })
    .catch(() => {
      diskEl.textContent = "";
    });
}

export function renderDownloadProgress(status: ModelDownloadStatusView): void {
  latestDownloadStatus = status;
  const box = element("wiz-download-box");
  const banner = element("download-banner");
  const active =
    status.state === "downloading" ||
    status.state === "paused" ||
    status.state === "verifying" ||
    status.state === "error";
  box.hidden = status.state === "idle";
  banner.hidden = !active;

  if (status.state === "idle") return;

  const pct =
    status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0;
  const mbps = (status.bytesPerSec / 1e6).toFixed(1);
  const eta = formatEta(status.etaSeconds);
  const diskPart =
    status.freeDiskBytes !== null ? ` · ${formatGb(status.freeDiskBytes)} disk free` : "";
  const statsLine =
    status.state === "ready"
      ? `Ready on disk (${formatGb(status.total)}).`
      : status.state === "verifying"
        ? "Verifying SHA-256 checksum…"
        : status.state === "paused"
          ? `Paused at ${pct}% (${formatGb(status.received)} / ${formatGb(status.total)})${diskPart}`
          : status.state === "error"
            ? `Download interrupted: ${status.error ?? "unknown error"}`
            : `${pct}% · ${formatGb(status.received)} / ${formatGb(status.total)} · ${mbps} MB/s · ${eta}${diskPart}`;

  element("wiz-dl-label").textContent = status.label || "Local AI Brain";
  element<HTMLProgressElement>("wiz-dl-bar").value = pct;
  element("wiz-dl-stats").textContent = statsLine;
  const wizToggle = element<HTMLButtonElement>("wiz-dl-toggle");
  wizToggle.hidden = status.state === "ready" || status.state === "verifying";
  wizToggle.textContent = status.state === "paused" || status.state === "error" ? "Resume" : "Pause";

  element("banner-dl-title").textContent =
    status.state === "paused"
      ? `Paused: ${status.label}`
      : status.state === "error"
        ? `Download stalled: ${status.label}`
        : `Downloading ${status.label}…`;
  element<HTMLProgressElement>("banner-dl-bar").value = pct;
  element("banner-dl-stats").textContent = statsLine;
  const bannerToggle = element<HTMLButtonElement>("banner-dl-toggle");
  bannerToggle.hidden = status.state === "verifying";
  bannerToggle.textContent =
    status.state === "paused" || status.state === "error" ? "Resume" : "Pause";
}

export function renderBootstrapList(status: SettingsView["bootstrapStatus"]): void {
  const container = element<HTMLDivElement>("wiz-bootstrap-list");
  const rows: {
    task: "ocr" | "launcher" | "browser-bridge" | "voice";
    label: string;
    ready?: boolean;
    detail?: string;
  }[] = [
    { task: "ocr", label: "Fast ONNX OCR", ready: status?.ocr.ready, detail: status?.ocr.detail },
    {
      task: "launcher",
      label: "Desktop App Menu Shortcut",
      ready: status?.launcher.ready,
      detail: status?.launcher.detail,
    },
    {
      task: "browser-bridge",
      label: "Browser DOM Native Host",
      ready: status?.browserBridge.ready,
      detail: status?.browserBridge.detail,
    },
    {
      task: "voice",
      label: "Full Qwen-TTS Python Env",
      ready: status?.voice.ready,
      detail: status?.voice.detail,
    },
  ];
  container.replaceChildren(
    ...rows.map((entry) => {
      const wrap = document.createElement("div");
      wrap.className = "wiz-service-row";
      const left = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = entry.label;
      const desc = document.createElement("div");
      desc.className = "why";
      desc.textContent =
        entry.detail ?? (entry.ready ? "Ready" : "Optional — click Setup to install");
      left.append(title, desc);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = entry.ready ? "Re-run" : "Setup";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        element("wiz-bootstrap-note").textContent = `Setting up ${entry.label}…`;
        void bridge
          .runBootstrap(entry.task)
          .then((res) => {
            if (latestView) latestView = { ...latestView, bootstrapStatus: res.status };
            element("wiz-bootstrap-note").textContent = res.summary.join(" ") || "Done.";
            renderBootstrapList(res.status);
          })
          .catch((error: unknown) => {
            const raw = error instanceof Error ? error.message : "Setup failed.";
            element("wiz-bootstrap-note").textContent = raw.replace(
              /^Error invoking remote method '[^']+': (?:Error: )?/,
              "",
            );
          })
          .finally(() => {
            btn.disabled = false;
          });
      });
      wrap.append(left, btn);
      return wrap;
    }),
  );
}

export function refreshHardwareWizard(): void {
  const summary = element("wiz-hw-summary");
  const reason = element("wiz-hw-reason");
  summary.textContent = "Probing GPU VRAM, memory bandwidth, and system RAM…";
  reason.textContent = "";
  void bridge
    .hardwareProfile()
    .then((hw) => {
      const gpuLabel = hw.gpuName
        ? `${hw.gpuName} (${hw.freeVramGb}/${hw.totalVramGb} GB VRAM free)`
        : "CPU mode (no discrete NVIDIA GPU)";
      const bwLabel = hw.memoryBandwidthGbps !== null ? `, ${hw.memoryBandwidthGbps} GB/s` : "";
      summary.textContent = `Detected: ${gpuLabel}, ${hw.systemRamGb} GB RAM, ${hw.cpuThreads} threads${bwLabel}.`;
      reason.textContent = hw.reason;
      const tierSelect = element<HTMLSelectElement>("wiz-brain-select");
      if ([...tierSelect.options].some((opt) => opt.value === hw.recommendedTier)) {
        tierSelect.value = hw.recommendedTier;
      }
      refreshDiskSpaceWizard();
    })
    .catch(() => {
      summary.textContent = "Could not probe GPU; you can still select a brain tier below.";
      refreshDiskSpaceWizard();
    });
}

export function refreshPolicyAuditWizard(): void {
  const badge = element("wiz-audit-badge");
  const list = element("wiz-audit-findings");
  badge.className = "audit-badge";
  badge.textContent = "Checking…";
  list.replaceChildren();
  void bridge
    .runPolicyAudit()
    .then((audit) => {
      badge.className = `audit-badge ${audit.ok ? "pass" : "fail"}`;
      badge.textContent = audit.ok
        ? `PASS (0 critical, ${audit.counts.warning} warnings)`
        : `REVIEW (${audit.counts.critical} critical, ${audit.counts.warning} warnings)`;
      if (audit.findings.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No security conflicts or risky rules detected.";
        list.append(li);
      } else {
        for (const f of audit.findings.slice(0, 5)) {
          const li = document.createElement("li");
          li.textContent = `[${f.severity}] ${f.message}`;
          list.append(li);
        }
      }
    })
    .catch(() => {
      badge.className = "audit-badge fail";
      badge.textContent = "Could not run policy audit.";
    });
}

export function showWizardStep(step: number): void {
  wizardStep = Math.max(1, Math.min(4, step));
  element("wiz-step-indicator").textContent = `Step ${wizardStep} of 4`;
  for (let i = 1; i <= 4; i += 1) {
    element(`wiz-step-${i}`).hidden = i !== wizardStep;
  }
  element<HTMLButtonElement>("wiz-prev").disabled = wizardStep === 1;
  element<HTMLButtonElement>("wiz-next").hidden = wizardStep === 4;
  element<HTMLButtonElement>("wiz-finish").hidden = wizardStep !== 4;
  if (wizardStep === 1) refreshHardwareWizard();
  if (wizardStep === 3) renderBootstrapList(latestView?.bootstrapStatus);
  if (wizardStep === 4) refreshPolicyAuditWizard();
}

export function openWizard(step = 1): void {
  wizardOpenedOnce = true;
  element("onboarding-wizard").hidden = false;
  showWizardStep(step);
}

export function showOnboarding(view: SettingsView): void {
  latestView = view;
  fill(
    element<HTMLSelectElement>("wiz-brain-select"),
    [
      { value: "auto", label: "Auto (hardware recommended)" },
      ...view.brains.map((b) => ({ value: b.id, label: b.label })),
    ],
    view.brain,
  );
  fill(
    element<HTMLSelectElement>("wiz-language"),
    view.languages.map((language) => ({ value: language.code, label: language.label })),
    view.language,
  );
  const voiceList = view.voices.length > 0 ? view.voices : [...BUNDLED_VOICE_NAMES];
  fill(
    element<HTMLSelectElement>("wiz-voice"),
    voiceList.map((name) => ({
      value: name,
      label: `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`,
    })),
    voiceList.includes(view.voiceDesign) ? view.voiceDesign : (voiceList[0] ?? "aria"),
  );
  element<HTMLInputElement>("wiz-always-listening").checked = view.alwaysListening;
  if (!view.onboardingComplete && !wizardOpenedOnce && !wizardDismissed) {
    openWizard(1);
  }
}

export function wireOnboarding(
  onView: (view: SettingsView) => void,
  savePatch: (patch: SettingsPatch) => Promise<void>,
): void {
  element<HTMLButtonElement>("open-wizard").addEventListener("click", () => {
    wizardDismissed = false;
    openWizard(1);
  });
  element<HTMLButtonElement>("wiz-skip").addEventListener("click", () => {
    wizardDismissed = true;
    element("onboarding-wizard").hidden = true;
  });
  element<HTMLButtonElement>("wiz-minimize").addEventListener("click", () => {
    wizardDismissed = true;
    element("onboarding-wizard").hidden = true;
  });
  element<HTMLButtonElement>("wiz-prev").addEventListener("click", () =>
    showWizardStep(wizardStep - 1),
  );
  element<HTMLButtonElement>("wiz-next").addEventListener("click", () =>
    showWizardStep(wizardStep + 1),
  );
  element<HTMLButtonElement>("wiz-hw-refresh").addEventListener("click", () =>
    refreshHardwareWizard(),
  );
  element<HTMLSelectElement>("wiz-brain-select").addEventListener("change", () => {
    refreshDiskSpaceWizard();
  });
  element<HTMLButtonElement>("wiz-use-recommended").addEventListener("click", () => {
    const tier = element<HTMLSelectElement>("wiz-brain-select").value;
    void bridge.downloadBrain(tier).then((view) => {
      onView(view);
      element("wiz-hw-reason").textContent =
        `Downloading "${tier}" in the background — feel free to preview the avatar, test voices, or browse Settings while it finishes.`;
      void bridge.downloadStatus().then(renderDownloadProgress);
    });
  });
  const toggleDownload = (): void => {
    const action =
      latestDownloadStatus?.state === "paused" || latestDownloadStatus?.state === "error"
        ? bridge.resumeBrainDownload()
        : bridge.pauseBrainDownload();
    void action.then(renderDownloadProgress);
  };
  element<HTMLButtonElement>("wiz-dl-toggle").addEventListener("click", toggleDownload);
  element<HTMLButtonElement>("banner-dl-toggle").addEventListener("click", toggleDownload);
  element<HTMLButtonElement>("wiz-preview-avatar").addEventListener("click", () =>
    bridge.previewAvatarWindow(),
  );
  element<HTMLButtonElement>("banner-dl-preview").addEventListener("click", () =>
    bridge.previewAvatarWindow(),
  );
  element<HTMLButtonElement>("wiz-import-avatar").addEventListener("click", () =>
    bridge.importAvatarModel(),
  );
  bridge.onDownloadProgress(renderDownloadProgress);
  void bridge.downloadStatus().then(renderDownloadProgress);
  element<HTMLSelectElement>("wiz-language").addEventListener("change", (event) => {
    void savePatch({
      language: (event.currentTarget as HTMLSelectElement).value as SettingsView["language"],
    });
  });
  element<HTMLInputElement>("wiz-always-listening").addEventListener("change", (event) => {
    void savePatch({ alwaysListening: (event.currentTarget as HTMLInputElement).checked });
  });
  element<HTMLButtonElement>("wiz-voice-preview").addEventListener("click", () => {
    const voice = element<HTMLSelectElement>("wiz-voice").value;
    const note = element("wiz-voice-status");
    note.textContent = `Loading "${voice}" sample…`;
    void bridge
      .previewVoice(voice)
      .then((dataUri) => {
        if (!dataUri) {
          note.textContent = "Preview file unavailable.";
          return;
        }
        if (activePreviewAudio) activePreviewAudio.pause();
        activePreviewAudio = new Audio(dataUri);
        void activePreviewAudio.play();
        note.textContent = `Playing "${voice}".`;
        if (latestView?.designedVoicesReady) {
          void savePatch({ voice: { engine: "full", design: voice } });
        }
      })
      .catch(() => {
        note.textContent = "Could not play voice preview.";
      });
  });
  element<HTMLButtonElement>("wiz-audit-rerun").addEventListener("click", () =>
    refreshPolicyAuditWizard(),
  );
  element<HTMLButtonElement>("wiz-finish").addEventListener("click", () => {
    void savePatch({ onboardingComplete: true }).then(() => {
      element("onboarding-wizard").hidden = true;
    });
  });
}
