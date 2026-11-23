import type { SettingsBridge } from "../../../shared/settings.ts";

declare global {
  interface Window {
    aichanSettings: SettingsBridge;
  }
}

export const bridge = window.aichanSettings;

export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The settings page is missing its "${id}" element.`);
  return found as T;
}

const saved = element<HTMLParagraphElement>("saved");
let savedTimer = 0;

export function stamp(text: string, failed = false): void {
  saved.textContent = text;
  saved.classList.toggle("failed", failed);
  saved.classList.add("on");
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => saved.classList.remove("on"), failed ? 6000 : 1600);
}

export function fill(
  select: HTMLSelectElement,
  options: readonly { value: string; label: string }[],
  value: string,
): void {
  select.replaceChildren(
    ...options.map((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      return item;
    }),
  );
  // A value from the settings file that is not on the list (a custom model path) is still shown.
  if (!options.some((option) => option.value === value)) {
    const custom = document.createElement("option");
    custom.value = value;
    custom.textContent = value;
    select.append(custom);
  }
  select.value = value;
}

/** Selects a value in a fixed list, adding it when the settings file holds one that is not listed. */
export function choose(
  select: HTMLSelectElement,
  value: string,
  describe: (value: string) => string,
): void {
  for (const stale of select.querySelectorAll("option[data-custom]")) stale.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const custom = document.createElement("option");
    custom.value = value;
    custom.textContent = describe(value);
    custom.dataset["custom"] = "";
    select.append(custom);
  }
  select.value = value;
}

export function setAdvancedMode(on: boolean): void {
  document.body.dataset["advanced"] = on ? "true" : "false";
  element<HTMLInputElement>("advancedSettings").checked = on;
}
