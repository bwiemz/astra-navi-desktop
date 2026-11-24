import { createHash, sign, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import { validateMcpHttpUrl } from "./mcpClient.ts";
import { toolVerdict, type PolicyContext, type Verdict } from "./permissions.ts";
import { isPrivateLanHost } from "./workerMesh.ts";

/**
 * Signed Plugin SDK (ai_chan_plan.pdf p. 15).
 *
 * Community capability packs declare bridge kinds (`obs`, `blender`, `home_assistant`,
 * `game_telemetry`, `mcp`, `lsp`, `custom`), explicit tool contracts, permission scopes,
 * optional MCP server bindings, SHA-256 entry digests, and bundled security eval cases
 * verified before activation. Every runtime call requires explicit user plugin approval
 * AND remains gated by declared plugin scopes + `core/permissions.ts`.
 */

export const PLUGIN_PERMISSION_SCOPES = [
  "read_workspace",
  "write_workspace",
  "read_web",
  "read_active_window",
  "emit_notification",
  "register_tool",
  "register_theme",
  "connect_mcp",
] as const;
export type PluginPermissionScope = (typeof PLUGIN_PERMISSION_SCOPES)[number];

export const PLUGIN_BRIDGE_KINDS = [
  "obs",
  "blender",
  "home_assistant",
  "game_telemetry",
  "mcp",
  "lsp",
  "custom",
] as const;
export type PluginBridgeKind = (typeof PLUGIN_BRIDGE_KINDS)[number];

function hasControlOrShellChars(cmd: string): boolean {
  for (let i = 0; i < cmd.length; i += 1) {
    const code = cmd.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return /[;&|`$<>()]/.test(cmd);
}

function isSafeRelativeEntryPath(entry: string): boolean {
  if (!entry || entry.includes("\0") || entry.includes("..") || entry.includes("\\") || entry.includes(":")) {
    return false;
  }
  if (entry.startsWith("/") || entry.endsWith("/")) return false;
  const parts = entry.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export const PluginMcpServerSchema = z
  .object({
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).max(260).optional(),
    args: z.array(z.string().max(260)).max(32).optional(),
    url: z.string().url().max(512).optional(),
    readOnlyAutoAllow: z.boolean().default(false),
  })
  .superRefine((srv, ctx) => {
    if (srv.transport === "stdio" && (!srv.command || hasControlOrShellChars(srv.command))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Stdio plugin MCP server requires a safe `command` string without control or shell metacharacters.",
      });
    }
    if (srv.transport === "http") {
      const check = srv.url ? validateMcpHttpUrl(srv.url) : { ok: false as const, reason: "Missing HTTP URL." };
      if (!check.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: check.reason });
      }
    }
  });

export const PluginToolSpecSchema = z.object({
  name: z.string().regex(/^plugin:[a-z0-9][a-z0-9:._-]{1,56}$/),
  description: z.string().min(1).max(240),
  requiredScope: z.enum(PLUGIN_PERMISSION_SCOPES),
  readOnly: z.boolean().default(false),
  endpointHost: z.string().max(120).optional(),
});
export type PluginToolSpec = z.infer<typeof PluginToolSpecSchema>;

export const PluginEvalCaseSchema = z.object({
  name: z.string().min(1).max(80),
  tool: z.string().min(1).max(80),
  args: z.record(z.string(), z.unknown()).default({}),
  expectDecision: z.enum(["allow", "ask", "blocked"]),
  readOutsideText: z.boolean().optional(),
  handsOff: z.boolean().optional(),
});
export type PluginEvalCase = z.infer<typeof PluginEvalCaseSchema>;

export const PluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
    name: z.string().min(1).max(80),
    version: z.string().min(1).max(32),
    author: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    defaultEnabled: z.literal(false).optional(),
    bridgeKind: z.enum(PLUGIN_BRIDGE_KINDS).optional(),
    bridges: z.array(z.enum(PLUGIN_BRIDGE_KINDS)).max(8).optional(),
    mcpServer: PluginMcpServerSchema.optional(),
    entry: z
      .string()
      .min(1)
      .max(160)
      .refine(isSafeRelativeEntryPath, "Plugin entry must be a safe relative path within its bundle directory."),
    permissions: z.array(z.enum(PLUGIN_PERMISSION_SCOPES)).max(16),
    tools: z.array(PluginToolSpecSchema).max(32).optional(),
    evalCases: z.array(PluginEvalCaseSchema).max(64).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    evalCasesCount: z.number().int().min(0).optional(),
  })
  .superRefine((manifest, ctx) => {
    const declared = new Set<PluginPermissionScope>(manifest.permissions);
    for (const tool of manifest.tools ?? []) {
      if (!declared.has(tool.requiredScope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Plugin tool "${tool.name}" requires scope "${tool.requiredScope}" not declared in permissions.`,
        });
      }
    }
    if (manifest.mcpServer && !declared.has("connect_mcp")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plugin declaring mcpServer must request the \"connect_mcp\" permission scope.",
      });
    }
  });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      const entry = record[key];
      if (entry !== undefined) sorted[key] = sortJsonValue(entry);
    }
    return sorted;
  }
  return value;
}

