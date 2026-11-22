import { describe, expect, it } from "vitest";
import { rankApps, type DesktopApp } from "../src/core/apps.ts";

const apps: DesktopApp[] = [
  { id: "firefox", name: "Firefox", description: "Web Browser", keywords: ["internet", "www"] },
  {
    id: "org.kde.kate",
    name: "Kate",
    description: "Advanced Text Editor",
    keywords: ["text", "editor"],
  },
  { id: "org.kde.kwrite", name: "KWrite", description: "Text Editor", keywords: ["text"] },
  { id: "org.kde.dolphin", name: "Dolphin", description: "File Manager", keywords: ["files"] },
];

describe("rankApps", () => {
  it("puts an exact name match first", () => {
    expect(rankApps(apps, "firefox")[0]?.id).toBe("firefox");
  });

  it("finds apps by what they are for", () => {
    expect(rankApps(apps, "text editor").map((app) => app.id)).toEqual([
      "org.kde.kate",
      "org.kde.kwrite",
    ]);
    expect(rankApps(apps, "browser")[0]?.id).toBe("firefox");
  });

  it("returns nothing for no match or an empty query", () => {
    expect(rankApps(apps, "photoshop")).toEqual([]);
    expect(rankApps(apps, "   ")).toEqual([]);
  });
});
