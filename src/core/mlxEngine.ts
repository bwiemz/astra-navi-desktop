import type { BrainModel } from "./models.ts";

/**
 * Apple Silicon MLX Inference Backend (`darwin` / `arm64`).
 *
 * Connects exclusively over localhost (`127.0.0.1` / `localhost` / `::1`) to a local
 * `mlx_lm.server` (or Apple Silicon MLX runtime daemon) with SSE streaming and OpenAI-style
 * tool-call parsing, falling back cleanly to `node-llama-cpp` Metal when absent.
 */

export interface MlxModelSpec {
  tier: BrainModel["id"];
  repoId: string;
  label: string;
  approxUnifiedGb: number;
  maxContext: number;
}

export const MLX_MODELS: Record<BrainModel["id"], MlxModelSpec> = {
  small: {
    tier: "small",
    repoId: "mlx-community/Qwen2.5-7B-Instruct-4bit",
    label: "Qwen 2.5 7B (MLX 4-bit)",
    approxUnifiedGb: 5,
    maxContext: 32_768,
  },
  standard: {
    tier: "standard",
    repoId: "mlx-community/Qwen3-14B-4bit",
    label: "Qwen 3 14B (MLX 4-bit)",
    approxUnifiedGb: 10,
    maxContext: 32_768,
  },
  large: {
    tier: "large",
    repoId: "mlx-community/Qwen2.5-32B-Instruct-4bit",
    label: "Qwen 2.5 32B (MLX 4-bit)",
    approxUnifiedGb: 20,
    maxContext: 65_536,
  },
  xl: {
    tier: "xl",
    repoId: "mlx-community/Qwen2.5-72B-Instruct-4bit",
    label: "Qwen 2.5 72B (MLX 4-bit)",
    approxUnifiedGb: 44,
    maxContext: 65_536,
  },
};

export interface MlxChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface MlxToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface MlxToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface MlxStreamResult {
  text: string;
  toolCalls: MlxToolCall[];
  finishReason: string | null;
}

export interface MlxBackendOptions {
  baseUrl?: string;
  tier?: BrainModel["id"];
  modelId?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
}

/** Ensures MLX local inference never dials off-machine or metadata endpoints. */
export function validateLocalMlxUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:") {
    throw new Error(`Local MLX server URL must use http:// on loopback (got ${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new Error("Local MLX server URL must not embed credentials.");
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Refused non-loopback MLX host "${host}"; local inference must remain on device.`);
  }
  return url;
}

export class MlxBackend {
  readonly baseUrl: URL;
  readonly modelId: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetchImpl: typeof fetch;
  private activeController: AbortController | null = null;
  private resting = true;

  constructor(options: MlxBackendOptions = {}) {
    const rawUrl = options.baseUrl ?? process.env["ASTRA_NAVI_MLX_URL"] ?? "http://127.0.0.1:8080";
    this.baseUrl = validateLocalMlxUrl(rawUrl);
    const tier = options.tier ?? "large";
    this.modelId = options.modelId ?? MLX_MODELS[tier].repoId;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get isResting(): boolean {
    return this.resting;
  }

  /** Probes Apple Silicon architecture and local MLX runtime readiness (`/v1/models`). */
  async isAvailable(): Promise<{ available: boolean; models: string[]; reason?: string }> {
    if (this.platform !== "darwin" || this.arch !== "arm64") {
      return {
        available: false,
        models: [],
        reason: `MLX requires Apple Silicon (darwin/arm64), running on ${this.platform}/${this.arch}.`,
      };
    }
    try {
      const res = await this.fetchImpl(new URL("/v1/models", this.baseUrl).toString(), {
        method: "GET",
      });
      if (!res.ok) {
        return { available: false, models: [], reason: `MLX server returned HTTP ${res.status}.` };
      }
      const data = (await res.json()) as { data?: { id?: string }[] };
      const models = Array.isArray(data?.data)
        ? data.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
        : [];
      return { available: true, models };
    } catch (err) {
      return {
        available: false,
        models: [],
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Streams completions and structured tool calls from local `mlx_lm.server`. */
  async chatStream(options: {
    messages: readonly MlxChatMessage[];
    tools?: readonly MlxToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    onDelta?: (textDelta: string) => void;
  }): Promise<MlxStreamResult> {
    this.resting = false;
    const controller = new AbortController();
    this.activeController = controller;
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const res = await this.fetchImpl(new URL("/v1/chat/completions", this.baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: this.modelId,
        messages: options.messages,
        ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        temperature: options.temperature ?? 0.6,
        max_tokens: options.maxTokens ?? 1024,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`MLX server error: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    let finishReason: string | null = null;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    const handleSseLine = (line: string): void => {
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
      if (typeof first["finish_reason"] === "string") {
        finishReason = first["finish_reason"];
      }
      const delta = first["delta"] as Record<string, unknown> | undefined;
      if (!delta) return;
      if (typeof delta["content"] === "string" && delta["content"].length > 0) {
        fullText += delta["content"];
        options.onDelta?.(delta["content"]);
      }
      const deltaTools = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
      for (const item of deltaTools) {
        if (typeof item !== "object" || item === null) continue;
        const tc = item as Record<string, unknown>;
        const idx = typeof tc["index"] === "number" ? tc["index"] : 0;
        const cur = toolAcc.get(idx) ?? {
          id: typeof tc["id"] === "string" ? tc["id"] : `call_${idx}`,
          name: "",
          args: "",
        };
        if (typeof tc["id"] === "string") cur.id = tc["id"];
        const fn = tc["function"] as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn["name"] === "string") cur.name += fn["name"];
          if (typeof fn["arguments"] === "string") cur.args += fn["arguments"];
        }
        toolAcc.set(idx, cur);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          handleSseLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) handleSseLine(buffer);
    } finally {
      this.activeController = null;
    }

    const toolCalls: MlxToolCall[] = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({ id: v.id, name: v.name, argumentsJson: v.args }));

    return { text: fullText, toolCalls, finishReason };
  }

  rest(): void {
    this.activeController?.abort();
    this.activeController = null;
    this.resting = true;
  }

  dispose(): void {
    this.rest();
  }
}

/** Selects `"mlx"` on Apple Silicon when an MLX server is reachable; falls back cleanly to `"llama.cpp"` Metal. */
export async function selectLocalInferenceBackend(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  preferMlx?: boolean;
  mlxBackend?: MlxBackend;
}): Promise<{ backend: "mlx" | "llama.cpp"; reason: string }> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    return { backend: "llama.cpp", reason: `Using node-llama-cpp backend on ${platform}/${arch}.` };
  }
  if (options.preferMlx === false) {
    return { backend: "llama.cpp", reason: "MLX disabled by configuration; using node-llama-cpp Metal." };
  }
  const backend = options.mlxBackend ?? new MlxBackend({ platform, arch });
  const probe = await backend.isAvailable();
  if (probe.available) {
    return { backend: "mlx", reason: `Apple Silicon MLX active (${probe.models.length} local model(s)).` };
  }
  return {
    backend: "llama.cpp",
    reason: `MLX server unreachable (${probe.reason ?? "offline"}); falling back to node-llama-cpp Metal.`,
  };
}
