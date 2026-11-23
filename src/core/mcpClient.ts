import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { isPrivateIpv4, type PolicyContext, type Verdict } from "./permissions.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Native Model Context Protocol (MCP) Client & Permission Bridge.
 *
 * Speaks JSON-RPC 2.0 (`2025-03-26` / `2024-11-05`) over both local stdio
 * subprocesses and Streamable HTTP / SSE servers, wrapping every tool call
 * inside `core/permissions.ts` approval gates and outside-text tagging.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_OUTPUT_CHARS = 32_768;
const DEFAULT_TIMEOUT_MS = 15_000;
const BLOCKED_METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "100.100.100.200"]);

export const McpServerConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    name: z.string().min(1).max(80).optional(),
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).max(260).optional(),
    args: z.array(z.string().max(512)).max(64).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().max(400).optional(),
    url: z.string().url().max(512).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Only when explicitly true may `readOnlyHint: true` tools auto-run before reading outside text. */
    readOnlyAutoAllow: z.boolean().default(false),
    timeoutMs: z.number().int().min(500).max(120_000).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "stdio" && !cfg.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Stdio MCP server requires a `command` executable.",
      });
    }
    if (cfg.transport === "http") {
      if (!cfg.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "HTTP MCP server requires a valid `url`.",
        });
      } else {
        const check = validateMcpHttpUrl(cfg.url);
        if (!check.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: check.reason,
          });
        }
      }
    }
  });

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpCallResult {
  content: { type: string; text?: string; [key: string]: unknown }[];
  textSummary: string;
  isError: boolean;
  /** Always true: remote/external MCP outputs are untrusted text per security policy. */
  outsideText: true;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

export interface McpTransport {
  connect(): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** Validates HTTP/SSE MCP endpoint URLs against SSRF / metadata / unencrypted non-LAN targets. */
export function validateMcpHttpUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid MCP endpoint URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported MCP URL scheme "${parsed.protocol}"; use http or https.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "MCP URLs must not embed credentials." };
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!host || BLOCKED_METADATA_HOSTS.has(host) || host.startsWith("169.254.")) {
    return { ok: false, reason: `Blocked cloud metadata or link-local MCP host "${host}".` };
  }
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const isLan = isLoopback || isPrivateLanHost(host) || isPrivateIpv4(host);
  if (parsed.protocol === "http:" && !isLan) {
    return {
      ok: false,
      reason: `Plaintext http:// MCP endpoints are restricted to localhost/private LAN (got "${host}").`,
    };
  }
  return { ok: true, url: parsed };
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Newline-delimited JSON-RPC 2.0 MCP transport over child process stdio. */
export class StdioMcpTransport implements McpTransport {
  private readonly cfg: McpServerConfig;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private stdoutBuf = "";
  private readonly pending = new Map<number, PendingRpc>();
  private stderrTail = "";

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    if (this.child) return;
    const command = this.cfg.command ?? "";
    if (!command || /[;&|`$<>]/.test(command)) {
      throw new Error(`Unsafe or missing MCP stdio command "${command}".`);
    }
    const child = spawn(command, [...(this.cfg.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}),
      ...(this.cfg.env ? { env: { ...process.env, ...this.cfg.env } } : {}),
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleChunk(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2048);
    });
    child.on("error", (err) => {
      this.rejectAll(new Error(`MCP stdio error: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.rejectAll(
        new Error(
          `MCP stdio process exited (${code ?? signal ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`,
        ),
      );
    });
  }

  private rejectAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  private handleChunk(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl = this.stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.dispatchLine(line);
      nl = this.stdoutBuf.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (msg["error"] && typeof msg["error"] === "object") {
      const errObj = msg["error"] as Record<string, unknown>;
      entry.reject(new Error(String(errObj["message"] ?? "MCP JSON-RPC error")));
    } else {
      entry.resolve(msg["result"]);
    }
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.child?.stdin) {
      return Promise.reject(new Error("MCP stdio transport is not connected."));
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });
      this.child?.stdin?.write(`${payload}\n`);
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.child?.stdin) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.child.stdin.write(`${payload}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error("MCP stdio transport closed."));
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        // Ignore broken pipe during close.
      }
      child.kill("SIGTERM");
    }
  }
}

/** Streamable HTTP + SSE MCP transport (`application/json` and `text/event-stream`). */
export class HttpMcpTransport implements McpTransport {
  private readonly cfg: McpServerConfig;
  private readonly endpointUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(cfg: McpServerConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    const validated = validateMcpHttpUrl(cfg.url ?? "");
    if (!validated.ok) throw new Error(validated.reason);
    this.endpointUrl = validated.url;
    this.fetchImpl = fetchImpl;
  }

  async connect(): Promise<void> {
    // Streamable HTTP is stateless until `initialize` negotiates an optional `Mcp-Session-Id`.
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private parseSseOrJson(contentType: string, bodyText: string, expectedId?: number): unknown {
    if (contentType.includes("text/event-stream")) {
      const events = bodyText.split(/\r?\n\r?\n/);
      let lastResult: unknown = undefined;
      for (const block of events) {
        const dataLines = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .filter(Boolean);
        if (dataLines.length === 0) continue;
        const raw = dataLines.join("\n");
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (expectedId !== undefined && parsed["id"] !== expectedId) continue;
        if (parsed["error"] && typeof parsed["error"] === "object") {
          throw new Error(String((parsed["error"] as Record<string, unknown>)["message"] ?? "MCP SSE error"));
        }
        lastResult = parsed["result"];
        if (expectedId !== undefined) return lastResult;
      }
      if (lastResult !== undefined) return lastResult;
      throw new Error("MCP SSE stream ended without a matching JSON-RPC result.");
    }

    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (parsed["error"] && typeof parsed["error"] === "object") {
      throw new Error(String((parsed["error"] as Record<string, unknown>)["message"] ?? "MCP HTTP error"));
    }
    return parsed["result"];
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpointUrl.toString(), {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        }),
        signal: controller.signal,
      });
      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!response.ok) {
        throw new Error(`MCP HTTP ${response.status} from ${this.endpointUrl.origin}`);
      }
      const ctype = (response.headers.get("content-type") ?? "application/json").toLowerCase();
      const text = await response.text();
      return this.parseSseOrJson(ctype, text, id) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      await this.fetchImpl(this.endpointUrl.toString(), {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params !== undefined ? { params } : {}),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }
}

export class McpClient {
  readonly config: McpServerConfig;
  private readonly transport: McpTransport;
  private initialized = false;
  private cachedTools: McpToolDescriptor[] = [];

  constructor(config: McpServerConfig, customTransport?: McpTransport) {
    this.config = McpServerConfigSchema.parse(config);
    this.transport =
      customTransport ??
      (this.config.transport === "stdio"
        ? new StdioMcpTransport(this.config)
        : new HttpMcpTransport(this.config));
  }

  get isConnected(): boolean {
    return this.initialized;
  }

  get tools(): readonly McpToolDescriptor[] {
    return this.cachedTools;
  }

  async initialize(): Promise<McpInitializeResult> {
    await this.transport.connect();
    const result = await this.transport.request<McpInitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "astra-navi-desktop", version: "1.0.0" },
    });
    await this.transport.notify("notifications/initialized", {});
    this.initialized = true;
    return result;
  }

  async ping(): Promise<boolean> {
    try {
      await this.transport.request("ping", {});
      return true;
    } catch {
      return false;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const res = await this.transport.request<{ tools?: McpToolDescriptor[] }>("tools/list", {});
    this.cachedTools = Array.isArray(res?.tools) ? res.tools : [];
    return this.cachedTools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const raw = await this.transport.request<{
      content?: { type: string; text?: string; [key: string]: unknown }[];
      isError?: boolean;
    }>("tools/call", { name, arguments: args });
    const items = Array.isArray(raw?.content) ? raw.content : [];
    const joined = items
      .map((item) => (typeof item.text === "string" ? item.text : JSON.stringify(item)))
      .join("\n");
    const bounded =
      joined.length > MAX_OUTPUT_CHARS
        ? `${joined.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${joined.length - MAX_OUTPUT_CHARS} chars]`
        : joined;
    return {
      content: items,
      textSummary: bounded,
      isError: raw?.isError === true,
      outsideText: true,
    };
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    const res = await this.transport.request<{ resources?: McpResourceDescriptor[] }>(
      "resources/list",
      {},
    );
    return Array.isArray(res?.resources) ? res.resources : [];
  }

  async readResource(uri: string): Promise<{ text: string; mimeType?: string; outsideText: true }> {
    const res = await this.transport.request<{
      contents?: { uri?: string; text?: string; mimeType?: string }[];
    }>("resources/read", { uri });
    const first = Array.isArray(res?.contents) ? res.contents[0] : undefined;
    const rawText = typeof first?.text === "string" ? first.text : "";
    return {
      text: rawText.slice(0, MAX_OUTPUT_CHARS),
      ...(first?.mimeType ? { mimeType: first.mimeType } : {}),
      outsideText: true,
    };
  }

  async close(): Promise<void> {
    this.initialized = false;
    await this.transport.close();
  }
}

/** Permission verdict for calling a discovered MCP tool through `core/permissions.ts`. */
export function evaluateMcpToolVerdict(
  serverId: string,
  tool: McpToolDescriptor | undefined,
  readOnlyAutoAllow: boolean,
  context: Pick<PolicyContext, "readOutsideText" | "handsOff">,
): Verdict {
  if (context.handsOff) {
    return {
      decision: "ask",
      sensitive: true,
      reason: `Hands-off mode blocks external MCP tool "${serverId}.${tool?.name ?? "unknown"}" without confirmation.`,
    };
  }
  if (!tool) {
    return {
      decision: "ask",
      sensitive: false,
      reason: `MCP tool on "${serverId}" is not in the initialized server manifest.`,
    };
  }
  const safeReadOnly =
    readOnlyAutoAllow &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations?.destructiveHint !== true &&
    tool.annotations?.openWorldHint !== true;
  if (!safeReadOnly) {
    return {
      decision: "ask",
      sensitive: tool.annotations?.destructiveHint === true,
      reason: `MCP tool "${serverId}.${tool.name}" may modify external state or reach open-world endpoints.`,
    };
  }
  if (context.readOutsideText) {
    return {
      decision: "ask",
      sensitive: false,
      reason: `She has read outside text in this conversation, so check before running MCP tool "${serverId}.${tool.name}".`,
    };
  }
  return { decision: "allow" };
}

/** Multi-server MCP coordinator integrated with `permissions.ts` and `semanticBridge.ts`. */
export class McpHub {
  private readonly clients = new Map<string, McpClient>();

  registerServer(config: McpServerConfig, customTransport?: McpTransport): McpClient {
    const client = new McpClient(config, customTransport);
    this.clients.set(client.config.id, client);
    return client;
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId);
  }

  listServers(): readonly McpServerConfig[] {
    return [...this.clients.values()].map((c) => c.config);
  }

  async connectAll(): Promise<{ connected: string[]; errors: Record<string, string> }> {
    const connected: string[] = [];
    const errors: Record<string, string> = {};
    for (const [id, client] of this.clients) {
      try {
        await client.initialize();
        await client.listTools();
        connected.push(id);
      } catch (err) {
        errors[id] = err instanceof Error ? err.message : String(err);
      }
    }
    return { connected, errors };
  }

  listPrefixedTools(): { fullName: string; serverId: string; tool: McpToolDescriptor }[] {
    const out: { fullName: string; serverId: string; tool: McpToolDescriptor }[] = [];
    for (const [serverId, client] of this.clients) {
      for (const tool of client.tools) {
        out.push({ fullName: `mcp:${serverId}.${tool.name}`, serverId, tool });
      }
    }
    return out;
  }

  /** Evaluates `permissions.ts` policy for any prefixed `mcp:<server>.<tool>` call. */
  verdictForTool(fullToolName: string, context: PolicyContext): Verdict {
    const match = /^mcp:([^.]+)\.(.+)$/.exec(fullToolName);
    if (!match) {
      return {
        decision: "ask",
        sensitive: false,
        reason: `Unrecognized MCP tool identifier "${fullToolName}".`,
      };
    }
    const serverId = match[1] ?? "";
    const toolName = match[2] ?? "";
    const client = this.clients.get(serverId);
    const tool = client?.tools.find((t) => t.name === toolName);
    return evaluateMcpToolVerdict(
      serverId,
      tool,
      client?.config.readOnlyAutoAllow === true,
      context,
    );
  }

  async callPrefixedTool(fullToolName: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const match = /^mcp:([^.]+)\.(.+)$/.exec(fullToolName);
    if (!match) throw new Error(`Invalid MCP tool name "${fullToolName}".`);
    const serverId = match[1] ?? "";
    const toolName = match[2] ?? "";
    const client = this.clients.get(serverId);
    if (!client) throw new Error(`Unknown MCP server "${serverId}".`);
    if (!client.isConnected) await client.initialize();
    return client.callTool(toolName, args);
  }

  async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
  }
}
