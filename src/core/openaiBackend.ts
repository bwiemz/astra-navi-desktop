import { createHash } from "node:crypto";
import type {
  ChatHistoryItem,
  ChatModelResponse,
  ChatSessionModelFunctions,
} from "node-llama-cpp";

/**
 * Generalized OpenAI-Compatible Inference Backend (Ollama, LM Studio, llama-server,
 * MLX server, or another workstation on the local network / remote host).
 *
 * Local on-device GGUF remains the default. When this optional backend is enabled,
 * `classifyInferenceEndpoint()` clearly identifies whether traffic stays on loopback
 * (`127.0.0.1`), crosses the private LAN, or leaves for an external internet host so
 * the desktop UI and Settings always display where prompts are sent.
 */

export type InferenceProvider = "local" | "openai-compatible";
export type OpenAiServerPreset = "ollama" | "lm-studio" | "llama-server" | "custom";
export type InferenceScope = "local-gguf" | "local-loopback" | "private-lan" | "remote-internet";

export const OPENAI_SERVER_PRESETS: Record<
  OpenAiServerPreset,
  { label: string; defaultUrl: string; placeholderModel: string }
> = {
  ollama: {
    label: "Ollama",
    defaultUrl: "http://127.0.0.1:11434/v1",
    placeholderModel: "qwen3.5:9b",
  },
  "lm-studio": {
    label: "LM Studio",
    defaultUrl: "http://127.0.0.1:1234/v1",
    placeholderModel: "qwen3.5-9b-instruct",
  },
  "llama-server": {
    label: "llama-server (llama.cpp)",
    defaultUrl: "http://127.0.0.1:8080/v1",
    placeholderModel: "qwen3.5-9b",
  },
  custom: {
    label: "Custom OpenAI-compatible",
    defaultUrl: "",
    placeholderModel: "model-id",
  },
};

export interface InferenceBackendConfig {
  provider: InferenceProvider;
  preset: OpenAiServerPreset;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface EndpointLocality {
  ok: true;
  /** Normalized API base ending in `/v1` (or the user's explicit versioned prefix). */
  apiBaseUrl: string;
  host: string;
  scope: Exclude<InferenceScope, "local-gguf">;
  leavesMachine: boolean;
}

export type EndpointCheckResult = EndpointLocality | { ok: false; reason: string };

export interface OpenAiProbeResult {
  ok: boolean;
  models: string[];
  scope: Exclude<InferenceScope, "local-gguf"> | null;
  host: string | null;
  leavesMachine: boolean;
  error?: string;
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface OpenAiToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const MAX_TOOL_STEPS = 8;

function normalizeMappedIpv4(host: string): string {
  if (!host.startsWith("::ffff:")) return host;
  const rest = host.slice("::ffff:".length);
  const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hexPair) return rest;
  const hi = Number.parseInt(hexPair[1] ?? "0", 16);
  const lo = Number.parseInt(hexPair[2] ?? "0", 16);
  return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
}

function isLoopbackHost(host: string): boolean {
  const mapped = normalizeMappedIpv4(host);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped)) return true;
  return false;
}

function isMetadataHost(host: string): boolean {
  const mapped = normalizeMappedIpv4(host);
  return (
    host === "169.254.169.254" ||
    mapped === "169.254.169.254" ||
    host === "169.254.170.2" ||
    mapped === "169.254.170.2" ||
    mapped.startsWith("169.254.") ||
    mapped === "100.100.100.200" ||
    mapped === "0.0.0.0" ||
    host === "::" ||
    host === "metadata.google.internal" ||
    host === "metadata"
  );
}

function isPrivateLanHost(host: string): boolean {
  const mapped = normalizeMappedIpv4(host);
  // Single-label local hostnames (e.g. `gpu-box`, `ollama`), excluding bare numeric/hex IP forms.
  if (
    !host.includes(".") &&
    !host.includes(":") &&
    /^[a-z0-9-]+$/i.test(host) &&
    !/^\d+$/.test(host) &&
    !/^0x[0-9a-f]+$/i.test(host)
  ) {
    return true;
  }
  // Common LAN / Docker / Tailscale MagicDNS suffixes (Tailscale traffic is WireGuard-encrypted).
  if (
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  ) {
    return true;
  }
  // IPv4 RFC 1918 + Carrier-Grade NAT / Tailscale (100.64.0.0/10)
  const ipv4 = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) {
    return true;
  }
  return false;
}

