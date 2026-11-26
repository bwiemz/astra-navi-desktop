import {
  OPENAI_SERVER_PRESETS,
  type InferenceProvider,
  type OpenAiServerPreset,
} from "../../../core/openaiBackend.ts";
import type { SettingsPatch, SettingsView } from "../../../shared/settings.ts";
import { bridge, element, stamp } from "./dom.ts";

function stripIpcError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || fallback;
}

export function showInferenceBackend(view: SettingsView): void {
  const inf = view.inference;
  const providerEl = element<HTMLSelectElement>("inf-provider");
  providerEl.value = inf.provider;

  const isRemoteProvider = inf.provider === "openai-compatible";
  element("inf-remote-group").hidden = !isRemoteProvider;
  element("local-brain-row").hidden = isRemoteProvider;

  element<HTMLSelectElement>("inf-preset").value = inf.preset;

  const urlInput = element<HTMLInputElement>("inf-baseUrl");
  if (document.activeElement !== urlInput) urlInput.value = inf.baseUrl;

  const modelInput = element<HTMLInputElement>("inf-model");
  if (document.activeElement !== modelInput) modelInput.value = inf.model;
  modelInput.placeholder = OPENAI_SERVER_PRESETS[inf.preset].placeholderModel;

  const keyInput = element<HTMLInputElement>("inf-apiKey");
  if (document.activeElement !== keyInput) keyInput.value = "";
  keyInput.placeholder = inf.hasApiKey
    ? "An API key is saved. Type a new one to replace, or clear + Enter to remove."
    : "Optional Bearer token (leave blank for local Ollama / LM Studio)";
  element("inf-apiKey-note").textContent = inf.hasApiKey
    ? "Key is stored locally and never echoed back. Clear the field and press Enter to remove."
    : "";

  const badge = element("inf-locality-badge");
  const note = element("inf-locality-note");
  if (!isRemoteProvider) {
    badge.textContent = "100% Local on this PC";
    badge.className = "mcp-badge mcp-badge-ok";
    note.textContent = "Built-in local GGUF inference. Prompts never leave this computer.";
  } else if (inf.scope === "local-loopback") {
    badge.textContent = inf.host ? `Local Server · ${inf.host}` : "Local Server (not configured)";
    badge.className = "mcp-badge mcp-badge-ok";
    note.textContent = inf.host
      ? "Loopback server on this computer. Prompts stay on this machine."
      : "Enter a server URL and model name below, then test the connection.";
  } else if (inf.scope === "private-lan") {
    badge.textContent = `Leaves this PC · LAN (${inf.host ?? "private network"})`;
    badge.className = "mcp-badge mcp-badge-err";
    note.textContent =
      "Prompts and tool context are sent to this server on your local network. Shown in the companion window.";
  } else {
    badge.textContent = `Leaves this PC · External (${inf.host ?? "remote"})`;
    badge.className = "mcp-badge mcp-badge-err";
    note.textContent =
      "Warning: Prompts leave your local network and are sent to an external server. Shown in the companion window.";
  }
}

export function wireInferenceBackend(
  save: (patch: SettingsPatch) => Promise<void>,
): void {
  const providerEl = element<HTMLSelectElement>("inf-provider");
  const presetEl = element<HTMLSelectElement>("inf-preset");
  const urlInput = element<HTMLInputElement>("inf-baseUrl");
  const modelInput = element<HTMLInputElement>("inf-model");
  const keyInput = element<HTMLInputElement>("inf-apiKey");
  const discoveredEl = element<HTMLSelectElement>("inf-discovered-models");
  const testBtn = element<HTMLButtonElement>("inf-test");
  const testStatus = element("inf-test-status");

  providerEl.addEventListener("change", () => {
    const provider = providerEl.value as InferenceProvider;
    const preset = presetEl.value as OpenAiServerPreset;
    const patch: NonNullable<SettingsPatch["inference"]> = { provider };
    if (provider === "openai-compatible" && !urlInput.value.trim()) {
      const def = OPENAI_SERVER_PRESETS[preset].defaultUrl;
      if (def) patch.baseUrl = def;
    }
    void save({ inference: patch });
  });

  presetEl.addEventListener("change", () => {
    const preset = presetEl.value as OpenAiServerPreset;
    const defUrl = OPENAI_SERVER_PRESETS[preset].defaultUrl;
    const patch: NonNullable<SettingsPatch["inference"]> = { preset };
    if (defUrl) {
      urlInput.value = defUrl;
      patch.baseUrl = defUrl;
    }
    modelInput.placeholder = OPENAI_SERVER_PRESETS[preset].placeholderModel;
    void save({ inference: patch });
  });

  urlInput.addEventListener("change", () => {
    void save({ inference: { baseUrl: urlInput.value.trim() } });
  });

  modelInput.addEventListener("change", () => {
    void save({ inference: { model: modelInput.value.trim() } });
  });

  keyInput.addEventListener("change", () => {
    void save({ inference: { apiKey: keyInput.value.trim() } });
  });

  discoveredEl.addEventListener("change", () => {
    const picked = discoveredEl.value.trim();
    if (!picked) return;
    modelInput.value = picked;
    void save({ inference: { model: picked } });
  });

  testBtn.addEventListener("click", () => {
    const baseUrl = urlInput.value.trim();
    if (!baseUrl) {
      testStatus.textContent = "Enter a server URL first.";
      return;
    }
    testBtn.disabled = true;
    testStatus.textContent = "Probing /models…";
    void bridge
      .testInferenceBackend({
        baseUrl,
        ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
      })
      .then((res) => {
        if (!res.ok) {
          discoveredEl.hidden = true;
          testStatus.textContent = res.error ?? "Could not connect to server.";
          stamp("Connection failed", true);
          return;
        }
        const where = res.leavesMachine
          ? `off-machine (${res.scope === "private-lan" ? "LAN" : "external"}: ${res.host ?? ""})`
          : `local (${res.host ?? "loopback"})`;
        testStatus.textContent = `Connected (${where}) · ${res.models.length} model${res.models.length === 1 ? "" : "s"} found.`;
        stamp("Server reachable");
        if (res.models.length > 0) {
          discoveredEl.replaceChildren(
            ...res.models.map((id) => {
              const opt = document.createElement("option");
              opt.value = id;
              opt.textContent = id;
              return opt;
            }),
          );
          discoveredEl.hidden = false;
          if (!modelInput.value.trim()) {
            const first = res.models[0];
            if (first) {
              modelInput.value = first;
              void save({ inference: { baseUrl, model: first } });
            }
          } else if (res.models.includes(modelInput.value.trim())) {
            discoveredEl.value = modelInput.value.trim();
          }
        } else {
          discoveredEl.hidden = true;
        }
      })
      .catch((error: unknown) => {
        testStatus.textContent = stripIpcError(error, "Could not test server.");
        stamp("Connection failed", true);
      })
      .finally(() => {
        testBtn.disabled = false;
      });
  });
}
