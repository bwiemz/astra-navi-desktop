import { ipcMain } from "electron";
import type { ConfigStore } from "../core/config.ts";
import {
  MAX_MCP_SERVERS,
  McpServerConfigSchema,
  type McpHub,
  type McpServerConfig,
} from "../core/mcpClient.ts";
import type { McpServerView, SettingsView } from "../shared/settings.ts";

/**
 * Settings-window IPC for managing external Model Context Protocol (MCP) servers.
 * Only the Settings window may add, toggle, or remove MCP servers — never the LLM
 * or her main chat window. Secret header and environment values are never echoed back.
 */

export interface McpIpcDeps {
  config: ConfigStore;
  mcpHub(): McpHub | null;
  fromSettingsWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
  settingsView(): SettingsView;
}

function summarizeTarget(server: McpServerConfig): string {
  if (server.transport === "http") {
    return server.url ?? "";
  }
  const args = server.args && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
  return `${server.command ?? ""}${args}`.trim();
}

/** Builds redacted Settings views of configured MCP servers (never exposing header/env secret values). */
export function buildMcpServerViews(
  servers: readonly McpServerConfig[],
  hub: McpHub | null,
): McpServerView[] {
  return servers.map((server) => {
    const status = hub?.statusFor(server.id);
    const tools = (status?.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      readOnly:
        tool.annotations?.readOnlyHint === true &&
        tool.annotations?.destructiveHint !== true &&
        tool.annotations?.openWorldHint !== true,
      destructive: tool.annotations?.destructiveHint === true,
    }));
    return {
      id: server.id,
      name: server.name?.trim() || server.id,
      transport: server.transport,
      enabled: server.enabled !== false,
      target: summarizeTarget(server),
      headerKeys: Object.keys(server.headers ?? {}),
      envKeys: Object.keys(server.env ?? {}),
      readOnlyAutoAllow: server.readOnlyAutoAllow === true,
      connected: status?.connected === true,
      toolCount: tools.length,
      tools,
      error: status?.error ?? null,
    };
  });
}

