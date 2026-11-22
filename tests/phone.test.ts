import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolHost } from "../src/core/agentTools.ts";
import { TOOLS } from "../src/core/permissions.ts";
import {
  isPhoneId,
  isWebLink,
  listPhones,
  parsePhoneLines,
  pickPhone,
  pingPhone,
  ringPhone,
  sendTextToPhone,
  sendToPhone,
  type Phone,
  type PhoneRunner,
} from "../src/core/phone.ts";
import { createPhoneTools } from "../src/core/phoneTools.ts";

const PIXEL = "a1b2c3d4_e5f6_4789_abcd_ef0123456789";
const TABLET = "0f1e2d3c4b5a6978";

interface Call {
  program: string;
  args: readonly string[];
}

/** A stand-in for KDE Connect: answers the listing calls and records everything asked of it. */
function fakeConnect(setup: {
  paired?: string;
  available?: string;
  battery?: Record<string, { charge?: number; charging?: boolean }>;
  fail?: (call: Call) => Error | null;
}): { run: PhoneRunner; calls: Call[]; sent: () => Call[] } {
  const calls: Call[] = [];
  const run: PhoneRunner = (program, args) => {
    const call = { program, args };
    calls.push(call);
    const failure = setup.fail?.(call);
    if (failure) return Promise.reject(failure);
    if (program === "kdeconnect-cli") {
      if (args.includes("--list-devices")) return Promise.resolve(setup.paired ?? "");
      if (args.includes("--list-available")) return Promise.resolve(setup.available ?? "");
      return Promise.resolve("");
    }
    if (program === "busctl") {
      const path = args[4] ?? "";
      const id = path.split("/")[4] ?? "";
      const known = setup.battery?.[id];
      const property = args[6];
      if (property === "charge" && known?.charge !== undefined) {
        return Promise.resolve(JSON.stringify({ type: "i", data: known.charge }));
      }
      if (property === "isCharging" && known?.charging !== undefined) {
        return Promise.resolve(JSON.stringify({ type: "b", data: known.charging }));
      }
      return Promise.reject(new Error("No such object path"));
    }
    return Promise.reject(new Error(`unexpected program ${program}`));
  };
  const sent = (): Call[] =>
    calls.filter(
      (call) =>
        call.program === "kdeconnect-cli" &&
        !call.args.includes("--list-devices") &&
        !call.args.includes("--list-available"),
    );
  return { run, calls, sent };
}

const phone = (over: Partial<Phone>): Phone => ({
  id: PIXEL,
  name: "Pixel 8",
  reachable: true,
  battery: null,
  charging: null,
  ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reading KDE Connect's list of devices", () => {
  it("reads id and name from each line", () => {
    expect(parsePhoneLines(`${PIXEL} Pixel 8\n${TABLET} Brandon's Tablet\n`)).toEqual([
      { id: PIXEL, name: "Pixel 8" },
      { id: TABLET, name: "Brandon's Tablet" },
    ]);
  });

  it("skips blank lines, the empty-list message, repeats and ids that are not ids", () => {
    const output = [
      "",
      "0 devices found",
      "1 device found",
      `${PIXEL} Pixel 8`,
      `${PIXEL} Pixel 8 again`,
      "../../etc/passwd evil",
      "--ring sneaky",
      `${TABLET}`,
    ].join("\n");
    expect(parsePhoneLines(output)).toEqual([
      { id: PIXEL, name: "Pixel 8" },
      { id: TABLET, name: "unnamed device" },
    ]);
  });

  it("accepts only plain ids", () => {
    expect(isPhoneId(PIXEL)).toBe(true);
    expect(isPhoneId(TABLET)).toBe(true);
    for (const bad of ["", "a/b", "../x", "a b", "a.b", "x".repeat(81), "a\nb", "id;rm"]) {
      expect(isPhoneId(bad), bad).toBe(false);
    }
  });

  it("lists paired devices, the ones in reach first, with their battery", async () => {
    const connect = fakeConnect({
      paired: `${TABLET} Tablet\n${PIXEL} Pixel 8\n`,
      available: `${PIXEL} Pixel 8\n`,
      battery: { [PIXEL]: { charge: 85, charging: true } },
    });
    expect(await listPhones(connect.run)).toEqual([
      { id: PIXEL, name: "Pixel 8", reachable: true, battery: 85, charging: true },
      { id: TABLET, name: "Tablet", reachable: false, battery: null, charging: null },
    ]);
    // The battery is only asked of a phone that can answer.
    const asked = connect.calls.filter((call) => call.program === "busctl");
    expect(asked).toHaveLength(2);
    expect(asked[0]?.args).toEqual([
      "--user",
      "--json=short",
      "get-property",
      "org.kde.kdeconnect",
      `/modules/kdeconnect/devices/${PIXEL}/battery`,
      "org.kde.kdeconnect.device.battery",
      "charge",
    ]);
  });

  it("leaves the battery unknown when the phone does not report one", async () => {
    const none = fakeConnect({ paired: `${PIXEL} Pixel 8`, available: `${PIXEL} Pixel 8` });
    expect((await listPhones(none.run))[0]).toMatchObject({ battery: null, charging: null });
    const unknown = fakeConnect({
      paired: `${PIXEL} Pixel 8`,
      available: `${PIXEL} Pixel 8`,
      battery: { [PIXEL]: { charge: -1, charging: false } },
    });
    expect((await listPhones(unknown.run))[0]).toMatchObject({ battery: null, charging: null });
  });

  it("counts a device that is only in the available list as paired", async () => {
    const connect = fakeConnect({ paired: "", available: `${PIXEL} Pixel 8` });
    expect(await listPhones(connect.run)).toHaveLength(1);
  });

  it("says plainly when KDE Connect is missing", async () => {
    const connect = fakeConnect({
      fail: () => new Error('This needs "kdeconnect-cli", which is not installed.'),
    });
    await expect(listPhones(connect.run)).rejects.toThrow("not installed");
  });
});

