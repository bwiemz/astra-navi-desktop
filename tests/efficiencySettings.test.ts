import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import {
  describeSelfCheck,
  describeWorkingMemory,
  selfCheck,
  type SelfCheckInputs,
} from "../src/core/selfCheck.ts";
import type { SpokenAudio, VoiceBackend } from "../src/core/voice/backend.ts";
import { Speaker } from "../src/core/voice/speaker.ts";
import { programShown } from "../src/main/shown.ts";

const ROOT = join(import.meta.dirname, "..");
const source = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-efficiency-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the settings for giving the card back and for less graphics memory", () => {
  it("gives the card back to games unless told not to, and is not lean unless told to", async () => {
    const config = new ConfigStore(join(dir, "config.json"));
    expect((await config.load()).yieldToGames).toBe(true);
    expect(config.value.leanMemory).toBe(false);
  });

  it("keeps what the user chose across a restart", async () => {
    const file = join(dir, "config.json");
    const first = new ConfigStore(file);
    await first.load();
    await first.update({ yieldToGames: false, leanMemory: true });
    const second = new ConfigStore(file);
    await second.load();
    expect(second.value.yieldToGames).toBe(false);
    expect(second.value.leanMemory).toBe(true);
    // the settings beside them are untouched
    expect(second.value.idleUnloadMinutes).toBe(10);
  });

  it("reads a settings file written before these existed", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ brain: "small", idleUnloadMinutes: 5 }));
    const config = new ConfigStore(file);
    await config.load();
    expect(config.value).toMatchObject({
      brain: "small",
      idleUnloadMinutes: 5,
      yieldToGames: true,
      leanMemory: false,
    });
  });

  it("ignores a settings file where one of them is not a yes or a no", async () => {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ brain: "small", leanMemory: "very" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const config = new ConfigStore(file);
      await config.load();
      expect(config.value.leanMemory).toBe(false);
      expect(config.value.brain).toBe("auto");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the two switches, from the settings page to the engine", () => {
  it("are accepted by the app as a yes or a no and nothing else", async () => {
    const schemaSource = await source("src/main/settingsSchema.ts");
    const schema = schemaSource.slice(schemaSource.indexOf("export const SettingsPatchSchema"));
    expect(schema).toContain("yieldToGames: z.boolean(),");
    expect(schema).toContain("leanMemory: z.boolean(),");
    expect(schema).toContain(".strict()");
  });

  it("are shown, saved and acted on", async () => {
    const [main, settingsIpc] = await Promise.all([
      source("src/main/index.ts"),
      source("src/main/settingsIpc.ts"),
    ]);
    expect(settingsIpc).toContain("yieldToGames: config.value.yieldToGames,");
    expect(settingsIpc).toContain("leanMemory: config.value.leanMemory,");
    expect(settingsIpc).toContain("{ yieldToGames: patch.yieldToGames }");
    expect(settingsIpc).toContain("{ leanMemory: patch.leanMemory }");
    expect(settingsIpc).toContain("engine?.setGameWatch(patch.yieldToGames ? gameOnCard : undefined)");
    expect(main).toContain("await engine?.setLean(lean)");
    // and the engine starts with what the settings say
    expect(main).toContain("lean: config.value.leanMemory,");
    expect(main).toContain("gameOnCard: config.value.yieldToGames ? gameOnCard : undefined,");
  });

  it("are on the settings page as switches, each with its words", async () => {
    const page = await source("src/renderer/settings.html");
    for (const [id, words] of [
      ["yieldToGames", "Give the graphics card back while a game is running"],
      ["leanMemory", "Use less graphics memory (experimental)"],
    ] as const) {
      expect(page).toContain(`<input id="${id}" type="checkbox" />`);
      expect(page).toContain(words);
    }
    const script = await source("src/renderer/src/settings.ts");
    const toggles = script.slice(script.indexOf("const toggles"), script.indexOf("] as const"));
    expect(toggles).toContain('"yieldToGames"');
    expect(toggles).toContain('"leanMemory"');
    expect(script).toContain(
      'element<HTMLInputElement>("yieldToGames").checked = view.yieldToGames',
    );
    expect(script).toContain('element<HTMLInputElement>("leanMemory").checked = view.leanMemory');
  });

  it("puts her voice away with her brain when a game gets the card, and says which game", async () => {
    const main = await source("src/main/index.ts");
    const handler = main.slice(
      main.indexOf("function onEngineStatus"),
      main.indexOf("function onBrainEvent"),
    );
    expect(handler).toContain("programShown(status.game)");
    expect(handler).toContain("restIfQuiet()");
    // never the kind of rest that cuts her off
    expect(handler).not.toMatch(/speaker\(\)\?\.rest\(\)|speaker\(\)\?\.stop\(\)/);
    expect(main).toContain("{ asleepFor: brainAsleepFor }");
    const page = await source("src/renderer/src/main.ts");
    expect(page).toContain("Resting: she gave the graphics card back to ${forGame}.");
  });
});

