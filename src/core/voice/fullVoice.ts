import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import type { Readable } from "node:stream";
import { LANGUAGES, type LanguageCode } from "../languages.ts";
import type { SpokenAudio, VoiceBackend } from "./backend.ts";

export interface FullVoiceOptions {
  /** The Python interpreter of the voice environment (made by `npm run setup-voice`). */
  python: string;
  /** Path to voice-server/server.py. */
  serverScript: string;
  /** The designed voice: a reference clip and the words spoken in it. */
  referenceAudio: string;
  referenceText: string;
  /** Where the speech model's files are downloaded to. */
  modelCache: string;
  /** Stop the speech server after this long unused, to give its memory back. 0 never stops it. */
  idleStopMs: number;
}

interface Waiting {
  resolve(audio: SpokenAudio): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Header {
  ready?: boolean;
  id?: number;
  ok?: boolean;
  error?: string;
  sampleRate?: number;
  samples?: number;
}

/** One running speech server and everything that belongs to it alone. */
interface Server {
  child: ChildProcess;
  ready: Promise<void>;
  waiting: Map<number, Waiting>;
  buffered: Buffer;
  header: Header | null;
  errorOutput: string;
  exited: Promise<void>;
}

const START_TIMEOUT_MS = 10 * 60 * 1000; // the first start downloads the model
/** Long enough for the longest sentence on a slow machine; past it the server is taken to be stuck. */
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_SAMPLES = 24_000 * 120;

/**
 * The full voice: Qwen3-TTS speaking in a voice that was designed for this project from
 * a written description (see voice-server/design.py). One consistent voice in every
 * language. It runs as a separate Python program on this computer, started here and
 * spoken to over pipes, and wants a graphics card to keep up with conversation.
 */
export class FullVoice implements VoiceBackend {
  readonly label = "full voice";
  private readonly options: FullVoiceOptions;
  private server: Server | null = null;
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: FullVoiceOptions) {
    this.options = options;
  }

  /** True when the voice environment and the designed voice are both in place. */
  static async isSetUp(
    options: Pick<FullVoiceOptions, "python" | "referenceAudio" | "referenceText">,
  ): Promise<boolean> {
    try {
      await access(options.python, constants.X_OK);
      await access(options.referenceAudio, constants.R_OK);
      await access(options.referenceText, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  supports(language: LanguageCode): boolean {
    return language in LANGUAGES;
  }

  async warm(): Promise<void> {
    await this.start().ready;
    this.keepAwake(); // loaded but unused must not mean loaded for ever
  }

  async synthesize(sentence: string, language: LanguageCode): Promise<SpokenAudio> {
    const server = this.start();
    await server.ready;
    const input = server.child.stdin;
    if (!input || this.server !== server) throw new Error("The speech server is not running.");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const id = this.nextId++;
    try {
      return await new Promise<SpokenAudio>((resolve, reject) => {
        const timer = setTimeout(() => {
          // The exit handler rejects this and every other request still waiting.
          server.child.kill("SIGKILL");
        }, REQUEST_TIMEOUT_MS);
        server.waiting.set(id, { resolve, reject, timer });
        const request = { id, text: sentence, language: LANGUAGES[language].voiceName };
        input.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error) this.take(server, id)?.reject(error);
        });
      });
    } finally {
      this.keepAwake();
    }
  }

  /** Stops the server and frees its memory. It starts again by itself when next needed. */
  async rest(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.child.stdin?.end(); // the server leaves when its input closes
    const force = setTimeout(() => server.child.kill("SIGKILL"), 3000);
    await server.exited;
    clearTimeout(force);
  }

  /**
   * Stops the server unless it is in the middle of a sentence. For giving the graphics
   * card back to a game without waiting out the usual quiet time.
   */
  async restIfIdle(): Promise<void> {
    if (this.server && this.server.waiting.size === 0) await this.rest();
  }

