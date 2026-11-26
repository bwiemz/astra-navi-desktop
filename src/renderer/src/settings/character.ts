import type { SettingsPatch, SettingsView } from "../../../shared/settings.ts";
import { bridge, element, stamp } from "./dom.ts";

function stripIpcError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || fallback;
}

function parseTraits(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function describeCharacterSource(view: SettingsView["character"]): { label: string; tone: "ok" | "off" } {
  const display = view.displayName.trim() || "Astra Navi";
  if (view.source === "bundle") {
    const bundleLabel = view.sourceName ? `Bundle: ${view.sourceName}` : "Character bundle";
    return { label: `${display} · ${bundleLabel}`, tone: "ok" };
  }
  if (view.source === "card") {
    const cardLabel = view.sourceName ? `Card: ${view.sourceName}` : "Imported card";
    return { label: `${display} · ${cardLabel}`, tone: "ok" };
  }
  if (view.source === "custom") {
    return { label: `${display} · Custom`, tone: "ok" };
  }
  return { label: "Built-in Astra Navi", tone: "off" };
}

export function showCharacterAndVision(view: SettingsView): void {
  const char = view.character;
  const sourceBadge = element("char-source");
  const sourceInfo = describeCharacterSource(char);
  sourceBadge.textContent = sourceInfo.label;
  sourceBadge.className =
    sourceInfo.tone === "ok" ? "mcp-badge mcp-badge-ok" : "mcp-badge mcp-badge-off";

  const userAddress = element<HTMLInputElement>("char-userAddress");
  if (document.activeElement !== userAddress) userAddress.value = char.userAddress;

  const displayName = element<HTMLInputElement>("char-displayName");
  if (document.activeElement !== displayName) displayName.value = char.displayName;

  element<HTMLInputElement>("char-thirdPerson").checked = char.speakInThirdPerson;

  const greetingStyle = element<HTMLInputElement>("char-greetingStyle");
  if (document.activeElement !== greetingStyle) greetingStyle.value = char.greetingStyle;

  const traits = element<HTMLTextAreaElement>("char-traits");
  if (document.activeElement !== traits) traits.value = char.traits.join(", ");

  const bio = element<HTMLTextAreaElement>("char-bio");
  if (document.activeElement !== bio) bio.value = char.bio;

  // Native vision sidecar section (inside #sec-senses)
  const vision = view.vision;
  element<HTMLInputElement>("nativeVision").checked = vision.nativeVision;

  const serverPath = element<HTMLInputElement>("llamaServerPath");
  if (document.activeElement !== serverPath) serverPath.value = vision.llamaServerPath;

  const endpoint = element<HTMLInputElement>("visionEndpoint");
  if (document.activeElement !== endpoint) endpoint.value = vision.visionEndpoint;

  const badge = element("vision-badge");
  if (!vision.nativeVision) {
    badge.textContent = "Disabled (Florence-2 fallback)";
    badge.className = "mcp-badge mcp-badge-off";
  } else if (vision.available) {
    badge.textContent =
      vision.mode === "loopback-endpoint"
        ? "Ready · Loopback endpoint"
        : "Ready · Managed llama-server";
    badge.className = "mcp-badge mcp-badge-ok";
  } else {
    badge.textContent = "Fallback · Florence-2 + OCR";
    badge.className = "mcp-badge mcp-badge-off";
  }

  element("vision-status").textContent = vision.reason;

  const dlBtn = element<HTMLButtonElement>("vision-download-mmproj");
  const wantsUpgrade =
    vision.nativeVision &&
    vision.upgradeAvailable === true &&
    vision.upgradeLabel !== null &&
    vision.upgradeLabel !== undefined &&
    vision.mode !== "loopback-endpoint";
  const canDownloadMmproj =
    vision.nativeVision &&
    vision.mode !== "loopback-endpoint" &&
    (wantsUpgrade || (!vision.mmprojReady && vision.mmprojFileName !== null));
  dlBtn.hidden = !canDownloadMmproj;
  if (wantsUpgrade && vision.upgradeLabel) {
    const sizeText =
      vision.upgradeBytes !== null && vision.upgradeBytes !== undefined
        ? ` (${formatMiB(vision.upgradeBytes)})`
        : "";
    dlBtn.textContent = `Switch to ${vision.upgradeLabel}${sizeText}`;
  } else if (canDownloadMmproj && vision.mmprojFileName) {
    const sizeText =
      vision.mmprojSizeBytes !== null ? ` (${formatMiB(vision.mmprojSizeBytes)})` : "";
    dlBtn.textContent = `Download ${vision.mmprojFileName}${sizeText}`;
  }
}

export function wireCharacterAndVision(
  onView: (fresh: SettingsView) => void,
  save: (patch: SettingsPatch) => Promise<void>,
): void {
  const charStatus = element("char-status");
  const saveCharacterField = (
    partial: NonNullable<SettingsPatch["character"]>,
  ): void => {
    charStatus.textContent = "";
    void save({ character: partial });
  };

  element<HTMLInputElement>("char-userAddress").addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    saveCharacterField({ userAddress: input.value.trim() });
  });
  element<HTMLInputElement>("char-displayName").addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    saveCharacterField({ displayName: input.value.trim() });
  });
  element<HTMLInputElement>("char-thirdPerson").addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    saveCharacterField({ speakInThirdPerson: input.checked });
  });
  element<HTMLInputElement>("char-greetingStyle").addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    saveCharacterField({ greetingStyle: input.value.trim() });
  });
  element<HTMLTextAreaElement>("char-traits").addEventListener("change", (event) => {
    const input = event.target as HTMLTextAreaElement;
    saveCharacterField({ traits: parseTraits(input.value) });
  });
  element<HTMLTextAreaElement>("char-bio").addEventListener("change", (event) => {
    const input = event.target as HTMLTextAreaElement;
    saveCharacterField({ bio: input.value.trim() });
  });

  const importBtn = element<HTMLButtonElement>("char-import-card");
  importBtn.addEventListener("click", () => {
    importBtn.disabled = true;
    charStatus.textContent = "Choose a Persona Card (.json or .png)…";
    void bridge
      .importPersonaCard()
      .then((res) => {
        if (res.ok) {
          onView(res.view);
          charStatus.textContent = `Imported persona card "${res.name}".`;
          stamp("Persona imported");
        } else if (res.canceled) {
          charStatus.textContent = "";
        } else {
          charStatus.textContent = res.error ?? "Could not import persona card.";
          stamp("Persona import failed", true);
        }
      })
      .catch((error: unknown) => {
        charStatus.textContent = stripIpcError(error, "Could not import persona card.");
        stamp("Persona import failed", true);
      })
      .finally(() => {
        importBtn.disabled = false;
      });
  });

  const bundleBtn = element<HTMLButtonElement>("char-load-bundle");
  bundleBtn.addEventListener("click", () => {
    bundleBtn.disabled = true;
    charStatus.textContent = "Choose an Astra Character Bundle (.bundle)…";
    void bridge
      .loadCharacterBundle()
      .then((res) => {
        if (res.ok) {
          onView(res.view);
          charStatus.textContent = `Loaded character bundle "${res.name}" (avatar, persona, and voice bound).`;
          stamp("Character bundle loaded");
        } else if (res.canceled) {
          charStatus.textContent = "";
        } else {
          charStatus.textContent = res.error ?? "Could not load character bundle.";
          stamp("Bundle load failed", true);
        }
      })
      .catch((error: unknown) => {
        charStatus.textContent = stripIpcError(error, "Could not load character bundle.");
        stamp("Bundle load failed", true);
      })
      .finally(() => {
        bundleBtn.disabled = false;
      });
  });

  const resetBtn = element<HTMLButtonElement>("char-reset");
  resetBtn.addEventListener("click", () => {
    resetBtn.disabled = true;
    void bridge
      .resetCharacter()
      .then((fresh) => {
        onView(fresh);
        charStatus.textContent = "Reset to built-in Astra Navi defaults.";
        stamp("Character reset");
      })
      .catch((error: unknown) => {
        charStatus.textContent = stripIpcError(error, "Could not reset character.");
        stamp("Reset failed", true);
      })
      .finally(() => {
        resetBtn.disabled = false;
      });
  });

  // Native vision controls
  element<HTMLInputElement>("nativeVision").addEventListener("change", (event) => {
    void save({ nativeVision: (event.target as HTMLInputElement).checked });
  });
  element<HTMLInputElement>("llamaServerPath").addEventListener("change", (event) => {
    void save({ llamaServerPath: (event.target as HTMLInputElement).value.trim() });
  });
  element<HTMLInputElement>("visionEndpoint").addEventListener("change", (event) => {
    void save({ visionEndpoint: (event.target as HTMLInputElement).value.trim() });
  });

  const dlMmprojBtn = element<HTMLButtonElement>("vision-download-mmproj");
  dlMmprojBtn.addEventListener("click", () => {
    dlMmprojBtn.disabled = true;
    element("vision-status").textContent = "Downloading vision projector (mmproj)…";
    void bridge
      .downloadVisionMmproj()
      .then((res) => {
        onView(res.view);
        if (res.ok) {
          stamp("Vision projector ready");
        } else {
          element("vision-status").textContent = res.error;
          stamp("Download failed", true);
        }
      })
      .catch((error: unknown) => {
        element("vision-status").textContent = stripIpcError(error, "Could not download vision projector.");
        stamp("Download failed", true);
      })
      .finally(() => {
        dlMmprojBtn.disabled = false;
      });
  });
}
