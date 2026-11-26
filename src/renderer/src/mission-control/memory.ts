import type { MemoryKind } from "../../../core/memory.ts";
import type {
  EpisodeInspectorItem,
  EpisodeThresholdView,
  MemoryInspectorItem,
} from "../../../shared/missionControl.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface MemoryPanelHandlers {
  onUpsertMemory(input: { id?: string; kind: MemoryKind; text: string }): Promise<void>;
  onPinMemory(id: string, pinned: boolean): Promise<void>;
  onDeleteMemory(id: string): Promise<void>;
  onDeleteEpisode(id: number): Promise<void>;
}

let searchText = "";
let kindFilter = "all";

export function renderMemoryPanel(
  container: HTMLElement,
  memories: readonly MemoryInspectorItem[],
  episodes: readonly EpisodeInspectorItem[],
  thresholds: readonly EpisodeThresholdView[],
  handlers: MemoryPanelHandlers,
): void {
  container.replaceChildren();

  // Add / filter bar
  const topCard = el("div", "card");
  const toolbar = el("div", "toolbar");

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search facts, tags, episodic summaries, or context buckets…";
  searchInput.value = searchText;

  const kindSelect = document.createElement("select");
  for (const opt of [
    "all",
    "pinned-only",
    "profile",
    "preference",
    "project",
    "fact",
    "topic",
    "skill",
    "episode",
  ]) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt === "all" ? "All kinds" : opt === "pinned-only" ? "Pinned only" : opt;
    if (opt === kindFilter) o.selected = true;
    kindSelect.appendChild(o);
  }

  const newKind = document.createElement("select");
  for (const k of ["fact", "preference", "profile", "project", "episode"] as const) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    newKind.appendChild(o);
  }

  const newText = document.createElement("input");
  newText.type = "text";
  newText.placeholder = "Add new fact or preference directly…";

  const addBtn = el("button", "btn-primary", "Add Memory");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    const text = newText.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    void handlers.onUpsertMemory({ kind: newKind.value as MemoryKind, text });
  });

  toolbar.append(searchInput, kindSelect, newKind, newText, addBtn);
  topCard.appendChild(toolbar);
  container.appendChild(topCard);

  const listsGrid = el("div", "grid-2");

  const memCard = el("div", "card");
  memCard.appendChild(el("h2", "card-title", `Semantic Memories (${memories.length})`));
  const memList = el("div");
  memCard.appendChild(memList);

  const epCard = el("div", "card");
  epCard.appendChild(
    el(
      "h2",
      "card-title",
      `Episodic Events (${episodes.length}) & Context Buckets (${thresholds.length})`,
    ),
  );
  const epList = el("div");
  epCard.appendChild(epList);

  listsGrid.append(memCard, epCard);
  container.appendChild(listsGrid);

  const renderFiltered = (): void => {
    const q = searchText.trim().toLowerCase();
    memList.replaceChildren();
    const filteredMem = memories.filter((m) => {
      if (kindFilter === "pinned-only" && !m.pinned) return false;
      if (kindFilter !== "all" && kindFilter !== "pinned-only" && m.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        m.text.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q)) ||
        (m.namespace?.toLowerCase().includes(q) ?? false)
      );
    });

    if (filteredMem.length === 0) {
      memList.appendChild(el("p", "muted", "No matching memories."));
    } else {
      for (const mem of filteredMem) {
        const row = el("div", "list-row");
        const top = el("div", "list-row-top");
        const badges = el("div", "btn-row");
        badges.appendChild(el("span", "badge", mem.kind));
        if (mem.pinned) badges.appendChild(el("span", "badge pinned", "pinned"));
        badges.appendChild(el("span", "muted", `hits: ${mem.hits}`));
        top.appendChild(badges);

        const actions = el("div", "btn-row");
        const pinBtn = el("button", "", mem.pinned ? "Unpin" : "Pin");
        pinBtn.type = "button";
        pinBtn.addEventListener("click", () => {
          void handlers.onPinMemory(mem.id, !mem.pinned);
        });

        const editBtn = el("button", "", "Edit");
        editBtn.type = "button";

        const delBtn = el("button", "btn-danger", "Delete");
        delBtn.type = "button";
        delBtn.addEventListener("click", () => {
          void handlers.onDeleteMemory(mem.id);
        });

        actions.append(pinBtn, editBtn, delBtn);
        top.appendChild(actions);
        row.appendChild(top);

        const textEl = el("div", "", mem.text);
        row.appendChild(textEl);

        if (mem.whyRemembered) {
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.className = "muted";
          summary.textContent = "Why do you remember this?";
          const why = el("div", "muted", mem.whyRemembered);
          details.append(summary, why);
          row.appendChild(details);
        }

        editBtn.addEventListener("click", () => {
          const input = document.createElement("textarea");
          input.rows = 2;
          input.style.width = "100%";
          input.value = mem.text;
          const saveBtn = el("button", "btn-ok", "Save");
          saveBtn.type = "button";
          saveBtn.addEventListener("click", () => {
            const next = input.value.trim();
            if (next) void handlers.onUpsertMemory({ id: mem.id, kind: mem.kind, text: next });
          });
          row.replaceChildren(top, input, saveBtn);
        });

        memList.appendChild(row);
      }
    }

    epList.replaceChildren();
    if (thresholds.length > 0) {
      const threshTitle = el("h3", "card-title", "Adaptive Context Thresholds (tauAct / tauSpeak)");
      epList.appendChild(threshTitle);
      for (const th of thresholds) {
        if (q && !th.contextBucket.toLowerCase().includes(q)) continue;
        const row = el("div", "list-row");
        row.appendChild(
          el(
            "div",
            "",
            `${th.contextBucket} — tauAct=${th.tauAct.toFixed(2)}, tauSpeak=${th.tauSpeak.toFixed(2)} (samples=${th.sampleCount}, ema=${th.emaReward.toFixed(2)})`,
          ),
        );
        epList.appendChild(row);
      }
    }

    const filteredEp = episodes.filter(
      (ep) =>
        !q ||
        ep.summary.toLowerCase().includes(q) ||
        ep.contextBucket.toLowerCase().includes(q) ||
        ep.activeApp.toLowerCase().includes(q),
    );
    if (filteredEp.length === 0) {
      epList.appendChild(el("p", "muted", "No matching episodic records."));
    } else {
      for (const ep of filteredEp) {
        const row = el("div", "list-row");
        const top = el("div", "list-row-top");
        top.appendChild(el("span", "badge", `${ep.kind} · ${ep.contextBucket}`));
        const delBtn = el("button", "btn-danger", "Delete");
        delBtn.type = "button";
        delBtn.addEventListener("click", () => {
          void handlers.onDeleteEpisode(ep.id);
        });
        top.appendChild(delBtn);
        row.appendChild(top);
        row.appendChild(el("div", "", ep.summary));
        row.appendChild(el("div", "muted", `${ep.at.slice(0, 19).replace("T", " ")} · app=${ep.activeApp}`));
        epList.appendChild(row);
      }
    }
  };

  searchInput.addEventListener("input", () => {
    searchText = searchInput.value;
    renderFiltered();
  });
  kindSelect.addEventListener("change", () => {
    kindFilter = kindSelect.value;
    renderFiltered();
  });

  renderFiltered();
}