describe("working out which phone was meant", () => {
  const pixel = phone({});
  const tablet = phone({ id: TABLET, name: "Galaxy Tab", reachable: true });
  const away = phone({ id: "feedfacefeedface", name: "Old Phone", reachable: false });

  it("takes the one in reach when no name is given", () => {
    expect(pickPhone([pixel, away], undefined)).toEqual({ phone: pixel });
    expect(pickPhone([pixel, away], "  ")).toEqual({ phone: pixel });
  });

  it("explains when nothing is paired, nothing is in reach, or several are", () => {
    const none = pickPhone([], undefined);
    expect("problem" in none && none.problem).toMatch(/^No phone is paired/);
    const unreachable = pickPhone([away], undefined);
    expect("problem" in unreachable && unreachable.problem).toMatch(/^No phone is in reach/);
    const several = pickPhone([pixel, tablet], undefined);
    expect("problem" in several && several.problem).toMatch(/^Nothing was sent/);
    expect("problem" in several && several.problem).toContain("Pixel 8, Galaxy Tab");
  });

  it("finds a phone by words from its name, whatever the case", () => {
    expect(pickPhone([pixel, tablet], "pixel")).toEqual({ phone: pixel });
    expect(pickPhone([pixel, tablet], "GALAXY TAB")).toEqual({ phone: tablet });
    expect(pickPhone([pixel, tablet], "tab galaxy")).toEqual({ phone: tablet });
    expect(pickPhone([pixel, tablet], TABLET)).toEqual({ phone: tablet });
  });

  it("prefers the exact name over one that merely contains the words", () => {
    const plain = phone({ id: "1111aaaa", name: "Pixel" });
    expect(pickPhone([pixel, plain], "pixel")).toEqual({ phone: plain });
  });

  it("does not guess between two that fit equally", () => {
    const second = phone({ id: "2222bbbb", name: "Pixel 9" });
    const picked = pickPhone([pixel, second], "pixel");
    expect("problem" in picked && picked.problem).toMatch(/^Nothing was sent/);
  });

  it("between two with the same name, takes the one in reach", () => {
    const twin = phone({ id: "3333cccc", reachable: false });
    expect(pickPhone([twin, pixel], "pixel 8")).toEqual({ phone: pixel });
  });

  it("explains when the named phone is unknown or out of reach", () => {
    const unknown = pickPhone([pixel], "iphone");
    expect("problem" in unknown && unknown.problem).toMatch(/^No phone is paired under the name/);
    const gone = pickPhone([pixel, away], "old");
    expect("problem" in gone && gone.problem).toMatch(/^No phone is in reach/);
  });
});