/** Encodes an object into sorted-key canonical UTF-8 JSON bytes for Ed25519 signing. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortJsonValue(value)), "utf8");
}

/** Signs a validated plugin manifest with an Ed25519 private key PEM, returning base64. */
export function signPluginManifest(manifest: PluginManifest, privateKeyPem: string): string {
  const parsed = PluginManifestSchema.parse(manifest);
  return sign(null, canonicalJsonBytes(parsed), privateKeyPem).toString("base64");
}

/** Verifies a plugin manifest Ed25519 signature against a trusted public key list. */
export function verifyPluginSignature(
  manifest: PluginManifest,
  signatureBase64: string,
  trustedPublicKeysPem: readonly string[],
): boolean {
  if (!signatureBase64 || trustedPublicKeysPem.length === 0) return false;
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(signatureBase64, "base64");
  } catch {
    return false;
  }
  if (sigBytes.length === 0) return false;
  const payload = canonicalJsonBytes(manifest);
  for (const pubPem of trustedPublicKeysPem) {
    try {
      if (verify(null, payload, pubPem, sigBytes)) return true;
    } catch {
      // Ignore malformed public key and test remaining keys.
    }
  }
  return false;
}

/** Executes bundled security eval assertions against `core/permissions.ts` and plugin scope rules. */
export async function runPluginBundledEvals(
  manifest: PluginManifest,
  baseContext: PolicyContext,
): Promise<{ ok: boolean; passed: number; total: number; failures: string[] }> {
  const cases = manifest.evalCases ?? [];
  const toolMap = new Map((manifest.tools ?? []).map((t) => [t.name, t]));
  const failures: string[] = [];
  let passed = 0;

  for (const tc of cases) {
    if (tc.handsOff) {
      if (tc.expectDecision === "blocked") passed += 1;
      else failures.push(`${tc.name}: expected ${tc.expectDecision} under handsOff`);
      continue;
    }

    const declaredSpec = toolMap.get(tc.tool);
    if (declaredSpec && !manifest.permissions.includes(declaredSpec.requiredScope)) {
      if (tc.expectDecision === "blocked") passed += 1;
      else failures.push(`${tc.name}: missing scope ${declaredSpec.requiredScope}`);
      continue;
    }

    const ctx: PolicyContext = {
      ...baseContext,
      ...(tc.readOutsideText !== undefined ? { readOutsideText: tc.readOutsideText } : {}),
      pluginPolicy: (toolName) => {
        const spec = toolMap.get(toolName);
        if (!spec || !manifest.permissions.includes(spec.requiredScope)) {
          return {
            decision: "ask",
            sensitive: false,
            reason: `Undeclared or unpermitted plugin tool "${toolName}".`,
          };
        }
        return spec.readOnly
          ? { decision: "allow" }
          : {
              decision: "ask",
              sensitive: false,
              reason: `Plugin action "${toolName}" may change external state.`,
            };
      },
    };

    let actualDecision: "allow" | "ask" | "blocked";
    try {
      const verdict = await toolVerdict(tc.tool, tc.args, ctx);
      actualDecision = verdict.decision;
    } catch {
      actualDecision = "blocked";
    }

    if (actualDecision === tc.expectDecision) {
      passed += 1;
    } else {
      failures.push(
        `${tc.name}: expected "${tc.expectDecision}" for "${tc.tool}", got "${actualDecision}".`,
      );
    }
  }

  return { ok: failures.length === 0, passed, total: cases.length, failures };
}