/**
 * Validates and classifies an OpenAI-compatible server URL as loopback, private LAN,
 * or remote internet, blocking embedded credentials and cloud metadata hosts.
 */
export function classifyInferenceEndpoint(rawUrl: string): EndpointCheckResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, reason: "Server URL is empty." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Invalid server URL. Example: http://127.0.0.1:11434/v1" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `Server URL must use http:// or https:// (got ${url.protocol}).`,
    };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Server URL must not embed credentials; use the API key field." };
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!host) return { ok: false, reason: "Server URL is missing a hostname." };
  if (isMetadataHost(host)) {
    return { ok: false, reason: `Refused cloud metadata host "${host}".` };
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) {
    pathname = pathname.slice(0, -"/chat/completions".length);
  }
  if (pathname === "") {
    pathname = "/v1";
  }
  const apiBaseUrl = `${url.origin}${pathname}`;

  const scope: Exclude<InferenceScope, "local-gguf"> = isLoopbackHost(host)
    ? "local-loopback"
    : isPrivateLanHost(host)
      ? "private-lan"
      : "remote-internet";

  if (scope === "remote-internet" && url.protocol === "http:") {
    return {
      ok: false,
      reason: `Plaintext http:// is only allowed for localhost or private LAN hosts; use https:// for external server "${host}".`,
    };
  }

  return {
    ok: true,
    apiBaseUrl,
    host: url.port ? `${host}:${url.port}` : host,
    scope,
    leavesMachine: scope !== "local-loopback",
  };
}

/** Summarizes current inference locality for UI badges, status views, and logs. */
export function describeInferenceLocality(config: InferenceBackendConfig): {
  provider: InferenceProvider;
  scope: InferenceScope;
  host: string | null;
  leavesMachine: boolean;
  label: string;
} {
  if (config.provider !== "openai-compatible") {
    return {
      provider: "local",
      scope: "local-gguf",
      host: null,
      leavesMachine: false,
      label: "Built-in local model (on this PC)",
    };
  }
  const checked = classifyInferenceEndpoint(config.baseUrl);
  if (!checked.ok) {
    return {
      provider: "openai-compatible",
      scope: "local-loopback",
      host: null,
      leavesMachine: false,
      label: "OpenAI-compatible server (not configured)",
    };
  }
  const modelLabel = config.model.trim() || "server model";
  if (checked.scope === "local-loopback") {
    return {
      provider: "openai-compatible",
      scope: "local-loopback",
      host: checked.host,
      leavesMachine: false,
      label: `${modelLabel} (Local server · ${checked.host})`,
    };
  }
  if (checked.scope === "private-lan") {
    return {
      provider: "openai-compatible",
      scope: "private-lan",
      host: checked.host,
      leavesMachine: true,
      label: `${modelLabel} (LAN · ${checked.host})`,
    };
  }
  return {
    provider: "openai-compatible",
    scope: "remote-internet",
    host: checked.host,
    leavesMachine: true,
    label: `${modelLabel} (External server · ${checked.host})`,
  };
}

const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface OpenAiToolNameMap {
  /** Maps internal tool name (e.g. `mcp:home-assistant.dim_light`) -> OpenAI wire name (`^[a-zA-Z0-9_-]{1,64}$`). */
  realToWire: Map<string, string>;
  /** Reverse map from OpenAI wire name -> internal tool name. */
  wireToReal: Map<string, string>;
}

/** Deterministically maps arbitrary internal tool names (including `mcp:server.tool`) to OpenAI-valid wire names. */
export function sanitizeOpenAiToolName(realName: string, forceHash = false): string {
  if (!forceHash && OPENAI_TOOL_NAME_RE.test(realName)) {
    return realName;
  }
  const cleaned = realName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "") || "tool";
  const hash = createHash("sha256").update(realName).digest("hex").slice(0, 8);
  if (!forceHash && cleaned.length <= 64 && OPENAI_TOOL_NAME_RE.test(cleaned)) {
    return cleaned;
  }
  const prefix = cleaned.slice(0, 55);
  return `${prefix}_${hash}`;
}

