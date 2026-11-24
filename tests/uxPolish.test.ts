import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationArchive } from "../src/core/archive.ts";
import {
  classifyDroppedPath,
  deriveCalendarNameFromPath,
  formatAttachedPrompt,
} from "../src/core/dropRouter.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { computeDownloadStats, probeDiskSpace } from "../src/core/modelBundle.ts";
import { Recall } from "../src/core/recall.ts";
import { classifyApprovalRisk } from "../src/core/riskRules.ts";
import { StartupGuard } from "../src/core/safeMode.ts";
import { HerStore } from "../src/core/store.ts";
import { SettingsPatchSchema } from "../src/main/settingsSchema.ts";
import { computeStatusPill, mayAnswer } from "../src/renderer/src/conversation.ts";
import { detectActivePosture, POSTURE_PRESETS } from "../src/shared/settings.ts";
import {
  clampModelFraming,
  computeDragPan,
  computeFramedCamera,
  computeWheelZoom,
  DEFAULT_MODEL_FRAMING,
  isBoundsOnAnyDisplay,
} from "../src/shared/spatialStage.ts";

const ROOT = join(import.meta.dirname, "..");
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "astra-ux-polish-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Posture presets and Settings search contracts", () => {
  it("validates every posture preset patch against SettingsPatchSchema", () => {
    expect(POSTURE_PRESETS.map((p) => p.id)).toEqual([
      "companion",
      "desktop-helper",
      "full-ship-ai",
    ]);
    for (const preset of POSTURE_PRESETS) {
      const parsed = SettingsPatchSchema.safeParse(preset.patch);
      expect(parsed.success, `Preset ${preset.id} failed schema validation`).toBe(true);
    }
  });

  it("detects active posture preset or custom accurately", () => {
    expect(
      detectActivePosture({
        handsOff: true,
        watch: false,
        hearPc: false,
        readNotices: false,
        workInPrograms: false,
        station: { on: false },
      }),
    ).toBe("companion");
    expect(
      detectActivePosture({
        handsOff: true,
        watch: false,
        hearPc: false,
        readNotices: false,
        workInPrograms: false,
        station: { on: true },
      }),
    ).toBe("custom");
    expect(
      detectActivePosture({
        handsOff: false,
        watch: true,
        hearPc: true,
        readNotices: false,
        workInPrograms: false,
        station: { on: false },
      }),
    ).toBe("desktop-helper");
    expect(
      detectActivePosture({
        handsOff: false,
        watch: true,
        hearPc: true,
        readNotices: true,
        workInPrograms: true,
        station: { on: true },
      }),
    ).toBe("full-ship-ai");
    expect(
      detectActivePosture({
        handsOff: false,
        watch: false,
        hearPc: false,
        readNotices: false,
        workInPrograms: false,
        station: { on: true },
      }),
    ).toBe("custom");
  });

  it("wires Settings search, presets, single safe-mode banner, and non-blocking download banner in HTML", async () => {
    const html = await readFile(join(ROOT, "src/renderer/settings.html"), "utf8");
    expect(html).toContain('id="settings-search"');
    expect(html).toContain('data-posture="companion"');
    expect(html).toContain('data-posture="desktop-helper"');
    expect(html).toContain('data-posture="full-ship-ai"');
    expect(html).toContain('id="download-banner"');
    expect(html).toContain('id="pair-firewall-help"');
    expect(html.match(/id="safe-mode-banner"/g)).toHaveLength(1);
  });
});

describe("Avatar canvas framing & multi-monitor recovery math", () => {
  it("clamps per-model framing and computes zoom, drag pan, and camera pose", () => {
    expect(clampModelFraming({ scale: 10, offsetX: -5, rimLight: 0, outlineThickness: 9 })).toEqual({
      scale: 2.2,
      offsetX: -0.6,
      offsetY: 0,
      rimLight: 0.4,
      outlineThickness: 2.5,
    });

    const zoomedIn = computeWheelZoom(1, -120);
    const zoomedOut = computeWheelZoom(1, 120);
    expect(zoomedIn).toBeGreaterThan(1);
    expect(zoomedOut).toBeLessThan(1);

    const panned = computeDragPan({ offsetX: 0, offsetY: 0 }, 43, -43, 430, 1);
    expect(panned.offsetX).toBeCloseTo(0.1, 4);
    expect(panned.offsetY).toBeCloseTo(0.1, 4);

    const baseCam = computeFramedCamera(
      { centerX: 0, centerY: 1, height: 1.6 },
      (20 * Math.PI) / 180,
      DEFAULT_MODEL_FRAMING,
    );
    const zoomedCam = computeFramedCamera(
      { centerX: 0, centerY: 1, height: 1.6 },
      (20 * Math.PI) / 180,
      { ...DEFAULT_MODEL_FRAMING, scale: 2 },
    );
    expect(Math.abs(zoomedCam.position[2])).toBeCloseTo(Math.abs(baseCam.position[2]) / 2, 5);
  });

  it("detects when an overlay window is stranded off unplugged monitors", () => {
    const displays = [
      { id: "1", x: 0, y: 0, width: 1920, height: 1080, primary: true },
    ];
    expect(isBoundsOnAnyDisplay({ x: 1600, y: 600, width: 280, height: 430 }, displays)).toBe(true);
    expect(isBoundsOnAnyDisplay({ x: 2500, y: 200, width: 280, height: 430 }, displays)).toBe(false);
    expect(isBoundsOnAnyDisplay({ x: -1900, y: 200, width: 280, height: 430 }, displays)).toBe(false);
  });
});

