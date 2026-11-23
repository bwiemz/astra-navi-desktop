import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkBootstrapStatus,
  launcherTargetPath,
  runBootstrapTask,
} from "../src/core/bootstrap.ts";

describe("cross-platform zero-terminal bootstrapper", () => {
  it("reports missing state then installs OCR, launcher, and browser-bridge manifests on Linux", async () => {
    const root = await mkdtemp(join(tmpdir(), "astranavi-boot-"));
    try {
      const home = join(root, "home");
      const appRoot = join(root, "app");
      const dataRoot = join(root, "data");
      const modelsRoot = join(root, "models");
      const xdgDataHome = join(home, ".local", "share");
      const xdgConfigHome = join(home, ".config");

      const opts = {
        platform: "linux" as const,
        home,
        xdgDataHome,
        xdgConfigHome,
        dataRoot,
        modelsRoot,
        appRoot,
        fetchBytes: vi.fn(async (url: string) => Buffer.from(`bytes:${url}`)),
        runCommand: vi.fn(async () => ({ stdout: "uv 0.6.0", stderr: "" })),
      };

      const before = await checkBootstrapStatus(opts);
      expect(before.ocr.ready).toBe(false);
      expect(before.launcher.ready).toBe(false);
      expect(before.browserBridge.ready).toBe(false);

      await runBootstrapTask("ocr", opts);
      await runBootstrapTask("launcher", opts);
      await runBootstrapTask("browser-bridge", opts);

      const after = await checkBootstrapStatus(opts);
      expect(after.ocr.ready).toBe(true);
      expect(after.launcher.ready).toBe(true);
      expect(after.browserBridge.ready).toBe(true);

      const desktopText = await readFile(launcherTargetPath(opts), "utf8");
      expect(desktopText).toContain("Name=Astra Navi Desktop");
      expect(desktopText).toContain("Icon=astra-navi-desktop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports dry-run voice setup via python3 fallback when uv is absent and computes Windows launcher paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "astranavi-boot-win-"));
    try {
      const calls: string[] = [];
      const res = await runBootstrapTask("voice", {
        platform: "win32",
        home: root,
        dataRoot: join(root, "data"),
        dryRun: true,
        runCommand: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          if (cmd === "uv") throw new Error("not found");
          return { stdout: "Python 3.12.2", stderr: "" };
        }),
      });
      expect(res.ok).toBe(true);
      expect(calls).toContain("py");

      const winTarget = launcherTargetPath({
        platform: "win32",
        appData: "C:\\Users\\Test\\AppData\\Roaming",
      });
      expect(winTarget).toContain("Start Menu");
      expect(winTarget).toContain("Astra Navi Desktop.lnk");

      const fakePy = join(root, "py.exe");
      await writeFile(fakePy, "py");
      expect(existsSync(fakePy)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
