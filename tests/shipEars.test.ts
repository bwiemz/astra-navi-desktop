import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHIP_EARS_RATE,
  ShipEars,
  SILENCE_LEVEL,
  trimSilence,
  type EarsProcess,
} from "../src/core/shipEars.ts";

/** A stand-in for the recorder: bytes pushed into it arrive as if it had recorded them. */
class FakeRecorder extends EventEmitter {
  readonly stdout = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  play(samples: readonly number[]): void {
    this.stdout.emit("data", bytesOf(samples));
  }
}

function bytesOf(samples: readonly number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, index) => buffer.writeFloatLE(sample, index * 4));
  return buffer;
}

/** Numbers that survive a trip through 32-bit floats unchanged. */
function ramp(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => (from + index) / 1024);
}

function makeEars(seconds: number): {
  ears: ShipEars;
  recorders: FakeRecorder[];
  started: { program: string; args: readonly string[] }[];
  problems: string[];
} {
  const recorders: FakeRecorder[] = [];
  const started: { program: string; args: readonly string[] }[] = [];
  const problems: string[] = [];
  const ears = new ShipEars({
    seconds,
    source: "test.monitor",
    spawn: (program, args) => {
      started.push({ program, args });
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      return recorder as unknown as EarsProcess;
    },
    onProblem: (message) => problems.push(message),
  });
  return { ears, recorders, started, problems };
}

function latest(recorders: FakeRecorder[]): FakeRecorder {
  const recorder = recorders.at(-1);
  if (!recorder) throw new Error("no recorder was started");
  return recorder;
}

