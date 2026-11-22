import { describe, expect, it, vi } from "vitest";
import {
  BrowserDomBridge,
  decodeLspMessages,
  decodeNativeMessages,
  EditorLspBridge,
  encodeLspMessage,
  encodeNativeMessage,
  isBrowserOriginAllowed,
  parseKWinTopology,
  parsePipeWireDump,
  PipeWireAudioBridge,
  SemanticResolver,
} from "../src/core/semanticBridge.ts";

describe("SemanticResolver & 4-tier priority ladder", () => {
  it("skips semantic-bridge when default-off, falling back to AT-SPI -> SoM -> raw input", async () => {
    const resolver = new SemanticResolver();
    expect(resolver.enabled).toBe(false);

    const semantic = vi.fn(async () => "from-bridge");
    const atSpi = vi.fn(async () => "from-atspi");

    const disabledRes = await resolver.resolve({ semanticBridge: semantic, atSpi });
    expect(semantic).not.toHaveBeenCalled();
    expect(disabledRes).toEqual({ ok: true, tierUsed: "at-spi", result: "from-atspi" });

    resolver.enabled = true;
    const enabledRes = await resolver.resolve({ semanticBridge: semantic, atSpi });
    expect(enabledRes).toEqual({ ok: true, tierUsed: "semantic-bridge", result: "from-bridge" });
  });
});

describe("Semantic bridges: PipeWire, LSP, Browser DOM, KWin", () => {
  it("parses PipeWire graph and invokes clamped wpctl volume adjustments", async () => {
    const dump = JSON.stringify([
      { id: 10, type: "PipeWire:Interface:Node", info: { props: { "node.name": "game", "application.name": "Game", "media.class": "Stream/Output/Audio" } } },
      { id: 20, type: "PipeWire:Interface:Link", info: { "output-node-id": 10, "input-node-id": 1 } },
    ]);
    const parsed = parsePipeWireDump(dump);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.links).toEqual([{ id: 20, outputNode: 10, inputNode: 1 }]);

    const run = vi.fn(async () => dump);
    const pw = new PipeWireAudioBridge(run);
    await pw.setNodeVolume(10, 140);
    expect(run).toHaveBeenCalledWith("wpctl", ["set-volume", "10", "100%"]);
  });

  it("frames & decodes LSP Content-Length JSON-RPC messages and ingests diagnostics", async () => {
    const m1 = encodeLspMessage({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///repo/main.ts",
        diagnostics: [{ range: { start: { line: 9 } }, severity: 1, message: "Type mismatch" }],
      },
    });
    const m2 = encodeLspMessage({ jsonrpc: "2.0", id: 2, result: [] });
    const joined = Buffer.concat([m1, m2]);

    const state = { buf: Buffer.alloc(0) };
    // Split mid-stream to exercise chunk reassembly
    const partA = decodeLspMessages(joined.subarray(0, 20), state);
    const partB = decodeLspMessages(joined.subarray(20), state);
    const all = [...partA, ...partB] as Record<string, unknown>[];
    expect(all).toHaveLength(2);

    const lsp = new EditorLspBridge();
    const diagMsg = all[0];
    expect(diagMsg).toBeDefined();
    if (diagMsg) lsp.ingestNotification(diagMsg);
    expect(await lsp.execute({ method: "diagnostics", uri: "file:///repo/main.ts" })).toEqual([
      { uri: "file:///repo/main.ts", line: 10, severity: "error", message: "Type mismatch" },
    ]);
  });

  it("frames native messaging payloads and enforces browser origin allowlist", async () => {
    const packet = encodeNativeMessage({ title: "Docs", ok: true });
    const decoded = decodeNativeMessages(packet);
    expect(decoded.rest.length).toBe(0);
    expect(decoded.messages).toEqual([{ title: "Docs", ok: true }]);

    const allow = ["https://docs.example.org"];
    expect(isBrowserOriginAllowed("https://docs.example.org/guide", allow)).toBe(true);
    expect(isBrowserOriginAllowed("http://127.0.0.1:8080/admin", allow)).toBe(false);
    expect(isBrowserOriginAllowed("file:///etc/passwd", allow)).toBe(false);
    expect(isBrowserOriginAllowed("chrome://settings", allow)).toBe(false);

    const bridge = new BrowserDomBridge({
      allowlist: () => allow,
      queryExtension: async (url) => ({ url, title: "Docs", articleText: "Hello" }),
    });
    await expect(bridge.readPage("https://evil.example.net")).rejects.toThrow(/refused/);
    expect((await bridge.readPage("https://docs.example.org/guide"))?.articleText).toBe("Hello");
  });

  it("validates KWin virtual desktop and activity topology", () => {
    expect(
      parseKWinTopology(
        JSON.stringify({ desktopCount: 4, currentDesktop: 2, activeActivity: "Work", activities: ["Work", "Gaming"] }),
      ),
    ).toEqual({ desktopCount: 4, currentDesktop: 2, activeActivity: "Work", activities: ["Work", "Gaming"] });
    expect(parseKWinTopology("{invalid")).toBeNull();
  });
});