describe("a program's name, made fit to show beside her", () => {
  it("is kept as it is when it is an ordinary name", () => {
    expect(programShown("BH3.exe")).toBe("BH3.exe");
    expect(programShown("Emberfall-Linux-Shipping")).toBe("Emberfall-Linux-Shipping");
  });

  it("is nothing when there is no game", () => {
    expect(programShown(undefined)).toBeNull();
  });

  it("loses characters that cannot be seen or that reorder the words around them", () => {
    expect(programShown("ga‮me\u0007.exe\n")).toBe("game.exe");
    expect(programShown("​​")).toBe("a game");
    expect(programShown("   ")).toBe("a game");
  });

  it("is cut to one short line", () => {
    expect(programShown("x".repeat(500))).toHaveLength(60);
  });
});

describe("the working-memory line of her self-check", () => {
  it("says how much of it the conversation holds", () => {
    expect(describeWorkingMemory({ meter: { held: 7900, size: 16384 } })).toBe(
      "Holding 7,900 of 16,384 tokens (48%).",
    );
    expect(describeWorkingMemory({ meter: { held: 0, size: 8192 } })).toBe(
      "Holding 0 of 8,192 tokens (0%).",
    );
  });

  it("says so when it is getting full", () => {
    expect(describeWorkingMemory({ meter: { held: 12000, size: 16384 } })).toBe(
      "Holding 12,000 of 16,384 tokens (73%). Getting full: older parts of the conversation are shortened to make room.",
    );
    expect(describeWorkingMemory({ meter: { held: 11000, size: 16384 } })).not.toContain(
      "Getting full",
    );
  });

  it("says it is put away when her brain is not in memory", () => {
    expect(describeWorkingMemory({ meter: null })).toBe(
      "Put away, so nothing is held in graphics memory right now.",
    );
    expect(describeWorkingMemory({ meter: null, gaveCardTo: null })).toBe(
      "Put away, so nothing is held in graphics memory right now.",
    );
  });

  it("says which game the card was given back to", () => {
    expect(describeWorkingMemory({ meter: null, gaveCardTo: "BH3.exe" })).toBe(
      "Put away: the graphics card was given back to BH3.exe while it runs. Nothing is held in graphics memory; she wakes when spoken to.",
    );
    // a meter that makes no sense is treated as none
    expect(describeWorkingMemory({ meter: { held: 5, size: 0 }, gaveCardTo: "BH3.exe" })).toContain(
      "given back to BH3.exe",
    );
  });

  const inputs = (overrides: Partial<SelfCheckInputs> = {}): SelfCheckInputs => ({
    dataDir: dir,
    modelsDir: join(dir, "models"),
    brain: {
      label: "Standard (Qwen3.5 9B)",
      fileName: "Qwen3.5-9B-Q4_K_M.gguf",
      onDisk: true,
      loaded: true,
    },
    voice: { label: "Light voice", ready: true },
    listening: false,
    handsOff: false,
    notes: { total: 0, topics: 0, skills: 0 },
    pastExchanges: 0,
    waitingToWriteUp: 0,
    actionsRecorded: 0,
    searchEngine: null,
    memoryInUse: null,
    canReachTheWeb: () => Promise.resolve(true),
    ...overrides,
  });

  it("is part of the report, right after her brain", async () => {
    const report = describeSelfCheck(
      await selfCheck(inputs({ workingMemory: { meter: { held: 7900, size: 16384 } } })),
    ).split("\n");
    const brain = report.findIndex((line) => line.startsWith("OK Brain:"));
    expect(report[brain + 1]).toBe("OK Working memory: Holding 7,900 of 16,384 tokens (48%).");
  });

  it("is in the report for a brain put away for a game", async () => {
    const report = describeSelfCheck(
      await selfCheck(
        inputs({
          brain: { label: "Standard (Qwen3.5 9B)", fileName: null, onDisk: true, loaded: false },
          workingMemory: { meter: null, gaveCardTo: "BH3.exe" },
        }),
      ),
    );
    expect(report).toContain(
      "OK Working memory: Put away: the graphics card was given back to BH3.exe while it runs.",
    );
  });

  it("is left out where there is nothing to say: no reading given, or no brain yet", async () => {
    expect(describeSelfCheck(await selfCheck(inputs()))).not.toContain("Working memory");
    const noBrain = await selfCheck(
      inputs({
        brain: { label: "Standard (Qwen3.5 9B)", fileName: null, onDisk: false, loaded: false },
        workingMemory: { meter: null },
      }),
    );
    expect(describeSelfCheck(noBrain)).not.toContain("Working memory");
  });
});