describe("her ears on what the PC plays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("starts the recorder on the given source with fixed arguments", () => {
    const { ears, started } = makeEars(1);
    ears.start();
    ears.start(); // a second call changes nothing
    expect(started).toHaveLength(1);
    expect(started[0]?.program).toBe("parec");
    expect(started[0]?.args).toEqual([
      "--device=test.monitor",
      "--format=float32le",
      "--rate=16000",
      "--channels=1",
      "--latency-msec=250",
      "--client-name=AI-chan",
      "--stream-name=what the PC is playing",
    ]);
    expect(ears.running).toBe(true);
    ears.stop();
  });

  it("listens to the default speakers unless told otherwise", () => {
    const sources: string[] = [];
    const spawn = (_program: string, args: readonly string[]): EarsProcess => {
      sources.push(args[0] ?? "");
      return new FakeRecorder() as unknown as EarsProcess;
    };
    const plain = new ShipEars({ spawn });
    plain.start();
    plain.stop();
    vi.stubEnv("AI_CHAN_PC_AUDIO_SOURCE", "scratch.monitor");
    const overridden = new ShipEars({ spawn });
    overridden.start();
    overridden.stop();
    expect(sources).toEqual(["--device=@DEFAULT_MONITOR@", "--device=scratch.monitor"]);
  });

  it("returns what was heard, oldest first, and no more than was heard", () => {
    const { ears, recorders } = makeEars(1);
    ears.start();
    expect(ears.recent(1)).toHaveLength(0);
    latest(recorders).play(ramp(0, 100));
    expect(ears.heldSeconds).toBeCloseTo(100 / SHIP_EARS_RATE);
    expect([...ears.recent(1)]).toEqual(ramp(0, 100));
    expect([...ears.recent(10 / SHIP_EARS_RATE)]).toEqual(ramp(90, 10));
    expect(ears.recent(0)).toHaveLength(0);
    expect(ears.recent(-5)).toHaveLength(0);
    expect(ears.recent(Number.NaN)).toHaveLength(0);
    ears.stop();
  });

  it("returns a copy, not a window onto its own memory", () => {
    const { ears, recorders } = makeEars(1);
    ears.start();
    latest(recorders).play(ramp(1, 4));
    const copy = ears.recent(1);
    copy.fill(9);
    expect([...ears.recent(1)]).toEqual(ramp(1, 4));
    ears.stop();
  });

  it("keeps only the newest sound once the ring is full", () => {
    const size = SHIP_EARS_RATE; // one second
    const { ears, recorders } = makeEars(1);
    ears.start();
    const recorder = latest(recorders);
    recorder.play(ramp(0, size - 10));
    recorder.play(ramp(size - 10, 30)); // wraps around the end
    const heard = ears.recent(5);
    expect(heard).toHaveLength(size);
    expect(heard[0]).toBe(20 / 1024);
    expect(heard[size - 1]).toBe((size + 19) / 1024);
    expect([...ears.recent(4 / SHIP_EARS_RATE)]).toEqual(ramp(size + 16, 4));
    ears.stop();
  });

  it("keeps the end of a chunk that is bigger than the whole ring", () => {
    const size = SHIP_EARS_RATE;
    const { ears, recorders } = makeEars(1);
    ears.start();
    latest(recorders).play(ramp(0, size + 500));
    const heard = ears.recent(1);
    expect(heard).toHaveLength(size);
    expect(heard[0]).toBe(500 / 1024);
    expect(heard[size - 1]).toBe((size + 499) / 1024);
    ears.stop();
  });

  it("puts a sample back together when it arrives split across reads", () => {
    const { ears, recorders } = makeEars(1);
    ears.start();
    const recorder = latest(recorders);
    const bytes = bytesOf(ramp(1, 5));
    recorder.stdout.emit("data", bytes.subarray(0, 6));
    expect(ears.recent(1)).toHaveLength(1);
    recorder.stdout.emit("data", bytes.subarray(6, 7));
    recorder.stdout.emit("data", bytes.subarray(7, 19));
    expect(ears.recent(1)).toHaveLength(4);
    recorder.stdout.emit("data", bytes.subarray(19));
    expect([...ears.recent(1)]).toEqual(ramp(1, 5));
    ears.stop();
  });

  it("treats a sample that is not a number as silence", () => {
    const { ears, recorders } = makeEars(1);
    ears.start();
    latest(recorders).play([0.5, Number.NaN, Number.POSITIVE_INFINITY, 0.25]);
    expect([...ears.recent(1)]).toEqual([0.5, 0, 0, 0.25]);
    ears.stop();
  });

  it("forgets everything and stops the recorder when switched off", () => {
    const { ears, recorders } = makeEars(1);
    ears.start();
    const recorder = latest(recorders);
    recorder.play(ramp(1, 50));
    ears.stop();
    expect(recorder.killed).toBe(true);
    expect(ears.running).toBe(false);
    expect(ears.recent(1)).toHaveLength(0);
    // Sound from the recorder that was just stopped is not taken in.
    recorder.play(ramp(1, 50));
    expect(ears.recent(1)).toHaveLength(0);
    // Its exit does not bring a new one to life.
    recorder.emit("exit", 0);
    vi.advanceTimersByTime(120_000);
    expect(recorders).toHaveLength(1);
    // Switched on again, the ring starts empty.
    ears.start();
    expect(recorders).toHaveLength(2);
    expect(ears.recent(1)).toHaveLength(0);
    ears.stop();
  });

  it("starts the recorder again when it dies, waiting longer each time", () => {
    const { ears, recorders, problems } = makeEars(1);
    ears.start();
    const waits = [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000];
    for (const [index, wait] of waits.entries()) {
      latest(recorders).emit("exit", 1);
      vi.advanceTimersByTime(wait - 1);
      expect(recorders, `before wait ${index}`).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(recorders, `after wait ${index}`).toHaveLength(index + 2);
    }
    // Told about once, after several failures in a row, not every time.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("keeps stopping");
    expect(ears.running).toBe(true);
    ears.stop();
  });

  it("goes back to a short wait after the recorder has worked for a while", () => {
    const { ears, recorders, problems } = makeEars(1);
    ears.start();
    latest(recorders).emit("exit", 1);
    vi.advanceTimersByTime(2000);
    latest(recorders).emit("exit", 1);
    vi.advanceTimersByTime(4000);
    expect(recorders).toHaveLength(3);
    vi.advanceTimersByTime(31_000); // this one worked
    latest(recorders).emit("exit", 1);
    vi.advanceTimersByTime(2000);
    expect(recorders).toHaveLength(4);
    expect(problems).toEqual([]);
    ears.stop();
  });

  it("counts an error followed by an exit as one failure", () => {
    const { ears, recorders } = makeEars(1);
    ears.start();
    const recorder = latest(recorders);
    recorder.emit("error", new Error("the sound server went away"));
    recorder.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    expect(recorders).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(recorders).toHaveLength(2);
    ears.stop();
  });

  it("keeps what it had heard across a restart of the recorder", () => {
    const { ears, recorders } = makeEars(1);
    ears.start();
    const first = latest(recorders);
    first.play(ramp(1, 3));
    first.stdout.emit("data", Buffer.from([1, 2])); // half a sample, lost with the recorder
    first.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    latest(recorders).play(ramp(4, 2));
    expect([...ears.recent(1)]).toEqual(ramp(1, 5));
    ears.stop();
  });

  it("says so once, and stops trying, when the recorder is not installed", () => {
    const { ears, recorders, problems } = makeEars(1);
    ears.start();
    const missing = Object.assign(new Error("spawn parec ENOENT"), { code: "ENOENT" });
    const recorder = latest(recorders);
    recorder.emit("error", missing);
    recorder.emit("exit", null);
    vi.advanceTimersByTime(300_000);
    expect(recorders).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"parec"');
    expect(ears.running).toBe(false);
  });

  it("handles a recorder that cannot even be started", () => {
    const problems: string[] = [];
    let attempts = 0;
    const ears = new ShipEars({
      seconds: 1,
      spawn: () => {
        attempts += 1;
        throw Object.assign(new Error("spawn parec ENOENT"), { code: "ENOENT" });
      },
      onProblem: (message) => problems.push(message),
    });
    ears.start();
    vi.advanceTimersByTime(300_000);
    expect(attempts).toBe(1);
    expect(problems).toHaveLength(1);
    expect(ears.running).toBe(false);
  });
});

