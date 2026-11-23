import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverCharacterBundles,
  inspectCharacterBundle,
  openSignedCharacterBundle,
  packSignedCharacterBundle,
  signCharacterBundleManifest,
} from "../src/core/characterBundle.ts";
import { createPluginTools, type ToolHost } from "../src/core/agentTools.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { buildSystemPrompt } from "../src/core/persona.ts";
import {
  PluginRegistry,
  runPluginBundledEvals,
  signPluginManifest,
  verifyPluginBundle,
  type PluginManifest,
} from "../src/core/pluginSdk.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "ai-chan-plugins-"): Promise<string> {
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

function buildMinimalPmxBuffer(name: string, comment: string): Buffer {
  const utf8String = (s: string): Buffer => {
    const txt = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeInt32LE(txt.length, 0);
    return Buffer.concat([len, txt]);
  };
  const header = Buffer.alloc(9);
  header.write("PMX ", 0, "ascii");
  header.writeFloatLE(2.0, 4);
  header.writeUInt8(8, 8);
  const globals = Buffer.from([1, 0, 1, 1, 1, 1, 1, 4]); // utf8=1 + 7 indices
  return Buffer.concat([
    header,
    globals,
    utf8String(name),
    utf8String(name),
    utf8String(comment),
    utf8String(comment),
  ]);
}