export type PluginVerifyResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; reason: string };

/**
 * Verifies plugin manifest structure, private-LAN bridge constraints, Ed25519 signature,
 * SHA-256 entry hash, and optional/bundled `evalCases` security gate.
 */
export async function verifyPluginBundle(options: {
  manifest: unknown;
  signature: string;
  entryBytes: Uint8Array;
  trustedPublicKeysPem: readonly string[];
  evalContext?: PolicyContext;
  runBundledEval?: () => Promise<{ ok: boolean; reason?: string }>;
}): Promise<PluginVerifyResult> {
  const parsed = PluginManifestSchema.safeParse(options.manifest);
  if (!parsed.success) {
    return { ok: false, reason: `Invalid plugin manifest: ${parsed.error.message}` };
  }
  for (const tool of parsed.data.tools ?? []) {
    if (tool.endpointHost && !isPrivateLanHost(tool.endpointHost)) {
      return {
        ok: false,
        reason: `Refused non-LAN bridge endpoint host "${tool.endpointHost}" in plugin tool "${tool.name}".`,
      };
    }
  }
  if (!verifyPluginSignature(parsed.data, options.signature, options.trustedPublicKeysPem)) {
    return { ok: false, reason: "Plugin signature failed Ed25519 verification." };
  }
  const actualDigest = createHash("sha256").update(options.entryBytes).digest();
  const expectedDigest = Buffer.from(parsed.data.sha256, "hex");
  if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
    return { ok: false, reason: "Plugin entry file SHA-256 digest mismatch." };
  }
  if (parsed.data.evalCases && parsed.data.evalCases.length > 0 && options.evalContext) {
    const evalRes = await runPluginBundledEvals(parsed.data, options.evalContext);
    if (!evalRes.ok) {
      return {
        ok: false,
        reason: `Bundled plugin evals failed: ${evalRes.failures.join("; ")}`,
      };
    }
  }
  if (options.runBundledEval) {
    const evalOutcome = await options.runBundledEval();
    if (!evalOutcome.ok) {
      return {
        ok: false,
        reason: evalOutcome.reason ?? "Plugin bundled safety evaluation failed.",
      };
    }
  }
  return { ok: true, manifest: parsed.data };
}

export class PluginRegistry {
  enabled: boolean;
  private readonly trustedKeys: string[];
  private readonly plugins = new Map<string, PluginManifest>();
  private readonly approved = new Set<string>();

  constructor(options: { enabled?: boolean; trustedPublicKeysPem?: readonly string[] } = {}) {
    this.enabled = options.enabled ?? false;
    this.trustedKeys = [...(options.trustedPublicKeysPem ?? [])];
  }

  list(): readonly PluginManifest[] {
    return [...this.plugins.values()];
  }

  approvePlugin(pluginId: string): void {
    if (this.plugins.has(pluginId)) this.approved.add(pluginId);
  }

  revokePlugin(pluginId: string): void {
    this.approved.delete(pluginId);
  }

  isPluginApproved(pluginId: string): boolean {
    return this.approved.has(pluginId);
  }

  listDeclaredTools(): { pluginId: string; spec: PluginToolSpec }[] {
    const out: { pluginId: string; spec: PluginToolSpec }[] = [];
    for (const plugin of this.plugins.values()) {
      for (const spec of plugin.tools ?? []) {
        out.push({ pluginId: plugin.id, spec });
      }
    }
    return out;
  }