describe("telling sound from silence", () => {
  it("measures loudness as the root mean square", () => {
    expect(ShipEars.loudness(new Float32Array(0))).toBe(0);
    expect(ShipEars.loudness(new Float32Array(100))).toBe(0);
    expect(ShipEars.loudness(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(ShipEars.loudness(new Float32Array([1, 0, 0, 0]))).toBeCloseTo(0.5);
  });

  it("returns nothing when there is no sound at all", () => {
    expect(trimSilence(new Float32Array(0), 16_000)).toHaveLength(0);
    expect(trimSilence(new Float32Array(48_000), 16_000)).toHaveLength(0);
    const hiss = new Float32Array(48_000).fill(SILENCE_LEVEL / 2);
    expect(trimSilence(hiss, 16_000)).toHaveLength(0);
  });

  it("cuts the silence off both ends and leaves a little room around the sound", () => {
    const rate = 16_000;
    const block = rate / 10;
    const samples = new Float32Array(rate * 3); // 30 blocks
    samples.fill(0.2, 10 * block, 15 * block); // sound in blocks 10 to 14
    const trimmed = trimSilence(samples, rate);
    // One quiet block kept on each side: blocks 9 to 15.
    expect(trimmed).toHaveLength(7 * block);
    expect(trimmed[block - 1]).toBe(0);
    expect(trimmed[block]).toBeCloseTo(0.2);
    expect(trimmed[6 * block - 1]).toBeCloseTo(0.2);
    expect(trimmed[6 * block]).toBe(0);
  });

  it("keeps a pause between two sounds", () => {
    const rate = 16_000;
    const block = rate / 10;
    const samples = new Float32Array(rate * 2);
    samples.fill(0.1, 0, block);
    samples.fill(0.1, 12 * block, 13 * block);
    expect(trimSilence(samples, rate)).toHaveLength(14 * block);
  });

  it("does not run past either end", () => {
    const rate = 16_000;
    const samples = new Float32Array(2500).fill(0.3); // one full block and a part
    const trimmed = trimSilence(samples, rate);
    expect(trimmed).toHaveLength(2500);
    trimmed[0] = 0;
    expect(samples[0]).toBeCloseTo(0.3); // a copy
  });
});