describe("Status pill, approval risk classification & keyboard guardrails", () => {
  it("prioritizes live runtime states cleanly for the status pill", () => {
    expect(
      computeStatusPill({
        handsOff: true,
        busy: true,
        activityLabel: "Thinking",
        voiceState: "listening",
        activeJobs: 2,
        asleep: true,
        asleepFor: "Elden Ring",
      }),
    ).toEqual({ kind: "hands-off", label: "Hands Off", showStop: true });

    expect(
      computeStatusPill({
        handsOff: false,
        busy: true,
        activityLabel: "Checking files",
        voiceState: "off",
        activeJobs: 0,
        asleep: false,
        asleepFor: null,
      }),
    ).toEqual({ kind: "thinking", label: "Checking files", showStop: true });

    expect(
      computeStatusPill({
        handsOff: false,
        busy: false,
        activityLabel: null,
        voiceState: "off",
        activeJobs: 1,
        asleep: false,
        asleepFor: null,
      }),
    ).toEqual({ kind: "job", label: "Background Job", showStop: false });

    expect(
      computeStatusPill({
        handsOff: false,
        busy: false,
        activityLabel: null,
        voiceState: "off",
        activeJobs: 0,
        asleep: true,
        asleepFor: "Cyberpunk 2077",
      }),
    ).toEqual({
      kind: "vram-yielded",
      label: "VRAM Yielded (Cyberpunk 2077)",
      showStop: false,
    });
  });

  it("classifies approval risk levels and blocks accidental Enter confirmation while typing", () => {
    expect(
      classifyApprovalRisk({
        toolName: "look_at_screen",
        changesSomething: false,
        sensitive: false,
      }),
    ).toBe("read-only");
    expect(
      classifyApprovalRisk({
        toolName: "write_file",
        changesSomething: true,
        sensitive: false,
        detail: "/home/user/notes.md",
      }),
    ).toBe("modify");
    expect(
      classifyApprovalRisk({
        toolName: "run_command",
        changesSomething: true,
        sensitive: false,
        commandRisk: "plain",
        detail: "pkexec pacman -S kdenlive",
      }),
    ).toBe("high-impact");
    expect(
      classifyApprovalRisk({
        toolName: "read_file",
        changesSomething: false,
        sensitive: true,
        detail: "~/.ssh/id_ed25519",
      }),
    ).toBe("high-impact");

    // Enter never confirms a high-impact action; Esc always denies after guardMs
    expect(
      mayAnswer({
        now: 5000,
        shownAt: 1000,
        guardMs: 450,
        by: "key-on-button",
        buttonFocusedAt: 2000,
        pointerDownAt: null,
        risk: "high-impact",
        decision: "allow",
        key: "Enter",
      }),
    ).toBe(false);
    expect(
      mayAnswer({
        now: 2000,
        shownAt: 1000,
        guardMs: 450,
        by: "key-on-button",
        buttonFocusedAt: 1600,
        pointerDownAt: null,
        risk: "high-impact",
        decision: "allow",
        key: " ",
        lastTypedAt: 1900,
        typingGuardMs: 1500,
      }),
    ).toBe(false);
    expect(
      mayAnswer({
        now: 2000,
        shownAt: 1000,
        guardMs: 450,
        by: "escape",
        buttonFocusedAt: null,
        pointerDownAt: null,
        risk: "high-impact",
        lastTypedAt: 1950,
      }),
    ).toBe(true);
  });
});

