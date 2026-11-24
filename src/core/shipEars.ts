import { spawn as startProcess } from "node:child_process";
import {
  AcousticEventClassifier,
  type AcousticClassification,
} from "./acousticEvents.ts";
import type { PlatformAdapter } from "./platform/adapter.ts";

/**
 * Her ears on the ship itself: what the PC is playing. While switched on, the last
 * minute and a half of it is kept in memory, so that "what did they just say?" can be
 * answered after the fact. It is never written to disk, and it is wiped the moment
 * this is switched off.
 *
 * The sound comes from the audio system's own recorder (`parec`) listening to the
 * "monitor" of the speakers: what is being played, not the microphone.
 */

export const SHIP_EARS_RATE = 16_000;
const BYTES_PER_SAMPLE = 4;
const DEFAULT_SECONDS = 90;
const FIRST_RETRY_MS = 2000;
const LONGEST_RETRY_MS = 60_000;
/** A recorder that lasted this long was working; the next failure starts the waits over. */
const HEALTHY_AFTER_MS = 30_000;
/** This many failures in a row are worth telling someone about, once. */
const WORTH_REPORTING = 5;
/** Quieter than this (about -50 dB) counts as silence. */
export const SILENCE_LEVEL = 0.003;

/** The part of a child process this needs. A real one fits; so does a stand-in in tests. */
export interface EarsProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export type EarsSpawn = (program: string, args: readonly string[]) => EarsProcess;

export interface ShipEarsOptions {
  /** Optional cross-platform adapter providing PipeWire/WASAPI loopback capture. */
  adapter?: PlatformAdapter;
  /** How much is kept, in seconds. */
  seconds?: number;
  /** Which sound source to listen to. Normally the monitor of the default speakers. */
  source?: string;
  /** How the recorder is started; replaced in tests. */
  spawn?: EarsSpawn;
  /** Told, in plain words, when listening cannot work. */
  onProblem?(message: string): void;
}

const realSpawn: EarsSpawn = (program, args) =>
  startProcess(program, [...args], { stdio: ["ignore", "pipe", "ignore"] });

export class ShipEars {
  private readonly ring: Float32Array;
  private readonly source: string;
  private readonly adapter?: PlatformAdapter;
  private readonly spawnOverride?: EarsSpawn;
  private readonly onProblem: (message: string) => void;
  /** Where the next sample goes. */
  private next = 0;
  /** How many samples of the ring hold real sound (it starts empty). */
  private filled = 0;
  /** The bytes of a sample that arrived split across two reads. */
  private carry: Buffer = Buffer.alloc(0);
  private child: EarsProcess | null = null;
  private wanted = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = FIRST_RETRY_MS;
  private failuresInARow = 0;
  private reported = false;

  constructor(options: ShipEarsOptions = {}) {
    const seconds = Math.min(600, Math.max(1, options.seconds ?? DEFAULT_SECONDS));
    this.ring = new Float32Array(Math.round(seconds * SHIP_EARS_RATE));
    this.source = options.source || process.env["AI_CHAN_PC_AUDIO_SOURCE"] || "@DEFAULT_MONITOR@";
    this.adapter = options.adapter;
    this.spawnOverride = options.spawn;
    this.onProblem = options.onProblem ?? ((): void => undefined);
  }

  /** True from `start()` until `stop()`, or until listening turned out to be impossible. */
  get running(): boolean {
    return this.wanted;
  }

  /** How many seconds of sound are held right now. */
  get heldSeconds(): number {
    return this.filled / SHIP_EARS_RATE;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.retryMs = FIRST_RETRY_MS;
    this.failuresInARow = 0;
    this.reported = false;
    this.listen();
  }

  /** Stops listening and forgets everything that was heard. */
  stop(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    this.child = null;
    try {
      child?.kill();
    } catch {
      // already gone
    }
    this.ring.fill(0);
    this.next = 0;
    this.filled = 0;
    this.carry = Buffer.alloc(0);
  }

  /** The last `seconds` of what was played, oldest first. Shorter when less has been heard. */
  recent(seconds: number): Float32Array {
    const asked = Number.isFinite(seconds) ? Math.round(seconds * SHIP_EARS_RATE) : 0;
    const count = Math.min(this.filled, Math.max(0, asked));
    const out = new Float32Array(count);
    const size = this.ring.length;
    const start = (this.next - count + size) % size;
    const untilEnd = Math.min(count, size - start);
    out.set(this.ring.subarray(start, start + untilEnd), 0);
    if (untilEnd < count) out.set(this.ring.subarray(0, count - untilEnd), untilEnd);
    return out;
  }

