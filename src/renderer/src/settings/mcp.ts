import type { McpServerAddRequest, SettingsView } from "../../../shared/settings.ts";
import { bridge, element, stamp } from "./dom.ts";

/** Per-server inline status messages kept while Settings stays open. */
const serverNotes = new Map<string, string>();

function stripIpcError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || fallback;
}

function parseKeyValueLines(
  raw: string,
  separator: "=" | ":",
): { ok: true; record: Record<string, string> | undefined } | { ok: false; why: string } {
  const out: Record<string, string> = {};
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const idx = line.indexOf(separator);
    if (idx <= 0) {
      return {
        ok: false,
        why:
          separator === "="
            ? `Each environment variable must be KEY=VALUE (could not read "${line.slice(0, 40)}").`
            : `Each HTTP header must be Name: value (could not read "${line.slice(0, 40)}").`,
      };
    }
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = val;
  }
  return { ok: true, record: Object.keys(out).length > 0 ? out : undefined };
}

export function showMcpServers(view: SettingsView, onView: (fresh: SettingsView) => void): void {
  const list = element("mcp-servers");
  const button = (label: string, act: () => void, kind: "default" | "quiet" | "danger" = "default"): HTMLButtonElement => {
    const made = document.createElement("button");
    made.type = "button";
    made.textContent = label;
    if (kind === "quiet") made.className = "quiet";
    if (kind === "danger") made.className = "danger";
    made.addEventListener("click", act);
    return made;
  };

  if (view.mcpServers.length === 0) {
    const empty = document.createElement("li");
    const text = document.createElement("span");
    text.className = "why";
    text.textContent =
      "No MCP servers configured yet. Add a local stdio command or a localhost/LAN HTTP MCP server below.";
    empty.append(text);
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...view.mcpServers.map((server) => {
      const item = document.createElement("li");

      const head = document.createElement("div");
      head.className = "mcp-head";
      const title = document.createElement("strong");
      title.textContent =
        server.name !== server.id ? `${server.name} (${server.id})` : server.id;

      const badge = document.createElement("span");
      badge.className = server.connected
        ? "mcp-badge mcp-badge-ok"
        : !server.enabled
          ? "mcp-badge mcp-badge-off"
          : "mcp-badge mcp-badge-err";
      badge.textContent = server.connected
        ? `Connected · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`
        : !server.enabled
          ? "Disabled"
          : "Disconnected";
      head.append(title, badge);

      const where = document.createElement("span");
      where.className = "why mcp-target";
      const extras: string[] = [];
      if (server.headerKeys.length > 0) extras.push(`Headers: ${server.headerKeys.join(", ")}`);
      if (server.envKeys.length > 0) extras.push(`Env: ${server.envKeys.join(", ")}`);
      where.textContent = `[${server.transport}] ${server.target}${extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}`;

      const note = document.createElement("span");
      note.className = "why machine-state";
      note.setAttribute("role", "status");
      note.textContent = serverNotes.get(server.id) ?? (server.error ? `Error: ${server.error}` : "");
      const say = (words: string): void => {
        serverNotes.set(server.id, words);
        note.textContent = words;
      };

      const actions = document.createElement("div");
      actions.className = "machine-actions";
      actions.append(
        button(
          server.enabled ? "Disable" : "Enable",
          () => {
            say(server.enabled ? "Disconnecting…" : "Connecting…");
            void bridge
              .toggleMcpServer(server.id, !server.enabled)
              .then((res) => {
                serverNotes.set(
                  server.id,
                  res.error ? `Error: ${res.error}` : server.enabled ? "Disabled." : "Connected.",
                );
                onView(res.view);
                stamp(server.enabled ? "MCP server disabled" : "MCP server updated");
              })
              .catch((err: unknown) => say(stripIpcError(err, "Could not update MCP server.")));
          },
          "quiet",
        ),
        button(
          "Reconnect",
          () => {
            say("Reconnecting…");
            void bridge
              .reconnectMcpServer(server.id)
              .then((res) => {
                serverNotes.set(
                  server.id,
                  res.ok ? "Connected and refreshed tools." : `Error: ${res.error ?? "Connection failed."}`,
                );
                onView(res.view);
              })
              .catch((err: unknown) => say(stripIpcError(err, "Reconnect failed.")));
          },
          "quiet",
        ),
        button(
          "Remove",
          () => {
            void bridge
              .removeMcpServer(server.id)
              .then((fresh) => {
                serverNotes.delete(server.id);
                onView(fresh);
                stamp("MCP server removed");
              })
              .catch((err: unknown) => say(stripIpcError(err, "Could not remove MCP server.")));
          },
          "danger",
        ),
      );

      const readOnlyRow = document.createElement("label");
      readOnlyRow.className = "machine-look";
      const readOnlyBox = document.createElement("input");
      readOnlyBox.type = "checkbox";
      readOnlyBox.checked = server.readOnlyAutoAllow;
      readOnlyBox.addEventListener("change", () => {
        void bridge
          .setMcpReadOnlyAuto(server.id, readOnlyBox.checked)
          .then((fresh) => {
            onView(fresh);
            stamp("Saved");
          })
          .catch((err: unknown) => say(stripIpcError(err, "Could not update permission.")));
      });
      const readOnlyWords = document.createElement("span");
      readOnlyWords.textContent =
        "Allow read-only tools without asking (still asks once outside text enters the chat).";
      readOnlyRow.append(readOnlyBox, readOnlyWords);

      item.append(head, where, actions, readOnlyRow, note);

      if (server.tools.length > 0) {
        const details = document.createElement("details");
        details.className = "mcp-tools-drawer";
        const summary = document.createElement("summary");
        summary.textContent = `Discovered tools (${server.tools.length})`;
        const toolList = document.createElement("ul");
        toolList.className = "mcp-tool-list";
        for (const tool of server.tools) {
          const li = document.createElement("li");
          const code = document.createElement("code");
          code.textContent = `mcp:${server.id}.${tool.name}`;
          const tag = document.createElement("span");
          tag.className = "why";
          const hint = tool.destructive
            ? " [destructive · always asks]"
            : tool.readOnly
              ? " [read-only]"
              : " [asks before running]";
          tag.textContent = `${hint}${tool.description ? ` — ${tool.description}` : ""}`;
          li.append(code, tag);
          toolList.append(li);
        }
        details.append(summary, toolList);
        item.append(details);
      }

      return item;
    }),
  );
}