/** Builds a bijective mapping between internal tool names and OpenAI-compliant wire names (`^[a-zA-Z0-9_-]{1,64}$`). */
export function buildOpenAiToolNameMap(toolNames: Iterable<string>): OpenAiToolNameMap {
  const realToWire = new Map<string, string>();
  const wireToReal = new Map<string, string>();
  for (const realName of toolNames) {
    if (realToWire.has(realName)) continue;
    let wire = sanitizeOpenAiToolName(realName, false);
    if (wireToReal.has(wire)) {
      wire = sanitizeOpenAiToolName(realName, true);
    }
    let attempt = 1;
    while (wireToReal.has(wire)) {
      const suffix = `_${attempt}`;
      wire = `${wire.slice(0, 64 - suffix.length)}${suffix}`;
      attempt += 1;
    }
    realToWire.set(realName, wire);
    wireToReal.set(wire, realName);
  }
  return { realToWire, wireToReal };
}

/** Converts `node-llama-cpp` function definitions (including MCP tools) into OpenAI `tools`. */
export function convertFunctionsToOpenAiTools(
  functions: ChatSessionModelFunctions | undefined,
  nameMap?: OpenAiToolNameMap,
): OpenAiToolSpec[] {
  if (!functions) return [];
  const mapping = nameMap ?? buildOpenAiToolNameMap(Object.keys(functions));
  const out: OpenAiToolSpec[] = [];
  for (const [realName, fn] of Object.entries(functions)) {
    const rawParams = fn.params as Record<string, unknown> | undefined;
    const parameters: Record<string, unknown> =
      rawParams && typeof rawParams === "object"
        ? rawParams
        : { type: "object", properties: {} };
    const wireName = mapping.realToWire.get(realName) ?? sanitizeOpenAiToolName(realName);
    out.push({
      type: "function",
      function: {
        name: wireName,
        description: fn.description ?? "",
        parameters,
      },
    });
  }
  return out;
}

function historyToWireMessages(
  systemPrompt: string,
  history: readonly ChatHistoryItem[],
  nameMap?: OpenAiToolNameMap,
): WireMessage[] {
  const wire: WireMessage[] = [];
  if (systemPrompt.trim()) {
    wire.push({ role: "system", content: systemPrompt });
  }
  let callCounter = 0;
  for (const item of history) {
    if (item.type === "system") continue;
    if (item.type === "user") {
      wire.push({ role: "user", content: item.text });
      continue;
    }
    if (item.type === "model") {
      const textParts: string[] = [];
      const toolCalls: NonNullable<WireMessage["tool_calls"]> = [];
      const toolResults: WireMessage[] = [];
      for (const part of item.response) {
        if (typeof part === "string") {
          if (part.length > 0) textParts.push(part);
        } else if (part.type === "functionCall") {
          callCounter += 1;
          const callId = `hist_call_${callCounter}`;
          const wireName = nameMap?.realToWire.get(part.name) ?? sanitizeOpenAiToolName(part.name);
          toolCalls.push({
            id: callId,
            type: "function",
            function: {
              name: wireName,
              arguments: JSON.stringify(part.params ?? {}),
            },
          });
          toolResults.push({
            role: "tool",
            tool_call_id: callId,
            content:
              typeof part.result === "string"
                ? part.result
                : JSON.stringify(part.result ?? ""),
          });
        }
      }
      if (toolCalls.length > 0) {
        wire.push({
          role: "assistant",
          content: textParts.join("") || null,
          tool_calls: toolCalls,
        });
        wire.push(...toolResults);
      } else if (textParts.length > 0) {
        wire.push({ role: "assistant", content: textParts.join("") });
      }
    }
  }
  return wire;
}

function authHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

