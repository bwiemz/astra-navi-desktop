import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, type Config } from "../src/core/config.ts";
import { auditPolicyConfiguration } from "../src/core/permissions.ts";
import { auditSecurityRules } from "../src/core/ruleAudit.ts";
import type { CompiledSkill } from "../src/core/skillCompiler.ts";
import type { StandingOrder } from "../src/core/standingOrders.ts";

function defaultConfig(): Config {
  return new ConfigStore(join(tmpdir(), "ai-chan-nonexistent-config.json")).value;
}

function baseOrder(overrides: Partial<StandingOrder> = {}): StandingOrder {
  return {
    id: "w-111111",
    title: "Check disk space",
    check: {
      kind: "command",
      where: "here",
      whereName: "this PC",
      target: "",
      command: "df -h /",
    },
    tellWhen: "contains",
    value: "95%",
    everyMinutes: 15,
    repeat: false,
    createdAt: "2026-11-22T10:00:00.000Z",
    expiresAt: "2026-11-29T10:00:00.000Z",
    baseline: null,
    held: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

function baseSkill(overrides: Partial<CompiledSkill> = {}): CompiledSkill {
  return {
    id: "sk-clean-1234",
    name: "Clean check",
    slug: "clean-check",
    description: "Clean read-only check",
    params: [],
    steps: [
      {
        tool: "read_file",
        argsTemplate: { path: "notes.txt" },
        capability: "fs.read.workspace",
      },
    ],
    requiredCapabilities: ["fs.read.workspace"],
    status: "active",
    verifiedRuns: 3,
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:00.000Z",
    ratifiedAt: "2026-11-22T10:05:00.000Z",
    driftReason: null,
    sayings: ["run clean check"],
    ...overrides,
  };
}

describe("Static Rule-Conflict Auditor (ruleAudit.ts)", () => {
  it("keeps new Tier 10 Pillar III flags default-off and passes clean default config with 0 criticals", () => {
    const cfg = defaultConfig();
    expect(cfg.tier10.causalDryRun).toBe(false);
    expect(cfg.tier10.skillCompiler).toBe(false);
    expect(cfg.tier10.microSandbox).toBe(false);

    const report = auditSecurityRules({ config: cfg });
    expect(report.ok).toBe(true);
    expect(report.counts.critical).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it("detects and reports every configured policy conflict and privilege chain rule", () => {
    const base = defaultConfig();
    const cfg: Config = {
      ...base,
      fleet: {
        machines: [
          {
            id: "m-public",
            name: "cloudbox",
            host: "198.51.100.10",
            port: 22,
            user: "root",
            lookWithoutAsking: true,
            fullMirrorTrusted: true,
          },
          {
            id: "m-lan",
            name: "nas",
            host: "192.168.50.10",
            port: 2222,
            user: "admin",
            lookWithoutAsking: false,
          },
        ],
      },
      notices: { read: true, skip: ["*", "KeePassXC"] },
      devices: { ...base.devices, station: true },
      tier10: { ...base.tier10, pushEvents: true, semanticBridges: true },
    };

    const orders: StandingOrder[] = [
      // Target drift (host changed from 192.168.50.1 to 192.168.50.10)
      baseOrder({
        id: "w-drift",
        title: "Remote check",
        check: {
          kind: "command",
          where: "m-lan",
          whereName: "nas",
          target: "admin@192.168.50.1:2222",
          command: "uptime",
        },
      }),
      // Privilege violation (non-read-only + shell expansion) + sensitive path + watch privilege chain
      baseOrder({
        id: "w-bad",
        title: "Bad order",
        check: {
          kind: "command",
          where: "here",
          whereName: "this PC",
          target: "",
          command: "bash -c 'cat ~/.ssh/id_ed25519' && cat ~/.config/autostart/run.sh",
        },
      }),
    ];

    const badSkills: CompiledSkill[] = [
      baseSkill({
        id: "sk-bad-1",
        slug: "unverified-active",
        status: "active",
        ratifiedAt: null,
        verifiedRuns: 0,
        steps: [
          {
            tool: "read_file",
            argsTemplate: { path: "~/.ssh/id_ed25519" },
            capability: "fs.read.workspace",
          },
          {
            tool: "write_file",
            argsTemplate: { path: "/tmp/watched/hook.sh", content: "echo hi" },
            capability: "fs.write.workspace",
          },
        ],
        requiredCapabilities: ["fs.read.workspace", "fs.write.workspace"],
      }),
    ];

    const report = auditSecurityRules({
      config: cfg,
      standingOrders: orders,
      compiledSkills: badSkills,
      watchedScripts: [{ path: "/tmp/watched/hook.sh", triggersOnWrite: true }],
      watchSkip: ["a"],
      operateTargets: [
        { app: "keepassxc", action: "press" },
        { app: "powershell.exe", action: "type" },
        { app: "wt.exe", action: "key" },
      ],
      fleetPolicies: [
        { machine: "nas", command: "systemctl restart nginx", autoApprove: true },
        { machine: "nas", command: "cat ~/.ssh/id_ed25519 > /tmp/watched/hook.sh", autoApprove: false },
      ],
    });

    expect(report.ok).toBe(false);
    const codes = new Set(report.findings.map((f) => f.code));
    expect(codes.has("FULL_MIRROR_NON_LAN")).toBe(true);
    expect(codes.has("FULL_MIRROR_WITH_LOOK_UNASKED")).toBe(true);
    expect(codes.has("REMOTE_ROOT_LOOK_UNASKED")).toBe(true);
    expect(codes.has("STANDING_ORDER_TARGET_DRIFT")).toBe(true);
    expect(codes.has("STANDING_ORDER_PRIVILEGE_VIOLATION")).toBe(true);
    expect(codes.has("STANDING_ORDER_SENSITIVE_PATH")).toBe(true);
    expect(codes.has("WATCH_PRIVILEGE_CHAIN")).toBe(true);
    expect(codes.has("SKIP_LIST_OVERBROAD")).toBe(true);
    expect(codes.has("COMPILED_SKILL_UNVERIFIED_ACTIVE")).toBe(true);
    expect(codes.has("STATION_EXPOSED_BRIDGES")).toBe(true);
    expect(codes.has("OPERATE_FORBIDDEN_BYPASS")).toBe(true);
    expect(codes.has("FLEET_REMOTE_WRITE_CHAIN")).toBe(true);

    // permissions.ts re-export wrapper check
    const cleanAudit = auditPolicyConfiguration({ config: base });
    expect(cleanAudit.ok).toBe(true);
  });
});