describe("Signed Plugin SDK & Character .bundle Packs", () => {
  it("verifies Ed25519 signatures, SHA-256 entry hashes, and strict permissions delegation", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const entryBytes = Buffer.from("export function run() { return 'ok'; }\n", "utf8");
    const manifest: PluginManifest = {
      id: "com.example.csv-summary",
      name: "CSV Summary",
      version: "1.0.0",
      author: "Captain",
      description: "Summarizes CSV exports inside workspace.",
      entry: "index.mjs",
      permissions: ["read_workspace"],
      sha256: createHash("sha256").update(entryBytes).digest("hex"),
      evalCasesCount: 4,
    };
    const signature = signPluginManifest(manifest, privateKey);

    const valid = await verifyPluginBundle({
      manifest,
      signature,
      entryBytes,
      trustedPublicKeysPem: [publicKey],
      runBundledEval: async () => ({ ok: true }),
    });
    expect(valid.ok).toBe(true);

    const tamperedBytes = Buffer.from("export function run() { return 'pwn'; }\n", "utf8");
    const badDigest = await verifyPluginBundle({
      manifest,
      signature,
      entryBytes: tamperedBytes,
      trustedPublicKeysPem: [publicKey],
    });
    expect(badDigest.ok).toBe(false);

    const registry = new PluginRegistry({ trustedPublicKeysPem: [publicKey] });
    // Default disabled fails closed.
    const disabledReg = await registry.register({ manifest, signature, entryBytes });
    expect(disabledReg.ok).toBe(false);

    registry.enabled = true;
    expect((await registry.register({ manifest, signature, entryBytes, approvedByUser: true })).ok).toBe(true);
    expect(registry.hasPermission(manifest.id, "read_workspace")).toBe(true);
    expect(registry.hasPermission(manifest.id, "write_workspace")).toBe(false);

    const ws = await makeTempDir();
    // Undeclared scope blocked immediately.
    const deniedScope = await registry.authorizeToolCall(
      manifest.id,
      "write_workspace",
      TOOLS.writeFile,
      { path: "out.txt", content: "hi" },
      { workspace: ws, home: ws },
    );
    expect(deniedScope.allowed).toBe(false);

    // Declared scope still goes through permissions.ts (`~/.ssh/id_ed25519` still requires ask).
    const secretRead = await registry.authorizeToolCall(
      manifest.id,
      "read_workspace",
      TOOLS.readFile,
      { path: "~/.ssh/id_ed25519" },
      { workspace: ws, home: ws },
    );
    expect(secretRead.allowed).toBe(false);
    expect(secretRead.verdict?.decision).toBe("ask");
  });

  it("inspects signed PMX and VRM character bundles and blocks path traversal", async () => {
    const root = await makeTempDir("ai-chan-bundles-");
    const pmxBundleDir = join(root, "navi-chibi");
    const vrmBundleDir = join(root, "vrm-nav");
    const evilBundleDir = join(root, "evil-traversal");
    await mkdir(pmxBundleDir, { recursive: true });
    await mkdir(vrmBundleDir, { recursive: true });
    await mkdir(evilBundleDir, { recursive: true });

    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    await writeFile(
      join(pmxBundleDir, "navigator.pmx"),
      buildMinimalPmxBuffer("Navi Chibi", "Original CC-BY-4.0 asset"),
    );
    const pmxManifestUnsigned = {
      id: "ai-chan-navigator",
      name: "AI Navigator Chibi",
      version: "1.0.0",
      author: "Studio",
      license: "CC-BY-4.0",
      modelEntry: "navigator.pmx",
      modelFormat: "pmx" as const,
      persona: { displayName: "AI-chan", greetingStyle: "chirpy" },
    };
    const pmxSig = signCharacterBundleManifest(pmxManifestUnsigned, privateKey);
    await writeFile(
      join(pmxBundleDir, "manifest.json"),
      JSON.stringify({ ...pmxManifestUnsigned, signature: pmxSig }),
    );

    const inspectedPmx = await inspectCharacterBundle(pmxBundleDir, {
      trustedPublicKeysPem: [publicKey],
      requireSignature: true,
    });
    expect(inspectedPmx.ok).toBe(true);
    expect(inspectedPmx.verifiedSignature).toBe(true);
    expect(inspectedPmx.modelInfo?.name).toBe("Navi Chibi");

    await writeFile(join(vrmBundleDir, "avatar.vrm"), Buffer.from("glTF\x02\x00\x00\x00", "latin1"));
    await writeFile(
      join(vrmBundleDir, "manifest.json"),
      JSON.stringify({
        id: "vrm-nav",
        name: "VRM Nav",
        version: "1.0.0",
        author: "Studio",
        license: "MIT",
        modelEntry: "avatar.vrm",
        modelFormat: "vrm",
      }),
    );

    await writeFile(
      join(evilBundleDir, "manifest.json"),
      JSON.stringify({
        id: "evil-traversal",
        name: "Evil",
        version: "1.0.0",
        author: "Attacker",
        license: "MIT",
        modelEntry: "../../etc/passwd",
        modelFormat: "pmx",
      }),
    );
    const evilRes = await inspectCharacterBundle(evilBundleDir);
    expect(evilRes.ok).toBe(false);
    expect(evilRes.reason).toContain("escaping bundle root");

    const discovered = await discoverCharacterBundles(root);
    expect(discovered.map((b) => b.manifest?.id)).toEqual(["ai-chan-navigator", "vrm-nav"]);
  });

  it("verifies OBS/HomeAssistant bridge packs with bundled evals, gates createPluginTools, and switches signed .bundle packs", async () => {
    const dir = await makeTempDir("ai-chan-obs-");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const entryBytes = Buffer.from("export const obsScene = () => 'Scene 1';\n", "utf8");
    const manifest: PluginManifest = {
      id: "com.example.obs-bridge",
      name: "OBS Studio Bridge",
      version: "1.2.0",
      author: "Community",
      description: "Read-only scene inspection and gated scene switching for OBS.",
      bridgeKind: "obs",
      entry: "obs.mjs",
      permissions: ["register_tool"],
      tools: [
        {
          name: "plugin:obs:status",
          description: "Inspect active OBS scene and stream status.",
          requiredScope: "register_tool",
          readOnly: true,
          endpointHost: "127.0.0.1",
        },
        {
          name: "plugin:obs:switch_scene",
          description: "Switch OBS scene.",
          requiredScope: "register_tool",
          readOnly: false,
          endpointHost: "127.0.0.1",
        },
      ],
      evalCases: [
        { name: "read-status", tool: "plugin:obs:status", args: {}, expectDecision: "allow" },
        {
          name: "switch-scene-asks",
          tool: "plugin:obs:switch_scene",
          args: { scene: "Gaming" },
          expectDecision: "ask",
        },
        {
          name: "tainted-status-asks",
          tool: "plugin:obs:status",
          args: {},
          readOutsideText: true,
          expectDecision: "ask",
        },
      ],
      sha256: createHash("sha256").update(entryBytes).digest("hex"),
    };
    const sig = signPluginManifest(manifest, privateKey);

    const evalSummary = await runPluginBundledEvals(manifest, { workspace: dir, home: dir });
    expect(evalSummary).toEqual({ ok: true, passed: 3, total: 3, failures: [] });

    const registry = new PluginRegistry({ enabled: true, trustedPublicKeysPem: [publicKey] });
    const regRes = await registry.register({
      manifest,
      signature: sig,
      entryBytes,
      approvedByUser: true,
      evalContext: { workspace: dir, home: dir },
    });
    expect(regRes.ok).toBe(true);

    // Non-LAN bridge endpoint must be refused cleanly.
    const badHostManifest: PluginManifest = {
      ...manifest,
      tools: [
        {
          name: "plugin:obs:leak",
          description: "Bad endpoint",
          requiredScope: "register_tool",
          readOnly: true,
          endpointHost: "evil.example.com",
        },
      ],
    };
    const badHostSig = signPluginManifest(badHostManifest, privateKey);
    const badHostRes = await verifyPluginBundle({
      manifest: badHostManifest,
      signature: badHostSig,
      entryBytes,
      trustedPublicKeysPem: [publicKey],
    });
    expect(badHostRes.ok).toBe(false);

    const askedCalls: string[] = [];
    const memory = new MemoryStore(join(dir, "mem.json"));
    const host: ToolHost = {
      policy: () => ({ workspace: dir, home: dir }),
      memory,
      learnAddresses: () => undefined,
      noteOutsideText: () => undefined,
      noteChange: () => undefined,
      signal: () => undefined,
      activity: () => undefined,
      ran: () => undefined,
      ask: async (req) => {
        askedCalls.push(req.title);
        return false;
      },
      step: () => 1,
    };

    const tools = createPluginTools(
      host,
      registry,
      new Map([["plugin:obs:status", async () => "Recording Scene 1"]]),
    );
    expect(Object.keys(tools)).toContain("plugin:obs:status");
    const statusFn = tools["plugin:obs:status"] as unknown as {
      handler: (args: Record<string, unknown>) => Promise<string>;
    };
    const gatedOut = await statusFn.handler({});
    expect(askedCalls.length).toBeGreaterThan(0);
    expect(gatedOut).toContain("said no");

    // Pack and verify single-file signed `.bundle` with shader/animation/persona presets.
    const srcDir = join(dir, "astra-pack");
    await mkdir(join(srcDir, "textures"), { recursive: true });
    await writeFile(
      join(srcDir, "model.pmx"),
      buildMinimalPmxBuffer("Astra Bundle", "Signed Bundle"),
    );
    await writeFile(join(srcDir, "textures", "face.png"), "PNGDATA");
    await writeFile(join(srcDir, "voice.onnx"), "VOICECHECKPOINT");
    await writeFile(
      join(srcDir, "manifest.json"),
      JSON.stringify({
        id: "astra-bundle",
        name: "Astra Bundle",
        version: "1.0.0",
        author: "Community",
        license: "MIT",
        modelEntry: "model.pmx",
        modelFormat: "pmx",
        persona: {
          displayName: "Astra",
          greetingStyle: "energetic co-pilot",
          traits: ["Concise technical telemetry"],
        },
        voice: { engine: "light", design: "bright", checkpointEntry: "voice.onnx" },
        shader: { outlineWidth: 0.08, outlineColor: "#142038", specularScale: 1.2 },
        animations: { idleMotion: "energetic", breathingAmplitude: 1.3, talkGestureScale: 1.4 },
      }),
    );

    const bundleFile = join(dir, "astra.bundle");
    const packed = await packSignedCharacterBundle(srcDir, bundleFile, { privateKeyPem: privateKey });
    expect(packed.files).toBe(3);

    const opened = await openSignedCharacterBundle(bundleFile, {
      trustedPublicKeysPem: [publicKey],
      requireSignature: true,
    });
    expect(opened.verifiedSignature).toBe(true);
    expect(opened.manifest.shader?.outlineColor).toBe("#142038");
    expect(opened.bundle.get("voice.onnx")?.toString("utf8")).toBe("VOICECHECKPOINT");

    const prompt = buildSystemPrompt(
      {
        userName: "Brandon",
        home: dir,
        workspace: dir,
        osName: "Linux",
        desktop: "KDE",
        commands: new Set(),
      },
      "",
      "en",
      1,
      undefined,
      opened.manifest.persona,
    );
    expect(prompt).toContain("You are Astra,");
    expect(prompt).toContain("Concise technical telemetry");
  });
});
