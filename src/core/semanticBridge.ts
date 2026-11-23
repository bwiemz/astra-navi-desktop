import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isPrivateIpv4 } from "./permissions.ts";

const execFileAsync = promisify(execFile);

/** Deterministic four-tier application inspection and control priority ladder (Spec §4.1). */
export type ResolutionTier = "semantic-bridge" | "at-spi" | "som-ocr" | "raw-input";

export type SemanticAppKind = "kwin" | "editor-lsp" | "browser-dom" | "pipewire";

export interface SemanticBridgeProvider<TReq = unknown, TRes = unknown> {
  readonly kind: SemanticAppKind;
  readonly name: string;
  supports(target: string): boolean;
  execute(request: TReq): Promise<TRes | null>;
}

export interface LadderHandlers<T> {
  semanticBridge?(): Promise<T | null>;
  atSpi?(): Promise<T | null>;
  somOcr?(): Promise<T | null>;
  rawInput?(): Promise<T | null>;
}

export type LadderResult<T> =
  | { ok: true; tierUsed: ResolutionTier; result: T }
  | { ok: false; tierUsed: null; reason: string };

/**
 * Resolves an application read or control request strictly down the 4-tier ladder:
 * 1. Direct Semantic Bridge -> 2. AT-SPI -> 3. Set-of-Mark GPU OCR -> 4. Raw Input.
 */
export class SemanticResolver {
  enabled: boolean;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  async resolve<T>(handlers: LadderHandlers<T>): Promise<LadderResult<T>> {
    const steps: readonly [ResolutionTier, (() => Promise<T | null>) | undefined][] = [
      ["semantic-bridge", this.enabled ? handlers.semanticBridge : undefined],
      ["at-spi", handlers.atSpi],
      ["som-ocr", handlers.somOcr],
      ["raw-input", handlers.rawInput],
    ];
    let lastError = "";
    for (const [tier, fn] of steps) {
      if (!fn) continue;
      try {
        const result = await fn();
        if (result !== null) {
          return { ok: true, tierUsed: tier, result };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ok: false,
      tierUsed: null,
      reason: lastError || "No resolution tier was able to handle the request.",
    };
  }
}

// ---------- 1. PipeWire Audio Graph Bridge ----------

export interface PipeWireNodeInfo {
  id: number;
  name: string;
  app: string;
  mediaClass: string;
}

export interface PipeWireLinkInfo {
  id: number;
  outputNode: number;
  inputNode: number;
}

/** Parses `pw-dump` JSON array into normalized audio nodes and graph links. */
export function parsePipeWireDump(rawJson: string): {
  nodes: PipeWireNodeInfo[];
  links: PipeWireLinkInfo[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { nodes: [], links: [] };
  }
  if (!Array.isArray(parsed)) return { nodes: [], links: [] };

  const nodes: PipeWireNodeInfo[] = [];
  const links: PipeWireLinkInfo[] = [];

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const type = obj["type"];
    const id = typeof obj["id"] === "number" ? obj["id"] : -1;
    const info = obj["info"] as Record<string, unknown> | undefined;
    if (id < 0 || !info) continue;

    if (type === "PipeWire:Interface:Node") {
      const props = info["props"] as Record<string, unknown> | undefined;
      if (!props) continue;
      nodes.push({
        id,
        name: String(props["node.name"] ?? ""),
        app: String(props["application.name"] ?? props["node.description"] ?? props["node.name"] ?? ""),
        mediaClass: String(props["media.class"] ?? ""),
      });
    } else if (type === "PipeWire:Interface:Link") {
      const outId = Number(info["output-node-id"]);
      const inId = Number(info["input-node-id"]);
      if (Number.isInteger(outId) && Number.isInteger(inId)) {
        links.push({ id, outputNode: outId, inputNode: inId });
      }
    }
  }
  return { nodes, links };
}

export class PipeWireAudioBridge {
  private readonly run: (program: string, args: readonly string[]) => Promise<string>;

  constructor(run?: (program: string, args: readonly string[]) => Promise<string>) {
    this.run =
      run ??
      (async (program, args) => {
        const res = await execFileAsync(program, args, {
          timeout: 5_000,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        });
        return res.stdout;
      });
  }

  async snapshot(): Promise<{ nodes: PipeWireNodeInfo[]; links: PipeWireLinkInfo[] }> {
    return parsePipeWireDump(await this.run("pw-dump", []));
  }

  async setNodeVolume(nodeId: number, percent: number): Promise<void> {
    if (!Number.isInteger(nodeId) || nodeId <= 0) {
      throw new Error("Give a positive PipeWire node id.");
    }
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await this.run("wpctl", ["set-volume", String(nodeId), `${clamped}%`]);
  }
}

// ---------- 2. Editor LSP JSON-RPC Framing Bridge ----------

/** Frames a JSON-RPC 2.0 message with `Content-Length` headers for LSP communication. */
export function encodeLspMessage(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, json]);
}

