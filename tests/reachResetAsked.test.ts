import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/core/config.ts";
import { Reach } from "../src/core/reach.ts";
import type { Sight } from "../src/core/sight.ts";
import type { PairedDevice, StationDeps } from "../src/core/station.ts";

/**
 * A device asking for the sign-in password to be reset: the station tells her reach,
 * and her reach tells whoever shows it to the person at the PC. The station is stood in
 * for (no port is opened); what it does with such a request is tested with the station.
 */

const made = vi.hoisted(() => ({ stations: [] as unknown[] }));

vi.mock("../src/core/station.ts", () => ({
  Station: class {
    deps: unknown;
    running = false;
    constructor(deps: unknown) {
      this.deps = deps;
      made.stations.push(this);
    }
    start(): Promise<void> {
      this.running = true;
      return Promise.resolve();
    }
    stop(): Promise<void> {
      this.running = false;
      return Promise.resolve();
    }
    broadcast(): void {
      // nothing listens here
    }
    addresses(): string[] {
      return [];
    }
    devices(): PairedDevice[] {
      return [];
    }
  },
}));

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aichan-reset-asked-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const TABLET: PairedDevice = {
  id: "d-1",
  name: "Kitchen tablet",
  pairedAt: "2026-11-22T09:00:00.000Z",
  lastSeenAt: null,
};

function reachWith(onResetAsked?: (device: PairedDevice) => void): Reach {
  return new Reach({
    config: new ConfigStore(join(root, "config.json")),
    sight: { readFrontWindow: () => Promise.resolve("") } as unknown as Sight,
    scriptDir: join(root, "scratch"),
    modelsCacheDir: join(root, "models"),
    handsScript: join(root, "hands.py"),
    ownApps: ["ai-chan-desktop"],
    stationDir: join(root, "station"),
    onNotice: () => undefined,
    onAwayMessage: () => true,
    onAwayStop: () => undefined,
    onProblem: () => undefined,
    ...(onResetAsked ? { onResetAsked } : {}),
  });
}

describe("a device asking for the sign-in password to be reset", () => {
  it("reaches whoever tells the person at the PC, with the device that asked", async () => {
    const asked: PairedDevice[] = [];
    const reach = reachWith((device) => asked.push(device));
    await reach.setStation(true);
    const station = made.stations.at(-1) as { deps: StationDeps };
    station.deps.onResetAsked?.(TABLET);
    expect(asked).toEqual([TABLET]);
    await reach.dispose();
  });

  it("is let drop without a fuss when nobody is there to be told", async () => {
    const reach = reachWith();
    await reach.setStation(true);
    const station = made.stations.at(-1) as { deps: StationDeps };
    expect(() => station.deps.onResetAsked?.(TABLET)).not.toThrow();
    await reach.dispose();
  });
});
