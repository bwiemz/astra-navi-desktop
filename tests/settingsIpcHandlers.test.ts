import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

const { invokeHandlers, mockWebContents } = vi.hoisted(() => {
  const invokeHandlers = new Map<string, IpcHandler>();
  const mockWebContents = {
    id: 42,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
  };
  return { invokeHandlers, mockWebContents };
});

vi.mock("electron", () => {
  class MockBrowserWindow {
    webContents = mockWebContents;
    private destroyed = false;
    isDestroyed(): boolean {
      return this.destroyed;
    }
    removeMenu(): void {
      // no-op
    }
    once(): void {
      // no-op
    }
    on(): void {
      // no-op
    }
    show(): void {
      // no-op
    }
    focus(): void {
      // no-op
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    app: {
      isPackaged: false,
      getVersion: () => "1.0.0-test",
      getAppPath: () => process.cwd(),
      getPath: () => tmpdir(),
    },
    BrowserWindow: MockBrowserWindow,
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    },
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => {
        invokeHandlers.set(channel, handler);
      },
      on: vi.fn(),
    },
    shell: {
      showItemInFolder: vi.fn(),
    },
  };
});

import { ConfigStore } from "../src/core/config.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { TraceKeeper } from "../src/core/trace.ts";
import { createSettingsController, resolveProbeApiKey } from "../src/main/settingsIpc.ts";
import type { SettingsView } from "../src/shared/settings.ts";