/** Incrementally decodes framed LSP JSON-RPC messages from a byte buffer. */
export function decodeLspMessages(chunk: Buffer, state: { buf: Buffer }): unknown[] {
  state.buf = Buffer.concat([state.buf, chunk]);
  const out: unknown[] = [];

  while (true) {
    const sep = state.buf.indexOf("\r\n\r\n");
    if (sep === -1) break;
    const header = state.buf.subarray(0, sep).toString("ascii");
    const lenMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lenMatch?.[1]) {
      state.buf = Buffer.alloc(0);
      break;
    }
    const bodyLen = Number.parseInt(lenMatch[1], 10);
    if (!Number.isFinite(bodyLen) || bodyLen < 0 || bodyLen > 16 * 1024 * 1024) {
      state.buf = Buffer.alloc(0);
      break;
    }
    const bodyStart = sep + 4;
    if (state.buf.length < bodyStart + bodyLen) break;
    const bodyBytes = state.buf.subarray(bodyStart, bodyStart + bodyLen);
    state.buf = state.buf.subarray(bodyStart + bodyLen);
    try {
      out.push(JSON.parse(bodyBytes.toString("utf8")) as unknown);
    } catch {
      // ignore malformed JSON-RPC frame
    }
  }
  return out;
}

export interface EditorDiagnostic {
  uri: string;
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export class EditorLspBridge implements SemanticBridgeProvider<
  { method: "diagnostics"; uri?: string },
  EditorDiagnostic[]
> {
  readonly kind = "editor-lsp" as const;
  readonly name = "Editor LSP";
  private readonly diagnosticsByUri = new Map<string, EditorDiagnostic[]>();

  supports(target: string): boolean {
    return /(code|vscode|codium|zed|kate|neovim|nvim)/i.test(target);
  }

  ingestNotification(msg: Record<string, unknown>): void {
    if (msg["method"] !== "textDocument/publishDiagnostics") return;
    const params = msg["params"] as Record<string, unknown> | undefined;
    const uri = typeof params?.["uri"] === "string" ? params["uri"] : "";
    const list = Array.isArray(params?.["diagnostics"]) ? params["diagnostics"] : [];
    if (!uri) return;
    const parsed: EditorDiagnostic[] = [];
    for (const d of list) {
      if (typeof d !== "object" || d === null) continue;
      const item = d as Record<string, unknown>;
      const range = item["range"] as Record<string, unknown> | undefined;
      const start = range?.["start"] as Record<string, unknown> | undefined;
      const line = typeof start?.["line"] === "number" ? start["line"] + 1 : 1;
      const sevNum = Number(item["severity"] ?? 1);
      const severity: EditorDiagnostic["severity"] =
        sevNum === 1 ? "error" : sevNum === 2 ? "warning" : "info";
      if (typeof item["message"] === "string") {
        parsed.push({ uri, line, severity, message: item["message"].slice(0, 400) });
      }
    }
    this.diagnosticsByUri.set(uri, parsed);
  }

  async execute(request: { method: "diagnostics"; uri?: string }): Promise<EditorDiagnostic[]> {
    if (request.uri) {
      return [...(this.diagnosticsByUri.get(request.uri) ?? [])];
    }
    return [...this.diagnosticsByUri.values()].flat();
  }
}

// ---------- 3. Browser Native Messaging DOM Bridge ----------

const MAX_NATIVE_MSG_BYTES = 1024 * 1024;

/** Encodes a Chrome/Firefox Native Messaging 32-bit LE length-prefixed JSON payload. */
export function encodeNativeMessage(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_NATIVE_MSG_BYTES) {
    throw new Error("Native messaging payload exceeded 1 MiB limit.");
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(json.length, 0);
  return Buffer.concat([lenBuf, json]);
}

/** Decodes complete Native Messaging frames, returning remaining partial bytes. */
export function decodeNativeMessages(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (len > MAX_NATIVE_MSG_BYTES) {
      return { messages, rest: Buffer.alloc(0) };
    }
    if (offset + 4 + len > buffer.length) break;
    const raw = buffer.subarray(offset + 4, offset + 4 + len).toString("utf8");
    offset += 4 + len;
    try {
      messages.push(JSON.parse(raw) as unknown);
    } catch {
      // skip invalid JSON
    }
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** Strict origin allowlist enforcing Spec §4.1 before reading browser DOM state. */
export function isBrowserOriginAllowed(rawUrl: string, allowlist: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const normalizedAllow = new Set(
    allowlist
      .map((entry) => {
        try {
          return new URL(entry).origin;
        } catch {
          return entry.trim().toLowerCase();
        }
      })
      .filter(Boolean),
  );
  if (!normalizedAllow.has(url.origin)) return false;

  // Private/loopback hosts must still match explicit exact origin (not wildcards).
  if (
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && isPrivateIpv4(host))
  ) {
    return normalizedAllow.has(url.origin);
  }
  return true;
}

export const NATIVE_HOST_NAME = "app.astranavi.dom_bridge";

export interface BrowserDomState {
  url: string;
  title: string;
  articleText: string;
  selection?: string;
  mediaPlaying?: {
    title: string;
    paused: boolean;
    playing?: boolean;
    artist?: string;
    currentTime?: number;
    duration?: number;
  } | null;
}

export class BrowserDomBridge {
  private readonly allowlist: () => readonly string[];
  private readonly queryExtension: (url: string) => Promise<BrowserDomState | null>;

