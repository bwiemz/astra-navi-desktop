import { firstCharacters, withoutUnseen } from "../core/unseen.ts";

/**
 * A program's name as the graphics card gave it, made fit to show beside her: one short
 * line with nothing in it but ordinary characters. Null when there is no name to show.
 */
export function programShown(name: string | undefined): string | null {
  if (name === undefined) return null;
  const plain = withoutUnseen(name).replace(/\s+/gu, " ").trim();
  return firstCharacters(plain, 60) || "a game";
}
