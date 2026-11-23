import { describe, expect, it } from "vitest";
import {
  analyzeWebcamPresenceFrame,
  blendAmbientScreenLighting,
  computeMultiMonitorDock,
  computeTimeOfDayLighting,
  PresenceTracker,
  ROOM_SCENE_SPECS,
  sampleAmbientScreenColor,
  snapBoundsToMonitorEdge,
  type DisplayWorkArea,
} from "../src/shared/spatialStage.ts";

describe("Pillar 1: Spatial Stage, Multi-Monitor Docking, Room Scenes, Dynamic Lighting & Webcam Presence", () => {
  const displays: DisplayWorkArea[] = [
    { id: "primary-1080p", x: 0, y: 0, width: 1920, height: 1040, primary: true, scaleFactor: 1 },
    { id: "left-4k", x: -2560, y: 0, width: 2560, height: 1400, primary: false, scaleFactor: 1.5 },
  ];

  it("docks cleanly on any connected display edge and orients character toward screen center", () => {
    const rightDock = computeMultiMonitorDock(displays, "primary-1080p", "bottom-right", {
      width: 280,
      height: 430,
    });
    expect(rightDock).toMatchObject({
      displayId: "primary-1080p",
      edge: "bottom-right",
      facingYawDeg: -14,
      x: 1920 - 280 - 20,
      y: 1040 - 430 - 20,
    });

    const leftSecondary = computeMultiMonitorDock(displays, "left-4k", "left-center", {
      width: 280,
      height: 430,
    });
    expect(leftSecondary.displayId).toBe("left-4k");
    expect(leftSecondary.x).toBe(-2560 + 20);
    expect(leftSecondary.y).toBe(Math.round((1400 - 430) / 2));
    expect(leftSecondary.facingYawDeg).toBe(14);

    // Oversized window clamps inside monitor workArea.
    const clamped = computeMultiMonitorDock(displays, "primary-1080p", "top-left", {
      width: 4000,
      height: 4000,
    });
    expect(clamped.width).toBe(1900);
    expect(clamped.height).toBe(1020);
  });

  it("snaps dragged window bounds near multi-monitor corners", () => {
    const nearLeftTop = snapBoundsToMonitorEdge(
      { x: -2548, y: 12, width: 280, height: 430 },
      displays,
      36,
      16,
    );
    expect(nearLeftTop?.displayId).toBe("left-4k");
    expect(nearLeftTop?.edge).toBe("top-left");

    const centered = snapBoundsToMonitorEdge(
      { x: 700, y: 300, width: 280, height: 430 },
      displays,
      36,
      16,
    );
    expect(centered).toBeNull();
  });

  it("defines room presets and blends circadian time-of-day with sampled ambient screen color", () => {
    expect(Object.keys(ROOM_SCENE_SPECS)).toEqual([
      "none",
      "cozy-desk",
      "command-bridge",
      "minimal-studio",
    ]);
    expect(ROOM_SCENE_SPECS.none.backdropColor[3]).toBe(0);
    expect(ROOM_SCENE_SPECS["cozy-desk"].backdropColor[3]).toBe(1);

    const night = computeTimeOfDayLighting(2);
    const noon = computeTimeOfDayLighting(13);
    const golden = computeTimeOfDayLighting(17.5);
    expect(night.period).toBe("night");
    expect(noon.sunIntensity).toBeGreaterThan(night.sunIntensity);
    expect(golden.sunColor[0]).toBeGreaterThan(golden.sunColor[2]);

    // Pure cyan screen RGBA sample (R=20, G=200, B=255) tints lighting softly without washing out.
    const screenBuf = new Uint8Array([20, 200, 255, 255, 20, 200, 255, 255]);
    const sampled = sampleAmbientScreenColor(screenBuf, 4);
    expect(sampled[2]).toBeCloseTo(1, 2);
    const blended = blendAmbientScreenLighting(night, sampled, 0.5);
    expect(blended.ambientColor[2]).toBeGreaterThan(night.ambientColor[2]);
    expect(blended.ambientColor[0]).toBeGreaterThanOrEqual(0.18);
  });

  it("keeps webcam presence opt-in (default off), detects gaze centroid in memory, and sleeps on absence", () => {
    const w = 16;
    const h = 12;
    const bg = new Uint8Array(w * h).fill(60);
    const movedLeftInCam = new Uint8Array(bg);
    // Motion on left side of camera image (x=2..4) -> mirrored user sits toward camera-left / viewer-right (+x).
    for (let y = 3; y < 8; y += 1) {
      for (let x = 1; x < 4; x += 1) movedLeftInCam[y * w + x] = 220;
    }

    const directSample = analyzeWebcamPresenceFrame(movedLeftInCam, bg, w, h, 0.03);
    expect(directSample.detected).toBe(true);
    expect(directSample.gazeTarget?.x).toBeGreaterThan(0.2);

    const tracker = new PresenceTracker({
      presentConfirmMs: 300,
      awayTimeoutMs: 2_000,
      motionThreshold: 0.03,
    });
    expect(tracker.enabled).toBe(false);
    // Disabled tracker ignores frames completely.
    expect(tracker.processFrame(movedLeftInCam, w, h, 1000).action).toBe("none");

    tracker.setEnabled(true);
    expect(tracker.processFrame(bg, w, h, 1000).action).toBe("none");
    expect(tracker.processFrame(movedLeftInCam, w, h, 1200).action).toBe("none");
    const awake = tracker.processFrame(bg, w, h, 1550);
    expect(awake.present).toBe(true);
    expect(awake.action).toBe("wake");

    // Static idle frames past awayTimeoutMs trigger clean sleep transition.
    const asleep = tracker.processFrame(bg, w, h, 4000);
    expect(asleep.present).toBe(false);
    expect(asleep.action).toBe("sleep");

    tracker.setEnabled(false);
    expect(tracker.enabled).toBe(false);
    expect(tracker.present).toBe(false);
  });
});
