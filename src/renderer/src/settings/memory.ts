import type { MemoryKind } from "../../../core/memory.ts";
import type { MemoryManagerEntry, MemoryManagerSnapshot, SettingsView } from "../../../shared/settings.ts";
import { bridge, element, stamp } from "./dom.ts";

let currentSnapshot: MemoryManagerSnapshot | null = null;
const expandedWhy = new Set<string>();
let editingId: string | null = null;
let searchQuery = "";
let filterKind = "all";

function stripIpcError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || fallback;
}

function sourceLabel(source: MemoryManagerEntry["source"]): string {
  switch (source) {
    case "learned":
      return "Auto-learned";
    case "user-edited":
      return "Edited by you";
    case "imported":
      return "Imported";
    default:
      return "Saved in chat";
  }
}

function renderList(onView: (fresh: SettingsView) => void): void {
  const list = element("memory-list");
  const pathEl = element("memory-ownership-path");
  const statusEl = element("memory-status");

  if (!currentSnapshot) {
    list.replaceChildren();
    return;
  }

  pathEl.textContent = `Local file: ${currentSnapshot.memoryFile} · ${currentSnapshot.stats.pinned} pinned · ${currentSnapshot.stats.alwaysInPrompt} always in prompt`;

  const q = searchQuery.trim().toLowerCase();
  const visible = currentSnapshot.entries.filter((entry) => {
    if (filterKind === "pinned" && !entry.pinned) return false;
    if (filterKind !== "all" && filterKind !== "pinned" && entry.kind !== filterKind) return false;
    if (!q) return true;
    return (
      entry.text.toLowerCase().includes(q) ||
      entry.id.toLowerCase().includes(q) ||
      entry.kind.toLowerCase().includes(q) ||
      entry.points.some((p) => p.toLowerCase().includes(q)) ||
      entry.whyRemembered.toLowerCase().includes(q)
    );
  });

  if (visible.length === 0) {
    const empty = document.createElement("li");
    const msg = document.createElement("span");
    msg.className = "why";
    msg.textContent =
      currentSnapshot.entries.length === 0
        ? "Nothing remembered yet. Notes she learns or you add will appear here."
        : "No memories match this filter.";
    empty.append(msg);
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...visible.map((entry) => {
      const item = document.createElement("li");

      const head = document.createElement("div");
      head.className = "mcp-head";

      const badgeGroup = document.createElement("div");
      badgeGroup.className = "backup-actions";

      const kindBadge = document.createElement("span");
      kindBadge.className = "mcp-badge mcp-badge-off";
      kindBadge.textContent = entry.kind;
      badgeGroup.append(kindBadge);

      if (entry.pinned) {
        const pinBadge = document.createElement("span");
        pinBadge.className = "mcp-badge mcp-badge-ok";
        pinBadge.textContent = "Pinned";
        badgeGroup.append(pinBadge);
      }

      const srcBadge = document.createElement("span");
      srcBadge.className = "why";
      srcBadge.textContent = `${sourceLabel(entry.source)} · [${entry.id}] · ${entry.updatedAt.slice(0, 10)}`;
      badgeGroup.append(srcBadge);

      head.append(badgeGroup);

      const actions = document.createElement("div");
      actions.className = "machine-actions";

      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "quiet";
      pinBtn.textContent = entry.pinned ? "Unpin" : "Pin";
      pinBtn.addEventListener("click", () => {
        pinBtn.disabled = true;
        void bridge
          .pinMemory(entry.id, !entry.pinned)
          .then((res) => {
            if (res.ok) {
              currentSnapshot = res.snapshot;
              onView(res.view);
              renderList(onView);
              stamp(entry.pinned ? "Unpinned" : "Pinned to prompt");
            } else {
              statusEl.textContent = res.error;
              stamp("Could not update pin", true);
            }
          })
          .catch((err: unknown) => {
            statusEl.textContent = stripIpcError(err, "Could not update pin.");
          });
      });

      const whyBtn = document.createElement("button");
      whyBtn.type = "button";
      whyBtn.className = "quiet";
      whyBtn.textContent = expandedWhy.has(entry.id) ? "Hide why" : "Why?";
      whyBtn.addEventListener("click", () => {
        if (expandedWhy.has(entry.id)) expandedWhy.delete(entry.id);
        else expandedWhy.add(entry.id);
        renderList(onView);
      });

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "quiet";
      editBtn.textContent = editingId === entry.id ? "Cancel edit" : "Correct";
      editBtn.addEventListener("click", () => {
        editingId = editingId === entry.id ? null : entry.id;
        renderList(onView);
      });

      const forgetBtn = document.createElement("button");
      forgetBtn.type = "button";
      forgetBtn.className = "danger";
      forgetBtn.textContent = "Forget";
      forgetBtn.addEventListener("click", () => {
        forgetBtn.disabled = true;
        void bridge
          .forgetMemory(entry.id)
          .then((res) => {
            if (res.ok) {
              expandedWhy.delete(entry.id);
              if (editingId === entry.id) editingId = null;
              currentSnapshot = res.snapshot;
              onView(res.view);
              renderList(onView);
              stamp("Memory forgotten");
            } else {
              statusEl.textContent = res.error;
              stamp("Could not forget note", true);
            }
          })
          .catch((err: unknown) => {
            statusEl.textContent = stripIpcError(err, "Could not forget memory.");
          });
      });

      actions.append(pinBtn, whyBtn, editBtn, forgetBtn);
      head.append(actions);
      item.append(head);

      if (editingId === entry.id) {
        const textArea = document.createElement("textarea");
        textArea.rows = 2;
        textArea.value = entry.text;

        let pointsArea: HTMLTextAreaElement | null = null;
        if (entry.kind === "topic" || entry.kind === "skill" || entry.points.length > 0) {
          pointsArea = document.createElement("textarea");
          pointsArea.rows = Math.min(6, Math.max(2, entry.points.length + 1));
          pointsArea.placeholder = "One key point or step per line";
          pointsArea.value = entry.points.join("\n");
        }

        const saveRow = document.createElement("div");
        saveRow.className = "machine-actions";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = "Save correction";
        saveBtn.addEventListener("click", () => {
          const nextText = textArea.value.trim();
          if (!nextText) {
            statusEl.textContent = "Memory text cannot be empty.";
            return;
          }
          saveBtn.disabled = true;
          const nextPoints = pointsArea
            ? pointsArea.value
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
            : undefined;
          void bridge
            .updateMemory({
              id: entry.id,
              text: nextText,
              ...(nextPoints !== undefined ? { points: nextPoints } : {}),
            })
            .then((res) => {
              if (res.ok) {
                editingId = null;
                currentSnapshot = res.snapshot;
                onView(res.view);
                renderList(onView);
                stamp("Memory updated");
              } else {
                statusEl.textContent = res.error;
                stamp("Update failed", true);
              }
            })
            .catch((err: unknown) => {
              statusEl.textContent = stripIpcError(err, "Could not update memory.");
            })
            .finally(() => {
              saveBtn.disabled = false;
            });
        });
        saveRow.append(saveBtn);
        item.append(textArea);
        if (pointsArea) item.append(pointsArea);
        item.append(saveRow);
      } else {
        const body = document.createElement("div");
        body.textContent = entry.text;
        item.append(body);

        if (entry.points.length > 0) {
          const pts = document.createElement("ul");
          pts.className = "mcp-tool-list";
          for (const point of entry.points) {
            const li = document.createElement("li");
            li.textContent = point;
            pts.append(li);
          }
          item.append(pts);
        }
      }

      if (expandedWhy.has(entry.id)) {
        const whyBox = document.createElement("p");
        whyBox.className = "why";
        whyBox.textContent = `Why she remembers this: ${entry.whyRemembered}`;
        item.append(whyBox);
      }

      return item;
    }),
  );
}

