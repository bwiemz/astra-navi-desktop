import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineChatSessionFunction } from "node-llama-cpp";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEngine } from "../src/core/engine.ts";
import {
  classifyInferenceEndpoint,
  describeInferenceLocality,
  OpenAiCompatibleSession,
  openAiSideQuestion,
  probeOpenAiModels,
  type InferenceBackendConfig,
} from "../src/core/openaiBackend.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
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

describe("OpenAI-compatible endpoint locality classification & security", () => {
  it("classifies loopback, private LAN, and external internet hosts accurately", () => {
    const loopback = classifyInferenceEndpoint("http://127.0.0.1:11434");
    expect(loopback.ok).toBe(true);
    if (loopback.ok) {
      expect(loopback.scope).toBe("local-loopback");
      expect(loopback.leavesMachine).toBe(false);
      expect(loopback.apiBaseUrl).toBe("http://127.0.0.1:11434/v1");
    }

    const lan = classifyInferenceEndpoint("http://192.168.1.50:1234/v1/");
    expect(lan.ok).toBe(true);
    if (lan.ok) {
      expect(lan.scope).toBe("private-lan");
      expect(lan.leavesMachine).toBe(true);
      expect(lan.host).toBe("192.168.1.50:1234");
    }

    const remote = classifyInferenceEndpoint("https://api.example.com/v1/chat/completions");
    expect(remote.ok).toBe(true);
    if (remote.ok) {
      expect(remote.scope).toBe("remote-internet");
      expect(remote.leavesMachine).toBe(true);
      expect(remote.apiBaseUrl).toBe("https://api.example.com/v1");
    }
  });

  it("blocks cloud metadata hosts, embedded credentials, and non-HTTP protocols", () => {
    expect(classifyInferenceEndpoint("http://169.254.169.254/latest").ok).toBe(false);
    expect(classifyInferenceEndpoint("http://user:pass@127.0.0.1:11434/v1").ok).toBe(false);
    expect(classifyInferenceEndpoint("file:///etc/passwd").ok).toBe(false);
  });

  it("reports local-gguf default as on-machine and LAN/remote servers as leaving the machine", () => {
    const local = describeInferenceLocality({
      provider: "local",
      preset: "ollama",
      baseUrl: "",
      model: "",
      apiKey: "",
    });
    expect(local.scope).toBe("local-gguf");
    expect(local.leavesMachine).toBe(false);

    const lan = describeInferenceLocality({
      provider: "openai-compatible",
      preset: "ollama",
      baseUrl: "http://10.0.0.25:11434/v1",
      model: "qwen3.5:35b-a3b",
      apiKey: "",
    });
    expect(lan.scope).toBe("private-lan");
    expect(lan.leavesMachine).toBe(true);
    expect(lan.label).toContain("10.0.0.25:11434");
  });
});

describe("OpenAI-compatible live HTTP server streaming, tool calling & LocalEngine integration", () => {
  it("probes models, streams SSE + tool calls end-to-end, answers side questions, and integrates with LocalEngine", async () => {
    let seenAuth = "";
    let chatSteps = 0;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seenAuth = req.headers.authorization ?? "";
      if (req.url === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "qwen3.5:9b" }, { id: "qwen3.5:35b-a3b" }] }));
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            stream?: boolean;
            messages: { role: string; content: string | null }[];
          };

          // Non-streaming sideQuestion path
          if (!body.stream) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [{ message: { content: "Compact summary of past turns." } }],
              }),
            );
            return;
          }

          chatSteps += 1;
          const hasToolResult = body.messages.some((m) => m.role === "tool");
          res.writeHead(200, { "content-type": "text/event-stream" });

          if (!hasToolResult) {
            // Step 1: stream a tool call for `add_numbers`
            res.write(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_sum_1",
                          function: { name: "add_numbers", arguments: '{"a":19,' },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: '"b":23}' } }],
                    },
                  },
                ],
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          // Step 2: incorporate tool output and stream final answer
          const toolMsg = body.messages.find((m) => m.role === "tool")?.content ?? "";
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "[[happy]] The sum is " } }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: `${toolMsg}.` } }],
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const cfg: InferenceBackendConfig = {
        provider: "openai-compatible",
        preset: "ollama",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "qwen3.5:9b",
        apiKey: "secret-test-key",
      };

      const probe = await probeOpenAiModels(cfg);
      expect(probe.ok).toBe(true);
      expect(probe.models).toEqual(["qwen3.5:9b", "qwen3.5:35b-a3b"]);
      expect(probe.leavesMachine).toBe(false);
      expect(seenAuth).toBe("Bearer secret-test-key");

      const modelsDir = await makeTempDir("astra-oai-eng-");
      const statuses: string[] = [];
      const engine = new LocalEngine({
        modelsDir,
        choice: "standard",
        contextSize: 8192,
        idleUnloadMs: 0,
        inference: cfg,
        onStatus: (st) => statuses.push(st.stage),
      });

      expect(await engine.isDownloaded()).toBe(true);
      expect((await engine.brainInfo()).label).toContain("qwen3.5:9b");

      const session = await engine.session("You are Astra Navi.");
      expect(session).toBeInstanceOf(OpenAiCompatibleSession);

      let toolInvoked = 0;
      const streamed: string[] = [];
      const functions = {
        add_numbers: defineChatSessionFunction({
          description: "Adds two integers.",
          params: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
          handler: async (params: { a: number; b: number }) => {
            toolInvoked += 1;
            return String(params.a + params.b);
          },
        }),
      };

      const reply = await session.prompt("What is 19 + 23?", {
        functions,
        onTextChunk: (delta) => streamed.push(delta),
      });

      expect(chatSteps).toBe(2);
      expect(toolInvoked).toBe(1);
      expect(reply).toBe("[[happy]] The sum is 42.");
      expect(streamed.join("")).toBe("[[happy]] The sum is 42.");
      expect(engine.getHistory()).toHaveLength(2);
      expect(engine.meter()?.input).toBeGreaterThan(0);

      const summary = await openAiSideQuestion(cfg, "Summarize.", "Long chat");
      expect(summary).toBe("Compact summary of past turns.");
      expect(await engine.sideQuestion("Summarize.", "Long chat")).toBe(
        "Compact summary of past turns.",
      );

      // Switching back to local preserves history cleanly.
      await engine.setInferenceBackend({ ...cfg, provider: "local" });
      expect(engine.inferenceLocality().scope).toBe("local-gguf");
      expect(engine.getHistory()).toHaveLength(2);
      await engine.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("renders Settings inference controls safely without innerHTML and redacts API keys", () => {
    const root = join(import.meta.dirname, "..");
    const infUi = readFileSync(join(root, "src/renderer/src/settings/inference.ts"), "utf8");
    const indexHtml = readFileSync(join(root, "src/renderer/index.html"), "utf8");
    const settingsIpc = readFileSync(join(root, "src/main/settingsIpc.ts"), "utf8");

    expect(infUi).not.toContain("innerHTML");
    expect(indexHtml).toContain('id="remote-inference-badge"');
    expect(settingsIpc).toContain("config.value.inference.apiKey");
    expect(settingsIpc).toContain("hasApiKey:");
  });
});
