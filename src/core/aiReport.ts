import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSupportText } from "./supportBundle.ts";

/**
 * In-App AI Output Reporting (Microsoft Store Policy 11.16 compliance & local safety triage).
 *
 * Strictly local-first: builds a secret-scrubbed incident report saved under
 * `<dataDir>/ai-reports/` and optionally generates a pre-filled GitHub issue URL.
 * Nothing is ever uploaded automatically without explicit user action.
 */

export const AI_REPORT_CATEGORIES = [
  "inaccurate",
  "harmful-or-unsafe",
  "out-of-character",
  "prompt-injection",
  "other",
] as const;
export type AiReportCategory = (typeof AI_REPORT_CATEGORIES)[number];

export const AI_REPORT_CATEGORY_LABELS: Record<AiReportCategory, string> = {
  inaccurate: "Inaccurate or hallucinated information",
  "harmful-or-unsafe": "Harmful, offensive, or unsafe AI output",
  "out-of-character": "Persona drift / out-of-character reply",
  "prompt-injection": "Suspicious tool call or prompt injection",
  other: "Other AI output issue",
};

export interface AiOutputReportInput {
  category: AiReportCategory;
  note: string;
  includeExcerpt: boolean;
  replyExcerpt?: string;
  userPromptExcerpt?: string;
  appVersion: string;
  brainLabel: string;
  inferenceScope: string;
  extraSecrets?: readonly string[];
  mcpEnvSecrets?: readonly string[];
}

export interface AiOutputReportRecord {
  schemaVersion: 1;
  reportedAt: string;
  privacyNotice: string;
  appVersion: string;
  brainLabel: string;
  inferenceScope: string;
  category: AiReportCategory;
  categoryLabel: string;
  note: string;
  replyExcerpt: string | null;
  userPromptExcerpt: string | null;
}

/**
 * Reduces any custom local GGUF file path (e.g. `C:\Users\JaneDoe\models\MyModel.gguf`)
 * to its safe filename only, preventing OS usernames or host directories from leaking
 * into saved reports or pre-filled GitHub issue URLs.
 */
export function safeBrainLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Unknown";
  if (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    trimmed.includes("\\") ||
    trimmed.toLowerCase().endsWith(".gguf")
  ) {
    const parts = trimmed.split(/[\\/]+/).filter(Boolean);
    const file = parts[parts.length - 1];
    if (file) return file;
  }
  return trimmed;
}

function scrub(
  text: string,
  maxChars: number,
  extraSecrets?: readonly string[],
  mcpEnvSecrets?: readonly string[],
): string {
  const clean = redactSupportText(text, extraSecrets ?? [], mcpEnvSecrets ?? []).text;
  return clean.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Builds a secret-scrubbed local AI output report object. */
export function buildAiOutputReport(input: AiOutputReportInput): AiOutputReportRecord {
  const category = (AI_REPORT_CATEGORIES as readonly string[]).includes(input.category)
    ? input.category
    : "other";
  const replyExcerpt =
    input.includeExcerpt && input.replyExcerpt?.trim()
      ? scrub(input.replyExcerpt, 1200, input.extraSecrets, input.mcpEnvSecrets)
      : null;
  const userPromptExcerpt =
    input.includeExcerpt && input.userPromptExcerpt?.trim()
      ? scrub(input.userPromptExcerpt, 600, input.extraSecrets, input.mcpEnvSecrets)
      : null;

  return {
    schemaVersion: 1,
    reportedAt: new Date().toISOString(),
    privacyNotice:
      "Saved locally only by Astra Navi Desktop. Never transmitted unless you choose to file a report.",
    appVersion: input.appVersion,
    brainLabel: scrub(
      safeBrainLabel(input.brainLabel || "Unknown"),
      120,
      input.extraSecrets,
      input.mcpEnvSecrets,
    ),
    inferenceScope: scrub(
      input.inferenceScope || "local-gguf",
      64,
      input.extraSecrets,
      input.mcpEnvSecrets,
    ),
    category,
    categoryLabel: AI_REPORT_CATEGORY_LABELS[category],
    note: scrub(input.note || "", 1200, input.extraSecrets, input.mcpEnvSecrets),
    replyExcerpt,
    userPromptExcerpt,
  };
}

/** Saves an AI output incident report locally under `<reportsDir>` with `0o600` permissions. */
export async function saveAiOutputReport(
  reportsDir: string,
  report: AiOutputReportRecord,
): Promise<string> {
  await mkdir(reportsDir, { recursive: true, mode: 0o700 });
  const stamp = report.reportedAt.replace(/[:.]/g, "-");
  const filePath = join(reportsDir, `ai-report-${stamp}.json`);
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

/** Builds a safe, user-initiated GitHub issue URL for reporting problematic AI output. */
export function buildGithubReportIssueUrl(
  report: AiOutputReportRecord,
  repoSlug = "bwiemz/astra-navi-desktop",
): string {
  const title = `[AI Output Report] ${report.categoryLabel}`;
  const bodyLines = [
    `### Category`,
    report.categoryLabel,
    "",
    `### Runtime`,
    `- App version: ${report.appVersion}`,
    `- Brain: ${report.brainLabel}`,
    `- Inference scope: ${report.inferenceScope}`,
    "",
    `### What happened`,
    report.note || "(Describe the unexpected or problematic AI output here)",
  ];
  if (report.replyExcerpt) {
    bodyLines.push("", "### Scrubbed Reply Excerpt", "```text", report.replyExcerpt, "```");
  }
  const params = new URLSearchParams({
    title,
    labels: "ai-output-report",
    body: bodyLines.join("\n"),
  });
  return `https://github.com/${repoSlug}/issues/new?${params.toString()}`;
}