describe("Drop routing, download telemetry, forget-last-turn, Safe Mode & Tray lifelines", () => {
  it("routes avatar, document, image, and calendar files cleanly", () => {
    expect(classifyDroppedPath("/tmp/model.vrm")).toBe("avatar");
    expect(classifyDroppedPath("C:\\Models\\miku.PMX")).toBe("avatar");
    expect(classifyDroppedPath("/home/u/report.pdf")).toBe("document");
    expect(classifyDroppedPath("/home/u/sheet.xlsx")).toBe("document");
    expect(classifyDroppedPath("/home/u/photo.PNG")).toBe("image");
    expect(classifyDroppedPath("/home/u/work-schedule.ics")).toBe("calendar");
    expect(deriveCalendarNameFromPath("/home/u/team_holidays-2026.ics")).toBe("team holidays 2026");

    const prompt = formatAttachedPrompt("", [
      { kind: "document", path: "/home/u/notes.pdf", name: "notes.pdf" },
    ]);
    expect(prompt).toContain('[Attached document: "/home/u/notes.pdf"]');
    expect(prompt).toContain("Please inspect");
  });

  it("computes download throughput (MB/s), ETA, and free disk space", async () => {
    expect(
      computeDownloadStats({
        received: 2_000_000_000,
        total: 6_000_000_000,
        bytesPerSec: 20_000_000,
      }),
    ).toEqual({ percent: (1 / 3) * 100, mbPerSec: 20, etaSeconds: 200 });

    const dir = await makeTempDir();
    const disk = await probeDiskSpace(dir, 1024);
    expect(disk.availableBytes).toBeGreaterThan(0);
    expect(disk.requiredBytes).toBeGreaterThanOrEqual(1024);
  });

  it("forgets the latest turn from ConversationArchive, MemoryStore, and Recall", async () => {
    const dir = await makeTempDir();
    const db = new HerStore(join(dir, "her.sqlite"));
    const archive = new ConversationArchive(join(dir, "conv.jsonl"), {
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
    }, 100, db);

    await archive.add({ at: "2026-11-23T10:00:00.000Z", said: "first", reply: "one", outside: false });
    await archive.add({ at: "2026-11-23T10:05:00.000Z", said: "second", reply: "two", outside: false });
    expect(archive.count).toBe(2);

    const removed = await archive.removeLast();
    expect(removed?.said).toBe("second");
    expect(archive.count).toBe(1);
    expect(archive.latest(5).map((t) => t.said)).toEqual(["first"]);
    db.close();

    const memory = new MemoryStore(join(dir, "memory.json"));
    const oldTime = new Date("2026-11-23T09:00:00.000Z").toISOString();
    await writeFile(
      join(dir, "memory.json"),
      JSON.stringify({
        version: 1,
        memories: [
          {
            id: "old1",
            kind: "fact",
            text: "Older fact",
            points: [],
            tags: [],
            createdAt: oldTime,
            updatedAt: oldTime,
            hits: 0,
          },
        ],
      }),
      "utf8",
    );
    await memory.load();
    const cut = new Date().toISOString();
    const saved = await memory.save({ kind: "fact", text: "Misheard fact from accidental turn" });
    const recall = new Recall(memory, {
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
    });
    await recall.warm();
    const droppedIds = await memory.forgetCreatedSince(cut);
    expect(droppedIds).toEqual([saved.memory.id]);
    recall.drop(droppedIds);
    expect(memory.all().map((m) => m.id)).toEqual(["old1"]);
  });

  it("supports requesting Safe Mode for the next boot via StartupGuard", async () => {
    const dir = await makeTempDir();
    const guard = new StartupGuard(dir, 2);
    await guard.requestSafeModeNextBoot("Requested via tray menu.");
    const boot = await guard.recordBootStart();
    expect(boot.safeMode).toBe(true);
    expect(boot.reason).toContain("Requested via tray menu.");
  });

  it("contains all multi-monitor tray lifelines and Windows firewall hint", async () => {
    const [traySrc, devicesSrc, indexHtml] = await Promise.all([
      readFile(join(ROOT, "src/main/tray.ts"), "utf8"),
      readFile(join(ROOT, "src/renderer/src/settings/devices.ts"), "utf8"),
      readFile(join(ROOT, "src/renderer/index.html"), "utf8"),
    ]);
    expect(traySrc).toContain("Reset window to primary monitor");
    expect(traySrc).toContain("Click-through lock");
    expect(traySrc).toContain("Force release GPU VRAM");
    expect(traySrc).toContain("Restart in Safe Mode");
    expect(traySrc).toContain("Export Support Bundle");
    expect(devicesSrc).toContain("netsh advfirewall firewall add rule");
    expect(indexHtml).toContain('id="mini-toolbar"');
    expect(indexHtml).toContain('id="status-pill"');
    expect(indexHtml).toContain('id="auto-frame"');
    expect(indexHtml).toContain('id="permission-risk"');
    expect(indexHtml).toContain('id="permission-preview"');
    expect(indexHtml).toContain('id="attachments"');
  });
});
