import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapKwinError,
  readClipboard,
  writeClipboard,
  type DesktopRunner,
} from "../src/core/desktop.ts";
import { detectLinuxDesktopEnvironment, isKdeWayland } from "../src/main/kwin.ts";

describe("detectLinuxDesktopEnvironment", () => {
  it("detects KDE Plasma on Wayland with kwin-script overlay mode and no warning notice", () => {
    const info = detectLinuxDesktopEnvironment(
      { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland" },
      () => false,
    );
    expect(info.isKdeWayland).toBe(true);
    expect(info.isFlatpak).toBe(false);
    expect(info.overlayMode).toBe("kwin-script");
    expect(info.notice).toBeNull();
    expect(isKdeWayland({ XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland" })).toBe(true);
  });

  it("degrades cleanly on GNOME Wayland", () => {
    const info = detectLinuxDesktopEnvironment(
      { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland" },
      () => false,
    );
    expect(info.isKdeWayland).toBe(false);
    expect(info.overlayMode).toBe("gtk-layer-fallback");
    expect(info.notice).toContain("Non-KDE Wayland session detected");
    expect(info.notice).toContain("ubuntu:GNOME");
  });

  it("degrades cleanly on Hyprland Wayland", () => {
    const info = detectLinuxDesktopEnvironment(
      { XDG_CURRENT_DESKTOP: "Hyprland", XDG_SESSION_TYPE: "wayland" },
      () => false,
    );
    expect(info.isKdeWayland).toBe(false);
    expect(info.overlayMode).toBe("gtk-layer-fallback");
    expect(info.notice).toContain("Hyprland");
    expect(info.notice).toContain("always-on-top overlay");
  });

  it("degrades cleanly on GNOME / generic X11", () => {
    const info = detectLinuxDesktopEnvironment(
      { XDG_CURRENT_DESKTOP: "GNOME", XDG_SESSION_TYPE: "x11" },
      () => false,
    );
    expect(info.isKdeWayland).toBe(false);
    expect(info.overlayMode).toBe("x11-overlay");
    expect(info.notice).toContain("X11 session detected");
    expect(info.notice).toContain("xclip/xsel");
  });

  it("detects Flatpak sandbox via /.flatpak-info or FLATPAK_ID and surfaces permission guidance", () => {
    const viaFile = detectLinuxDesktopEnvironment(
      { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland" },
      (path) => path === "/.flatpak-info",
    );
    expect(viaFile.isFlatpak).toBe(true);
    expect(viaFile.notice).toContain("Flatpak sandbox");

    const viaEnv = detectLinuxDesktopEnvironment(
      {
        FLATPAK_ID: "app.astranavi.Desktop",
        XDG_CURRENT_DESKTOP: "GNOME",
        XDG_SESSION_TYPE: "wayland",
      },
      () => false,
    );
    expect(viaEnv.isFlatpak).toBe(true);
    expect(viaEnv.isKdeWayland).toBe(false);
    expect(viaEnv.notice).toContain("Flatpak sandbox");
    expect(viaEnv.notice).toContain("Non-KDE Wayland session detected");
  });
});

describe("non-KDE D-Bus / KWin and clipboard fallbacks", () => {
  it("maps missing org.kde.KWin / ServiceUnknown errors into a clear user message", () => {
    const dbusErr = new Error(
      "Error org.freedesktop.DBus.Error.ServiceUnknown: The name org.kde.KWin was not provided by any .service files",
    );
    const mapped = mapKwinError(dbusErr);
    expect(mapped.message).toBe(
      "Window listing and management currently require KDE Plasma (KWin) on Linux; unavailable on this desktop session.",
    );

    const missingDbusSend = new Error('This needs "dbus-send", which is not installed.');
    expect(mapKwinError(missingDbusSend).message).toContain("require KDE Plasma (KWin)");

    const unrelated = new Error("Unexpected JSON parse error");
    expect(mapKwinError(unrelated)).toBe(unrelated);
  });

  it("falls back through Klipper -> wl-paste -> xclip -> xsel when reading clipboard", async () => {
    const calls: string[] = [];
    const wlPasteRunner: DesktopRunner = async (program) => {
      calls.push(program);
      if (program === "wl-paste") return "from wayland";
      throw new Error(`${program} unavailable`);
    };
    await expect(readClipboard(wlPasteRunner)).resolves.toBe("from wayland");
    expect(calls).toEqual(["busctl", "wl-paste"]);

    const xselCalls: string[] = [];
    const xselRunner: DesktopRunner = async (program) => {
      xselCalls.push(program);
      if (program === "xsel") return "from xsel";
      throw new Error(`${program} unavailable`);
    };
    await expect(readClipboard(xselRunner)).resolves.toBe("from xsel");
    expect(xselCalls).toEqual(["busctl", "wl-paste", "xclip", "xsel"]);

    const noneRunner: DesktopRunner = async (program) => {
      throw new Error(`${program} unavailable`);
    };
    await expect(readClipboard(noneRunner)).rejects.toThrow(
      /org\.kde\.klipper, wl-paste, xclip, and xsel/,
    );
  });

  it("falls back through Klipper -> wl-copy -> xclip -> xsel when writing clipboard", async () => {
    const recorded: { program: string; stdinText?: string }[] = [];
    const xclipRunner: DesktopRunner = async (program, _args, _timeout, stdinText) => {
      recorded.push({ program, stdinText });
      if (program === "xclip") return "";
      throw new Error(`${program} unavailable`);
    };
    await writeClipboard("hello astra", xclipRunner);
    expect(recorded).toEqual([
      { program: "busctl", stdinText: undefined },
      { program: "wl-copy", stdinText: "hello astra" },
      { program: "xclip", stdinText: "hello astra" },
    ]);

    const noneRunner: DesktopRunner = async (program) => {
      throw new Error(`${program} unavailable`);
    };
    await expect(writeClipboard("hello", noneRunner)).rejects.toThrow(
      /org\.kde\.klipper, wl-copy, xclip, and xsel/,
    );
  });
});

describe("Flatpak manifest structural check", () => {
  it("validates build/flatpak/app.astranavi.Desktop.yml syntax and sandbox grants", () => {
    const raw = readFileSync(
      resolve(import.meta.dirname, "..", "build", "flatpak", "app.astranavi.Desktop.yml"),
      "utf8",
    );
    const lines = raw.split(/\r?\n/);
    // YAML forbids literal tab indentation.
    expect(lines.some((line) => /^\t+/.test(line))).toBe(false);
    expect(raw).toContain("app-id: app.astranavi.Desktop");
    expect(raw).toContain("runtime: org.freedesktop.Platform");
    expect(raw).toContain("base: org.electronjs.Electron2.BaseApp");
    expect(raw).toContain("command: astra-navi-desktop");
    for (const arg of [
      "--socket=wayland",
      "--socket=fallback-x11",
      "--socket=pulseaudio",
      "--device=dri",
      "--filesystem=xdg-data/astra-navi:create",
      "--filesystem=xdg-data/ai-chan:ro",
    ]) {
      expect(raw).toContain(arg);
    }
    expect(raw).toContain("cp -r out assets hands voice-server browser-bridge package.json");
  });
});