export function refreshMemoryManager(onView: (fresh: SettingsView) => void): void {
  void bridge
    .listMemories()
    .then((snapshot) => {
      currentSnapshot = snapshot;
      renderList(onView);
    })
    .catch((error: unknown) => {
      element("memory-status").textContent = stripIpcError(error, "Could not load memories.");
    });
}

export function wireMemoryManager(onView: (fresh: SettingsView) => void): void {
  const searchInput = element<HTMLInputElement>("memory-search");
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderList(onView);
  });

  const filterSelect = element<HTMLSelectElement>("memory-filter-kind");
  filterSelect.addEventListener("change", () => {
    filterKind = filterSelect.value;
    renderList(onView);
  });

  const addForm = element<HTMLFormElement>("memory-add-form");
  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const kind = element<HTMLSelectElement>("memory-add-kind").value as MemoryKind;
    const textInput = element<HTMLInputElement>("memory-add-text");
    const pinInput = element<HTMLInputElement>("memory-add-pin");
    const submitBtn = element<HTMLButtonElement>("memory-add-submit");
    const statusEl = element("memory-status");
    const text = textInput.value.trim();
    if (!text) {
      statusEl.textContent = "Type a note before saving.";
      return;
    }
    submitBtn.disabled = true;
    statusEl.textContent = "";
    void bridge
      .addMemory({ kind, text, pinned: pinInput.checked })
      .then((res) => {
        if (res.ok) {
          textInput.value = "";
          pinInput.checked = false;
          currentSnapshot = res.snapshot;
          onView(res.view);
          renderList(onView);
          stamp("Memory saved");
        } else {
          statusEl.textContent = res.error;
          stamp("Could not save note", true);
        }
      })
      .catch((err: unknown) => {
        statusEl.textContent = stripIpcError(err, "Could not save memory.");
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });
}
