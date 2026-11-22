import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openModelBundle, packModel, readModelInfo } from "../src/core/modelBundle.ts";

/** A minimal PMX header: magic, version, eight global settings, then the four text fields. */
function pmxHeader(
  name: string,
  comment: string,
  encoding: "utf16le" | "utf8" = "utf16le",
): Buffer {
  const text = (value: string): Buffer => {
    const bytes = Buffer.from(value, encoding);
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const version = Buffer.alloc(4);
  version.writeFloatLE(2.0);
  const globals = Buffer.from([8, encoding === "utf16le" ? 0 : 1, 0, 1, 1, 1, 1, 1, 1]);
  return Buffer.concat([
    Buffer.from("PMX "),
    version,
    globals,
    text(name),
    text(""),
    text(comment),
    text(""),
  ]);
}

const KEY = Buffer.alloc(48, 7);
const OTHER_KEY = Buffer.alloc(48, 9);

let dir: string;
let bundle: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-bundle-"));
  bundle = join(dir, "out", "model.aichan");
  await mkdir(join(dir, "model", "Tex"), { recursive: true });
  await writeFile(join(dir, "model", "Chara.pmx"), "PMX-MODEL-BYTES");
  await writeFile(join(dir, "model", "Tex", "Face.PNG"), "FACE-TEXTURE");
  await writeFile(join(dir, "model", "other.pmx"), "A-DIFFERENT-MODEL");
  await writeFile(join(dir, "model", "Readme.txt"), "terms of use");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("model bundle", () => {
  it("round-trips the model and its textures", async () => {
    const packed = await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    expect(packed.files).toBe(2);
    const opened = await openModelBundle(bundle, KEY);
    expect(opened?.entry).toBe("Chara.pmx");
    expect(opened?.get("Chara.pmx")?.toString()).toBe("PMX-MODEL-BYTES");
    expect(opened?.get("Tex/Face.PNG")?.toString()).toBe("FACE-TEXTURE");
  });

  it("finds textures the way Windows-made models name them", async () => {
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    const opened = await openModelBundle(bundle, KEY);
    expect(opened?.get("tex\\face.png")?.toString()).toBe("FACE-TEXTURE");
    expect(opened?.get("./TEX/FACE.png")?.toString()).toBe("FACE-TEXTURE");
  });

  it("leaves out other models and unrelated files in the same folder", async () => {
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    const opened = await openModelBundle(bundle, KEY);
    expect(opened?.get("other.pmx")).toBeUndefined();
    expect(opened?.get("Readme.txt")).toBeUndefined();
  });

  it("does not contain the raw model bytes in readable form", async () => {
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    const raw = await readFile(bundle);
    expect(raw.includes("PMX-MODEL-BYTES")).toBe(false);
    expect(raw.includes("FACE-TEXTURE")).toBe(false);
    expect(raw.includes("Chara.pmx")).toBe(false);
  });

  it("keeps the model's own name and terms so the app can credit them", async () => {
    await writeFile(
      join(dir, "model", "Chara.pmx"),
      pmxHeader("爱衣", "请勿二次配布\r\n模型版权所属miHoYo"),
    );
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    const opened = await openModelBundle(bundle, KEY);
    expect(opened?.info).toEqual({ name: "爱衣", comment: "请勿二次配布\n模型版权所属miHoYo" });
  });

  it("reads UTF-8 headers and shrugs off files it cannot parse", () => {
    expect(readModelInfo(pmxHeader("Ai", "terms", "utf8"))).toEqual({
      name: "Ai",
      comment: "terms",
    });
    expect(readModelInfo(Buffer.from("PMX-MODEL-BYTES"))).toBeNull();
    expect(readModelInfo(Buffer.from("PMX \u0000\u0000\u0000@\u0008\u0000"))).toBeNull();
    expect(readModelInfo(Buffer.alloc(0))).toBeNull();
  });

  it("has no credit to show for a model without a readable header", async () => {
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    expect((await openModelBundle(bundle, KEY))?.info).toBeNull();
  });

  it("cannot be opened with another computer's key", async () => {
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    await expect(openModelBundle(bundle, OTHER_KEY)).rejects.toThrow(
      /different computer or account/,
    );
  });

  it("refuses key material that is too short to be a real secret", async () => {
    await expect(
      packModel(join(dir, "model", "Chara.pmx"), bundle, Buffer.alloc(8)),
    ).rejects.toThrow(/too short/);
  });

  it("does not serve a file whose bytes were altered", async () => {
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    const raw = await readFile(bundle);
    raw[raw.length - 3] = (raw[raw.length - 3] ?? 0) ^ 0xff; // inside the last file's bytes
    await writeFile(bundle, raw);
    const opened = await openModelBundle(bundle, KEY);
    const served = [opened?.get("Chara.pmx"), opened?.get("Tex/Face.PNG")];
    expect(served.filter((file) => file === undefined)).toHaveLength(1);
  });

  it("reports no model when nothing has been imported", async () => {
    expect(await openModelBundle(join(dir, "missing.aichan"), KEY)).toBeNull();
  });

  it("rejects a bundle whose file list was altered, and a file that is not a bundle", async () => {
    await packModel(join(dir, "model", "Chara.pmx"), bundle, KEY);
    const raw = await readFile(bundle);
    raw[80] = (raw[80] ?? 0) ^ 0xff; // inside the encrypted file list
    await writeFile(bundle, raw);
    await expect(openModelBundle(bundle, KEY)).rejects.toThrow(/cannot be opened/);

    await writeFile(
      bundle,
      "just some text that is long enough to pass the length check, definitely so",
    );
    await expect(openModelBundle(bundle, KEY)).rejects.toThrow(/older version|not a model bundle/);
  });

  it("refuses to pack something that is not a model file", async () => {
    await expect(packModel(join(dir, "model", "Readme.txt"), bundle, KEY)).rejects.toThrow(
      /not a \.pmx/,
    );
    await expect(packModel(join(dir, "model", "missing.pmx"), bundle, KEY)).rejects.toThrow();
  });
});
