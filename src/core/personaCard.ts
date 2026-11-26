import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/**
 * Persona Card Importer (`chara_card_v2`, `chara_card_v3`, V1 JSON, PNG `tEXt` cards,
 * and native Astra persona JSON).
 *
 * Strictly extracts character identity fields (`displayName`, `greetingStyle`, `traits`,
 * `bio`, `speakInThirdPerson`, optional `userAddress`) while stripping prompt-injection
 * delimiters, control characters, BiDi overrides, and `[[mood]]` spoofing tags. Imported
 * cards can never alter permissions, tool policies, or security rules.
 */

const MAX_CARD_FILE_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImportedPersonaCard {
  format: "chara_card_v3" | "chara_card_v2" | "chara_card_v1" | "astra_persona";
  displayName: string;
  userAddress?: string;
  greetingStyle: string;
  traits: string[];
  speakInThirdPerson: boolean;
  bio: string;
  sourceName: string;
  creator?: string;
}

/**
 * Removes control chars, invisible Unicode tag characters (`U+E0000–U+E007F`), zero-width
 * & BiDi overrides, ChatML/tool/system markup (iterated to fixed point so nested tags
 * cannot reconstruct delimiters), and `[[mood]]` spoofing.
 */
export function sanitizePersonaText(raw: string, maxChars: number): string {
  const safeMax = Math.max(0, maxChars);
  if (safeMax === 0 || !raw) return "";
  // Pre-slice before stripping so adversarial huge strings stay O(safeMax).
  const preLimit = Math.max(2048, safeMax * 4);
  const bounded = raw.length > preLimit ? raw.slice(0, preLimit) : raw;
  const chars: string[] = [];
  for (const ch of bounded) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      cp === 0x7f ||
      cp === 0x00ad ||
      cp === 0x034f ||
      cp === 0x061c ||
      cp === 0x180e ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x206f) ||
      cp === 0xfeff ||
      (cp >= 0xe0000 && cp <= 0xe007f)
    ) {
      continue;
    }
    chars.push(ch);
  }
  let neutralized = chars.join("");
  // Iterate to fixed point so nested payloads like `<tool_<tool_call>call>` or `<|im_<|im_start|>start|>` vanish.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = neutralized
      .replaceAll("<|im_start|>", "")
      .replaceAll("<|im_end|>", "")
      .replace(/<\/?(?:tool_call|tool_response|system|memories|assistant|user)[^>]{0,256}>/gi, "")
      .replace(/<function=[^>]{0,256}>/gi, "")
      .replaceAll("[[", "[")
      .replaceAll("]]", "]")
      .replace(/\s+/g, " ")
      .trim();
    if (next === neutralized) break;
    neutralized = next;
  }
  return neutralized.length > safeMax ? neutralized.slice(0, safeMax).trim() : neutralized;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractTraits(rawTraits: unknown, personalityText: string): string[] {
  const out: string[] = [];
  const pushClean = (candidate: string): void => {
    const clean = sanitizePersonaText(candidate, 160);
    if (clean.length >= 2 && !out.includes(clean)) {
      out.push(clean);
    }
  };

  if (Array.isArray(rawTraits)) {
    for (const item of rawTraits) {
      if (out.length >= 8) break;
      if (typeof item === "string") pushClean(item);
    }
  }
  if (out.length === 0 && personalityText.trim()) {
    const pieces = personalityText
      .split(/[\r\n;]+|,\s+(?=[A-Za-z])/)
      .map((p) => p.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);
    for (const piece of pieces) {
      if (out.length >= 6) break;
      pushClean(piece);
    }
  }
  return out;
}

/** Extracts base64-encoded `ccv3` or `chara` JSON payload from PNG `tEXt` metadata chunks. */
export function extractPngPersonaPayload(pngBytes: Buffer): unknown {
  if (pngBytes.length < PNG_MAGIC.length || !pngBytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("File is not a valid PNG image.");
  }
  const chunks: Record<string, string> = {};
  let offset = 8;
  while (offset + 12 <= pngBytes.length) {
    const length = pngBytes.readUInt32BE(offset);
    const type = pngBytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBytes.length) break;
    if (type === "tEXt") {
      const data = pngBytes.subarray(dataStart, dataEnd);
      const nulIdx = data.indexOf(0);
      if (nulIdx > 0) {
        const keyword = data.subarray(0, nulIdx).toString("latin1").toLowerCase();
        if (keyword === "ccv3" || keyword === "chara") {
          chunks[keyword] = data.subarray(nulIdx + 1).toString("utf8").trim();
        }
      }
    }
    if (type === "IEND") break;
    offset = dataEnd + 4;
  }

  const encoded = chunks["ccv3"] ?? chunks["chara"];
  if (!encoded) {
    throw new Error("PNG image does not contain an embedded Character Card (ccv3/chara) chunk.");
  }
  const decodedText = Buffer.from(encoded, "base64").toString("utf8");
  try {
    return JSON.parse(decodedText) as unknown;
  } catch {
    throw new Error("Embedded PNG character card metadata is not valid JSON.");
  }
}

