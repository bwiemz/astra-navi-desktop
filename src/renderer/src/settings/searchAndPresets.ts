import {
  detectActivePosture,
  POSTURE_PRESETS,
  type PosturePresetId,
  type SettingsPatch,
  type SettingsView,
} from "../../../shared/settings.ts";
import { element, stamp } from "./dom.ts";

/** Updates the active posture preset pill and button highlights from the current SettingsView. */
export function showPosture(view: SettingsView): void {
  const active = detectActivePosture(view);
  const labelEl = element("posture-active-label");
  const matched = POSTURE_PRESETS.find((p) => p.id === active);
  labelEl.textContent = matched ? `Active: ${matched.label}` : "Active: Custom";

  for (const btn of document.querySelectorAll<HTMLButtonElement>(".posture-btn[data-posture]")) {
    const isMatch = btn.dataset["posture"] === active;
    btn.classList.toggle("is-active", isMatch);
    btn.setAttribute("aria-pressed", String(isMatch));
  }
}

/** Wires live Settings search filtering and the three one-click security posture presets. */
export function wireSearchAndPresets(savePatch: (patch: SettingsPatch) => Promise<void>): void {
  const input = element<HTMLInputElement>("settings-search");
  const clearBtn = element<HTMLButtonElement>("settings-search-clear");
  const countEl = element("settings-search-count");
  const tier10Block = element<HTMLDetailsElement>("tier10-block");
  let preSearchTier10Open: boolean | null = null;

  const filterSettings = (): void => {
    const query = input.value.trim().toLowerCase();
    clearBtn.hidden = query.length === 0;
    const panels = [...document.querySelectorAll<HTMLElement>("main > .panel")];

    if (!query) {
      delete document.body.dataset["searching"];
      for (const el of document.querySelectorAll(".search-miss")) {
        el.classList.remove("search-miss");
      }
      if (preSearchTier10Open !== null) {
        tier10Block.open = preSearchTier10Open;
        preSearchTier10Open = null;
      }
      countEl.textContent = "";
      return;
    }

    if (preSearchTier10Open === null) preSearchTier10Open = tier10Block.open;
    document.body.dataset["searching"] = "true";

    let totalMatches = 0;

    for (const panel of panels) {
      const heading = panel.querySelector("h2")?.textContent?.toLowerCase() ?? "";
      const panelTitleMatch = heading.includes(query);
      const rows = [
        ...panel.querySelectorAll<HTMLElement>(":scope > .row, :scope > .signin > form > .row, :scope > .machine-form > .row"),
      ];
      let visibleInPanel = 0;

      for (const row of rows) {
        const text = (row.textContent ?? "").toLowerCase();
        const match = panelTitleMatch || text.includes(query);
        row.classList.toggle("search-miss", !match);
        if (match) {
          visibleInPanel += 1;
          totalMatches += 1;
        }
      }

      const expRows = [...tier10Block.querySelectorAll<HTMLElement>(".row")];
      if (panel.contains(tier10Block)) {
        let matchedExp = 0;
        for (const row of expRows) {
          const text = (row.textContent ?? "").toLowerCase();
          const match = panelTitleMatch || text.includes(query) || "experimental options".includes(query);
          row.classList.toggle("search-miss", !match);
          if (match) {
            matchedExp += 1;
            totalMatches += 1;
          }
        }
        tier10Block.classList.toggle("search-miss", matchedExp === 0);
        if (matchedExp > 0) tier10Block.open = true;
        visibleInPanel += matchedExp;
      }

      panel.classList.toggle("search-miss", visibleInPanel === 0 && !panelTitleMatch);
    }

    countEl.textContent =
      totalMatches === 0
        ? "No matching settings found."
        : `Showing ${totalMatches} matching setting${totalMatches === 1 ? "" : "s"}.`;
  };

  input.addEventListener("input", filterSettings);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && input.value !== "") {
      event.preventDefault();
      input.value = "";
      filterSettings();
    }
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    filterSettings();
    input.focus();
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>(".posture-btn[data-posture]")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset["posture"] as PosturePresetId | undefined;
      const preset = POSTURE_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      void savePatch(preset.patch).then(() => {
        stamp(`Applied "${preset.label}" posture`);
      });
    });
  }
}