  /** Classifies recent PC loopback audio strictly in RAM (call/match chime/music/alarm/silence). */
  async classifyRecent(
    seconds = 3,
    classifier = new AcousticEventClassifier(),
  ): Promise<AcousticClassification> {
    return await classifier.classify(this.recent(seconds), SHIP_EARS_RATE);
  }

  /** How loud a stretch of sound is on average (root mean square, 0 to about 1). */
  static loudness(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  private listen(): void {
    if (!this.wanted || this.child) return;
    const startedAt = performance.now();
    let child: EarsProcess;
    try {
      child = this.spawnOverride
        ? this.spawnOverride("parec", [
            `--device=${this.source}`,
            "--format=float32le",
            `--rate=${SHIP_EARS_RATE}`,
            "--channels=1",
            "--latency-msec=250",
            "--client-name=AI-chan",
            "--stream-name=what the PC is playing",
          ])
        : this.adapter?.audioLoopback.spawnCapture
          ? this.adapter.audioLoopback.spawnCapture(this.source)
          : realSpawn("parec", [
              `--device=${this.source}`,
              "--format=float32le",
              `--rate=${SHIP_EARS_RATE}`,
              "--channels=1",
              "--latency-msec=250",
              "--client-name=AI-chan",
              "--stream-name=what the PC is playing",
            ]);
    } catch (error) {
      this.ended(null, startedAt, error);
      return;
    }
    this.child = child;
    this.carry = Buffer.alloc(0);
    // A recorder that failed reports it twice (an error, then an exit); once is enough.
    let over = false;
    const end = (error?: unknown): void => {
      if (over) return;
      over = true;
      this.ended(child, startedAt, error);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.child === child) this.take(chunk);
    });
    child.on("error", (error) => end(error));
    child.on("exit", () => end());
  }

  /** The recorder stopped. Unless that was asked for, it is started again after a wait. */
  private ended(child: EarsProcess | null, startedAt: number, error?: unknown): void {
    if (this.child !== child) return; // an old one, already replaced or stopped
    this.child = null;
    if (!this.wanted) return;
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      this.wanted = false;
      this.onProblem(
        "Hearing what the PC plays needs \"parec\" (it comes with PipeWire's or PulseAudio's tools), which is not installed.",
      );
      return;
    }
    if (performance.now() - startedAt >= HEALTHY_AFTER_MS) {
      this.retryMs = FIRST_RETRY_MS;
      this.failuresInARow = 0;
    }
    this.failuresInARow += 1;
    if (this.failuresInARow === WORTH_REPORTING && !this.reported) {
      this.reported = true;
      this.onProblem(
        "The PC's sound cannot be listened to right now (the recorder keeps stopping). She will keep trying.",
      );
    }
    const wait = this.retryMs;
    this.retryMs = Math.min(LONGEST_RETRY_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.listen();
    }, wait);
    this.retryTimer.unref();
  }

  /** Adds freshly recorded bytes to the ring, oldest sound falling off the far end. */
  private take(chunk: Buffer): void {
    const bytes = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = Math.floor(bytes.length / BYTES_PER_SAMPLE);
    const size = this.ring.length;
    // More than the ring holds in one go: only the end of it can be kept anyway.
    const first = Math.max(0, whole - size);
    for (let index = first; index < whole; index++) {
      const sample = bytes.readFloatLE(index * BYTES_PER_SAMPLE);
      this.ring[this.next] = Number.isFinite(sample) ? sample : 0;
      this.next = (this.next + 1) % size;
    }
    this.filled = Math.min(size, this.filled + (whole - first));
    // Copied, not sliced: a slice would keep the whole chunk alive behind three bytes.
    this.carry = Buffer.from(bytes.subarray(whole * BYTES_PER_SAMPLE));
  }
}

/**
 * Drops the silence before the first sound and after the last, judged in blocks of a
 * tenth of a second, so that a transcriber is not handed a minute of nothing. One quiet
 * block is left on each side, so a word's first consonant is not cut off. Returns an
 * empty array when there is no sound at all.
 */
export function trimSilence(samples: Float32Array, sampleRate: number): Float32Array {
  const block = Math.max(1, Math.round(sampleRate / 10));
  const blocks = Math.ceil(samples.length / block);
  let firstLoud = -1;
  let lastLoud = -1;
  for (let index = 0; index < blocks; index++) {
    const piece = samples.subarray(index * block, (index + 1) * block);
    if (ShipEars.loudness(piece) < SILENCE_LEVEL) continue;
    if (firstLoud === -1) firstLoud = index;
    lastLoud = index;
  }
  if (firstLoud === -1) return new Float32Array(0);
  const from = Math.max(0, firstLoud - 1) * block;
  const to = Math.min(samples.length, (lastLoud + 2) * block);
  return samples.slice(from, to);
}