/** Parses and sanitizes an unknown JSON object representing a V1/V2/V3 or Astra persona card. */
export function parsePersonaCardJson(raw: unknown): ImportedPersonaCard {
  const root = asRecord(raw);
  if (!root) {
    throw new Error("Persona card must be a JSON object.");
  }

  const spec = asString(root["spec"]).trim().toLowerCase();
  const data = asRecord(root["data"]);

  if ((spec === "chara_card_v3" || spec === "chara_card_v2") && data) {
    const name = sanitizePersonaText(asString(data["name"]), 40);
    if (!name) throw new Error("Character card is missing a character name.");
    const personality = asString(data["personality"]);
    const description = asString(data["description"]);
    const scenario = asString(data["scenario"]);
    const firstMes = asString(data["first_mes"]);
    const creator = sanitizePersonaText(asString(data["creator"]), 80) || undefined;

    const bioParts = [
      sanitizePersonaText(description, 520),
      scenario.trim() ? `Setting: ${sanitizePersonaText(scenario, 240)}` : "",
    ].filter(Boolean);
    const bio = sanitizePersonaText(bioParts.join(" "), 800);
    const traits = extractTraits(data["traits"], personality);
    const greetingStyle = sanitizePersonaText(
      asString(data["greetingStyle"]) || firstMes,
      160,
    );
    const speakInThirdPerson =
      typeof data["speakInThirdPerson"] === "boolean" ? data["speakInThirdPerson"] : false;

    return {
      format: spec === "chara_card_v3" ? "chara_card_v3" : "chara_card_v2",
      displayName: name,
      greetingStyle,
      traits,
      speakInThirdPerson,
      bio,
      sourceName: name,
      ...(creator ? { creator } : {}),
    };
  }

  // Native Astra persona JSON (`displayName` / `traits` / `speakInThirdPerson` / `userAddress`)
  if (
    typeof root["displayName"] === "string" ||
    Array.isArray(root["traits"]) ||
    typeof root["speakInThirdPerson"] === "boolean"
  ) {
    const displayName = sanitizePersonaText(
      asString(root["displayName"]) || asString(root["name"]),
      40,
    );
    if (!displayName) throw new Error("Persona JSON is missing a displayName or name.");
    const userAddressRaw =
      typeof root["userAddress"] === "string"
        ? sanitizePersonaText(root["userAddress"], 40)
        : undefined;
    const greetingStyle = sanitizePersonaText(asString(root["greetingStyle"]), 160);
    const traits = extractTraits(root["traits"], asString(root["personality"]));
    const bio = sanitizePersonaText(
      asString(root["bio"]) || asString(root["description"]),
      800,
    );
    const speakInThirdPerson =
      typeof root["speakInThirdPerson"] === "boolean" ? root["speakInThirdPerson"] : false;

    return {
      format: "astra_persona",
      displayName,
      ...(userAddressRaw !== undefined ? { userAddress: userAddressRaw } : {}),
      greetingStyle,
      traits,
      speakInThirdPerson,
      bio,
      sourceName: displayName,
    };
  }

  // Character Card V1 flat JSON (`{ name, description, personality, first_mes, scenario }`)
  const v1Name = sanitizePersonaText(asString(root["name"]), 40);
  if (!v1Name) {
    throw new Error("Unrecognized persona card: missing character `name`.");
  }
  const bioParts = [
    sanitizePersonaText(asString(root["description"]), 520),
    asString(root["scenario"]).trim()
      ? `Setting: ${sanitizePersonaText(asString(root["scenario"]), 240)}`
      : "",
  ].filter(Boolean);

  return {
    format: "chara_card_v1",
    displayName: v1Name,
    greetingStyle: sanitizePersonaText(asString(root["first_mes"]), 160),
    traits: extractTraits(undefined, asString(root["personality"])),
    speakInThirdPerson: false,
    bio: sanitizePersonaText(bioParts.join(" "), 800),
    sourceName: v1Name,
  };
}

/** Loads and parses a `.json` or `.png` persona card file from disk with size bounds. */
export async function importPersonaCardFile(filePath: string): Promise<ImportedPersonaCard> {
  const bytes = await readFile(filePath);
  if (bytes.length > MAX_CARD_FILE_BYTES) {
    throw new Error("Persona card file exceeds the 8 MB safety limit.");
  }
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png" || (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC))) {
    return parsePersonaCardJson(extractPngPersonaPayload(bytes));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Persona card file is not valid JSON or PNG.");
  }
  return parsePersonaCardJson(parsed);
}
