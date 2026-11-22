import { describe, expect, it } from "vitest";
import {
  cardHolders,
  gameAmongHolders,
  gameOnCard,
  type Holder,
  type ProcessLook,
} from "../src/core/cardWatch.ts";
import { afterLookingForGame } from "../src/core/engine.ts";

describe("telling a game from the other programs on the graphics card", () => {
  it.each([
    ["S:\\steamapps\\common\\HonkaiImpact3rd\\BH3.exe", "BH3.exe"],
    ["/home/sam/.local/share/Steam/steamapps/common/Hades/Hades.x86_64", "Hades.x86_64"],
    ["Z:\\Games\\Launcher.exe", "Launcher.exe"],
    ["/usr/bin/gamescope-wl", "gamescope-wl"],
    ["/opt/Emberfall/Emberfall-Linux-Shipping", "Emberfall-Linux-Shipping"],
  ])("takes %s for a game", (holder, name) => {
    expect(gameAmongHolders(["/usr/bin/kwin_wayland", holder])).toBe(name);
  });

  it("does not take the desktop, a browser, an editor or her own process for one", () => {
    expect(
      gameAmongHolders([
        "/usr/bin/kwin_wayland",
        "/home/sam/.local/share/Steam/steamrt64/steam",
        "/usr/lib/firefox/firefox",
        "/opt/UnrealEngine/Engine/Binaries/Linux/UnrealEditor",
        "/usr/bin/blender",
        "/usr/lib/electron45/electron",
        "node",
        "",
      ]),
    ).toBeNull();
    expect(gameAmongHolders([])).toBeNull();
  });

  it("answers no game when the card cannot be asked", async () => {
    expect(await cardHolders("/nonexistent/nvidia-smi")).toBeNull();
    expect(await gameOnCard(() => Promise.resolve(null))).toBeNull();
    expect(
      await gameOnCard(() => Promise.resolve([{ pid: null, name: "C:\\Game\\game.exe" }])),
    ).toBe("game.exe");
  });
});

describe("a native game the card names only by how it was started", () => {
  const desk: Holder[] = [
    { pid: 1439, name: "/usr/bin/kwin_wayland" },
    { pid: 23114, name: "/home/sam/.local/share/Steam/steamrt64/steam" },
  ];
  const civ: Holder = { pid: 1579785, name: "./Civ7_linux_Vulkan_FinalRelease" };
  const nothing: ProcessLook = {
    mine: () => Promise.resolve(true),
    exe: () => Promise.resolve(null),
    environment: () => Promise.resolve(null),
  };

  it("is known by where its program file lives", async () => {
    const look: ProcessLook = {
      ...nothing,
      exe: (pid) =>
        Promise.resolve(
          pid === civ.pid
            ? "/mnt/games/SteamLibrary/steamapps/common/Sid Meier's Civilization VII/Base/Binaries/Civ7_linux_Vulkan_FinalRelease"
            : "/usr/bin/something",
        ),
    };
    expect(await gameOnCard(() => Promise.resolve([...desk, civ]), look)).toBe(
      "Sid Meier's Civilization VII",
    );
  });

  it("is known by what its launcher started it with", async () => {
    const look: ProcessLook = {
      ...nothing,
      exe: (pid) => Promise.resolve(pid === civ.pid ? "/opt/games/civ/Civ7_linux" : "/usr/bin/x"),
      environment: (pid) =>
        Promise.resolve(
          pid === civ.pid ? ["HOME=/home/sam", "SteamAppId=1295660"] : ["HOME=/home/sam"],
        ),
    };
    expect(await gameOnCard(() => Promise.resolve([...desk, civ]), look)).toBe("Civ7_linux");
    for (const mark of ["LUTRIS_GAME_UUID=ab-12", "HEROIC_APP_NAME=Emberfall", "SteamGameId=7"]) {
      const other: ProcessLook = { ...look, environment: () => Promise.resolve([mark]) };
      expect(await gameOnCard(() => Promise.resolve([civ]), other), mark).toBe("Civ7_linux");
    }
  });

  it("does not take the launcher itself, or an empty mark, for a game", async () => {
    const look: ProcessLook = {
      ...nothing,
      exe: () => Promise.resolve("/home/sam/.local/share/Steam/steamrt64/steam"),
      environment: () =>
        Promise.resolve(["SteamAppId=", "STEAM_COMPAT_APP_ID=0", "HOME=/home/sam"]),
    };
    expect(await gameOnCard(() => Promise.resolve(desk), look)).toBeNull();
  });

  it("does not take another account's program for a game, whatever it calls itself", async () => {
    const other: Holder = { pid: 4242, name: "/tmp/steamapps/common/Totally A Game/run.exe" };
    const theirs: ProcessLook = { ...nothing, mine: () => Promise.resolve(false) };
    expect(await gameOnCard(() => Promise.resolve([other]), theirs)).toBeNull();
    // The same from a program of this user's is believed.
    expect(await gameOnCard(() => Promise.resolve([other]), nothing)).toBe("Totally A Game");
  });

  it("still knows a launcher of the user's own whose program file cannot be read", async () => {
    // gamescope is started with special rights, so even its owner may not read its file.
    const scope: Holder = { pid: 777, name: "/usr/bin/gamescope-wl" };
    expect(await gameOnCard(() => Promise.resolve([scope]), nothing)).toBe("gamescope-wl");
  });

  it("names a Windows game by its own folder, not by the layer it runs in", async () => {
    const honkai: Holder = {
      pid: 1488725,
      name: "S:\\steamapps\\common\\HonkaiImpact3rd\\BH3.exe",
    };
    const look: ProcessLook = {
      ...nothing,
      exe: () =>
        Promise.resolve(
          "/home/sam/.local/share/Steam/steamapps/common/Proton - Experimental/files/bin/wine64-preloader",
        ),
    };
    expect(await gameOnCard(() => Promise.resolve([honkai]), look)).toBe("HonkaiImpact3rd");
    // With nothing but the layer to go by, the layer is still not the name.
    const bare: Holder = { pid: 9, name: "Z:\\game\\Play.exe" };
    expect(await gameOnCard(() => Promise.resolve([bare]), look)).toBe("Play.exe");
  });

  it("is not found, and nothing breaks, when the program cannot be looked into", async () => {
    expect(await gameOnCard(() => Promise.resolve([...desk, civ]), nothing)).toBeNull();
  });
});

describe("giving the card back while she rests", () => {
  const MINUTE = 60_000;

  it("keeps looking every half minute while no game is running", () => {
    expect(afterLookingForGame(null, 0, MINUTE)).toBe(30_000);
    expect(afterLookingForGame(null, 50 * MINUTE, MINUTE)).toBe(30_000);
  });

  it("waits out her patience after a reply, then gives the memory back", () => {
    expect(afterLookingForGame("BH3.exe", 30_000, MINUTE)).toBe(30_000);
    expect(afterLookingForGame("BH3.exe", 45_000, MINUTE)).toBe(15_000);
    expect(afterLookingForGame("BH3.exe", 59_900, MINUTE)).toBe(1000);
    expect(afterLookingForGame("BH3.exe", MINUTE, MINUTE)).toBe("give back");
  });

  it("gives it back at once when a game starts in the middle of a long rest", () => {
    expect(afterLookingForGame("BH3.exe", 7 * MINUTE, MINUTE)).toBe("give back");
  });
});
