import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelKeyMaterial } from "../src/core/modelKey.ts";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-key-"));
  file = join(dir, "sub", "model.key");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("modelKeyMaterial", () => {
  it("has nothing to offer before a model was ever imported", async () => {
    expect(await modelKeyMaterial(file, false)).toBeNull();
  });

  it("creates a private random secret once and reuses it", async () => {
    const first = await modelKeyMaterial(file, true);
    const second = await modelKeyMaterial(file, false);
    expect(first).not.toBeNull();
    expect(second?.equals(first as Buffer)).toBe(true);
    expect((await readFile(file)).length).toBe(32);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("differs between installs", async () => {
    const one = await modelKeyMaterial(file, true);
    const two = await modelKeyMaterial(join(dir, "other", "model.key"), true);
    expect(one?.equals(two as Buffer)).toBe(false);
  });

  it("refuses a secret file that has been truncated", async () => {
    await modelKeyMaterial(file, true);
    await writeFile(file, "short");
    await expect(modelKeyMaterial(file, false)).rejects.toThrow(/damaged/);
  });
});