describe("what is handed to KDE Connect", () => {
  it("rings, pings, sends text and shares, each as fixed arguments", async () => {
    const connect = fakeConnect({});
    await ringPhone(PIXEL, connect.run);
    await pingPhone(PIXEL, "  Tea is\nready ", connect.run);
    await sendTextToPhone(PIXEL, "line one\nline two", connect.run);
    await sendToPhone(PIXEL, "https://example.org/a?b=1", connect.run);
    await sendToPhone(PIXEL, "/home/someone/Pictures/cat.png", connect.run);
    expect(connect.calls.map((call) => call.args)).toEqual([
      [`--device=${PIXEL}`, "--ring"],
      [`--device=${PIXEL}`, "--ping-msg=Tea is ready"],
      [`--device=${PIXEL}`, "--share-text=line one\nline two"],
      [`--device=${PIXEL}`, "--share=https://example.org/a?b=1"],
      [`--device=${PIXEL}`, "--share=/home/someone/Pictures/cat.png"],
    ]);
    expect(connect.calls.every((call) => call.program === "kdeconnect-cli")).toBe(true);
  });

  it("never lets a value be read as an option", async () => {
    const connect = fakeConnect({});
    await sendTextToPhone(PIXEL, "--unpair", connect.run);
    await pingPhone(PIXEL, "--ring -d other", connect.run);
    for (const call of connect.calls) {
      // Two arguments, each a single "--option=value": the text stays inside its own.
      expect(call.args).toHaveLength(2);
      expect(call.args[0]).toBe(`--device=${PIXEL}`);
    }
    expect(connect.calls[0]?.args[1]).toBe("--share-text=--unpair");
    expect(connect.calls[1]?.args[1]).toBe("--ping-msg=--ring -d other");
    await expect(sendToPhone(PIXEL, "--unpair", connect.run)).rejects.toThrow("full path");
    await expect(sendToPhone(PIXEL, "-d", connect.run)).rejects.toThrow("full path");
    expect(connect.calls).toHaveLength(2);
  });

  it("refuses an id that is not one", async () => {
    const connect = fakeConnect({});
    for (const bad of ["--ring", "a b", "../x", ""]) {
      await expect(ringPhone(bad, connect.run)).rejects.toThrow("not a device");
      await expect(pingPhone(bad, "hi", connect.run)).rejects.toThrow("not a device");
      await expect(sendTextToPhone(bad, "hi", connect.run)).rejects.toThrow("not a device");
      await expect(sendToPhone(bad, "https://example.org", connect.run)).rejects.toThrow(
        "not a device",
      );
    }
    expect(connect.calls).toHaveLength(0);
  });

  it("sends only web addresses and full paths", async () => {
    const connect = fakeConnect({});
    for (const bad of [
      "file:///etc/passwd",
      "relative/file.txt",
      "~/notes.txt",
      "javascript:alert(1)",
      "sms:12345",
      "http://",
      "/tmp/a\u0000b",
    ]) {
      await expect(sendToPhone(PIXEL, bad, connect.run), bad).rejects.toThrow();
    }
    expect(connect.calls).toHaveLength(0);
    expect(isWebLink("https://example.org")).toBe(true);
    expect(isWebLink("HTTP://example.org/x")).toBe(true);
    expect(isWebLink("ftp://example.org")).toBe(false);
    expect(isWebLink("example.org")).toBe(false);
  });

  it("drops what cannot be passed along and bounds the length", async () => {
    const connect = fakeConnect({});
    await sendTextToPhone(PIXEL, `a\u0000b${"x".repeat(5000)}`, connect.run);
    const text = connect.calls[0]?.args[1] ?? "";
    expect(text.startsWith("--share-text=ab")).toBe(true);
    expect(text.length).toBe("--share-text=".length + 4000);
    await pingPhone(PIXEL, "y".repeat(500), connect.run);
    expect((connect.calls[1]?.args[1] ?? "").length).toBe("--ping-msg=".length + 200);
    await expect(sendTextToPhone(PIXEL, "   ", connect.run)).rejects.toThrow("no text");
    await expect(pingPhone(PIXEL, " \n ", connect.run)).rejects.toThrow("no message");
  });

  it("only rehearses when told to: nothing reaches the phone", async () => {
    vi.stubEnv("AI_CHAN_REHEARSE_DESKTOP", "1");
    const connect = fakeConnect({});
    await ringPhone(PIXEL, connect.run);
    await pingPhone(PIXEL, "hello", connect.run);
    await sendTextToPhone(PIXEL, "hello", connect.run);
    await sendToPhone(PIXEL, "https://example.org", connect.run);
    expect(connect.calls).toHaveLength(0);
    // What could never be sent is still refused while rehearsing.
    await expect(ringPhone("not an id", connect.run)).rejects.toThrow();
    await expect(sendToPhone(PIXEL, "relative.txt", connect.run)).rejects.toThrow();
  });
});

