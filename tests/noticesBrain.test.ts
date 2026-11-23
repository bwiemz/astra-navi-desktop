import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatHistoryItem } from "node-llama-cpp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationArchive } from "../src/core/archive.ts";
import { Brain } from "../src/core/brain.ts";
import { ConfigStore } from "../src/core/config.ts";
import type { LocalEngine } from "../src/core/engine.ts";
import type { EnvironmentFacts } from "../src/core/environment.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { NoticeWatch } from "../src/core/notices.ts";
import type { TurnTrace } from "../src/core/trace.ts";
import { TOOLS } from "../src/core/permissions.ts";

const SECRET = "the door code is 4471";
const line = (app: string, summary: string, body: string): string =>
  JSON.stringify({
    type: "method_call",
    interface: "org.freedesktop.Notifications",
    member: "Notify",
    payload: { type: "susssasa{sv}i", data: [app, 0, "", summary, body, [], {}, -1] },
  });

describe("what notifications said, once she has told it", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-notices-brain-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is in neither her mind, the saved conversation, nor the record of past conversations", async () => {
    const config = new ConfigStore(join(dir, "config.json"));
    await config.load();
    await config.update({
      notices: { ...config.value.notices, read: true },
      keepConversations: true,
    });
    // Listening, with a stand-in for the monitor that never says anything by itself.
    const watch = new NoticeWatch({
      skip: () => [],
      ownNames: ["ai-chan"],
      start: () => ({ onLine: () => undefined, onExit: () => undefined, kill: () => undefined }),
    });
    watch.start();
    watch.take(line("Discord", "Mika", SECRET));
    expect(watch.held).toBe(1);

    // An engine that keeps the conversation the way the real one does.
    let history: ChatHistoryItem[] = [];
    const archived: string[] = [];
    const traces: TurnTrace[] = [];
    const seenByHer: string[] = [];
    const session = {
      prompt: async (
        text: string,
        options: {
          functions: Record<string, { handler(input: unknown): Promise<string> }>;
          onTextChunk(chunk: string): void;
        },
      ): Promise<string> => {
        history.push({ type: "user", text });
        const read = options.functions[TOOLS.notifications];
        if (text.includes("miss") && read) {
          const result = await read.handler({ app: "", count: 0 });
          seenByHer.push(result);
          // And she is asked to do something with it, which hands the text to another tool.
          await options.functions[TOOLS.writeFile]?.handler({
            path: "summary.txt",
            content: `Mika says ${SECRET}`,
          });
          const words = `[[happy]] One from Discord, Captain: Mika says ${SECRET}.`;
          options.onTextChunk(words);
          history.push({
            type: "model",
            response: [
              {
                type: "functionCall",
                name: TOOLS.notifications,
                params: { app: "", count: 0 },
                result,
              },
              words,
            ],
          });
        } else {
          options.onTextChunk("[[happy]] All quiet, Captain.");
          history.push({ type: "model", response: ["[[happy]] All quiet, Captain."] });
        }
        return "";
      },
      decide: () => Promise.resolve({ claimed: { value: 0 } }),
    };
    const engine = new Proxy(
      {
        getHistory: () => history,
        setHistory: (items: ChatHistoryItem[]) => {
          history = items;
        },
        session: () => Promise.resolve(session),
        meter: () => null,
        brainInfo: () =>
          Promise.resolve({ label: "Test brain", fileName: null, onDisk: true, loaded: true }),
      } as Record<string, unknown>,
      {
        get: (target, key: string) =>
          key === "then" ? undefined : (target[key] ?? ((): undefined => undefined)),
      },
    );
    const environment: EnvironmentFacts = {
      userName: "tester",
      home: dir,
      workspace: join(dir, "workspace"),
      osName: "Linux",
      desktop: "KDE Plasma",
      commands: new Set(),
    };
    const historyFile = join(dir, "conversation.json");
    const brain = new Brain({
      config,
      memory: new MemoryStore(join(dir, "memory.json")),
      environment,
      engine: engine as unknown as LocalEngine,
      historyFile,
      notices: () => watch,
      archive: {
        add: (entry: { said: string; reply: string }) => {
          archived.push(`${entry.said} / ${entry.reply}`);
          return Promise.resolve();
        },
      } as unknown as ConversationArchive,
      emit: () => undefined,
      onTrace: (trace) => traces.push(trace),
    });
    try {
      expect(brain.send("did I miss anything?")).toBe(true);
      await brain.whenIdle();
      // The record of that reply says which tools were called and how each ended, and
      // nothing of what was read: not what the notifications said, not her retelling,
      // and not what she handed on to the other tool.
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({ withheld: true, reply: "" });
      expect(
        traces[0]?.calls.map((call) => [call.tool, call.outcome, call.input, call.result]),
      ).toEqual([
        [TOOLS.notifications, "done", "", ""],
        [TOOLS.writeFile, "done", "", ""],
      ]);
      expect(JSON.stringify(traces)).not.toContain("4471");
      expect(JSON.stringify(traces)).not.toContain("Mika");
      // She was given it and said it...
      expect(seenByHer.join("\n")).toContain("4471");
      // ...and now it is nowhere but in the watch's own short list.
      expect(JSON.stringify(history)).not.toContain("4471");
      expect(JSON.stringify(history)).not.toContain("Mika");
      expect(JSON.stringify(history)).toContain("looks again");
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ type: "user" });
      // What she was handed ends with the reminder of her manner; the record of what
      // Captain said does not have it.
      const first = history[0] as { text: string };
      expect(first.text.startsWith("did I miss anything?")).toBe(true);
      expect(first.text.trimEnd().split("\n").at(-1)).toMatch(
        /^\[form\] Answer as Astra, by name/,
      );

      // A turn that read nothing is kept as it is, and is archived as usual.
      expect(brain.send("anything else going on?")).toBe(true);
      await brain.whenIdle();
      expect(JSON.stringify(history)).toContain("All quiet, Captain.");
      expect(archived).toHaveLength(1);
      expect(archived[0]).toContain("All quiet");
      expect(archived[0]).not.toContain("[form]");
      expect(archived[0]?.startsWith("anything else going on? / ")).toBe(true);
    } finally {
      await brain.dispose();
    }
    const saved = await readFile(historyFile, "utf8");
    expect(saved).not.toContain("4471");
    expect(saved).not.toContain("Mika");
    expect(saved).toContain("All quiet, Captain.");
    expect(watch.held).toBe(1);
    watch.dispose();
  });
});
