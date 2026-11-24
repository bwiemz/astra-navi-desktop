import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Native Hands Chaos Fuzzer (`scripts/fuzz-native-hands.ts`).
 *
 * Stresses the compiled `hands/linux-hands-native/target/release/linux-hands` binary
 * (with `AI_CHAN_NO_VIRTUAL_INPUT=1` so zero desktop events ever inject) across:
 * 1) Persistent streaming session (150 UTF-8 / JSON / boundary / flag-injection / oversized frames)
 * 2) Isolated binary/invalid-UTF8/truncated-EOF framing resilience checks (25 frames)
 * 3) Static safety audit of `hands/win-hands-native/Program.cs`
 */

export interface NativeFuzzReport {
  linuxBinaryPath: string;
  linuxBinaryPresent: boolean;
  totalCases: number;
  streamCases: number;
  isolatedBinaryCases: number;
  responsesReceived: number;
  crashes: number;
  nonzeroExits: number;
  winStaticAudit: {
    present: boolean;
    usesJsonSourceGen: boolean;
    blocksShellProcessStart: boolean;
    boundsCheckedCoordinates: boolean;
  };
  passed: boolean;
}

function buildStreamPayloads(): Buffer[] {
  const frames: Buffer[] = [
    Buffer.from('{"id":1,"op":"ping"}\n'),
    Buffer.from('{"id":2,"op":"rest"}\n'),
    Buffer.from("{not-json\n"),
    Buffer.from("[]\n"),
    Buffer.from('"just a string"\n'),
    Buffer.from("null\n"),
    Buffer.from(`${"[".repeat(64)}${"]".repeat(64)}\n`),
    Buffer.from(`{"id":3,"op":"key","keys":["--clearmodifiers"]}\n`),
    Buffer.from(`{"id":4,"op":"key","keys":["Ctrl+c;rm -rf /"]}\n`),
    Buffer.from(`{"id":5,"op":"key","keys":[]}\n`),
    Buffer.from(`{"id":6,"op":"key","keys":["a","b","c","d","e","f","g"]}\n`),
    Buffer.from(`{"id":7,"op":"pointer","x":1e309,"y":-1e309,"button":"left"}\n`),
    Buffer.from(`{"id":8,"op":"pointer","x":0.5,"y":0.5,"button":"side"}\n`),
    Buffer.from(`{"id":9,"op":"pointer","x":-999,"y":999,"rehearse":true}\n`),
    Buffer.from(`{"id":10,"op":"scroll","notches":-9223372036854775808,"rehearse":true}\n`),
    Buffer.from(`{"id":11,"op":"scroll","notches":9223372036854775807,"rehearse":true}\n`),
    Buffer.from(`{"id":12,"op":"unknown_danger_verb","cmd":"whoami"}\n`),
    Buffer.from(`{"id":13,"op":"key","keys":["\\u0000"]}\n`),
    Buffer.from(`{"id":15,"op":"ping","pad":"${"x".repeat(70_000)}"}\n`),
    // Verify recovery right after an oversized >64KiB line
    Buffer.from('{"id":16,"op":"ping"}\n'),
  ];

  // Deterministically synthesize 130 additional mutated UTF-8/JSON frames for 150 stream cases
  let seed = 20261123;
  const nextRand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const ops = ["ping", "pointer", "scroll", "key", "watch", "unwatch", "rest", "bogus", "", "\t"];
  for (let i = 0; i < 130; i += 1) {
    const r = nextRand();
    const op = ops[r % ops.length] ?? "ping";
    const x = ((r % 2000) - 1000) / 100;
    const y = (((r >>> 8) % 2000) - 1000) / 100;
    if (i % 9 === 0) {
      frames.push(Buffer.from(`{{{bad-json-${i}-${r}\n`));
    } else {
      const msg = JSON.stringify({
        id: 100 + i,
        op,
        x,
        y,
        notches: (r & 1 ? -1 : 1) * (r % 100_000),
        keys: i % 3 === 0 ? ["--help", "$(id)"] : ["Escape"],
        rehearse: true,
      });
      frames.push(Buffer.from(`${msg}\n`));
    }
  }
  return frames;
}

function buildIsolatedBinaryPayloads(): Buffer[] {
  const cases: Buffer[] = [
    Buffer.concat([Buffer.from('{"id":14,"op":"'), Buffer.from([0xff, 0xfe, 0x00, 0x80]), Buffer.from('"}\n')]),
    Buffer.from('{"id":900,"op":"ping"'), // truncated without trailing newline / brace
    Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a]),
  ];
  let seed = 99123;
  for (let i = 0; i < 22; i += 1) {
    const len = 16 + (i % 64);
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const b = seed & 0xff;
      buf[j] = b === 0x0a ? 0x20 : b;
    }
    cases.push(Buffer.concat([buf, Buffer.from("\n")]));
  }
  return cases;
}

