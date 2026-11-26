import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAiOutputReport,
  buildGithubReportIssueUrl,
  saveAiOutputReport,
} from "../src/core/aiReport.ts";
import { buildLlamaCpp10Args } from "../src/core/models.ts";
import {
  auditWorkshopPackDirectory,
  isSafeDataOnlyFilename,
} from "../src/core/workshopPack.ts";

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

describe("Microsoft Store Policy 11.16: in-app AI output reporting", () => {
  it("builds secret-scrubbed local reports, saves to disk with 0600 mode, and generates safe GitHub issue URLs", async () => {
    const dir = await makeTempDir("astra-airep-");
    const report = buildAiOutputReport({
      category: "harmful-or-unsafe",
      note: "Suggested deleting a system folder with key sk-1234567890abcdefghijklmnop",
      includeExcerpt: true,
      replyExcerpt: "Run with token my-super-secret-token-value and custom-literal-998877 right now.",
      userPromptExcerpt: "Help clean disk",
      appVersion: "1.0.0-rc.1",
      brainLabel: "Standard (Qwen3.5 9B)",
      inferenceScope: "local-gguf",
      extraSecrets: ["custom-literal-998877"],
    });

    expect(report.note).not.toContain("sk-1234567890");
    expect(report.replyExcerpt).not.toContain("my-super-secret-token-value");
    expect(report.replyExcerpt).not.toContain("custom-literal-998877");
    expect(report.replyExcerpt).toContain("[redacted]");

    const savedPath = await saveAiOutputReport(dir, report);
    const onDisk = JSON.parse(await readFile(savedPath, "utf8")) as { category: string };
    expect(onDisk.category).toBe("harmful-or-unsafe");

    const url = buildGithubReportIssueUrl(report);
    expect(url).toContain("https://github.com/bwiemz/astra-navi-desktop/issues/new?");
    expect(url).not.toContain("my-super-secret-token-value");
    expect(url).not.toContain("sk-1234567890");
  });

  it("omits reply and prompt excerpts when includeExcerpt is false", () => {
    const report = buildAiOutputReport({
      category: "inaccurate",
      note: "Got the date wrong.",
      includeExcerpt: false,
      replyExcerpt: "Private reply content",
      userPromptExcerpt: "Private prompt content",
      appVersion: "1.0.0",
      brainLabel: "Standard",
      inferenceScope: "local-gguf",
    });
    expect(report.replyExcerpt).toBeNull();
    expect(report.userPromptExcerpt).toBeNull();
  });
});

describe("Data-only Workshop pack validator (anti-malware gate)", () => {
  it("approves a clean data-only emote/avatar pack", async () => {
    const dir = await makeTempDir("astra-ws-ok-");
    await mkdir(join(dir, "clips"), { recursive: true });
    await writeFile(join(dir, "clips", "wave.vrma"), Buffer.from("glTF-stub"));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "calm-emotes-v1",
        name: "Calm Emotes",
        kind: "emote-pack",
        version: "1.0.0",
        author: "Community",
        license: "CC-BY-4.0",
        dataOnly: true,
        entryFile: "clips/wave.vrma",
      }),
    );

    const res = await auditWorkshopPackDirectory(dir);
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
    expect(res.manifest?.id).toBe("calm-emotes-v1");
  });

  it("blocks executable code files, scripts, HTML/SVG, and symlinks inside Workshop packs", async () => {
    expect(isSafeDataOnlyFilename("clips/wave.vrma").ok).toBe(true);
    expect(isSafeDataOnlyFilename("payload.js").ok).toBe(false);
    expect(isSafeDataOnlyFilename("helper.exe").ok).toBe(false);
    expect(isSafeDataOnlyFilename("run.ps1").ok).toBe(false);
    expect(isSafeDataOnlyFilename("xss.svg").ok).toBe(false);
    expect(isSafeDataOnlyFilename("../escape.png").ok).toBe(false);

    const dir = await makeTempDir("astra-ws-bad-");
    await writeFile(join(dir, "avatar.vrm"), Buffer.from("glTF-stub"));
    await writeFile(join(dir, "stealer.js"), "console.log('pwn');");
    await symlink(join(dir, "avatar.vrm"), join(dir, "link.vrm"));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "evil-pack",
        name: "Evil Pack",
        kind: "avatar",
        version: "1.0.0",
        author: "Attacker",
        license: "MIT",
        dataOnly: true,
        entryFile: "avatar.vrm",
      }),
    );

    const res = await auditWorkshopPackDirectory(dir);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.includes("stealer.js"))).toBe(true);
    expect(res.violations.some((v) => /symlink/i.test(v))).toBe(true);
  });
});

describe("Qwen3.5 MTP flag generation, Windows verify script & UI compliance wiring", () => {
  it("emits upstream llama-server MTP flags cleanly via buildLlamaCpp10Args", () => {
    const args = buildLlamaCpp10Args({
      modelPath: "/models/Qwen3.5-35B-A3B-MTP-Q4_K_M.gguf",
      contextSize: 8192,
      mtpDraftTokens: 3,
      kvCachePrecision: "q8_0",
    });
    expect(args).toContain("--spec-type");
    expect(args).toContain("draft-mtp");
    expect(args).toContain("--spec-draft-n-max");
    expect(args).toContain("3");
    expect(args).toContain("-np");
    expect(args).toContain("1");
  });

  it("wires in-app AI report dialog and hardened Windows verification checks safely", () => {
    const root = join(import.meta.dirname, "..");
    const indexHtml = readFileSync(join(root, "src/renderer/index.html"), "utf8");
    const mainRenderer = readFileSync(join(root, "src/renderer/src/main.ts"), "utf8");
    const desktopIpc = readFileSync(join(root, "src/main/desktopIpc.ts"), "utf8");
    const winVerify = readFileSync(join(root, "scripts/verify-clean-windows.ps1"), "utf8");

    expect(indexHtml).toContain('id="live-report-output"');
    expect(indexHtml).toContain('id="ai-report-dialog"');
    expect(mainRenderer).toContain("wireAiReportDialog");
    expect(desktopIpc).toContain('"ai:report-output"');
    expect(winVerify).toContain("-RequireSigned");
    expect(winVerify).toContain("TimeStamperCertificate");
    expect(winVerify).toContain("volume-get");
    expect(winVerify).toContain("gpu-vram");
  });
});