/** Probes `/models` on an OpenAI-compatible server to verify connectivity and list available models. */
export async function probeOpenAiModels(
  config: Pick<InferenceBackendConfig, "baseUrl" | "apiKey">,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<OpenAiProbeResult> {
  const checked = classifyInferenceEndpoint(config.baseUrl);
  if (!checked.ok) {
    return {
      ok: false,
      models: [],
      scope: null,
      host: null,
      leavesMachine: false,
      error: checked.reason,
    };
  }
  const fetchFn = options.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${checked.apiBaseUrl}/models`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...authHeaders(config.apiKey),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    });
    if (!res.ok) {
      return {
        ok: false,
        models: [],
        scope: checked.scope,
        host: checked.host,
        leavesMachine: checked.leavesMachine,
        error: `Server returned HTTP ${res.status} at ${checked.apiBaseUrl}/models.`,
      };
    }
    const payload = (await res.json()) as {
      data?: { id?: string }[];
      models?: { name?: string; id?: string }[];
    };
    const ids = new Set<string>();
    if (Array.isArray(payload.data)) {
      for (const item of payload.data) {
        if (typeof item?.id === "string" && item.id.trim()) ids.add(item.id.trim());
      }
    }
    if (Array.isArray(payload.models)) {
      for (const item of payload.models) {
        const id = typeof item?.id === "string" ? item.id : item?.name;
        if (typeof id === "string" && id.trim()) ids.add(id.trim());
      }
    }
    return {
      ok: true,
      models: [...ids],
      scope: checked.scope,
      host: checked.host,
      leavesMachine: checked.leavesMachine,
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      scope: checked.scope,
      host: checked.host,
      leavesMachine: checked.leavesMachine,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs a single non-streaming helper turn (compaction / learner) on an OpenAI-compatible server. */
export async function openAiSideQuestion(
  config: InferenceBackendConfig,
  instructions: string,
  text: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const checked = classifyInferenceEndpoint(config.baseUrl);
  const model = config.model.trim();
  if (!checked.ok || !model) return null;
  try {
    const res = await fetchImpl(`${checked.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(config.apiKey),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: text },
        ],
        temperature: 0.2,
        max_tokens: 900,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

export interface ChatSessionPromptOptions {
  functions?: ChatSessionModelFunctions;
  maxParallelFunctionCalls?: number;
  signal?: AbortSignal;
  stopOnAbortSignal?: boolean;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  topP?: number;
  topK?: number;
  tokenBias?: unknown;
  budgets?: unknown;
  onResponseChunk?: (chunk: { type: string; segmentType?: string; segmentEndTime?: number }) => void;
  onFunctionCallParamsChunk?: (chunk: {
    callIndex: number;
    functionName: string;
    paramsChunk: string;
    done: boolean;
  }) => void;
  onTextChunk?: (chunk: string) => void;
}

/** Structural chat session interface shared between `LlamaChatSession` and `OpenAiCompatibleSession`. */
export interface ChatSessionLike {
  getChatHistory(): ChatHistoryItem[];
  setChatHistory(items: ChatHistoryItem[]): void;
  prompt(text: string, options?: ChatSessionPromptOptions): Promise<string>;
  decide(
    options: unknown,
    extra?: { functions?: ChatSessionModelFunctions; signal?: AbortSignal },
  ): Promise<{ claimed: { value: number } }>;
  dispose(): void;
}

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Stateful OpenAI-compatible chat session implementing `ChatSessionLike` with SSE
 * streaming and multi-step tool-calling loops compatible with `Brain` and MCP tools.
 */
export class OpenAiCompatibleSession implements ChatSessionLike {
  private readonly config: InferenceBackendConfig;
  private readonly locality: EndpointLocality;
  private readonly fetchImpl: typeof fetch;
  /** Remote model's discovered/explicit context window in tokens (independent of local GGUF contextSize). */
  private remoteContextTokens: number | null;
  private probedRemoteContext = false;
  /** Remembered per-session so a server rejecting `chat_template_kwargs` (400/422) never costs 2 round trips again. */
  private supportsChatTemplateKwargs = true;
  private systemPrompt: string;
  private history: ChatHistoryItem[] = [];
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    config: InferenceBackendConfig,
    systemPrompt: string,
    fetchImpl: typeof fetch = fetch,
    remoteContextTokens?: number,
  ) {
    const checked = classifyInferenceEndpoint(config.baseUrl);
    if (!checked.ok) {
      throw new Error(`Invalid OpenAI-compatible server URL: ${checked.reason}`);
    }
    if (!config.model.trim()) {
      throw new Error("OpenAI-compatible backend requires a model name.");
    }
    this.config = config;
    this.locality = checked;
    this.systemPrompt = systemPrompt;
    this.fetchImpl = fetchImpl;
    if (typeof remoteContextTokens === "number" && Number.isFinite(remoteContextTokens) && remoteContextTokens >= 1_024) {
      this.remoteContextTokens = Math.floor(remoteContextTokens);
      this.probedRemoteContext = true;
    } else {
      this.remoteContextTokens = null;
    }
  }

  /** Lazily queries `/models` once to learn the remote server's actual context window (falls back safely to 4096). */
  private async resolveRemoteContextTokens(signal?: AbortSignal): Promise<number> {
    if (this.probedRemoteContext) {
      return this.remoteContextTokens ?? 4_096;
    }
    this.probedRemoteContext = true;
    try {
      const timeout = AbortSignal.timeout(1_500);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const res = await this.fetchImpl(`${this.locality.apiBaseUrl}/models`, {
        method: "GET",
        headers: { accept: "application/json", ...authHeaders(this.config.apiKey) },
        signal: combined,
      });
      if (res.ok) {
        const payload = (await res.json()) as {
          data?: Record<string, unknown>[];
          models?: Record<string, unknown>[];
        };
        const entries = [
          ...(Array.isArray(payload.data) ? payload.data : []),
          ...(Array.isArray(payload.models) ? payload.models : []),
        ];
        const wanted = this.config.model.trim().toLowerCase();
        // Match ONLY the configured model (never fall back to entries[0], which may be a different model).
        const match = entries.find((e) => {
          const id =
            typeof e["id"] === "string" ? e["id"] : typeof e["name"] === "string" ? e["name"] : "";
          return id.trim().toLowerCase() === wanted;
        });
        if (match) {
          const meta =
            typeof match["meta"] === "object" && match["meta"] !== null
              ? (match["meta"] as Record<string, unknown>)
              : {};
          // Use ONLY runtime context-window fields — never `n_ctx_train` (training context can be
          // 128K–262K even when the server is running with a 4K–8K active window).
          const candidates = [
            match["max_model_len"],
            match["context_length"],
            match["n_ctx"],
            match["max_context_length"],
            meta["n_ctx"],
          ];
          for (const c of candidates) {
            if (typeof c === "number" && Number.isFinite(c) && c >= 1_024) {
              this.remoteContextTokens = Math.floor(c);
              break;
            }
          }
        }
      }
    } catch {
      // Conservative 4096-token fallback when server omits or doesn't expose context metadata.
    }
    return this.remoteContextTokens ?? 4_096;
  }

  getChatHistory(): ChatHistoryItem[] {
    return [
      { type: "system", text: this.systemPrompt },
      ...this.history,
    ];
  }

  setChatHistory(items: ChatHistoryItem[]): void {
    const sys = items.find((item) => item.type === "system");
    if (sys && sys.type === "system" && typeof sys.text === "string") {
      this.systemPrompt = sys.text;
    }
    this.history = items.filter((item) => item.type !== "system");
  }

  meter(): { input: number; output: number; held: number; size: number; kept: number } {
    const heldChars =
      this.systemPrompt.length +
      this.history.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
    return {
      input: this.inputTokens,
      output: this.outputTokens,
      held: approxTokens("x".repeat(heldChars)),
      size: 32_768,
      kept: 0,
    };
  }

  async decide(
    checkSpec: unknown,
    extra?: { functions?: ChatSessionModelFunctions; signal?: AbortSignal },
  ): Promise<{ claimed: { value: number } }> {
    const lastModel = [...this.history].reverse().find((item) => item.type === "model");
    const lastReply =
      lastModel && lastModel.type === "model"
        ? lastModel.response
            .filter((part): part is string => typeof part === "string")
            .join("")
            .trim()
        : "";
    if (!lastReply) return { claimed: { value: 0 } };

    const specRoot =
      typeof checkSpec === "object" && checkSpec !== null
        ? (checkSpec as Record<string, unknown>)
        : {};
    const claimedSpec =
      typeof specRoot["claimed"] === "object" && specRoot["claimed"] !== null
        ? (specRoot["claimed"] as Record<string, unknown>)
        : {};
    const instruction =
      typeof claimedSpec["instruction"] === "string"
        ? claimedSpec["instruction"]
        : "Does the assistant's most recent reply claim that an action was carried out or started?";
    const criteria =
      typeof claimedSpec["criteria"] === "object" && claimedSpec["criteria"] !== null
        ? (claimedSpec["criteria"] as Record<string, unknown>)
        : {};
    const trueRule = typeof criteria["true"] === "string" ? criteria["true"] : "Claimed an action.";
    const falseRule =
      typeof criteria["false"] === "string" ? criteria["false"] : "Only talked, asked, or declined.";

    // Size the reply excerpt dynamically to the REMOTE server's discovered/configured context
    // window (2.4K–12K chars) rather than the local GGUF context setting.
    const remoteCtx = await this.resolveRemoteContextTokens(extra?.signal);
    const maxExcerptChars = Math.max(2_400, Math.min(12_000, Math.floor(remoteCtx * 1.5)));
    const replyExcerpt =
      lastReply.length <= maxExcerptChars
        ? lastReply
        : (() => {
            const sliceLen = Math.max(600, Math.floor(maxExcerptChars / 3));
            const midStart = Math.max(sliceLen, Math.floor((lastReply.length - sliceLen) / 2));
            return `${lastReply.slice(0, sliceLen)}\n...\n${lastReply.slice(midStart, midStart + sliceLen)}\n...\n${lastReply.slice(-sliceLen)}`;
          })();

    const basePayload = {
      model: this.config.model.trim(),
      messages: [
        {
          role: "system",
          content:
            "/no_think\nYou are a strict binary verifier. Reply ONLY with a single JSON object " +
            '{"claimed": <number between 0.0 and 1.0>} and nothing else. ' +
            `1.0 means: ${trueRule}. 0.0 means: ${falseRule}.`,
        },
        {
          role: "user",
          content: `${instruction}\n\nAssistant's most recent reply:\n${replyExcerpt}`,
        },
      ],
      temperature: 0,
      // Keep ample headroom (1024 tokens) in case a server ignores `enable_thinking: false` and emits `<think>...</think>`.
      max_tokens: 1_024,
      stream: false,
    };

    const sendDecide = (withThinkingToggle: boolean): Promise<Response> =>
      this.fetchImpl(`${this.locality.apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...authHeaders(this.config.apiKey),
        },
        body: JSON.stringify(
          withThinkingToggle
            ? { ...basePayload, chat_template_kwargs: { enable_thinking: false } }
            : basePayload,
        ),
        signal: extra?.signal,
      });

    // Try `chat_template_kwargs: { enable_thinking: false }` for all servers (including remote
    // thinking models). Only permanently disable it for the session when an HTTP 400/422 error
    // body actually names the field or an unknown/extra property rejection, so transient/unrelated
    // 400s (e.g. context overflow) never turn off thinking suppression permanently.
    const tryDisableThinking = this.supportsChatTemplateKwargs;
    let res = await sendDecide(tryDisableThinking);
    if (tryDisableThinking && (res.status === 400 || res.status === 422)) {
      const errBody = await res.text().catch(() => "");
      const rejectsThinkingField =
        /chat_template_kwargs|enable_thinking|extra_body|unknown[\s_-]*field|unrecognized|additional[\s_-]*propert|extra_forbidden|unexpected[\s_-]*field/i.test(
          errBody,
        );
      if (rejectsThinkingField) {
        this.supportsChatTemplateKwargs = false;
        res = await sendDecide(false);
      } else {
        throw new Error(
          `OpenAI-compatible claim-check returned HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 180)}` : ""}`,
        );
      }
    }
    if (!res.ok) {
      throw new Error(`OpenAI-compatible claim-check returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const raw = (data.choices?.[0]?.message?.content ?? "").trim();
    const score = parseClaimDecisionScore(raw);
    if (score === null) {
      throw new Error(`Could not parse claim-check decision from response: "${raw.slice(0, 80)}"`);
    }
    return { claimed: { value: score } };
  }

  dispose(): void {
    // Stateless HTTP client; nothing to free.
  }

  async prompt(text: string, options: ChatSessionPromptOptions = {}): Promise<string> {
    const userItem: ChatHistoryItem = { type: "user", text };
    const knownToolNames = new Set<string>(Object.keys(options.functions ?? {}));
    for (const item of this.history) {
      if (item.type !== "model") continue;
      for (const part of item.response) {
        if (typeof part === "object" && part.type === "functionCall") {
          knownToolNames.add(part.name);
        }
      }
    }
    const nameMap = buildOpenAiToolNameMap(knownToolNames);
    const wire = historyToWireMessages(this.systemPrompt, [...this.history, userItem], nameMap);
    const tools = convertFunctionsToOpenAiTools(options.functions, nameMap);
    const modelResponseParts: ChatModelResponse["response"] = [];
    let finalAssistantText = "";
    let completedNormally = false;

    try {
      for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
        if (options.signal?.aborted) break;

        const stepResult = await this.streamOneStep(wire, tools, options, nameMap);
        if (stepResult.text) {
          finalAssistantText += stepResult.text;
          modelResponseParts.push(stepResult.text);
        }

        if (stepResult.toolCalls.length === 0 || !options.functions) {
          break;
        }

        wire.push({
          role: "assistant",
          content: stepResult.text || null,
          tool_calls: stepResult.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        });

        const limit = Math.max(
          1,
          options.maxParallelFunctionCalls ?? stepResult.toolCalls.length,
        );

        // Emit a matching `role: "tool"` reply for EVERY `tool_call_id` so strict OpenAI servers never HTTP 400.
        for (let idx = 0; idx < stepResult.toolCalls.length; idx += 1) {
          const call = stepResult.toolCalls[idx];
          if (!call) continue;
          const realName = nameMap.wireToReal.get(call.name) ?? call.name;

          if (options.signal?.aborted) {
            wire.push({
              role: "tool",
              tool_call_id: call.id,
              content: "Cancelled before running.",
            });
            continue;
          }

          if (idx >= limit) {
            wire.push({
              role: "tool",
              tool_call_id: call.id,
              content: "Skipped: execute one tool call at a time and wait for its result before calling another.",
            });
            continue;
          }

          const fn = options.functions[realName];
          let parsedParams: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(call.argumentsJson || "{}") as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              parsedParams = parsed as Record<string, unknown>;
            }
          } catch {
            parsedParams = {};
          }

          let resultText: string;
          if (!fn) {
            resultText = `That failed: unknown tool "${realName}".`;
          } else {
            try {
              const rawResult = await fn.handler(parsedParams as never);
              resultText =
                typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult ?? "");
            } catch (error) {
              resultText = `That failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }

          modelResponseParts.push({
            type: "functionCall",
            name: realName,
            params: parsedParams,
            result: resultText,
          });
          wire.push({
            role: "tool",
            tool_call_id: call.id,
            content: resultText,
          });
        }
      }
      completedNormally = true;
    } finally {
      // Preserve executed tool calls (e.g. write_file) and streamed text even on abort or mid-turn error.
      if (completedNormally || modelResponseParts.length > 0) {
        this.history.push(userItem, { type: "model", response: modelResponseParts });
      }
    }

    return finalAssistantText;
  }

  private async streamOneStep(
    messages: readonly WireMessage[],
    tools: readonly OpenAiToolSpec[],
    options: ChatSessionPromptOptions,
    nameMap: OpenAiToolNameMap,
  ): Promise<{
    text: string;
    toolCalls: { id: string; name: string; argumentsJson: string }[];
  }> {
    const bodyPayload: Record<string, unknown> = {
      model: this.config.model.trim(),
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      stream: true,
    };
    if (options.topP !== undefined) bodyPayload["top_p"] = options.topP;
    if (options.seed !== undefined) bodyPayload["seed"] = options.seed;
    if (tools.length > 0) {
      bodyPayload["tools"] = tools;
      if (options.maxParallelFunctionCalls === 1) {
        bodyPayload["parallel_tool_calls"] = false;
      }
    }

    const encodedBody = JSON.stringify(bodyPayload);
    this.inputTokens += approxTokens(encodedBody);

    const res = await this.fetchImpl(`${this.locality.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...authHeaders(this.config.apiKey),
      },
      body: encodedBody,
      signal: options.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `OpenAI-compatible server (${this.locality.host}) returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`,
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!res.body || contentType.includes("application/json")) {
      const data = (await res.json()) as {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };
      const msg = data.choices?.[0]?.message;
      const text = typeof msg?.content === "string" ? msg.content : "";
      if (text) {
        this.outputTokens += approxTokens(text);
        options.onTextChunk?.(text);
      }
      const calls = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls
            .filter((c) => typeof c.function?.name === "string" && c.function.name.length > 0)
            .map((c, idx) => ({
              id: c.id || `call_${idx}`,
              name: c.function?.name ?? "",
              argumentsJson: c.function?.arguments ?? "{}",
            }))
        : [];
      return { text, toolCalls: calls };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return;
      }
      const choices = Array.isArray(chunk["choices"]) ? chunk["choices"] : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      if (!first) return;
      const delta = first["delta"] as Record<string, unknown> | undefined;
      if (!delta) return;

      if (typeof delta["content"] === "string" && delta["content"].length > 0) {
        fullText += delta["content"];
        this.outputTokens += approxTokens(delta["content"]);
        options.onTextChunk?.(delta["content"]);
      }

      const deltaTools = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
      for (const item of deltaTools) {
        const entry = item as {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        const idx = typeof entry.index === "number" ? entry.index : 0;
        const acc = toolAcc.get(idx) ?? {
          id: entry.id ?? `call_${idx}`,
          name: "",
          args: "",
        };
        if (entry.id) acc.id = entry.id;
        if (entry.function?.name) acc.name += entry.function.name;
        if (entry.function?.arguments) {
          acc.args += entry.function.arguments;
          options.onFunctionCallParamsChunk?.({
            callIndex: idx,
            functionName: nameMap.wireToReal.get(acc.name) ?? acc.name,
            paramsChunk: entry.function.arguments,
            done: false,
          });
        }
        toolAcc.set(idx, acc);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          handleLine(buffer.slice(0, newlineIdx));
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) handleLine(buffer);
    } finally {
      reader.releaseLock();
    }

    const toolCalls = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, entry]) => entry.name.length > 0)
      .map(([, entry]) => ({
        id: entry.id,
        name: entry.name,
        argumentsJson: entry.args || "{}",
      }));

    return { text: fullText, toolCalls };
  }
}

/** Parses `{"claimed": 0..1}` or `{"claimed": true|false}` from an OpenAI-compatible claim-check reply. */
export function parseClaimDecisionScore(raw: string): number | null {
  // Strip thinking blocks (e.g. Qwen3/DeepSeek `<think>...</think>`) before inspecting the verdict.
  const withoutThinking = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .trim();
  const cleaned = withoutThinking
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!cleaned) return null;

  const candidates: string[] = [cleaned];
  const braceMatches = cleaned.match(/\{[^{}]*\}/g);
  if (braceMatches) {
    // Prefer the last JSON object in case thinking/prose appeared before the final verdict.
    for (let i = braceMatches.length - 1; i >= 0; i -= 1) {
      const m = braceMatches[i];
      if (m) candidates.push(m);
    }
  }
  const outerBrace = /\{[\s\S]*\}/.exec(cleaned);
  if (outerBrace) candidates.push(outerBrace[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const val = (parsed as Record<string, unknown>)["claimed"];
        if (typeof val === "boolean") return val ? 1 : 0;
        if (typeof val === "number" && Number.isFinite(val)) {
          return Math.max(0, Math.min(1, val));
        }
        if (typeof val === "string") {
          const trimmedVal = val.trim();
          const num = Number(trimmedVal);
          if (trimmedVal !== "" && Number.isFinite(num)) return Math.max(0, Math.min(1, num));
          if (/^(?:true|yes)$/i.test(trimmedVal)) return 1;
          if (/^(?:false|no)$/i.test(trimmedVal)) return 0;
        }
      }
    } catch {
      // Try next fallback below.
    }
  }

  if (/^(?:true|yes)\b/i.test(cleaned)) return 1;
  if (/^(?:false|no)\b/i.test(cleaned)) return 0;
  return null;
}