describe("her phone tool", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-phone-"));
    await writeFile(join(dir, "notes.txt"), "hello");
    await mkdir(join(dir, "folder"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface PhoneInput {
    action: string;
    phone?: string;
    text?: string;
    link?: string;
    path?: string;
  }

  function makeTool(connect: { run: PhoneRunner }): {
    phoneTool: (input: PhoneInput) => Promise<string>;
    state: { tainted: number; audited: string[]; activity: string[] };
  } {
    const state = { tainted: 0, audited: [] as string[], activity: [] as string[] };
    let steps = 0;
    const host: ToolHost = {
      policy: () => ({ workspace: dir, home: dir }),
      memory: undefined as never,
      learnAddresses: () => undefined,
      noteOutsideText: () => {
        state.tainted += 1;
      },
      noteChange: () => undefined,
      signal: () => undefined,
      activity: (label) => state.activity.push(label),
      ran: () => undefined,
      audit: (entry) => state.audited.push(entry.outcome),
      ask: () => Promise.resolve(true),
      step: () => (steps += 1),
    };
    const tools = createPhoneTools(host, { run: connect.run });
    const phoneTool = tools[TOOLS.phone]?.handler as (input: PhoneInput) => Promise<string>;
    return { phoneTool, state };
  }

  const onePhone = {
    paired: `${PIXEL} Pixel 8\n${TABLET} Galaxy Tab\n`,
    available: `${PIXEL} Pixel 8\n`,
    battery: { [PIXEL]: { charge: 62, charging: false } },
  };

  it("lists the paired phones with reach and battery, without marking the chat as tainted", async () => {
    const connect = fakeConnect(onePhone);
    const { phoneTool, state } = makeTool(connect);
    const listed = await phoneTool({ action: "list" });
    expect(listed).toBe(
      "Paired devices:\n- Pixel 8: in reach, battery 62%\n- Galaxy Tab: paired, not in reach",
    );
    expect(state.tainted).toBe(0);
    expect(connect.sent()).toHaveLength(0);
    expect(state.activity).toEqual(["Checking for your phone"]);
  });

  it("shows when the phone is charging", async () => {
    const connect = fakeConnect({
      ...onePhone,
      battery: { [PIXEL]: { charge: 40, charging: true } },
    });
    const { phoneTool } = makeTool(connect);
    expect(await phoneTool({ action: "list" })).toContain("battery 40% (charging)");
  });

  it("says how to pair one when none is paired", async () => {
    const connect = fakeConnect({});
    const { phoneTool } = makeTool(connect);
    expect(await phoneTool({ action: "list" })).toMatch(/^There is no phone paired/);
    expect(await phoneTool({ action: "ring" })).toMatch(/^No phone is paired/);
    expect(await phoneTool({ action: "send_text", text: "hi" })).toMatch(/^No phone is paired/);
    expect(connect.sent()).toHaveLength(0);
  });

  it("rings the phone", async () => {
    const connect = fakeConnect(onePhone);
    const { phoneTool } = makeTool(connect);
    expect(await phoneTool({ action: "ring" })).toBe("Pixel 8 is ringing now.");
    expect(connect.sent().map((call) => call.args)).toEqual([[`--device=${PIXEL}`, "--ring"]]);
  });

  it("sends text, a link, a note and a file", async () => {
    const connect = fakeConnect(onePhone);
    const { phoneTool } = makeTool(connect);
    expect(await phoneTool({ action: "send_text", text: " milk, eggs " })).toBe(
      "Sent 10 characters to Pixel 8.",
    );
    expect(await phoneTool({ action: "send_link", link: "https://example.org/map" })).toBe(
      "Sent the link to Pixel 8: https://example.org/map",
    );
    expect(await phoneTool({ action: "ping", text: "Dinner is ready" })).toBe(
      'Shown on Pixel 8: "Dinner is ready"',
    );
    // A bare file name is looked for in her own folder, like her other file tools.
    expect(await phoneTool({ action: "send_file", path: "notes.txt" })).toBe(
      "Sent notes.txt to Pixel 8. The phone saves it in its downloads.",
    );
    expect(connect.sent().map((call) => call.args[1])).toEqual([
      "--share-text=milk, eggs",
      "--share=https://example.org/map",
      "--ping-msg=Dinner is ready",
      `--share=${join(dir, "notes.txt")}`,
    ]);
  });

  it("reaches a named phone, and says when that one is out of reach", async () => {
    const connect = fakeConnect({
      ...onePhone,
      available: `${PIXEL} Pixel 8\n${TABLET} Galaxy Tab\n`,
    });
    const { phoneTool } = makeTool(connect);
    expect(await phoneTool({ action: "ring" })).toMatch(/^Nothing was sent: several devices/);
    expect(await phoneTool({ action: "ring", phone: "tab" })).toBe("Galaxy Tab is ringing now.");
    const away = makeTool(fakeConnect(onePhone));
    expect(await away.phoneTool({ action: "ring", phone: "galaxy" })).toMatch(
      /^No phone is in reach/,
    );
    const nobody = makeTool(fakeConnect({ paired: onePhone.paired, available: "" }));
    expect(await nobody.phoneTool({ action: "ping", text: "hi" })).toMatch(/^No phone is in reach/);
  });

  it("sends nothing when what to send is missing or wrong", async () => {
    const connect = fakeConnect(onePhone);
    const { phoneTool } = makeTool(connect);
    const refused = [
      await phoneTool({ action: "send_text" }),
      await phoneTool({ action: "send_text", text: "  " }),
      await phoneTool({ action: "send_text", text: "x".repeat(4001) }),
      await phoneTool({ action: "ping" }),
      await phoneTool({ action: "ping", text: "y".repeat(201) }),
      await phoneTool({ action: "send_link" }),
      await phoneTool({ action: "send_link", link: "example.org" }),
      await phoneTool({ action: "send_link", link: "file:///etc/passwd" }),
      await phoneTool({ action: "send_link", link: "--unpair" }),
      await phoneTool({ action: "send_file" }),
      await phoneTool({ action: "send_file", path: "missing.txt" }),
      await phoneTool({ action: "send_file", path: join(dir, "folder") }),
    ];
    for (const result of refused) expect(result).toMatch(/^Nothing was sent/);
    expect(connect.sent()).toHaveLength(0);
  });

  it("reports a failure of KDE Connect itself as a failure", async () => {
    const connect = fakeConnect({
      ...onePhone,
      fail: (call) => (call.args.includes("--ring") ? new Error("device not reachable") : null),
    });
    const { phoneTool, state } = makeTool(connect);
    expect(await phoneTool({ action: "ring" })).toBe("That failed: device not reachable");
    expect(state.audited).toEqual(["failed"]);
    const missing = makeTool(
      fakeConnect({
        fail: () => new Error('This needs "kdeconnect-cli", which is not installed.'),
      }),
    );
    expect(await missing.phoneTool({ action: "list" })).toContain("not installed");
  });

  it("reports as done while rehearsing, and sends nothing", async () => {
    vi.stubEnv("AI_CHAN_REHEARSE_DESKTOP", "1");
    const connect = fakeConnect(onePhone);
    const { phoneTool } = makeTool(connect);
    expect(await phoneTool({ action: "ring" })).toBe("Pixel 8 is ringing now.");
    expect(await phoneTool({ action: "send_text", text: "hi" })).toBe(
      "Sent 2 characters to Pixel 8.",
    );
    expect(connect.sent()).toHaveLength(0);
  });
});
