import { normalize } from "node:path";
import type { Config } from "./config.ts";
import type { Machine } from "./fleet.ts";
import { isRemoteSecret, isStatusCommand } from "./fleetRules.ts";
import { forbidden, type OperateAction } from "./operateRules.ts";
import { hasShellExpansion, isSensitivePath } from "./riskRules.ts";
import { isReadOnlyCommand } from "./shell.ts";
import type { CompiledSkill } from "./skillCompiler.ts";
import { machineTarget, type StandingOrder } from "./standingOrders.ts";
import { hasUnseen } from "./unseen.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Static Rule-Conflict & Security Policy Auditor (ai_chan_plan.pdf p. 17).
 *
 * Cross-checks Fleet settings, Standing Orders, Compiled Skills, watch skip lists,
 * and Tier 10 bridge flags for unintended privilege chains, target drift, and
 * unsafe configurations without executing anything.
 */

export type RuleAuditSeverity = "critical" | "warning" | "info";

export type RuleAuditCode =
  | "FULL_MIRROR_NON_LAN"
  | "FULL_MIRROR_WITH_LOOK_UNASKED"
  | "REMOTE_ROOT_LOOK_UNASKED"
  | "STANDING_ORDER_TARGET_DRIFT"
  | "STANDING_ORDER_PRIVILEGE_VIOLATION"
  | "STANDING_ORDER_SENSITIVE_PATH"
  | "WATCH_PRIVILEGE_CHAIN"
  | "SKIP_LIST_OVERBROAD"
  | "COMPILED_SKILL_UNVERIFIED_ACTIVE"
  | "STATION_EXPOSED_BRIDGES"
  | "OPERATE_FORBIDDEN_BYPASS"
  | "FLEET_REMOTE_WRITE_CHAIN";

export interface RuleAuditFinding {
  code: RuleAuditCode;
  severity: RuleAuditSeverity;
  subject: string;
  message: string;
  remediation: string;
}

export interface WatchedScriptRule {
  path: string;
  triggersOnWrite: boolean;
  description?: string;
}

export interface OperatePolicyTarget {
  app: string;
  title?: string;
  action?: OperateAction;
}

export interface FleetPolicyRule {
  machine: string;
  command: string;
  autoApprove?: boolean;
}

export interface RuleAuditInput {
  config: Config;
  standingOrders?: readonly StandingOrder[];
  compiledSkills?: readonly CompiledSkill[];
  watchedScripts?: readonly WatchedScriptRule[];
  watchSkip?: readonly string[];
  operateTargets?: readonly OperatePolicyTarget[];
  fleetPolicies?: readonly FleetPolicyRule[];
}

export interface RuleAuditReport {
  ok: boolean;
  findings: RuleAuditFinding[];
  counts: Record<RuleAuditSeverity, number>;
}

const AUTOSTART_OR_SYSTEMD =
  /(^|\/)\.(?:config\/(?:autostart|systemd))(\/|$)|^\/etc\/systemd\/system(\/|$)|(^|\/)\.local\/share\/applications(\/|$)/i;
const CRITICAL_APP_SKIP = /(keepass|1password|bitwarden|kwallet|polkit|pinentry|keyring)/i;
const WINDOWS_TERMINALS =
  /(?:^|[\\/._-])(wt|windowsterminal|cmd|powershell|pwsh|conhost)(?:\.exe)?$/i;

