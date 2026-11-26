import type { CharacterBundleManifest } from "./characterBundle.ts";
import type { Config } from "./config.ts";
import type { CharacterPersonaOverride } from "./persona.ts";
import { sanitizePersonaText, type ImportedPersonaCard } from "./personaCard.ts";

/**
 * Character Layer helpers connecting `config.character`, `persona.ts`, avatar `.bundle`
 * manifests (name + personality + voice), and imported persona cards.
 */

export const DEFAULT_USER_ADDRESS = "Captain";
export const DEFAULT_DISPLAY_NAME = "Astra Navi";

/**
 * Replaces internal app-authored `"Captain"` wording with neutral `"the user"` / `"User"`
 * phrasing whenever the user has customized how the companion addresses them (e.g. a first
 * name or empty title). Leaves built-in default `"Captain"` prompts byte-for-byte unchanged
 * and NEVER interpolates raw custom text into tool or safety rules.
 */
export function replaceInternalCaptain(text: string, userAddress?: string): string {
  if (userAddress === undefined || userAddress.trim() === DEFAULT_USER_ADDRESS) {
    return text;
  }
  return text.replace(
    /(^|[.!?\n]\s*)(Captain's|Captain)\b|\bCaptain:\s|\bCaptain's\b|\bCaptain\b/g,
    (match, lead: string | undefined, startWord: string | undefined) => {
      if (startWord === "Captain's") return `${lead ?? ""}The user's`;
      if (startWord === "Captain") return `${lead ?? ""}The user`;
      if (match.startsWith("Captain:")) return `User:${match.slice("Captain:".length)}`;
      if (match === "Captain's") return "the user's";
      return "the user";
    },
  );
}

export type CharacterConfig = Config["character"];

export function defaultCharacterConfig(): CharacterConfig {
  return {
    userAddress: DEFAULT_USER_ADDRESS,
    displayName: "",
    greetingStyle: "",
    traits: [],
    speakInThirdPerson: true,
    bio: "",
    source: "default",
    sourceName: "",
  };
}

/**
 * Converts persisted `config.character` into a `CharacterPersonaOverride`, returning
 * `undefined` when all fields match the built-in Astra/Captain defaults so the default
 * prompt remains byte-exact.
 */
export function characterOverrideFromConfig(
  character: CharacterConfig | undefined,
): CharacterPersonaOverride | undefined {
  if (!character) return undefined;
  const displayName = sanitizePersonaText(character.displayName, 40);
  const userAddress = sanitizePersonaText(character.userAddress, 40);
  const greetingStyle = sanitizePersonaText(character.greetingStyle, 160);
  const bio = sanitizePersonaText(character.bio, 800);
  const traits = character.traits
    .map((t) => sanitizePersonaText(t, 160))
    .filter((t) => t.length > 0)
    .slice(0, 8);
  const speakInThirdPerson = character.speakInThirdPerson !== false;

  const isDefault =
    displayName === "" &&
    userAddress === DEFAULT_USER_ADDRESS &&
    greetingStyle === "" &&
    bio === "" &&
    traits.length === 0 &&
    speakInThirdPerson === true;

  if (isDefault) return undefined;

  return {
    ...(displayName ? { displayName } : {}),
    userAddress,
    ...(greetingStyle ? { greetingStyle } : {}),
    ...(traits.length > 0 ? { traits } : {}),
    speakInThirdPerson,
    ...(bio ? { bio } : {}),
  };
}

/** Builds a persisted character profile bound to an avatar bundle manifest. */
export function characterFromBundleManifest(
  manifest: CharacterBundleManifest,
  currentUserAddress: string,
): CharacterConfig {
  const persona = manifest.persona;
  const displayName = sanitizePersonaText(persona?.displayName ?? manifest.name, 40);
  const userAddress =
    persona?.userAddress !== undefined
      ? sanitizePersonaText(persona.userAddress, 40)
      : sanitizePersonaText(currentUserAddress, 40);
  return {
    userAddress,
    displayName,
    greetingStyle: sanitizePersonaText(persona?.greetingStyle ?? "", 160),
    traits: (persona?.traits ?? [])
      .map((t) => sanitizePersonaText(t, 160))
      .filter(Boolean)
      .slice(0, 8),
    speakInThirdPerson: persona?.speakInThirdPerson ?? true,
    bio: sanitizePersonaText(persona?.bio ?? "", 800),
    source: "bundle",
    sourceName: sanitizePersonaText(manifest.name, 80),
  };
}

/** Builds a persisted character profile from an imported persona card, preserving userAddress unless specified. */
export function characterFromImportedCard(
  card: ImportedPersonaCard,
  currentUserAddress: string,
): CharacterConfig {
  return {
    userAddress:
      card.userAddress !== undefined
        ? sanitizePersonaText(card.userAddress, 40)
        : sanitizePersonaText(currentUserAddress, 40),
    displayName: card.displayName,
    greetingStyle: card.greetingStyle,
    traits: [...card.traits],
    speakInThirdPerson: card.speakInThirdPerson,
    bio: card.bio,
    source: "card",
    sourceName: card.sourceName,
  };
}

/** Resolves a character bundle's declared voice binding onto the local machine's available voice engines. */
export function resolveBundleVoiceBinding(
  bundleVoice: CharacterBundleManifest["voice"],
  availableDesignedVoices: readonly string[],
  fullVoiceReady: boolean,
): { engine: "full" | "light"; design: string; speed?: number } | null {
  if (!bundleVoice) return null;
  const speed =
    typeof bundleVoice.speed === "number" && Number.isFinite(bundleVoice.speed)
      ? Math.min(2, Math.max(0.5, bundleVoice.speed))
      : undefined;
  if (bundleVoice.engine === "full" && fullVoiceReady) {
    const chosen = availableDesignedVoices.includes(bundleVoice.design)
      ? bundleVoice.design
      : (availableDesignedVoices[0] ?? bundleVoice.design);
    return { engine: "full", design: chosen, ...(speed !== undefined ? { speed } : {}) };
  }
  return {
    engine: "light",
    design: bundleVoice.design,
    ...(speed !== undefined ? { speed } : {}),
  };
}
