import { describe, expect, it } from "vitest";
import { parseGdbusIdleMs, parseIdleNumber, unattendedReason } from "../src/core/idleCheck.ts";

describe("parseGdbusIdleMs", () => {
  it("parses uint32/uint64/int32/int64 tuple formats from gdbus output", () => {
    expect(parseGdbusIdleMs("(uint32 125000,)\n")).toBe(125000);
    expect(parseGdbusIdleMs("(uint64 900000)")).toBe(900000);
    expect(parseGdbusIdleMs("( 0 , )")).toBe(0);
    expect(parseGdbusIdleMs("(int32 45000,)")).toBe(45000);
  });

  it("returns null on malformed or negative values", () => {
    expect(parseGdbusIdleMs("")).toBeNull();
    expect(parseGdbusIdleMs("(uint32 -10,)")).toBeNull();
    expect(parseGdbusIdleMs("Error: Service unknown")).toBeNull();
  });
});

describe("parseIdleNumber", () => {
  it("parses trimmed non-negative integer millisecond strings", () => {
    expect(parseIdleNumber("0\n")).toBe(0);
    expect(parseIdleNumber("  600000  ")).toBe(600000);
  });

  it("rejects non-integer, negative, or empty output", () => {
    expect(parseIdleNumber("")).toBeNull();
    expect(parseIdleNumber("-50")).toBeNull();
    expect(parseIdleNumber("12.5")).toBeNull();
    expect(parseIdleNumber("123 ms")).toBeNull();
  });
});

describe("unattendedReason", () => {
  it("returns null when minIdleMinutes <= 0, idleMs is null, or idle threshold is met", () => {
    expect(unattendedReason(1000, 0)).toBeNull();
    expect(unattendedReason(1000, -5)).toBeNull();
    expect(unattendedReason(null, 10)).toBeNull();
    expect(unattendedReason(600_000, 10)).toBeNull();
    expect(unattendedReason(750_000, 10)).toBeNull();
  });

  it("explains recent activity with singular/plural formatting when below threshold", () => {
    expect(unattendedReason(5_000, 10)).toBe(
      "someone was active just now (waiting for 10 idle minutes)",
    );
    expect(unattendedReason(60_000, 10)).toBe(
      "someone was active 1 minute ago (waiting for 10 idle minutes)",
    );
    expect(unattendedReason(300_000, 10)).toBe(
      "someone was active 5 minutes ago (waiting for 10 idle minutes)",
    );
  });
});
