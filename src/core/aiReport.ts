import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withoutSecrets } from "./secrets.ts";

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

function scrub(text: string, maxChars: number, extraSecrets?: readonly string[]): string {
  let clean = withoutSecrets(text);
  for (const literal of extraSecrets ?? []) {
    const trimmed = literal.trim();
    if (trimmed.length >= 6) {
      clean = clean.split(trimmed).join("[redacted]");
    }
  }
  return clean.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Builds a secret-scrubbed local AI output report object. */
export function buildAiOutputReport(input: AiOutputReportInput): AiOutputReportRecord {
  const category = (AI_REPORT_CATEGORIES as readonly string[]).includes(input.category)
    ? input.category
    : "other";
  const replyExcerpt =
    input.includeExcerpt && input.replyExcerpt?.trim()
      ? scrub(input.replyExcerpt, 1200, input.extraSecrets)
      : null;
  const userPromptExcerpt =
    input.includeExcerpt && input.userPromptExcerpt?.trim()
      ? scrub(input.userPromptExcerpt, 600, input.extraSecrets)
      : null;

  return {
    schemaVersion: 1,
    reportedAt: new Date().toISOString(),
    privacyNotice:
      "Saved locally only by Astra Navi Desktop. Never transmitted unless you choose to file a report.",
    appVersion: input.appVersion,
    brainLabel: scrub(input.brainLabel || "Unknown", 120, input.extraSecrets),
    inferenceScope: scrub(input.inferenceScope || "local-gguf", 64, input.extraSecrets),
    category,
    categoryLabel: AI_REPORT_CATEGORY_LABELS[category],
    note: scrub(input.note || "", 1200, input.extraSecrets),
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
