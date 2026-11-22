import { describe, expect, it } from "vitest";
import type { Embedder } from "../src/core/embedder.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { CORE_TOOLS, HINTS, MOST_BY_MEANING, ToolRouter } from "../src/core/toolRouter.ts";

const everything: string[] = Object.values(TOOLS);

/** An embedder that knows nothing: every text lands in the same place. */
const flat: Embedder = {
  embed: (texts) => Promise.resolve(texts.map(() => Float32Array.from([1, 0]))),
};

/** One that puts a text beside whichever of two subjects it mentions. */
const twoSubjects: Embedder = {
  embed: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        /loud|volume|music|song|track|mute|sound/i.test(text)
          ? Float32Array.from([1, 0])
          : Float32Array.from([0, 1]),
      ),
    ),
};

describe("which tools are offered for a message", () => {
  it("always offers the core, and every tool has either a place in it or hints", () => {
    for (const tool of everything) {
      expect(CORE_TOOLS.includes(tool) || HINTS[tool] !== undefined, tool).toBe(true);
    }
    for (const tool of [...CORE_TOOLS, ...Object.keys(HINTS)]) {
      expect(everything, tool).toContain(tool);
    }
  });

  it("goes by words that name the thing outright, in her three languages", async () => {
    const router = new ToolRouter(null);
    for (const [said, tool] of [
      ["Pause the music.", TOOLS.sound],
      ["What's on my calendar today?", TOOLS.agenda],
      ["Tell me when final.mp4 shows up in the folder.", TOOLS.keepWatch],
      ["How long has my Proxmox server been up?", TOOLS.remote],
      ["Ring my phone, I can't find it.", TOOLS.phone],
      ["What was that notification just now?", TOOLS.notifications],
      ["Lock the screen.", TOOLS.lockScreen],
      ["Click the Save button in Kate.", TOOLS.operate],
      ["音量を下げて", TOOLS.sound],
      ["今天有什么安排？", TOOLS.agenda],
      ["明日の天気は？", TOOLS.weather],
    ] as const) {
      const route = await router.route(said, { available: everything });
      expect(route.offered, said).toContain(tool);
      expect(route.why[tool], said).toBe("words");
    }
  });

  it("offers little beyond the core for talk that needs no tool", async () => {
    const router = new ToolRouter(null);
    for (const said of [
      "Tell me a joke.",
      "What's the capital of France?",
      "Thanks, that helps.",
    ]) {
      const route = await router.route(said, { available: everything });
      expect(route.offered.sort(), said).toEqual([...CORE_TOOLS].sort());
    }
  });

  it("keeps what was used a moment ago, and reads a follow-up with what came before it", async () => {
    const router = new ToolRouter(null);
    const later = await router.route("And the other one?", {
      available: everything,
      recent: [TOOLS.windows],
    });
    expect(later.why[TOOLS.windows]).toBe("used just now");
    const followUp = await router.route("And tomorrow?", {
      available: everything,
      before: "What's the weather like today?",
    });
    expect(followUp.offered).toContain(TOOLS.weather);
  });

  it("takes a machine's name for a question about that machine", async () => {
    const router = new ToolRouter(null);
    const named = await router.route("How is aw-runner doing?", {
      available: everything,
      machines: ["aw-runner", "The NAS"],
    });
    expect(named.why[TOOLS.remote]).toBe("names a machine");
    const unnamed = await router.route("How is aw-runner doing?", { available: everything });
    expect(unnamed.offered).not.toContain(TOOLS.remote);
  });

  it("brings along what a tool is no use without", async () => {
    const router = new ToolRouter(null);
    const route = await router.route("Click OK in that dialog.", { available: everything });
    expect(route.offered).toContain(TOOLS.operate);
    expect(route.why[TOOLS.windows]).toMatch(/words|goes with operate/);
    const watch = await router.route("Let me know if the site goes down.", {
      available: everything,
    });
    expect(watch.why[TOOLS.reminders]).toMatch(/goes with keep_watch|words/);
  });

  it("never offers a tool she does not have, and always one nobody wrote hints for", async () => {
    const router = new ToolRouter(null);
    const without = everything.filter((tool) => tool !== TOOLS.sound);
    const route = await router.route("Pause the music.", {
      available: [...without, "brand_new_tool"],
    });
    expect(route.offered).not.toContain(TOOLS.sound);
    expect(route.why["brand_new_tool"]).toBe("no hints");
    // In the order they were given, so the same tools always read the same to the model.
    expect(route.offered).toEqual(
      [...without, "brand_new_tool"].filter((tool) => route.offered.includes(tool)),
    );
  });

  it("adds by nearness in meaning what the words did not name", async () => {
    const router = new ToolRouter(twoSubjects);
    const route = await router.route("It's far too loud in here.", { available: everything });
    expect(route.offered).toContain(TOOLS.sound);
    expect(route.why[TOOLS.sound]).toMatch(/^meaning \+\d/);
    const byMeaning = Object.values(route.why).filter((reason) => reason.startsWith("meaning"));
    expect(byMeaning.length).toBeLessThanOrEqual(MOST_BY_MEANING);
  });

  it("adds nothing by meaning when the embedder tells nothing apart", async () => {
    const router = new ToolRouter(flat);
    const route = await router.route("Tell me a joke.", { available: everything });
    expect(route.offered.sort()).toEqual([...CORE_TOOLS].sort());
  });

  it("still routes by words when the embedding model cannot be loaded", async () => {
    const broken: Embedder = { embed: () => Promise.reject(new Error("no model")) };
    const router = new ToolRouter(broken);
    const route = await router.route("Pause the music.", { available: everything });
    expect(route.offered).toContain(TOOLS.sound);
  });
});