describe("putting her voice away without cutting her off", () => {
  /** A voice that finishes a sentence only when told to, and counts its rests. */
  function rig(withRestIfIdle = true): {
    speaker: Speaker;
    rests: { whole: number; ifIdle: number };
    finish(): void;
    spoken: number[];
  } {
    const rests = { whole: 0, ifIdle: 0 };
    const waiting: ((audio: SpokenAudio) => void)[] = [];
    const spoken: number[] = [];
    const backend: VoiceBackend = {
      label: "test voice",
      supports: () => true,
      warm: () => Promise.resolve(),
      synthesize: () => new Promise<SpokenAudio>((resolve) => waiting.push(resolve)),
      rest: () => {
        rests.whole += 1;
        return Promise.resolve();
      },
      ...(withRestIfIdle
        ? {
            restIfIdle: () => {
              rests.ifIdle += 1;
              return Promise.resolve();
            },
          }
        : {}),
      dispose: () => Promise.resolve(),
    };
    const speaker = new Speaker({
      backend,
      language: "en",
      onAudio: (samples) => spoken.push(samples.length),
      onError: (message) => {
        throw new Error(message);
      },
    });
    return {
      speaker,
      rests,
      spoken,
      finish: () => waiting.shift()?.({ samples: new Float32Array(4), sampleRate: 24_000 }),
    };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("lets the voice go when she is saying nothing", async () => {
    const { speaker, rests } = rig();
    await speaker.restIfQuiet();
    expect(rests).toEqual({ whole: 0, ifIdle: 1 });
  });

  it("leaves it alone in the middle of a sentence, and with more still to say", async () => {
    const { speaker, rests, finish, spoken } = rig();
    speaker.push("First sentence here. Second sentence here. ");
    speaker.end();
    await settle();
    await speaker.restIfQuiet();
    expect(rests.ifIdle).toBe(0);
    finish();
    await settle();
    // the first is out, the second is being made
    await speaker.restIfQuiet();
    expect(rests.ifIdle).toBe(0);
    finish();
    await settle();
    expect(spoken).toHaveLength(2);
    await speaker.restIfQuiet();
    expect(rests).toEqual({ whole: 0, ifIdle: 1 });
  });

  it("does nothing for a voice that holds no graphics memory", async () => {
    const { speaker, rests } = rig(false);
    await expect(speaker.restIfQuiet()).resolves.toBeUndefined();
    expect(rests).toEqual({ whole: 0, ifIdle: 0 });
  });
});
