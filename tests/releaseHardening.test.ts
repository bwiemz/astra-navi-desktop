import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runBootstrapTask } from "../src/core/bootstrap.ts";
import {
  CharacterBundleManifestSchema,
  inspectCharacterBundle,
  openSignedCharacterBundle,
  packSignedCharacterBundle,
} from "../src/core/characterBundle.ts";
import { recommendHardwareTier } from "../src/core/hardwareTuner.ts";
import { encodeMdnsResponse, parseMdnsQuery } from "../src/core/mdns.ts";
import { checkFreeDiskSpace, downloadModelResumable } from "../src/core/modelBundle.ts";
import { WindowsPlatformAdapter } from "../src/core/platform/windows.ts";
import {
  exportProfileBackup,
  importProfileBackup,
  inspectProfileBackup,
} from "../src/core/profileBackup.ts";
import { buildPairingUri, encodeQrMatrix } from "../src/core/qrCode.ts";
import { StartupGuard } from "../src/core/safeMode.ts";
import { resolveLocalSecretBackend } from "../src/core/secrets.ts";
import { checkGithubReleaseUpdate } from "../src/core/updateCheck.ts";
import { detectDistributionChannel } from "../src/shared/edition.ts";

const ROOT = resolve(import.meta.dirname, "..");
const GIB = 1024 ** 3;

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error("Invalid PNG header");
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function parseXmlStringKeys(xml: string): string[] {
  const names: string[] = [];
  const re = /<string\s+name="([^"]+)">/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