  /** Stops the server for good. Used when the app is closing, so nothing can start it again. */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.rest();
  }

  private keepAwake(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.options.idleStopMs <= 0 || !this.server) return;
    this.idleTimer = setTimeout(() => {
      // Never in the middle of a sentence; the request's own end re-arms this.
      if (this.server && this.server.waiting.size === 0) void this.rest();
    }, this.options.idleStopMs);
    this.idleTimer.unref();
  }

  private take(server: Server, id: number | undefined): Waiting | undefined {
    if (id === undefined) return undefined;
    const waiter = server.waiting.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      server.waiting.delete(id);
    }
    return waiter;
  }

  private start(): Server {
    if (this.closed) throw new Error("The voice has been shut down.");
    if (this.server) return this.server;
    const { options } = this;
    const child = spawn(
      options.python,
      [
        options.serverScript,
        "--reference",
        options.referenceAudio,
        "--reference-text",
        options.referenceText,
      ],
      {
        // stdin: requests. stdout: discarded (libraries print there). stderr: kept for
        // error messages. fd 3: the replies, where nothing else can write.
        stdio: ["pipe", "ignore", "pipe", "pipe"],
        env: { ...process.env, HF_HOME: options.modelCache, TOKENIZERS_PARALLELISM: "false" },
      },
    );

    let settle: (error: Error | null) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The speech server took too long to start."));
        child.kill("SIGKILL");
      }, START_TIMEOUT_MS);
      settle = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
    });
    ready.catch(() => undefined); // reported to whoever awaits it; never an unhandled rejection

    const server: Server = {
      child,
      ready,
      waiting: new Map(),
      buffered: Buffer.alloc(0),
      header: null,
      errorOutput: "",
      exited: new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve()); // it never started, so it will never exit
      }),
    };
    this.server = server;

    const fail = (error: Error): void => {
      if (this.server === server) this.server = null; // the next sentence starts a fresh one
      settle(error);
      for (const id of [...server.waiting.keys()]) this.take(server, id)?.reject(error);
    };

    // A broken pipe is reported through "exit"; without these listeners it would crash the app.
    child.stdin?.on("error", () => undefined);
    const replies = child.stdio[3] as Readable;
    replies.on("error", () => undefined);
    replies.on("data", (chunk: Buffer) => this.onData(server, chunk, settle));
    child.stderr?.on("data", (chunk: Buffer) => {
      server.errorOutput = (server.errorOutput + chunk.toString("utf8")).slice(-1500);
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => {
      const reason = server.errorOutput.trim().split("\n").pop() ?? "";
      fail(new Error(`The speech server stopped (exit ${code ?? "?"}). ${reason}`.trim()));
    });
    return server;
  }

  /** Reads replies: a JSON line, then for a successful one that many float32 samples. */
  private onData(server: Server, chunk: Buffer, settle: (error: Error | null) => void): void {
    server.buffered = Buffer.concat([server.buffered, chunk]);
    for (;;) {
      if (!server.header) {
        const end = server.buffered.indexOf(0x0a);
        if (end === -1) return;
        let header: Header;
        try {
          header = JSON.parse(server.buffered.subarray(0, end).toString("utf8")) as Header;
        } catch {
          server.child.kill("SIGKILL");
          return;
        }
        server.buffered = server.buffered.subarray(end + 1);
        if (header.ready !== undefined) {
          settle(
            header.ready
              ? null
              : new Error(header.error ?? "The speech model could not be loaded."),
          );
          continue;
        }
        if (!header.ok) {
          this.take(server, header.id)?.reject(
            new Error(header.error ?? "That sentence could not be spoken."),
          );
          continue;
        }
        server.header = header;
      }

      const count = server.header.samples ?? 0;
      if (!Number.isInteger(count) || count < 0 || count > MAX_SAMPLES) {
        server.child.kill("SIGKILL");
        return;
      }
      const bytes = count * 4;
      if (server.buffered.length < bytes) return;
      // Copied out, because the buffer it was read from is reused for the next reply.
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = server.buffered.readFloatLE(i * 4);
      server.buffered = server.buffered.subarray(bytes);
      this.take(server, server.header.id)?.resolve({
        samples,
        sampleRate: server.header.sampleRate ?? 24_000,
      });
      server.header = null;
    }
  }
}
