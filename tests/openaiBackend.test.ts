import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineChatSessionFunction } from "node-llama-cpp";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEngine } from "../src/core/engine.ts";
import { CLAIM_CHECK } from "../src/core/followThrough.ts";
import {
  buildOpenAiToolNameMap,
  classifyInferenceEndpoint,
  describeInferenceLocality,
  OpenAiCompatibleSession,
  openAiSideQuestion,
  parseClaimDecisionScore,
  probeOpenAiModels,
  type InferenceBackendConfig,
} from "../src/core/openaiBackend.ts";
import { collectMcpEnvSecrets, redactSupportText } from "../src/core/supportBundle.ts";

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

  it("blocks cloud metadata hosts, plaintext http:// to internet hosts, embedded credentials, and non-HTTP protocols", () => {
    expect(classifyInferenceEndpoint("http://169.254.169.254/latest").ok).toBe(false);
    expect(classifyInferenceEndpoint("http://api.openai.com/v1").ok).toBe(false);
    expect(classifyInferenceEndpoint("http://8.8.8.8:8080/v1").ok).toBe(false);
    expect(classifyInferenceEndpoint("http://user:pass@127.0.0.1:11434/v1").ok).toBe(false);
    expect(classifyInferenceEndpoint("file:///etc/passwd").ok).toBe(false);
    // https:// to internet and http:// to loopback/private LAN remain allowed.
    expect(classifyInferenceEndpoint("https://api.openai.com/v1").ok).toBe(true);
    expect(classifyInferenceEndpoint("http://192.168.1.50:1234/v1").ok).toBe(true);
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

  it("sanitizes MCP tool names on the wire, answers every parallel tool_call_id, runs live decide(), supports openWorker(), preserves partial history on abort, and refuses blank model fallback", async () => {
    const strictNameRe = /^[a-zA-Z0-9_-]{1,64}$/;
    let seenParallelToolCallsFlag: unknown = undefined;
    let seenToolWireNames: string[] = [];
    let seenToolRepliesInStep2: string[] = [];
    let decideDecisionToReturn: unknown = { claimed: 0.91 };
    let mode: "parallel-and-mcp" | "abort-after-write" | "worker" = "parallel-and-mcp";

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          stream?: boolean;
          parallel_tool_calls?: unknown;
          tools?: { function: { name: string } }[];
          messages: {
            role: string;
            content: string | null;
            tool_calls?: { id: string; function: { name: string } }[];
            tool_call_id?: string;
          }[];
        };

        // Strict OpenAI validator: every tool name in `tools` and in `messages` MUST match ^[a-zA-Z0-9_-]{1,64}$
        for (const t of body.tools ?? []) {
          if (!strictNameRe.test(t.function.name)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `Invalid tool name: ${t.function.name}` }));
            return;
          }
        }
        for (const msg of body.messages) {
          for (const tc of msg.tool_calls ?? []) {
            if (!strictNameRe.test(tc.function.name)) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: `Invalid history tool name: ${tc.function.name}` }));
              return;
            }
          }
        }
        // Strict OpenAI validator: every assistant tool_call_id MUST have a following role:"tool" reply.
        for (let i = 0; i < body.messages.length; i += 1) {
          const msg = body.messages[i];
          if (msg?.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
            const expectedIds = new Set(msg.tool_calls.map((c) => c.id));
            const answeredIds = new Set<string>();
            for (let j = i + 1; j < body.messages.length && body.messages[j]?.role === "tool"; j += 1) {
              const id = body.messages[j]?.tool_call_id;
              if (id) answeredIds.add(id);
            }
            for (const reqId of expectedIds) {
              if (!answeredIds.has(reqId)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: `Missing tool response for ${reqId}` }));
                return;
              }
            }
          }
        }

        // Non-streaming claim-check decide() path
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(decideDecisionToReturn) } }],
            }),
          );
          return;
        }

        if (mode === "worker") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "Worker report ready." } }] }));
          return;
        }

        if (mode === "abort-after-write") {
          const hasToolReply = body.messages.some((m) => m.role === "tool");
          if (!hasToolReply) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: "Writing file now.",
                      tool_calls: [
                        {
                          id: "call_write_1",
                          function: { name: "write_file", arguments: '{"path":"notes.txt","content":"hi"}' },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            return;
          }
          // Simulate server failure on step 2 after write_file already executed.
          res.writeHead(500);
          res.end("upstream error");
          return;
        }

        // mode === "parallel-and-mcp"
        seenParallelToolCallsFlag = body.parallel_tool_calls;
        seenToolWireNames = (body.tools ?? []).map((t) => t.function.name);
        const toolReplies = body.messages.filter((m) => m.role === "tool");
        if (toolReplies.length === 0) {
          const mcpWireName = seenToolWireNames.find((n) => n.includes("dim_light")) ?? "dim_light";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    // Server ignores parallel_tool_calls:false and sends TWO parallel tool calls!
                    tool_calls: [
                      {
                        id: "call_p1",
                        function: { name: mcpWireName, arguments: '{"pct":25}' },
                      },
                      {
                        id: "call_p2",
                        function: { name: mcpWireName, arguments: '{"pct":80}' },
                      },
                    ],
                  },
                },
              ],
            }),
          );
          return;
        }

        seenToolRepliesInStep2 = toolReplies.map((m) => `${m.tool_call_id}:${m.content}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "[[happy]] Dimmed the desk light to 25%." } }],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const cfg: InferenceBackendConfig = {
        provider: "openai-compatible",
        preset: "custom",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "qwen3.5:9b",
        apiKey: "k-test",
      };

      // 1. Parallel tool calls + MCP wire-name bijective mapping
      const longMcpName = `mcp:very-long-home-automation-server.${"x".repeat(60)}_dim`;
      const mapCheck = buildOpenAiToolNameMap(["mcp:home-assistant.dim_light", longMcpName]);
      for (const wireName of mapCheck.realToWire.values()) {
        expect(wireName).toMatch(strictNameRe);
      }

      const session = new OpenAiCompatibleSession(cfg, "You are Astra Navi.");
      const executedPcts: number[] = [];
      const mcpFns = {
        "mcp:home-assistant.dim_light": defineChatSessionFunction({
          description: "Dim light",
          params: { type: "object", properties: { pct: { type: "integer" } } },
          handler: async (p: { pct: number }) => {
            executedPcts.push(p.pct);
            return `set to ${p.pct}`;
          },
        }),
        [longMcpName]: defineChatSessionFunction({
          description: "Long tool",
          params: { type: "object", properties: {} },
          handler: async () => "ok",
        }),
      };

      const reply = await session.prompt("Dim light to 25%", {
        functions: mcpFns,
        maxParallelFunctionCalls: 1,
      });
      expect(seenParallelToolCallsFlag).toBe(false);
      expect(seenToolWireNames.every((n) => strictNameRe.test(n))).toBe(true);
      // Only the 1st tool call ran, yet BOTH tool_call_ids received matching role:"tool" replies (no HTTP 400)!
      expect(executedPcts).toEqual([25]);
      expect(seenToolRepliesInStep2).toHaveLength(2);
      expect(seenToolRepliesInStep2[0]).toContain("call_p1:set to 25");
      expect(seenToolRepliesInStep2[1]).toContain("call_p2:Skipped:");
      expect(reply).toContain("25%");
      // History stores the REAL internal MCP tool name!
      const modelTurn = session.getChatHistory().find((item) => item.type === "model");
      expect(JSON.stringify(modelTurn)).toContain("mcp:home-assistant.dim_light");

      // 2. Real decide() claim-check HTTP round-trip
      decideDecisionToReturn = { claimed: 0.91 };
      const high = await session.decide(CLAIM_CHECK);
      expect(high.claimed.value).toBeCloseTo(0.91, 2);

      decideDecisionToReturn = { claimed: false };
      const low = await session.decide(CLAIM_CHECK);
      expect(low.claimed.value).toBe(0);

      // 3. Partial history preserved when a turn aborts or errors AFTER write_file ran
      mode = "abort-after-write";
      const abortSession = new OpenAiCompatibleSession(cfg, "You are Astra.");
      let wroteFile = false;
      await expect(
        abortSession.prompt("Save notes.txt", {
          functions: {
            write_file: defineChatSessionFunction({
              description: "Write file",
              params: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
              handler: async () => {
                wroteFile = true;
                return "Saved notes.txt";
              },
            }),
          },
          maxParallelFunctionCalls: 1,
        }),
      ).rejects.toThrow(/HTTP 500/);
      expect(wroteFile).toBe(true);
      const savedHist = abortSession.getChatHistory();
      expect(savedHist.some((item) => item.type === "model" && JSON.stringify(item).includes("write_file"))).toBe(true);

      // 4. LocalEngine.openWorker() works on OpenAI-compatible backend (for background research)
      mode = "worker";
      const modelsDir = await makeTempDir("astra-oai-worker-");
      const engine = new LocalEngine({
        modelsDir,
        choice: "standard",
        contextSize: 8192,
        idleUnloadMs: 0,
        inference: cfg,
        onStatus: () => undefined,
      });
      const worker = await engine.openWorker("Research assistant");
      expect(worker).not.toBeNull();
      if (worker) {
        const report = await worker.session.prompt("Summarize findings");
        expect(report).toBe("Worker report ready.");
        await worker.close();
      }
      await engine.dispose();

      // 5. Blank model name when provider === "openai-compatible" MUST fail clearly, NEVER fall back to local GGUF!
      const badEngine = new LocalEngine({
        modelsDir,
        choice: "standard",
        contextSize: 8192,
        idleUnloadMs: 0,
        inference: { ...cfg, model: "   " },
        onStatus: () => undefined,
      });
      expect(await badEngine.isDownloaded()).toBe(false);
      await expect(badEngine.session("System")).rejects.toThrow(/no model name is set/i);
      await badEngine.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("allows common local/LAN/Docker/Tailscale http endpoints, aborts remote workers when switching back to local, and handles long replies + thinking tags in decide()", async () => {
    // 1. Common local setups MUST be classified as private-lan and allowed over http://.
    for (const url of [
      "http://gpu-box:11434/v1",
      "http://nas.home:11434/v1",
      "http://host.docker.internal:11434/v1",
      "http://mac-studio.tail1234.ts.net:11434/v1",
      "http://workstation.local:8080/v1",
      "http://server.lan:1234/v1",
    ]) {
      const res = classifyInferenceEndpoint(url);
      expect(res.ok, `Expected ${url} to be accepted`).toBe(true);
      if (res.ok) expect(res.scope).toBe("private-lan");
    }
    // Public internet & cloud metadata over plaintext http:// MUST stay rejected!
    for (const blocked of [
      "http://api.openai.com/v1",
      "http://8.8.8.8:8080/v1",
      "http://metadata.google.internal/v1",
      "http://metadata/v1",
      "http://169.254.169.254/v1",
    ]) {
      expect(classifyInferenceEndpoint(blocked).ok, `Expected ${blocked} to be rejected`).toBe(false);
    }

    // 2. Claim-check parser handles `<think>...</think>` and rejects `"nope, yes"` / `"yes, no"`!
    expect(
      parseClaimDecisionScore('<think>The reply claimed a timer was set.</think>\n{"claimed": 0.94}'),
    ).toBeCloseTo(0.94, 2);
    expect(parseClaimDecisionScore('{"claimed": "nope, yes"}')).toBeNull();
    expect(parseClaimDecisionScore('{"claimed": "yes, no"}')).toBeNull();
    expect(parseClaimDecisionScore('{"claimed": "yes"}')).toBe(1);
    expect(parseClaimDecisionScore('{"claimed": "no"}')).toBe(0);

    // 3. decide() inspects claims at the END of long (>3000 char) replies and grants >= 256 max_tokens.
    let seenDecideBody: { max_tokens?: number; messages?: { role: string; content: string }[] } | null = null;
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenDecideBody = JSON.parse(String(init?.body ?? "{}")) as typeof seenDecideBody;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '<think>Saw claim at end.</think>{"claimed": 0.88}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const session = new OpenAiCompatibleSession(
      {
        provider: "openai-compatible",
        preset: "ollama",
        baseUrl: "http://gpu-box:11434/v1",
        model: "qwen3.5:9b",
        apiKey: "",
      },
      "You are Astra.",
      mockFetch,
    );
    const longReply = `${"Introductory explanation. ".repeat(120)} All done — I have set your 10 minute timer!`;
    session.setChatHistory([
      { type: "system", text: "You are Astra." },
      { type: "user", text: "Set a 10 minute timer" },
      { type: "model", response: [longReply] },
    ]);
    const decision = await session.decide(CLAIM_CHECK);
    expect(decision.claimed.value).toBeCloseTo(0.88, 2);
    const decideBody = seenDecideBody as unknown as {
      max_tokens?: number;
      messages?: { role: string; content: string }[];
    } | null;
    expect(decideBody?.max_tokens).toBeGreaterThanOrEqual(256);
    const userMsg = decideBody?.messages?.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("I have set your 10 minute timer!");

    // 4. Switching LocalEngine back to "local" MUST immediately abort active remote workers!
    const modelsDir = await makeTempDir("astra-oai-switch-");
    const engine = new LocalEngine({
      modelsDir,
      choice: "standard",
      contextSize: 8192,
      idleUnloadMs: 0,
      inference: {
        provider: "openai-compatible",
        preset: "ollama",
        baseUrl: "http://gpu-box:11434/v1",
        model: "qwen3.5:9b",
        apiKey: "",
      },
      fetchImpl: mockFetch,
      onStatus: () => undefined,
    });
    const worker = await engine.openWorker("Research assistant");
    expect(worker).not.toBeNull();
    let closedOnAbort = false;
    worker?.signal.addEventListener("abort", () => {
      closedOnAbort = true;
      void worker.close();
    });
    expect(worker?.signal.aborted).toBe(false);

    await engine.setInferenceBackend({
      provider: "local",
      preset: "ollama",
      baseUrl: "http://gpu-box:11434/v1",
      model: "qwen3.5:9b",
      apiKey: "",
    });
    expect(worker?.signal.aborted).toBe(true);
    expect(closedOnAbort).toBe(true);
    await engine.dispose();
  });

  it("avoids over-redacting common words/substrings, preserves running research on unrelated inference edits, snapshots AI report at open time, and checks real Python voice deps on Windows", async () => {
    // 1. Redaction sorts longest-first, matches case-insensitively, scrubs short/numeric secrets
    //    (even 4-digit MCP PINs), and never partially leaks `nas.tail1234.ts.net` -> `[redacted].tail1234.ts.net`!
    const sample =
      "More information available (debug=true on localhost:11434) at gymnasium for administrator; " +
      "myalpha99x stays, but nas.tail1234.ts.net, NAS, pve.home.arpa, PVE, user admin, user kenji, " +
      "pin 84726193, mcp pin 4829, alpha99, ha-secret-token-7788, and super-secret-key-98765 must all be scrubbed.";
    const collectedMcp = collectMcpEnvSecrets([
      {
        headers: { Authorization: "ha-secret-token-7788" },
        env: { PORT: "11434", PIN: "4829", LOG_LEVEL: "info", DEBUG: "true" },
      },
    ]);
    const scrubbed = redactSupportText(
      sample,
      ["pve", "nas", "nas.tail1234.ts.net", "pve.home.arpa", "admin", "kenji", "84726193", "alpha99", "super-secret-key-98765"],
      ["info", "true", "debug", "localhost", ...collectedMcp],
    );
    expect(scrubbed.text).toContain("More information available");
    expect(scrubbed.text).toContain("debug=true");
    expect(scrubbed.text).toContain("localhost:11434");
    expect(scrubbed.text).toContain("gymnasium");
    expect(scrubbed.text).toContain("administrator");
    expect(scrubbed.text).toContain("myalpha99x");
    expect(scrubbed.text).not.toContain("tail1234.ts.net");
    expect(scrubbed.text).not.toContain("home.arpa");
    expect(scrubbed.text).not.toMatch(/\bpve\b/i);
    expect(scrubbed.text).not.toMatch(/\bnas\b/i);
    expect(scrubbed.text).not.toMatch(/\badmin\b/i);
    expect(scrubbed.text).not.toContain("kenji");
    expect(scrubbed.text).not.toContain("84726193");
    expect(scrubbed.text).not.toContain("4829");
    expect(scrubbed.text).not.toContain(" alpha99");
    expect(scrubbed.text).not.toContain("ha-secret-token-7788");
    expect(scrubbed.text).not.toContain("super-secret-key-98765");

    // 2. Unrelated inference edits while provider stays unchanged must NOT cancel running research workers!
    const modelsDir = await makeTempDir("astra-oai-noop-");
    const mockFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const engine = new LocalEngine({
      modelsDir,
      choice: "standard",
      contextSize: 8192,
      idleUnloadMs: 0,
      inference: {
        provider: "openai-compatible",
        preset: "ollama",
        baseUrl: "http://gpu-box:11434/v1",
        model: "qwen3.5:9b",
        apiKey: "",
      },
      fetchImpl: mockFetch,
      onStatus: () => undefined,
    });
    const worker = await engine.openWorker("Research assistant");
    expect(worker).not.toBeNull();
    // Changing only `preset` while provider/baseUrl/model/apiKey stay identical must NOT abort!
    await engine.setInferenceBackend({
      provider: "openai-compatible",
      preset: "lm-studio",
      baseUrl: "http://gpu-box:11434/v1",
      model: "qwen3.5:9b",
      apiKey: "",
    });
    expect(worker?.signal.aborted).toBe(false);
    await worker?.close();
    await engine.dispose();

    // 3. Report dialog resets on BOTH clearLive() AND forgetLog() ("Forget all past exchanges"),
    //    only refreshes on reply-start when closed (preserving user's note during proactive events),
    //    and guards against duplicate Save writes!
    const rendererMain = await readFile(join(process.cwd(), "src/renderer/src/main.ts"), "utf8");
    const dialogFn = rendererMain.slice(rendererMain.indexOf("function wireAiReportDialog()"));
    expect(dialogFn).toContain("snapshotReply = document.getElementById(\"reply\")");
    expect(dialogFn).toContain("replyExcerpt: snapshotReply");
    expect(dialogFn).toContain("if (!dialogEl.hidden) return;");
    expect(dialogFn).toContain("if (lastSavedKey && reportKey === lastSavedKey)");
    const clearLiveIdx = rendererMain.indexOf("function clearLive()");
    expect(rendererMain.slice(clearLiveIdx, clearLiveIdx + 250)).toContain("resetAiReportDialog()");
    const forgetLogIdx = rendererMain.indexOf("function forgetLog()");
    expect(rendererMain.slice(forgetLogIdx, forgetLogIdx + 250)).toContain("resetAiReportDialog()");
    const replyStartIdx = rendererMain.indexOf('case "reply-start":');
    expect(rendererMain.slice(replyStartIdx, replyStartIdx + 250)).toContain("refreshAiReportOnNewReply()");
    // When closed, refreshAiReportOnNewReply also clears abandoned typed notes so they don't carry over.
    const refreshIdx = dialogFn.indexOf("refreshAiReportOnNewReply = (): void =>");
    expect(dialogFn.slice(refreshIdx, refreshIdx + 550)).toContain('detailsEl.value = ""');

    // 4. decide() probes remote /models context (never using local GGUF contextSize), sends
    //    enable_thinking:false even on remote HTTPS servers, caches HTTP 400/422 rejection so
    //    later calls take 1 round trip, and grants max_tokens=1024!
    const decideBodies: {
      max_tokens?: number;
      chat_template_kwargs?: { enable_thinking?: boolean };
      messages?: { role: string; content: string }[];
    }[] = [];
    let failFirst422 = true;
    const midSession = new OpenAiCompatibleSession(
      {
        provider: "openai-compatible",
        preset: "custom",
        baseUrl: "https://api.example.com/v1",
        model: "qwen3.5:9b",
        apiKey: "k-remote",
      },
      "You are Astra.",
      (async (u: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(u);
        if (urlStr.endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "qwen3.5:9b", max_model_len: 8_192 }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const parsed = JSON.parse(String(init?.body ?? "{}")) as (typeof decideBodies)[number];
        decideBodies.push(parsed);
        if (failFirst422 && parsed.chat_template_kwargs) {
          failFirst422 = false;
          return new Response("unprocessable chat_template_kwargs", { status: 422 });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"claimed": 0.92}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );
    const midReply = `${"Opening paragraph. ".repeat(200)} I have just restarted nginx on your server. ${"Closing advice. ".repeat(200)}`;
    midSession.setChatHistory([
      { type: "system", text: "You are Astra." },
      { type: "user", text: "Restart nginx" },
      { type: "model", response: [midReply] },
    ]);
    const midRes = await midSession.decide(CLAIM_CHECK);
    expect(midRes.claimed.value).toBeCloseTo(0.92, 2);
    expect(decideBodies).toHaveLength(2);
    expect(decideBodies[0]?.chat_template_kwargs?.enable_thinking).toBe(false);
    expect(decideBodies[1]?.chat_template_kwargs).toBeUndefined();
    expect(decideBodies[1]?.max_tokens).toBe(1_024);
    expect(decideBodies[1]?.messages?.find((m) => m.role === "system")?.content).toContain("/no_think");
    expect(decideBodies[1]?.messages?.find((m) => m.role === "user")?.content).toContain(
      "I have just restarted nginx on your server.",
    );

    // Second decide() on the same session remembers 422 rejection -> ONLY 1 round trip!
    await midSession.decide(CLAIM_CHECK);
    expect(decideBodies).toHaveLength(3);
    expect(decideBodies[2]?.chat_template_kwargs).toBeUndefined();

    // Small remote server reporting context_length: 2048 via /models caps reply excerpt cleanly!
    let smallUserContent = "";
    const smallCtxSession = new OpenAiCompatibleSession(
      {
        provider: "openai-compatible",
        preset: "ollama",
        baseUrl: "http://gpu-box:11434/v1",
        model: "qwen3.5:4b",
        apiKey: "",
      },
      "You are Astra.",
      (async (u: string | URL | Request, init?: RequestInit) => {
        if (String(u).endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "qwen3.5:4b", context_length: 2_048 }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const parsed = JSON.parse(String(init?.body ?? "{}")) as (typeof decideBodies)[number];
        smallUserContent = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"claimed": 0.1}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );
    smallCtxSession.setChatHistory([
      { type: "system", text: "You are Astra." },
      { type: "user", text: "Explain Rust lifetimes" },
      { type: "model", response: ["A".repeat(10_000)] },
    ]);
    await smallCtxSession.decide(CLAIM_CHECK);
    expect(smallUserContent.length).toBeLessThan(3_600);

    // 5. Windows clean-install verification checks actual voice-server/server.py imports (numpy, torch, qwen_tts).
    const winScript = await readFile(join(process.cwd(), "scripts/verify-clean-windows.ps1"), "utf8");
    expect(winScript).toContain("import numpy, torch, qwen_tts");
    expect(winScript).not.toContain("import fastapi, uvicorn");
  });
});