function parseCleanRecord(raw: unknown, maxEntries = 24): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= maxEntries) break;
    const cleanKey = key.trim();
    if (!cleanKey || typeof val !== "string") continue;
    out[cleanKey] = val;
    count += 1;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function registerMcpIpc(deps: McpIpcDeps): void {
  const fromSettings = (event: Electron.IpcMainInvokeEvent): void => {
    if (!deps.fromSettingsWindow(event)) throw new Error("Not allowed from here.");
  };

  ipcMain.handle(
    "mcp:add-server",
    async (
      event,
      input: unknown,
    ): Promise<{ ok: true; view: SettingsView; warning?: string } | { ok: false; why: string }> => {
      fromSettings(event);
      const raw = (typeof input === "object" && input !== null ? input : {}) as Record<
        string,
        unknown
      >;
      const existing = deps.config.value.mcp.servers;
      if (existing.length >= MAX_MCP_SERVERS) {
        return { ok: false, why: `At most ${MAX_MCP_SERVERS} MCP servers may be configured.` };
      }

      const rawId = typeof raw["id"] === "string" ? raw["id"].trim().toLowerCase() : "";
      const rawName = typeof raw["name"] === "string" ? raw["name"].trim() : "";
      const transport = raw["transport"] === "http" ? "http" : "stdio";
      const readOnlyAutoAllow = raw["readOnlyAutoAllow"] === true;

      const candidate =
        transport === "stdio"
          ? {
              id: rawId,
              ...(rawName ? { name: rawName } : {}),
              transport: "stdio" as const,
              enabled: true,
              command: typeof raw["command"] === "string" ? raw["command"].trim() : "",
              args: Array.isArray(raw["args"])
                ? raw["args"].filter((a): a is string => typeof a === "string" && a.length > 0)
                : undefined,
              ...(typeof raw["cwd"] === "string" && raw["cwd"].trim()
                ? { cwd: raw["cwd"].trim() }
                : {}),
              env: parseCleanRecord(raw["env"]),
              readOnlyAutoAllow,
            }
          : {
              id: rawId,
              ...(rawName ? { name: rawName } : {}),
              transport: "http" as const,
              enabled: true,
              url: typeof raw["url"] === "string" ? raw["url"].trim() : "",
              headers: parseCleanRecord(raw["headers"]),
              readOnlyAutoAllow,
            };

      const parsed = McpServerConfigSchema.safeParse(candidate);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        return {
          ok: false,
          why: firstIssue
            ? firstIssue.message
            : "Check the server ID (lowercase letters, digits, - or _) and transport details.",
        };
      }

      if (existing.some((server) => server.id === parsed.data.id)) {
        return {
          ok: false,
          why: `An MCP server with id "${parsed.data.id}" already exists. Pick another id.`,
        };
      }

      const nextServers = [...existing, parsed.data];
      await deps.config.update({ mcp: { servers: nextServers } });
      const hub = deps.mcpHub();
      let warning: string | undefined;
      if (hub) {
        const sync = await hub.syncServers(nextServers);
        if (sync.errors[parsed.data.id]) {
          warning = `Saved, but connecting failed: ${sync.errors[parsed.data.id]}`;
        }
      }
      return {
        ok: true,
        view: deps.settingsView(),
        ...(warning ? { warning } : {}),
      };
    },
  );

  ipcMain.handle("mcp:remove-server", async (event, id: unknown): Promise<SettingsView> => {
    fromSettings(event);
    const wanted = typeof id === "string" ? id.trim() : "";
    const nextServers = deps.config.value.mcp.servers.filter((server) => server.id !== wanted);
    await deps.config.update({ mcp: { servers: nextServers } });
    await deps.mcpHub()?.unregisterServer(wanted);
    return deps.settingsView();
  });

  ipcMain.handle(
    "mcp:toggle-server",
    async (
      event,
      id: unknown,
      enabled: unknown,
    ): Promise<{ ok: boolean; view: SettingsView; error?: string }> => {
      fromSettings(event);
      const wanted = typeof id === "string" ? id.trim() : "";
      const nextEnabled = enabled === true;
      const nextServers = deps.config.value.mcp.servers.map((server) =>
        server.id === wanted ? { ...server, enabled: nextEnabled } : server,
      );
      await deps.config.update({ mcp: { servers: nextServers } });
      const hub = deps.mcpHub();
      let error: string | undefined;
      if (hub) {
        const sync = await hub.syncServers(nextServers);
        error = sync.errors[wanted];
      }
      return {
        ok: !error,
        view: deps.settingsView(),
        ...(error ? { error } : {}),
      };
    },
  );

  ipcMain.handle(
    "mcp:set-read-only-auto",
    async (event, id: unknown, on: unknown): Promise<SettingsView> => {
      fromSettings(event);
      const wanted = typeof id === "string" ? id.trim() : "";
      const nextAuto = on === true;
      const nextServers = deps.config.value.mcp.servers.map((server) =>
        server.id === wanted ? { ...server, readOnlyAutoAllow: nextAuto } : server,
      );
      await deps.config.update({ mcp: { servers: nextServers } });
      const hub = deps.mcpHub();
      if (hub) {
        await hub.syncServers(nextServers);
      }
      return deps.settingsView();
    },
  );

  ipcMain.handle(
    "mcp:reconnect-server",
    async (
      event,
      id: unknown,
    ): Promise<{ ok: boolean; view: SettingsView; error?: string }> => {
      fromSettings(event);
      const wanted = typeof id === "string" ? id.trim() : "";
      const hub = deps.mcpHub();
      if (!hub) {
        return { ok: false, view: deps.settingsView(), error: "MCP hub is not running." };
      }
      const cfg = deps.config.value.mcp.servers.find((server) => server.id === wanted);
      if (!cfg) {
        return { ok: false, view: deps.settingsView(), error: `Unknown MCP server "${wanted}".` };
      }
      if (!hub.getClient(wanted)) {
        hub.registerServer(cfg);
      }
      const res = await hub.connectServer(wanted);
      return {
        ok: res.ok,
        view: deps.settingsView(),
        ...(res.error ? { error: res.error } : {}),
      };
    },
  );
}
