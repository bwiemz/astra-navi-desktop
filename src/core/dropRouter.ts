import { basename, extname } from "node:path";

export type DroppedFileKind = "avatar" | "document" | "image" | "calendar" | "other";

export interface DroppedAttachment {
  kind: "document" | "image";
  path: string;
  name: string;
}

const AVATAR_EXTS = new Set([".vrm", ".pmx", ".pmd"]);
const DOCUMENT_EXTS = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".odt",
  ".rtf",
  ".epub",
  ".xlsx",
  ".xls",
  ".ods",
  ".pptx",
  ".ppt",
  ".odp",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"]);

/** Routes a dropped desktop file path to its corresponding Astra subsystem. */
export function classifyDroppedPath(filePath: string): DroppedFileKind {
  const ext = extname(filePath).toLowerCase();
  if (AVATAR_EXTS.has(ext)) return "avatar";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (ext === ".ics") return "calendar";
  return "other";
}

/** Derives a safe, non-reserved calendar name from a dropped `.ics` filename. */
export function deriveCalendarNameFromPath(filePath: string): string {
  const base = basename(filePath, extname(filePath))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  if (!base || base.toLowerCase() === "ai-chan") return "Imported Calendar";
  return base;
}

/** Builds the user message combining typed text and dropped document/image attachments. */
export function formatAttachedPrompt(
  userText: string,
  attachments: readonly DroppedAttachment[],
): string {
  const trimmed = userText.trim();
  if (attachments.length === 0) return trimmed;
  const header = attachments
    .map((att) =>
      att.kind === "image"
        ? `[Attached image: "${att.path}"]`
        : `[Attached document: "${att.path}"]`,
    )
    .join("\n");
  const promptBody =
    trimmed !== "" ? trimmed : "Please inspect the attached file(s) and help me with them.";
  return `${header}\n\n${promptBody}`;
}