async function runLinuxStreamFuzz(binPath: string, payloads: readonly Buffer[]): Promise<{
  responsesReceived: number;
  crashes: number;
  nonzeroExits: number;
}> {
  return new Promise((resolve) => {
    const child = spawn(binPath, [], {
      env: { ...process.env, AI_CHAN_NO_VIRTUAL_INPUT: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let writeErr = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.on("error", () => {
      writeErr = true;
    });
    for (const frame of payloads) {
      if (!child.stdin.destroyed) child.stdin.write(frame);
    }
    child.stdin.end();
    child.on("close", (code, signal) => {
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const crashed = signal !== null || writeErr;
      resolve({
        responsesReceived: lines.length,
        crashes: crashed ? 1 : 0,
        nonzeroExits: code !== 0 ? 1 : 0,
      });
    });
  });
}

function runIsolatedBinaryFuzz(binPath: string, cases: readonly Buffer[]): {
  responsesReceived: number;
  crashes: number;
  nonzeroExits: number;
} {
  let responsesReceived = 0;
  let crashes = 0;
  let nonzeroExits = 0;
  for (const frame of cases) {
    const res = spawnSync(binPath, [], {
      input: frame,
      env: { ...process.env, AI_CHAN_NO_VIRTUAL_INPUT: "1" },
      timeout: 3_000,
    });
    if (res.signal !== null) crashes += 1;
    if (res.status !== 0) nonzeroExits += 1;
    const out = String(res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    responsesReceived += out.length;
  }
  return { responsesReceived, crashes, nonzeroExits };
}

function auditWinProgramCs(csPath: string): NativeFuzzReport["winStaticAudit"] {
  if (!existsSync(csPath)) {
    return {
      present: false,
      usesJsonSourceGen: false,
      blocksShellProcessStart: false,
      boundsCheckedCoordinates: false,
    };
  }
  const src = readFileSync(csPath, "utf8");
  const usesJsonSourceGen = src.includes("JsonSerializerContext") && src.includes("WinHandsJsonContext");
  const startedFiles = [...src.matchAll(/FileName\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const onlyFixedNvidiaSmi = startedFiles.every((f) => f === "nvidia-smi");
  const hasShellExecTrue = /UseShellExecute\s*=\s*true/i.test(src);
  const invokesShell = /\b(?:cmd\.exe|powershell|pwsh)\b/i.test(src);
  const blocksShellProcessStart = onlyFixedNvidiaSmi && !hasShellExecTrue && !invokesShell;
  const boundsCheckedCoordinates = src.includes("Clamp") || src.includes("Math.Clamp") || src.includes("clamp");
  return {
    present: true,
    usesJsonSourceGen,
    blocksShellProcessStart,
    boundsCheckedCoordinates,
  };
}

export async function runNativeHandsChaosFuzz(): Promise<NativeFuzzReport> {
  const linuxBinaryPath = join(
    process.cwd(),
    "hands",
    "linux-hands-native",
    "target",
    "release",
    "linux-hands",
  );
  const winCsPath = join(process.cwd(), "hands", "win-hands-native", "Program.cs");
  const linuxBinaryPresent = existsSync(linuxBinaryPath);
  const streamPayloads = buildStreamPayloads();
  const isolatedPayloads = buildIsolatedBinaryPayloads();

  let responsesReceived = 0;
  let crashes = 0;
  let nonzeroExits = 0;
  if (linuxBinaryPresent) {
    const streamRes = await runLinuxStreamFuzz(linuxBinaryPath, streamPayloads);
    const isoRes = runIsolatedBinaryFuzz(linuxBinaryPath, isolatedPayloads);
    responsesReceived = streamRes.responsesReceived + isoRes.responsesReceived;
    crashes = streamRes.crashes + isoRes.crashes;
    nonzeroExits = streamRes.nonzeroExits + isoRes.nonzeroExits;
  }

  const totalCases = streamPayloads.length + isolatedPayloads.length;
  const winStaticAudit = auditWinProgramCs(winCsPath);
  const passed =
    linuxBinaryPresent &&
    crashes === 0 &&
    nonzeroExits === 0 &&
    responsesReceived >= streamPayloads.length &&
    winStaticAudit.present &&
    winStaticAudit.usesJsonSourceGen &&
    winStaticAudit.blocksShellProcessStart;

  return {
    linuxBinaryPath,
    linuxBinaryPresent,
    totalCases,
    streamCases: streamPayloads.length,
    isolatedBinaryCases: isolatedPayloads.length,
    responsesReceived,
    crashes,
    nonzeroExits,
    winStaticAudit,
    passed,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runNativeHandsChaosFuzz();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `Native Hands Chaos Fuzz: ${report.totalCases} frames (stream=${report.streamCases}, binary=${report.isolatedBinaryCases}), responses=${report.responsesReceived}, crashes=${report.crashes}, exitNonZero=${report.nonzeroExits}, winAuditOk=${report.winStaticAudit.usesJsonSourceGen && report.winStaticAudit.blocksShellProcessStart}`,
    );
  }
  if (!report.passed) process.exitCode = 1;
}