const tempDirs: string[] = [];
const prevDataDir = process.env["ASTRA_NAVI_DATA_DIR"];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  invokeHandlers.clear();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env["ASTRA_NAVI_DATA_DIR"];
  else process.env["ASTRA_NAVI_DATA_DIR"] = prevDataDir;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Real Settings IPC Handlers (createSettingsController)", () => {
  it("enforces sender isolation, redacts API keys, guards saved key by origin on Test, and edits memory without unloading the model", async () => {
    const dir = await makeTempDir("astra-settings-ipc-");
    process.env["ASTRA_NAVI_DATA_DIR"] = dir;

    const config = new ConfigStore(join(dir, "config.json"));
    await config.load();
    await config.update({
      inference: {
        provider: "openai-compatible",
        preset: "custom",
        baseUrl: "https://trusted.example/v1",
        model: "qwen3.5:9b",
        apiKey: "sk-super-secret-prod-999",
      },
      mcp: {
        servers: [
          {
            id: "ha",
            name: "Home Assistant",
            transport: "http",
            enabled: true,
            url: "http://127.0.0.1:8123/mcp",
            headers: { Authorization: "Bearer mcp-secret-token-777" },
            readOnlyAutoAllow: false,
          },
        ],
      },
    });
    const memory = new MemoryStore(join(dir, "memory.json"));
    await memory.load();

    let memoryChangedCalls = 0;
    let characterChangedCalls = 0;
    const probeRequests: { url: string; auth: string | null }[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      probeRequests.push({ url, auth: headers.get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "qwen3.5:9b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const controller = createSettingsController({
      appOrigin: "app://astra-navi",
      config,
      engine: () => null,
      memoryStore: () => memory,
      archive: () => null,
      traces: new TraceKeeper(10),
      noticeWatch: () => null,
      initiative: () => null,
      reach: () => null,
      searchBudget: () => null,
      designedVoices: () => [],
      fullVoiceReady: () => false,
      createVoice: async () => undefined,
      chooseBrain: () => undefined,
      chooseLean: () => undefined,
      chooseLanguage: () => undefined,
      chooseVoice: () => undefined,
      setHandsOff: async () => undefined,
      forgetConversations: async () => undefined,
      showLearned: async () => undefined,
      showActions: async () => undefined,
      showSelfCheck: async () => undefined,
      onMemoryChanged: () => {
        memoryChangedCalls += 1;
      },
      onCharacterChanged: () => {
        characterChangedCalls += 1;
      },
      probeFetch: mockFetch,
      sendToWindow: () => undefined,
      rebuildTrayMenu: () => undefined,
    });

    controller.openSettings();
    controller.registerSettingsIpc();

    const validEvent = { sender: mockWebContents };
    const attackerEvent = { sender: { id: 999 } };

    // 1. Unauthorized sender from another window is rejected on every sensitive handler.
    const loadHandler = invokeHandlers.get("settings:load");
    const saveHandler = invokeHandlers.get("settings:save");
    const testInfHandler = invokeHandlers.get("settings:test-inference");
    const memAddHandler = invokeHandlers.get("settings:memory-add");
    const memUpdateHandler = invokeHandlers.get("settings:memory-update");
    const memPinHandler = invokeHandlers.get("settings:memory-pin");
    const memForgetHandler = invokeHandlers.get("settings:memory-forget");
    const exportBundleHandler = invokeHandlers.get("settings:export-support-bundle");

    if (
      !loadHandler ||
      !saveHandler ||
      !testInfHandler ||
      !memAddHandler ||
      !memUpdateHandler ||
      !memPinHandler ||
      !memForgetHandler ||
      !exportBundleHandler
    ) {
      throw new Error("Expected all settings IPC handlers to register.");
    }

    await expect(Promise.resolve().then(() => loadHandler(attackerEvent))).rejects.toThrow(/Not allowed/i);
    await expect(Promise.resolve().then(() => testInfHandler(attackerEvent, {}))).rejects.toThrow(
      /Not allowed/i,
    );

    // 2. settings:load exposes hasApiKey: true while NEVER exposing the raw secret key.
    const view = (await loadHandler(validEvent)) as SettingsView;
    expect(view.inference.hasApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain("sk-super-secret-prod-999");

    // 3. settings:test-inference ONLY sends saved API key when target origin === saved origin!
    const sameOriginProbe = (await testInfHandler(validEvent, {
      baseUrl: "https://trusted.example/v1",
      apiKey: "",
    })) as { ok: boolean };
    expect(sameOriginProbe.ok).toBe(true);
    expect(probeRequests.at(-1)?.auth).toBe("Bearer sk-super-secret-prod-999");

    // Different host (attacker URL) with blank typed key MUST NOT receive saved key!
    const diffHostProbe = (await testInfHandler(validEvent, {
      baseUrl: "https://attacker.example/v1",
      apiKey: "",
    })) as { ok: boolean };
    expect(diffHostProbe.ok).toBe(true);
    expect(probeRequests.at(-1)?.auth).toBeNull();

    // Different port on loopback MUST NOT receive saved key either!
    expect(
      resolveProbeApiKey(
        "http://127.0.0.1:9999/v1",
        "",
        "http://127.0.0.1:11434/v1",
        "saved-local-key",
      ),
    ).toBe("");

    // Plaintext http:// to a public internet host is blocked before any network call!
    const countBeforeHttp = probeRequests.length;
    const plainHttpProbe = (await testInfHandler(validEvent, {
      baseUrl: "http://public-api.example/v1",
      apiKey: "",
    })) as { ok: boolean; error?: string };
    expect(plainHttpProbe.ok).toBe(false);
    expect(plainHttpProbe.error).toMatch(/https:\/\//i);
    expect(probeRequests.length).toBe(countBeforeHttp);

    // 4. settings:save also rejects plaintext http:// to internet hosts.
    await expect(
      saveHandler(validEvent, {
        inference: {
          provider: "openai-compatible",
          baseUrl: "http://api.openai.com/v1",
          model: "gpt-4o",
        },
      }),
    ).rejects.toThrow(/https:\/\//i);

    // 5. settings:memory-{add,pin,update,forget} trigger onMemoryChanged (lightweight refresh),
    //    NEVER onCharacterChanged / model unload!
    const added = (await memAddHandler(validEvent, {
      kind: "fact",
      text: "Uses Arch Linux on desktop",
      pinned: false,
    })) as { ok: boolean; snapshot: { entries: { id: string; text: string; pinned?: boolean }[] } };
    expect(added.ok).toBe(true);
    const noteId = added.snapshot.entries[0]?.id ?? "";
    expect(noteId).toBeTruthy();

    const pinned = (await memPinHandler(validEvent, { id: noteId, pinned: true })) as {
      ok: boolean;
      snapshot: { entries: { id: string; pinned?: boolean }[] };
    };
    expect(pinned.ok).toBe(true);
    expect(pinned.snapshot.entries[0]?.pinned).toBe(true);

    const updated = (await memUpdateHandler(validEvent, {
      id: noteId,
      text: "Uses Arch Linux + KDE Wayland",
    })) as { ok: boolean; snapshot: { entries: { text: string }[] } };
    expect(updated.ok).toBe(true);
    expect(updated.snapshot.entries[0]?.text).toBe("Uses Arch Linux + KDE Wayland");

    const forgotten = (await memForgetHandler(validEvent, noteId)) as {
      ok: boolean;
      snapshot: { entries: unknown[] };
    };
    expect(forgotten.ok).toBe(true);
    expect(forgotten.snapshot.entries).toHaveLength(0);

    expect(memoryChangedCalls).toBe(4);
    expect(characterChangedCalls).toBe(0);

    // 6. settings:export-support-bundle redacts BOTH inference API key AND MCP secret header on disk!
    const exported = (await exportBundleHandler(validEvent)) as { path: string; bytes: number };
    const bundleText = await readFile(exported.path, "utf8");
    expect(bundleText).not.toContain("sk-super-secret-prod-999");
    expect(bundleText).not.toContain("mcp-secret-token-777");
  });
});