  constructor(options: {
    allowlist: () => readonly string[];
    queryExtension: (url: string) => Promise<BrowserDomState | null>;
  }) {
    this.allowlist = options.allowlist;
    this.queryExtension = options.queryExtension;
  }

  async readPage(url: string): Promise<BrowserDomState | null> {
    if (!isBrowserOriginAllowed(url, this.allowlist())) {
      throw new Error(`Browser DOM bridge refused unlisted or restricted origin: ${url}`);
    }
    return this.queryExtension(url);
  }
}

export function defaultDomBridgeSocketPath(platform = process.platform): string {
  const override = process.env["ASTRA_NAVI_DOM_SOCKET"];
  if (override) return override;
  if (platform === "win32") return "\\\\.\\pipe\\astra-navi-dom-bridge";
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  const primary = join(base, "astra-navi");
  const legacy = join(base, "ai-chan");
  const dataRoot = !existsSync(primary) && existsSync(legacy) ? legacy : primary;
  return join(dataRoot, "scratch", "dom-bridge.sock");
}

/**
 * Connects over local Native Messaging IPC socket/pipe (`native-host.mjs`) to request
 * read-only page state from the browser extension, gated strictly by `allowlist`.
 */
export class NativeBrowserDomClient {
  private readonly allowlist: () => readonly string[];
  private readonly socketPath: () => string;
  private readonly timeoutMs: number;
  private readonly bridge: BrowserDomBridge;

  constructor(options: {
    allowlist: () => readonly string[];
    socketPath?: () => string;
    timeoutMs?: number;
  }) {
    this.allowlist = options.allowlist;
    this.socketPath = options.socketPath ?? (() => defaultDomBridgeSocketPath());
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.bridge = new BrowserDomBridge({
      allowlist: this.allowlist,
      queryExtension: (url) => this.requestNative("read-page", url),
    });
  }

  private requestNative(action: "read-page" | "ping", url?: string): Promise<BrowserDomState | null> {
    return new Promise((resolve, reject) => {
      const targetSocket = this.socketPath();
      const id = randomUUID();
      const socket = connect(targetSocket);
      let recv = Buffer.alloc(0);
      let settled = false;

      const finish = (err: Error | null, value: BrowserDomState | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };

      const timer = setTimeout(
        () => finish(new Error(`Browser DOM bridge timed out waiting for ${NATIVE_HOST_NAME}.`), null),
        this.timeoutMs,
      );

      socket.on("connect", () => {
        socket.write(encodeNativeMessage({ id, action, ...(url ? { url } : {}) }));
      });
      socket.on("data", (chunk: Buffer) => {
        const combined = Buffer.concat([recv, chunk]);
        const decoded = decodeNativeMessages(combined);
        recv = Buffer.from(decoded.rest);
        for (const msg of decoded.messages) {
          if (typeof msg !== "object" || msg === null) continue;
          const record = msg as Record<string, unknown>;
          if (record["id"] !== id) continue;
          if (record["ok"] !== true) {
            finish(new Error(String(record["error"] ?? "Browser DOM bridge failed.")), null);
            return;
          }
          const data = record["data"] as BrowserDomState | undefined;
          finish(null, data ?? null);
          return;
        }
      });
      socket.on("error", (err) => finish(err, null));
      socket.on("end", () => finish(new Error("Browser DOM bridge disconnected before replying."), null));
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.requestNative("ping");
      return true;
    } catch {
      return false;
    }
  }

  async readPage(url: string): Promise<BrowserDomState | null> {
    return this.bridge.readPage(url);
  }
}

// ---------- 4. KWin Topology Bridge ----------

export interface KWinTopology {
  desktopCount: number;
  currentDesktop: number;
  activeActivity: string;
  activities: string[];
}

export function parseKWinTopology(rawJson: string): KWinTopology | null {
  try {
    const obj = JSON.parse(rawJson) as Record<string, unknown>;
    const desktopCount = Number(obj["desktopCount"]);
    const currentDesktop = Number(obj["currentDesktop"]);
    if (!Number.isInteger(desktopCount) || desktopCount < 1) return null;
    if (!Number.isInteger(currentDesktop) || currentDesktop < 1) return null;
    const activities = Array.isArray(obj["activities"])
      ? obj["activities"].filter((a): a is string => typeof a === "string")
      : [];
    return {
      desktopCount,
      currentDesktop,
      activeActivity: typeof obj["activeActivity"] === "string" ? obj["activeActivity"] : "",
      activities,
    };
  } catch {
    return null;
  }
}