describe("pre-launch release hardening, mobile QR/mDNS, profile backup, variants & store assets", () => {
  it("pins all Python dependencies with == in voice-server and train requirements and passes -r to bootstrap", async () => {
    for (const rel of ["voice-server/requirements.txt", "train/requirements.txt"]) {
      const content = await readFile(join(ROOT, rel), "utf8");
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      expect(lines.length).toBeGreaterThanOrEqual(5);
      for (const pkg of lines) {
        expect(pkg).toMatch(/^[A-Za-z0-9_.-]+==[0-9]+(\.[0-9]+)*$/);
      }
    }

    const root = await mkdtemp(join(tmpdir(), "astranavi-voice-req-"));
    try {
      const appRoot = join(root, "app");
      const dataRoot = join(root, "data");
      await mkdir(join(appRoot, "voice-server"), { recursive: true });
      await writeFile(join(appRoot, "voice-server", "requirements.txt"), "qwen-tts==0.0.5\n", "utf8");

      const calls: string[][] = [];
      const res = await runBootstrapTask("voice", {
        platform: "linux",
        home: root,
        appRoot,
        dataRoot,
        dryRun: false,
        runCommand: vi.fn(async (cmd: string, args: readonly string[]) => {
          calls.push([cmd, ...args]);
          if (cmd === "uv" && args[0] === "--version") return { stdout: "uv 0.6.0", stderr: "" };
          return { stdout: "", stderr: "" };
        }),
      });
      expect(res.ok).toBe(true);
      const installCall = calls.find((c) => c.includes("-r"));
      expect(installCall).toBeDefined();
      expect(installCall).toContain(join(appRoot, "voice-server", "requirements.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports resumable HTTP 206 downloads, 200 restarts, abort cleanup, disk space guard, and SHA-256 tamper cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "astranavi-dl-"));
    try {
      await expect(checkFreeDiskSpace(dir, 100_000_000 * GIB)).rejects.toThrow(
        /Insufficient disk space/i,
      );

      const payload = Buffer.from("ASTRA_NAVI_GGUF_MOCK_PAYLOAD_0123456789ABCDEF");
      const expectedSha = createHash("sha256").update(payload).digest("hex");
      const destPath = join(dir, "model.gguf");
      const partPath = `${destPath}.part`;

      // Seed first 16 bytes as interrupted .part file and resume via HTTP 206
      await writeFile(partPath, payload.subarray(0, 16));
      let seenRange: string | null = null;
      const resumed = await downloadModelResumable({
        url: "https://example.local/model.gguf",
        destPath,
        expectedSizeBytes: payload.length,
        expectedSha256: expectedSha,
        fetchImpl: vi.fn(async (_url, init) => {
          seenRange = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
          return new Response(payload.subarray(16), {
            status: 206,
            headers: {
              "content-range": `bytes 16-${payload.length - 1}/${payload.length}`,
              "content-length": String(payload.length - 16),
            },
          });
        }) as unknown as typeof fetch,
      });
      expect(seenRange).toBe("bytes=16-");
      expect(resumed.resumed).toBe(true);
      expect(resumed.bytes).toBe(payload.length);
      expect(await readFile(destPath)).toEqual(payload);

      // Corrupt SHA-256 must fail and clean up .part
      const badDest = join(dir, "bad.gguf");
      await expect(
        downloadModelResumable({
          url: "https://example.local/bad.gguf",
          destPath: badDest,
          expectedSizeBytes: payload.length,
          expectedSha256: "0".repeat(64),
          fetchImpl: vi.fn(async () => new Response(payload, { status: 200 })) as unknown as typeof fetch,
        }),
      ).rejects.toThrow(/SHA-256 verification failed/i);
      await expect(stat(`${badDest}.part`)).rejects.toThrow();

      // Abort mid-stream with cleanupPartialOnAbort cleans up .part
      const abortDest = join(dir, "abort.gguf");
      const controller = new AbortController();
      await expect(
        downloadModelResumable({
          url: "https://example.local/abort.gguf",
          destPath: abortDest,
          cleanupPartialOnAbort: true,
          signal: controller.signal,
          fetchImpl: vi.fn(async () => {
            const stream = new ReadableStream({
              start(ctrl) {
                ctrl.enqueue(new Uint8Array([1, 2, 3, 4]));
                controller.abort();
                ctrl.error(new DOMException("Aborted", "AbortError"));
              },
            });
            return new Response(stream, { status: 200 });
          }) as unknown as typeof fetch,
        }),
      ).rejects.toThrow();
      await expect(stat(`${abortDest}.part`)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("activates StartupGuard safe mode after consecutive crashes and clears on exitSafeMode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "astranavi-safemode-"));
    try {
      const guard = new StartupGuard(dir, 2);
      const first = await guard.recordBootStart(new Date("2026-11-22T01:00:00Z"));
      expect(first.safeMode).toBe(false);
      expect(first.consecutiveCrashes).toBe(1);

      const second = await guard.recordBootStart(new Date("2026-11-22T01:01:00Z"));
      expect(second.safeMode).toBe(true);
      expect(second.consecutiveCrashes).toBe(2);
      expect(second.reason).toContain("Safe Mode active");

      await guard.markBootHealthy(new Date("2026-11-22T01:02:00Z"));
      const whileStillFlagged = await guard.recordBootStart(new Date("2026-11-22T01:03:00Z"));
      expect(whileStillFlagged.safeMode).toBe(true);

      await guard.exitSafeMode(new Date("2026-11-22T01:04:00Z"));
      const recovered = await guard.recordBootStart(new Date("2026-11-22T01:05:00Z"));
      expect(recovered.safeMode).toBe(false);
      expect(recovered.consecutiveCrashes).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("suppresses GitHub release update checks on Steam, itch, Flatpak, and Supporter editions", async () => {
    expect(detectDistributionChannel({ SteamAppId: "12345" })).toBe("steam");
    expect(detectDistributionChannel({ WHARF_CHANNEL: "win-64" })).toBe("itch");
    expect(detectDistributionChannel({ FLATPAK_ID: "app.astranavi.desktop" })).toBe("flatpak");

    for (const env of [
      { SteamAppId: "12345" },
      { BUTLER_INSTALL: "1" },
      { FLATPAK_ID: "app.astranavi.desktop" },
      { ASTRA_NAVI_EDITION: "supporter" },
    ]) {
      const res = await checkGithubReleaseUpdate({
        currentVersion: "0.1.0",
        env,
        exists: () => false,
        fetchImpl: vi.fn(() => {
          throw new Error("Should never fetch on managed storefront/edition");
        }) as unknown as typeof fetch,
      });
      expect(res.status).toBe("disabled");
    }

    const avail = await checkGithubReleaseUpdate({
      currentVersion: "0.1.0",
      env: {},
      exists: () => false,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tag_name: "v0.2.0",
              html_url: "https://github.com/bwiemz/astra-navi-desktop/releases/tag/v0.2.0",
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
    });
    expect(avail.status).toBe("update-available");
    expect(avail.latestVersion).toBe("0.2.0");

    const current = await checkGithubReleaseUpdate({
      currentVersion: "0.2.0",
      env: {},
      exists: () => false,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ tag_name: "v0.2.0" }), { status: 200 }),
      ) as unknown as typeof fetch,
    });
    expect(current.status).toBe("up-to-date");
  });

  it("degrades secrets backend cleanly on minimal Linux and excludes win_hands.ps1 in packaging", async () => {
    const minimal = resolveLocalSecretBackend({
      platform: "linux",
      safeStorageAvailable: false,
      hasSecretService: false,
    });
    expect(minimal.backend).toBe("owner-file-0600");
    expect(minimal.degraded).toBe(true);
    expect(minimal.notice).toContain("0600");

    const desktop = resolveLocalSecretBackend({
      platform: "linux",
      safeStorageAvailable: true,
      hasSecretService: true,
    });
    expect(desktop.backend).toBe("os-keyring");
    expect(desktop.degraded).toBe(false);

    const builderYaml = await readFile(join(ROOT, "electron-builder.yml"), "utf8");
    expect(builderYaml).toContain('"!win_hands.ps1"');

    // WindowsPlatformAdapter must construct cleanly even when win_hands.ps1 does not exist
    const dir = await mkdtemp(join(tmpdir(), "astranavi-win-nops1-"));
    try {
      const adapter = new WindowsPlatformAdapter({
        scriptPath: join(dir, "missing-win_hands.ps1"),
      });
      await adapter.dispose?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("generates valid ISO 18004 QR matrices and mDNS _astranavi._tcp.local DNS-SD packets", () => {
    const uri = buildPairingUri({
      address: "https://192.168.1.42:47821",
      fingerprint: "AA:BB:CC:DD:11:22:33:44",
      code: "654321",
    });
    expect(uri).toContain("astranavi://station?");
    expect(uri).toContain("code=654321");

    const qr = encodeQrMatrix(uri);
    expect(qr.size).toBeGreaterThanOrEqual(29);
    expect(qr.modules.length).toBe(qr.size);
    for (const row of qr.modules) expect(row.length).toBe(qr.size);

    const mdnsPacket = encodeMdnsResponse({
      instanceName: "Astra Test Deck",
      hostName: "bridge-pc",
      port: 47821,
      addresses: ["192.168.1.42"],
      fingerprintTail: "11223344",
    });
    expect(mdnsPacket.toString("ascii")).toContain("_astranavi");
    expect(mdnsPacket.toString("ascii")).toContain("bridge-pc");

    // Verify parseMdnsQuery decodes a minimal query frame cleanly
    const qHeader = Buffer.alloc(12);
    qHeader.writeUInt16BE(1, 4); // QDCOUNT = 1
    const qName = Buffer.concat([
      Buffer.from([10]),
      Buffer.from("_astranavi"),
      Buffer.from([4]),
      Buffer.from("_tcp"),
      Buffer.from([5]),
      Buffer.from("local"),
      Buffer.from([0]),
    ]);
    const qMeta = Buffer.from([0x00, 0x0c, 0x00, 0x01]);
    const questions = parseMdnsQuery(Buffer.concat([qHeader, qName, qMeta]));
    expect(questions).toEqual([{ name: "_astranavi._tcp.local", qtype: 12, qclass: 1 }]);
  });

  it("exports, inspects, snapshots, and verifies SHA-256 profile backups cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "astranavi-profile-"));
    try {
      const srcDir = join(root, "src");
      const dstDir = join(root, "dst");
      const archivePath = join(root, "backup.anprof");
      await mkdir(srcDir, { recursive: true });
      await mkdir(dstDir, { recursive: true });

      await writeFile(join(srcDir, "config.json"), '{"brain":"standard"}\n', "utf8");
      await writeFile(join(srcDir, "memory.json"), '{"notes":[]}\n', "utf8");
      await writeFile(join(dstDir, "config.json"), '{"brain":"small"}\n', "utf8");

      const exported = await exportProfileBackup(srcDir, archivePath);
      expect(exported.files.map((f) => f.name)).toEqual(["config.json", "memory.json"]);

      const inspected = await inspectProfileBackup(archivePath);
      expect(inspected.totalBytes).toBe(exported.totalBytes);

      const restored = await importProfileBackup(archivePath, dstDir);
      expect(restored.restoredFiles).toEqual(["config.json", "memory.json"]);
      expect(restored.backupSnapshotDir).not.toBeNull();
      expect(await readFile(join(dstDir, "config.json"), "utf8")).toBe('{"brain":"standard"}\n');
      const snapDir = restored.backupSnapshotDir;
      if (!snapDir) throw new Error("Expected snapshot dir");
      expect(await readFile(join(snapDir, "config.json"), "utf8")).toBe(
        '{"brain":"small"}\n',
      );

      // Corrupt byte in archive must be rejected before modifying destination
      const { gunzipSync, gzipSync } = await import("node:zlib");
      const raw = JSON.parse(gunzipSync(await readFile(archivePath)).toString("utf8")) as {
        magic: string;
        version: number;
        exportedAt: string;
        files: { name: string; sha256: string; bytes: number; dataBase64: string }[];
      };
      if (raw.files[0]) raw.files[0].sha256 = "f".repeat(64);
      const tampered = join(root, "tampered.anprof");
      await writeFile(tampered, gzipSync(Buffer.from(JSON.stringify(raw), "utf8")));
      await expect(importProfileBackup(tampered, dstDir)).rejects.toThrow(/Integrity check failed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("steps down cleanly on 6 GB and 8 GB GPUs to prevent OOM", () => {
    const rec6Gb = recommendHardwareTier({
      gpuName: "RTX 3060 Laptop 6GB",
      totalVramBytes: 6 * GIB,
      freeVramBytes: 5.5 * GIB,
      systemRamBytes: 16 * GIB,
      cpuThreads: 8,
      activeGameOrRender: false,
    });
    expect(rec6Gb.tier).toBe("small");

    const rec8GbGaming = recommendHardwareTier({
      gpuName: "RTX 4060 8GB",
      totalVramBytes: 8 * GIB,
      freeVramBytes: 5.0 * GIB,
      systemRamBytes: 16 * GIB,
      cpuThreads: 12,
      activeGameOrRender: true,
    });
    expect(["small", "standard"]).toContain(rec8GbGaming.tier);
    if (rec8GbGaming.tier === "standard") {
      expect(rec8GbGaming.leanMemory).toBe(true);
    }
  });

  it("maintains Android strings.xml key parity across EN/JA/ZH and hardens Android 15+ lifecycle/NSD", async () => {
    const baseXml = await readFile(join(ROOT, "phone-app/res/values/strings.xml"), "utf8");
    const jaXml = await readFile(join(ROOT, "phone-app/res/values-ja/strings.xml"), "utf8");
    const zhXml = await readFile(join(ROOT, "phone-app/res/values-zh/strings.xml"), "utf8");
    const baseKeys = parseXmlStringKeys(baseXml).sort();
    expect(parseXmlStringKeys(jaXml).sort()).toEqual(baseKeys);
    expect(parseXmlStringKeys(zhXml).sort()).toEqual(baseKeys);

    const pollerJava = await readFile(
      join(ROOT, "phone-app/java/app/astranavi/station/AlertPollerService.java"),
      "utf8",
    );
    expect(pollerJava).toContain("onStopJob");
    expect(pollerJava).toContain("activeConnection");
    expect(pollerJava).toContain("CONNECT_TIMEOUT_MS");

    const mainJava = await readFile(
      join(ROOT, "phone-app/java/app/astranavi/station/MainActivity.java"),
      "utf8",
    );
    expect(mainJava).toContain("WindowInsets");
    expect(mainJava).toContain("NsdManager");
    expect(mainJava).toContain("_astranavi._tcp.");
  });

  it("ships 3 valid Supporter character variants that pack and verify as signed .bundle archives", async () => {
    const work = await mkdtemp(join(tmpdir(), "astranavi-variants-"));
    try {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      for (const id of ["astral-midnight", "solar-dawn", "sakura-nebula"]) {
        const dir = join(ROOT, "assets", "models", "variants", id);
        const manifestJson = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as unknown;
        const parsed = CharacterBundleManifestSchema.parse(manifestJson);
        expect(parsed.id).toBe(id);

        const inspected = await inspectCharacterBundle(dir);
        expect(inspected.ok).toBe(true);

        const bundleOut = join(work, `${id}.bundle`);
        const packed = await packSignedCharacterBundle(dir, bundleOut, { privateKeyPem: privateKey });
        expect(packed.files).toBeGreaterThanOrEqual(8);

        const opened = await openSignedCharacterBundle(bundleOut, {
          trustedPublicKeysPem: [publicKey],
          requireSignature: true,
        });
        expect(opened.verifiedSignature).toBe(true);
        expect(opened.manifest.id).toBe(id);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("includes exact-dimension store capsules and <10 MB trailer in store/assets/", async () => {
    const expectedDims: [string, number, number][] = [
      ["steam-header-capsule.png", 920, 430],
      ["steam-main-capsule.png", 1232, 706],
      ["steam-small-capsule.png", 462, 174],
      ["steam-vertical-capsule.png", 748, 896],
      ["steam-library-hero.png", 1920, 620],
      ["itch-cover.png", 630, 500],
    ];
    for (const [file, width, height] of expectedDims) {
      const buf = await readFile(join(ROOT, "store", "assets", file));
      expect(readPngDimensions(buf)).toEqual({ width, height });
    }

    const trailerInfo = await stat(join(ROOT, "store", "assets", "astra-navi-trailer.mp4"));
    expect(trailerInfo.size).toBeGreaterThan(50_000);
    expect(trailerInfo.size).toBeLessThan(10 * 1024 * 1024);
  });
});
