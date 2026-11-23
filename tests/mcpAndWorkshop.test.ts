import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateMcpToolVerdict,
  McpClient,
  McpHub,
  McpServerConfigSchema,
  validateMcpHttpUrl,
} from "../src/core/mcpClient.ts";
import { toolVerdict } from "../src/core/permissions.ts";
import {
  PluginManifestSchema,
  PluginRegistry,
  runPluginBundledEvals,
  signPluginManifest,
  verifyPluginBundle,
} from "../src/core/pluginSdk.ts";
import { McpSemanticBridge, SemanticResolver } from "../src/core/semanticBridge.ts";
import {
  installCreatorPack,
  parseValveKeyValuesLibraries,
  scanSteamWorkshopItems,
  signCreatorCatalog,
  verifyCreatorCatalog,
  WorkshopSubscriptionStore,
} from "../src/core/workshop.ts";
import { createObsCohostPlugin } from "../plugins/obs-cohost/index.ts";
import { createCodingCompanionPlugin } from "../plugins/coding-companion/index.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "astranavi-mcp-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Pillar 2, 3 & 4b: Native MCP bridge, Steam Workshop / Creator Packs, and Creator Plugins", () => {
  it("communicates over real stdio JSON-RPC MCP transport and enforces permission gates", async () => {
    const mockServerScript = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-stdio" } } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [
            { name: "read_note", description: "Read workspace note", annotations: { readOnlyHint: true } },
            { name: "delete_note", description: "Delete note", annotations: { readOnlyHint: false, destructiveHint: true } }
          ] } }) + "\\n");
        } else if (msg.method === "tools/call") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "note-content:" + JSON.stringify(msg.params.arguments) }] } }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
        }
      });
    `;

    const dir = await makeTempDir();
    const mockScriptPath = join(dir, "mock-mcp.cjs");
    await writeFile(mockScriptPath, mockServerScript, "utf8");

    const hub = new McpHub();
    hub.registerServer({
      id: "obsidian",
      transport: "stdio",
      command: process.execPath,
      args: [mockScriptPath],
      readOnlyAutoAllow: true,
    });

    try {
      const { connected, errors } = await hub.connectAll();
      expect(errors).toEqual({});
      expect(connected).toEqual(["obsidian"]);

      const tools = hub.listPrefixedTools();
      expect(tools.map((t) => t.fullName)).toEqual([
        "mcp:obsidian.read_note",
        "mcp:obsidian.delete_note",
      ]);

      const readVerdict = await toolVerdict("mcp:obsidian.read_note", { path: "daily.md" }, {
        workspace: "/tmp/ws",
        mcpPolicy: (name) => hub.verdictForTool(name, { workspace: "/tmp/ws" }),
      });
      expect(readVerdict.decision).toBe("allow");

      const escalatedVerdict = await toolVerdict("mcp:obsidian.read_note", {}, {
        workspace: "/tmp/ws",
        readOutsideText: true,
        mcpPolicy: (name) =>
          hub.verdictForTool(name, { workspace: "/tmp/ws", readOutsideText: true }),
      });
      expect(escalatedVerdict.decision).toBe("ask");

      const mutatingVerdict = hub.verdictForTool("mcp:obsidian.delete_note", { workspace: "/tmp/ws" });
      expect(mutatingVerdict.decision).toBe("ask");
      if (mutatingVerdict.decision === "ask") expect(mutatingVerdict.sensitive).toBe(true);

      const bridge = new McpSemanticBridge(hub);
      const resolver = new SemanticResolver(true);
      const res = await resolver.resolve({
        semanticBridge: () => bridge.execute({ tool: "mcp:obsidian.read_note", args: { tag: "inbox" } }),
      });
      expect(res.ok).toBe(true);
      if (res.ok && res.result) {
        expect(res.result.outsideText).toBe(true);
        expect(res.result.textSummary).toContain("note-content");
      }
    } finally {
      await hub.closeAll();
    }
  });

  it("communicates over real Streamable HTTP + SSE MCP transport and blocks SSRF metadata targets", async () => {
    expect(validateMcpHttpUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(validateMcpHttpUrl("http://example.com/mcp").ok).toBe(false);
    expect(validateMcpHttpUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateMcpHttpUrl("https://user:pass@localhost/mcp").ok).toBe(false);
    expect(validateMcpHttpUrl("http://127.0.0.1:4455/mcp").ok).toBe(true);

    const srv = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const msg = JSON.parse(body) as { id?: number; method: string };
        res.setHeader("Mcp-Session-Id", "sess-123");
        if (msg.method === "resources/read") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri: "mcp://doc", text: "SSE Stream OK" }] } })}\n\n`,
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        const result =
          msg.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {} }
            : msg.method === "resources/list"
              ? { resources: [{ uri: "mcp://doc", name: "Manual" }] }
              : { tools: [] };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });

    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const cfg = McpServerConfigSchema.parse({
        id: "sse-test",
        transport: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        readOnlyAutoAllow: false,
      });
      const client = new McpClient(cfg);
      await client.initialize();
      expect(await client.ping()).toBe(true);
      const list = await client.listResources();
      expect(list[0]?.uri).toBe("mcp://doc");
      const content = await client.readResource("mcp://doc");
      expect(content.text).toBe("SSE Stream OK");
      expect(content.outsideText).toBe(true);

      const deniedReadOnly = evaluateMcpToolVerdict(
        "sse-test",
        { name: "read", annotations: { readOnlyHint: true } },
        false,
        { readOutsideText: false },
      );
      expect(deniedReadOnly.decision).toBe("ask");
      await client.close();
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("scans Steam libraryfolders.vdf Workshop items and installs signed HTTPS creator packs", async () => {
    const dir = await makeTempDir();
    const steamRoot = join(dir, "Steam");
    const extraLib = join(dir, "FastNVMeLibrary");
    const appId = "3141590";

    await mkdir(join(steamRoot, "steamapps"), { recursive: true });
    await writeFile(
      join(steamRoot, "steamapps", "libraryfolders.vdf"),
      `"libraryfolders"\n{\n  "0" { "path" "${steamRoot}" }\n  "1" { "path" "${extraLib}" }\n}\n`,
    );

    const parsedLibs = parseValveKeyValuesLibraries(
      await readFile(join(steamRoot, "steamapps", "libraryfolders.vdf"), "utf8"),
    );
    expect(parsedLibs).toHaveLength(2);

    // Populate one character item & one plugin item in Steam Workshop dir
    const charItem = join(extraLib, "steamapps", "workshop", "content", appId, "9001");
    await mkdir(charItem, { recursive: true });
    const pmxBuf = Buffer.concat([
      Buffer.from("PMX ", "ascii"),
      Buffer.from([0, 0, 0, 0x40, 8, 1, 0, 1, 1, 1, 1, 1, 4]),
      Buffer.from([4, 0, 0, 0]),
      Buffer.from("Test", "utf8"),
      Buffer.from([4, 0, 0, 0]),
      Buffer.from("Test", "utf8"),
      Buffer.from([2, 0, 0, 0]),
      Buffer.from("OK", "utf8"),
      Buffer.from([2, 0, 0, 0]),
      Buffer.from("OK", "utf8"),
    ]);
    await writeFile(join(charItem, "model.pmx"), pmxBuf);
    await writeFile(
      join(charItem, "manifest.json"),
      JSON.stringify({
        id: "workshop-chibi",
        name: "Workshop Chibi",
        version: "1.0.0",
        author: "Community",
        license: "MIT",
        modelEntry: "model.pmx",
        modelFormat: "pmx",
      }),
    );

    const discovered = await scanSteamWorkshopItems({ appId, steamRoots: [steamRoot] });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.kind).toBe("character");
    expect(discovered[0]?.id).toBe("workshop-chibi");

    // Signed creator catalog & pack installation
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const packBytes = Buffer.from(JSON.stringify({ outfit: "bridge-coat" }), "utf8");
    const packSha = createHash("sha256").update(packBytes).digest("hex");

    const unsignedCatalog = {
      catalogVersion: 1 as const,
      publisher: "Astra Community Registry",
      issuedAt: "2026-11-23T00:00:00Z",
      packs: [
        {
          id: "bridge-coat-outfit",
          kind: "outfit" as const,
          name: "Captain Coat Outfit",
          version: "1.0.0",
          author: "ArtistB",
          license: "CC-BY-4.0",
          url: "https://example.invalid/packs/bridge-coat.json",
          sha256: packSha,
          sizeBytes: packBytes.length,
        },
      ],
    };
    const signature = signCreatorCatalog(unsignedCatalog, privateKey);
    const verified = verifyCreatorCatalog({ ...unsignedCatalog, signature }, [publicKey]);
    expect(verified.ok).toBe(true);

    const tampered = verifyCreatorCatalog(
      { ...unsignedCatalog, publisher: "Attacker", signature },
      [publicKey],
    );
    expect(tampered.ok).toBe(false);

    const store = new WorkshopSubscriptionStore(join(dir, "workshop-subscriptions.json"));
    await store.load();
    await store.syncFromSteam({ appId, steamRoots: [steamRoot] });

    const packEntry = unsignedCatalog.packs[0];
    if (!packEntry) throw new Error("missing pack entry");

    const installed = await installCreatorPack({
      entry: packEntry,
      installRoot: join(dir, "packs"),
      fetchBytes: async () => packBytes,
    });
    await store.subscribe(installed);
    expect(store.list().map((s) => s.id)).toEqual(["bridge-coat-outfit", "workshop-chibi"]);

    // Tampered download hash fails integrity check
    await expect(
      installCreatorPack({
        entry: packEntry,
        installRoot: join(dir, "packs"),
        fetchBytes: async () => Buffer.from("corrupted"),
      }),
    ).rejects.toThrow(/SHA-256/);
  });

  it("validates bundled obs-cohost and coding-companion creator plugin packs and runs their evals", async () => {
    const dir = await makeTempDir();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    for (const pluginId of ["obs-cohost", "coding-companion"]) {
      const manifestRaw = JSON.parse(
        await readFile(join("plugins", pluginId, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      const manifest = PluginManifestSchema.parse(manifestRaw);
      expect(manifest.defaultEnabled).toBe(false);

      const entryBytes = await readFile(join("plugins", pluginId, manifest.entry));
      const sig = signPluginManifest(manifest, privateKey);
      const check = await verifyPluginBundle({
        manifest,
        signature: sig,
        entryBytes,
        trustedPublicKeysPem: [publicKey],
        evalContext: { workspace: dir, home: dir },
      });
      expect(check, check.ok ? undefined : check.reason).toEqual({
        ok: true,
        manifest,
      });

      const registry = new PluginRegistry({ enabled: true, trustedPublicKeysPem: [publicKey] });
      expect((await registry.register({ manifest, signature: sig, entryBytes })).ok).toBe(true);

      const evalSummary = await runPluginBundledEvals(manifest, { workspace: dir, home: dir });
      expect(evalSummary.ok).toBe(true);
      expect(evalSummary.passed).toBe(4);
    }

    const obs = createObsCohostPlugin({
      fetchStatus: async () => ({ streaming: true, recording: false, currentScene: "Live Coding" }),
      switchScene: async (scene) => ({ ok: true, scene }),
    });
    const obsRes = await obs.handleTool("plugin:obs.highlight_chat", { sender: "Alex" });
    expect(obsRes["gesture"]).toBe("nod");
    expect(obsRes["outsideText"]).toBe(true);

    const cc = createCodingCompanionPlugin({
      workspace: dir,
      readGitDiff: async () => "diff --git a/a.ts b/a.ts\n+const x = 1;\n-const y = 2;\n",
      readDiagnostics: async () => [
        { severity: "error", file: join(dir, "a.ts"), message: "Oops", line: 1 },
      ],
      runTests: async (command) => ({ exitCode: 0, summary: `ran ${command}` }),
    });
    const diffRes = await cc.handleTool("plugin:code.git_diff_summary", {});
    expect(diffRes["filesChanged"]).toBe(1);
    expect(diffRes["insertions"]).toBe(1);
    await expect(cc.handleTool("plugin:code.diagnostics", { path: "/etc/passwd" })).rejects.toThrow(
      /outside the workspace/i,
    );
  });
});