  listApprovedDeclaredTools(): { pluginId: string; spec: PluginToolSpec }[] {
    const out: { pluginId: string; spec: PluginToolSpec }[] = [];
    for (const plugin of this.plugins.values()) {
      if (!this.approved.has(plugin.id)) continue;
      for (const spec of plugin.tools ?? []) {
        out.push({ pluginId: plugin.id, spec });
      }
    }
    return out;
  }

  async register(options: {
    manifest: unknown;
    signature: string;
    entryBytes: Uint8Array;
    evalContext?: PolicyContext;
    approvedByUser?: boolean;
    runBundledEval?: () => Promise<{ ok: boolean; reason?: string }>;
  }): Promise<PluginVerifyResult> {
    if (!this.enabled) {
      return { ok: false, reason: "Signed plugins are disabled in Experimental options." };
    }
    const verified = await verifyPluginBundle({
      ...options,
      trustedPublicKeysPem: this.trustedKeys,
    });
    if (!verified.ok) return verified;
    this.plugins.set(verified.manifest.id, verified.manifest);
    if (options.approvedByUser === true) {
      this.approved.add(verified.manifest.id);
    } else {
      this.approved.delete(verified.manifest.id);
    }
    return verified;
  }

  hasPermission(pluginId: string, scope: PluginPermissionScope): boolean {
    const plugin = this.plugins.get(pluginId);
    return plugin ? plugin.permissions.includes(scope) : false;
  }

  /** Checks explicit user approval, plugin scope declaration, and core `permissions.ts` `toolVerdict`. */
  async authorizeToolCall(
    pluginId: string,
    requiredScope: PluginPermissionScope,
    toolName: string,
    input: unknown,
    context: PolicyContext,
  ): Promise<{ allowed: boolean; verdict: Verdict | null; reason?: string }> {
    if (!this.enabled) {
      return { allowed: false, verdict: null, reason: "Signed plugins are disabled." };
    }
    if (!this.isPluginApproved(pluginId)) {
      return {
        allowed: false,
        verdict: null,
        reason: `Plugin "${pluginId}" has not been explicitly approved by the user.`,
      };
    }
    if (context.handsOff === true) {
      return {
        allowed: false,
        verdict: null,
        reason: `Hands-off mode blocks plugin execution ("${pluginId}").`,
      };
    }
    const plugin = this.plugins.get(pluginId);
    const declaredTools = plugin?.tools ?? [];
    const toolSpec = declaredTools.find((t) => t.name === toolName);
    if (declaredTools.length > 0) {
      if (!toolSpec) {
        return {
          allowed: false,
          verdict: null,
          reason: `Tool "${toolName}" is not declared in plugin "${pluginId}".`,
        };
      }
      if (toolSpec.requiredScope !== requiredScope) {
        return {
          allowed: false,
          verdict: null,
          reason: `Tool "${toolName}" requires scope "${toolSpec.requiredScope}", not "${requiredScope}".`,
        };
      }
      if (!this.hasPermission(pluginId, toolSpec.requiredScope)) {
        return {
          allowed: false,
          verdict: null,
          reason: `Plugin "${pluginId}" lacks declared scope "${toolSpec.requiredScope}".`,
        };
      }
    }
    if (!this.hasPermission(pluginId, requiredScope)) {
      return {
        allowed: false,
        verdict: null,
        reason: `Plugin "${pluginId}" lacks declared permission scope "${requiredScope}".`,
      };
    }
    const mergedContext: PolicyContext = {
      ...context,
      ...(context.pluginPolicy
        ? {}
        : toolSpec
          ? {
              pluginPolicy: () =>
                toolSpec.readOnly
                  ? { decision: "allow" }
                  : {
                      decision: "ask",
                      sensitive: false,
                      reason: `Plugin bridge action "${toolName}" may change external state.`,
                    },
            }
          : {}),
    };
    try {
      const verdict = await toolVerdict(toolName, input, mergedContext);
      return {
        allowed: verdict.decision === "allow",
        verdict,
        ...(verdict.decision === "ask" ? { reason: verdict.reason } : {}),
      };
    } catch (error) {
      return {
        allowed: false,
        verdict: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
