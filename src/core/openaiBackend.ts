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

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function isMetadataHost(host: string): boolean {
  return (
    host === "169.254.169.254" ||
    host === "169.254.170.2" ||
    host === "metadata.google.internal" ||
    host === "metadata"
  );
}

function isPrivateLanHost(host: string): boolean {
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) {
    return true;
  }
  // IPv4 RFC 1918 + Carrier-Grade NAT / Tailscale (100.64.0.0/10)
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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

/** Converts `node-llama-cpp` function definitions (including MCP tools) into OpenAI `tools`. */
export function convertFunctionsToOpenAiTools(
  functions: ChatSessionModelFunctions | undefined,
): OpenAiToolSpec[] {
  if (!functions) return [];
  const out: OpenAiToolSpec[] = [];
  for (const [name, fn] of Object.entries(functions)) {
    const rawParams = fn.params as Record<string, unknown> | undefined;
    const parameters: Record<string, unknown> =
      rawParams && typeof rawParams === "object"
        ? rawParams
        : { type: "object", properties: {} };
    out.push({
      type: "function",
      function: {
        name,
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
          toolCalls.push({
            id: callId,
            type: "function",
            function: {
              name: part.name,
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
  private systemPrompt: string;
  private history: ChatHistoryItem[] = [];
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    config: InferenceBackendConfig,
    systemPrompt: string,
    fetchImpl: typeof fetch = fetch,
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

  async decide(): Promise<{ claimed: { value: number } }> {
    return { claimed: { value: 0 } };
  }

  dispose(): void {
    // Stateless HTTP client; nothing to free.
  }

  async prompt(text: string, options: ChatSessionPromptOptions = {}): Promise<string> {
    const userItem: ChatHistoryItem = { type: "user", text };
    const wire = historyToWireMessages(this.systemPrompt, [...this.history, userItem]);
    const tools = convertFunctionsToOpenAiTools(options.functions);
    const modelResponseParts: ChatModelResponse["response"] = [];
    let finalAssistantText = "";

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      if (options.signal?.aborted) break;

      const stepResult = await this.streamOneStep(wire, tools, options);
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

      const limit = options.maxParallelFunctionCalls ?? stepResult.toolCalls.length;
      const callsToRun = stepResult.toolCalls.slice(0, Math.max(1, limit));

      for (const call of callsToRun) {
        if (options.signal?.aborted) break;
        const fn = options.functions[call.name];
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
          resultText = `That failed: unknown tool "${call.name}".`;
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
          name: call.name,
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

    this.history.push(userItem, { type: "model", response: modelResponseParts });
    return finalAssistantText;
  }

  private async streamOneStep(
    messages: readonly WireMessage[],
    tools: readonly OpenAiToolSpec[],
    options: ChatSessionPromptOptions,
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
    if (tools.length > 0) bodyPayload["tools"] = tools;

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
            functionName: acc.name,
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