export function wireMcpSettings(onView: (fresh: SettingsView) => void): void {
  const form = element<HTMLFormElement>("mcp-form");
  const transportSelect = element<HTMLSelectElement>("mcp-transport");
  const stdioGroup = element("mcp-stdio-fields");
  const httpGroup = element("mcp-http-fields");
  const noteEl = element("mcp-note");
  const submitBtn = element<HTMLButtonElement>("mcp-add-btn");

  const syncTransportVisibility = (): void => {
    const isHttp = transportSelect.value === "http";
    stdioGroup.hidden = isHttp;
    httpGroup.hidden = !isHttp;
    element<HTMLInputElement>("mcp-command").required = !isHttp;
    element<HTMLInputElement>("mcp-url").required = isHttp;
  };
  transportSelect.addEventListener("change", syncTransportVisibility);
  syncTransportVisibility();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = element<HTMLInputElement>("mcp-id").value.trim().toLowerCase();
    const name = element<HTMLInputElement>("mcp-name").value.trim();
    const transport = transportSelect.value === "http" ? "http" : "stdio";
    const readOnlyAutoAllow = element<HTMLInputElement>("mcp-readonly-auto").checked;

    const payload: McpServerAddRequest = {
      id,
      ...(name ? { name } : {}),
      transport,
      readOnlyAutoAllow,
    };

    if (transport === "stdio") {
      payload.command = element<HTMLInputElement>("mcp-command").value.trim();
      const rawArgs = element<HTMLTextAreaElement>("mcp-args").value;
      const args = rawArgs
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (args.length > 0) payload.args = args;
      const cwd = element<HTMLInputElement>("mcp-cwd").value.trim();
      if (cwd) payload.cwd = cwd;
      const envParsed = parseKeyValueLines(element<HTMLTextAreaElement>("mcp-env").value, "=");
      if (!envParsed.ok) {
        noteEl.textContent = envParsed.why;
        return;
      }
      if (envParsed.record) payload.env = envParsed.record;
    } else {
      payload.url = element<HTMLInputElement>("mcp-url").value.trim();
      const headersParsed = parseKeyValueLines(
        element<HTMLTextAreaElement>("mcp-headers").value,
        ":",
      );
      if (!headersParsed.ok) {
        noteEl.textContent = headersParsed.why;
        return;
      }
      if (headersParsed.record) payload.headers = headersParsed.record;
    }

    submitBtn.disabled = true;
    noteEl.textContent = "Adding and connecting…";
    void bridge
      .addMcpServer(payload)
      .then((res) => {
        if (!res.ok) {
          noteEl.textContent = res.why;
          return;
        }
        form.reset();
        syncTransportVisibility();
        noteEl.textContent = res.warning ?? "Connected and ready.";
        onView(res.view);
        stamp("MCP server added");
      })
      .catch((err: unknown) => {
        noteEl.textContent = stripIpcError(err, "Could not add MCP server.");
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });
}