function extractTokens(command: string): string[] {
  return command
    .replace(/["'\\]/g, "")
    .split(/[\s;|&<>()=,]+/)
    .map((tok) => tok.trim())
    .filter(Boolean);
}

function normalizeToken(token: string): string {
  if (token.startsWith("~/")) return `/home/user/${token.slice(2)}`;
  return normalize(token);
}

function findSensitiveToken(text: string): string | null {
  for (const raw of extractTokens(text)) {
    const candidate = normalizeToken(raw);
    if (isSensitivePath(candidate) || isRemoteSecret(candidate) || isSensitivePath(raw)) {
      return raw;
    }
  }
  return null;
}

function matchesWatchedScript(
  candidateText: string,
  watched: readonly WatchedScriptRule[],
): WatchedScriptRule | null {
  const tokens = extractTokens(candidateText).map(normalizeToken);
  for (const rule of watched) {
    if (!rule.triggersOnWrite) continue;
    const ruleNorm = normalizeToken(rule.path);
    if (
      tokens.some((tok) => tok === ruleNorm || tok.startsWith(`${ruleNorm}/`)) ||
      candidateText.includes(rule.path)
    ) {
      return rule;
    }
  }
  return null;
}

function auditMachines(machines: readonly Machine[], findings: RuleAuditFinding[]): void {
  for (const machine of machines) {
    if (machine.fullMirrorTrusted && !isPrivateLanHost(machine.host)) {
      findings.push({
        code: "FULL_MIRROR_NON_LAN",
        severity: "critical",
        subject: `fleet:${machine.name}`,
        message: `Machine "${machine.name}" (${machine.host}) has fullMirrorTrusted=true but is not a private LAN/VPN host.`,
        remediation:
          "Set fullMirrorTrusted to false or restrict host to a verified RFC1918/LAN address.",
      });
    }
    if (machine.fullMirrorTrusted && machine.lookWithoutAsking) {
      findings.push({
        code: "FULL_MIRROR_WITH_LOOK_UNASKED",
        severity: "warning",
        subject: `fleet:${machine.name}`,
        message: `Machine "${machine.name}" combines fullMirrorTrusted=true with lookWithoutAsking=true, widening unprompted remote exposure.`,
        remediation:
          "Disable lookWithoutAsking on fullMirrorTrusted offload nodes unless strictly required.",
      });
    }
    if (machine.user.trim() === "root" && machine.lookWithoutAsking) {
      findings.push({
        code: "REMOTE_ROOT_LOOK_UNASKED",
        severity: "warning",
        subject: `fleet:${machine.name}`,
        message: `Machine "${machine.name}" authenticates as root with lookWithoutAsking=true.`,
        remediation:
          "Use an unprivileged monitoring account or require confirmation before remote lookups.",
      });
    }
  }
}

function auditStandingOrders(
  orders: readonly StandingOrder[],
  machines: readonly Machine[],
  watchedScripts: readonly WatchedScriptRule[],
  findings: RuleAuditFinding[],
): void {
  for (const order of orders) {
    if (order.check.kind !== "command") continue;
    const check = order.check;
    const cmd = check.command;

    if (check.where !== "here") {
      const targetMachine = machines.find((m) => m.id === check.where);
      if (!targetMachine) {
        findings.push({
          code: "STANDING_ORDER_TARGET_DRIFT",
          severity: "warning",
          subject: `order:${order.id}`,
          message: `Remote standing order "${order.title}" references unknown machine id "${check.where}".`,
          remediation: "Cancel or recreate the standing order after confirming the target host.",
        });
      } else if (machineTarget(targetMachine) !== check.target) {
        findings.push({
          code: "STANDING_ORDER_TARGET_DRIFT",
          severity: "warning",
          subject: `order:${order.id}`,
          message: `Standing order "${order.title}" points to "${check.target}", which differs from current machine config "${machineTarget(targetMachine)}".`,
          remediation:
            "Re-approve the standing order so it cannot silently shift to a modified endpoint.",
        });
      }
    }

    const privilegeBad =
      hasUnseen(cmd) ||
      (check.where === "here"
        ? hasShellExpansion(cmd) || !isReadOnlyCommand(cmd)
        : !isStatusCommand(cmd));
    if (privilegeBad) {
      findings.push({
        code: "STANDING_ORDER_PRIVILEGE_VIOLATION",
        severity: "critical",
        subject: `order:${order.id}`,
        message: `Standing order "${order.title}" violates read-only / safe-syntax invariants: "${cmd}".`,
        remediation:
          "Remove this standing order immediately; orders must never mutate state or use shell expansions.",
      });
    }

    const sensitive = findSensitiveToken(cmd);
    if (sensitive) {
      findings.push({
        code: "STANDING_ORDER_SENSITIVE_PATH",
        severity: "critical",
        subject: `order:${order.id}`,
        message: `Standing order "${order.title}" references sensitive path "${sensitive}".`,
        remediation: "Delete the standing order so unattended checks cannot inspect secret locations.",
      });
    }

    const watched = matchesWatchedScript(cmd, watchedScripts);
    if (watched || AUTOSTART_OR_SYSTEMD.test(cmd)) {
      findings.push({
        code: "WATCH_PRIVILEGE_CHAIN",
        severity: "critical",
        subject: `order:${order.id}`,
        message: `Standing order "${order.title}" references watched or autostart target "${watched?.path ?? cmd}".`,
        remediation:
          "Break the watcher-to-autostart reference chain so background checks cannot influence execution triggers.",
      });
    }
  }
}

function auditCompiledSkills(
  skills: readonly CompiledSkill[],
  watchedScripts: readonly WatchedScriptRule[],
  findings: RuleAuditFinding[],
): void {
  for (const skill of skills) {
    const sensitiveArg = skill.steps
      .flatMap((step) => Object.values(step.argsTemplate))
      .filter((v): v is string => typeof v === "string")
      .map((v) => findSensitiveToken(v))
      .find((hit) => hit !== null);

    if (
      skill.status === "active" &&
      (skill.ratifiedAt === null || skill.verifiedRuns < 1 || sensitiveArg !== undefined)
    ) {
      findings.push({
        code: "COMPILED_SKILL_UNVERIFIED_ACTIVE",
        severity: "critical",
        subject: `skill:${skill.slug}`,
        message: `Active compiled skill "${skill.slug}" lacks ratification/verified runs or references sensitive path${sensitiveArg ? ` ("${sensitiveArg}")` : ""}.`,
        remediation: "Demote the skill to 'needs_recalibration' and require fresh ratification.",
      });
    }

    for (const step of skill.steps) {
      for (const value of Object.values(step.argsTemplate)) {
        if (typeof value !== "string") continue;
        const normalized = normalizeToken(value);
        const watched = matchesWatchedScript(value, watchedScripts);
        if (AUTOSTART_OR_SYSTEMD.test(normalized) || watched) {
          findings.push({
            code: "WATCH_PRIVILEGE_CHAIN",
            severity: "critical",
            subject: `skill:${skill.slug}`,
            message: `Compiled skill "${skill.slug}" targets autostart or trigger-watched path "${watched?.path ?? value}".`,
            remediation:
              "Remove autostart/watched-script writes from compiled skill definitions.",
          });
        }
      }
    }
  }
}

function auditSkipLists(
  noticeSkip: readonly string[],
  watchSkip: readonly string[],
  findings: RuleAuditFinding[],
): void {
  const combined: { list: string; entry: string }[] = [
    ...noticeSkip.map((entry) => ({ list: "notices.skip", entry })),
    ...watchSkip.map((entry) => ({ list: "watch.skip", entry })),
  ];
  for (const { list, entry } of combined) {
    const trimmed = entry.trim();
    if (
      trimmed.length <= 1 ||
      trimmed.includes("*") ||
      trimmed === ".*" ||
      CRITICAL_APP_SKIP.test(trimmed)
    ) {
      findings.push({
        code: "SKIP_LIST_OVERBROAD",
        severity: "warning",
        subject: `${list}:${trimmed || "<empty>"}`,
        message: `Skip list ${list} contains overly broad or redundant critical pattern "${entry}".`,
        remediation:
          "Use exact program names >= 2 characters without wildcards; secret apps are protected unconditionally.",
      });
    }
  }
}

function auditOperateTargets(
  targets: readonly OperatePolicyTarget[],
  findings: RuleAuditFinding[],
): void {
  for (const target of targets) {
    const action: OperateAction = target.action ?? "type";
    const blocked = forbidden({ app: target.app, title: target.title ?? "" }, action, []);
    const winTermBlocked =
      WINDOWS_TERMINALS.test(target.app.trim()) &&
      (action === "type" || action === "key" || action === "fill");
    if (blocked || winTermBlocked) {
      findings.push({
        code: "OPERATE_FORBIDDEN_BYPASS",
        severity: "critical",
        subject: `operate:${target.app}`,
        message: `Operate policy target "${target.app}" (${action}) violates protected-app or terminal isolation: ${blocked ?? "Windows terminal input is forbidden."}`,
        remediation:
          "Remove forbidden password/authority apps and terminal input actions from automation allowlists.",
      });
    }
  }
}

function auditFleetPolicies(
  policies: readonly FleetPolicyRule[],
  watchedScripts: readonly WatchedScriptRule[],
  findings: RuleAuditFinding[],
): void {
  for (const rule of policies) {
    const sensitive = findSensitiveToken(rule.command);
    const watched = matchesWatchedScript(rule.command, watchedScripts);
    const mutatesOrUnsafe =
      hasUnseen(rule.command) ||
      hasShellExpansion(rule.command) ||
      sensitive !== null ||
      (rule.autoApprove === true && !isStatusCommand(rule.command));

    if (mutatesOrUnsafe) {
      findings.push({
        code: "FLEET_REMOTE_WRITE_CHAIN",
        severity: "critical",
        subject: `fleet-policy:${rule.machine}`,
        message: `Fleet rule on "${rule.machine}" introduces an unsafe or unapproved remote write/secret chain: "${rule.command}".`,
        remediation:
          "Restrict auto-approved remote rules to exact status commands without shell expansions or secret paths.",
      });
    }
    if (watched || AUTOSTART_OR_SYSTEMD.test(rule.command)) {
      findings.push({
        code: "WATCH_PRIVILEGE_CHAIN",
        severity: "critical",
        subject: `fleet-policy:${rule.machine}`,
        message: `Fleet rule on "${rule.machine}" touches watched or autostart target "${watched?.path ?? rule.command}".`,
        remediation:
          "Prevent remote automation rules from modifying auto-executing scripts or systemd/autostart units.",
      });
    }
  }
}

/**
 * Audits security configuration, standing orders, compiled skills, operate rules, fleet policies,
 * and skip lists for policy conflicts or privilege escalation chains.
 */
export function auditSecurityRules(input: RuleAuditInput): RuleAuditReport {
  const findings: RuleAuditFinding[] = [];
  const machines = input.config.fleet.machines;
  const watchedScripts = input.watchedScripts ?? [];

  auditMachines(machines, findings);
  auditStandingOrders(input.standingOrders ?? [], machines, watchedScripts, findings);
  auditCompiledSkills(input.compiledSkills ?? [], watchedScripts, findings);
  auditSkipLists(input.config.notices.skip, input.watchSkip ?? [], findings);
  auditOperateTargets(input.operateTargets ?? [], findings);
  auditFleetPolicies(input.fleetPolicies ?? [], watchedScripts, findings);

  if (
    input.config.devices.station &&
    input.config.tier10.pushEvents &&
    input.config.tier10.semanticBridges
  ) {
    findings.push({
      code: "STATION_EXPOSED_BRIDGES",
      severity: "info",
      subject: "tier10:bridges",
      message:
        "Station remote access, push events, and semantic bridges are simultaneously enabled; review paired devices and allowed webhook origins regularly.",
      remediation:
        "Verify paired client certificates and keep semantic bridge allowlists restricted to trusted local apps.",
    });
  }

  const counts: Record<RuleAuditSeverity, number> = {
    critical: findings.filter((f) => f.severity === "critical").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
  return {
    ok: counts.critical === 0,
    findings,
    counts,
  };
}
