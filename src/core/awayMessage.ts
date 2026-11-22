import type { Brain } from "./brain.ts";

/**
 * Hands her a message sent from one of the user's other devices, and shows it at the PC
 * so whoever is sitting there sees what was asked from afar.
 *
 * The order matters. Her brain starts on a message before `send` returns, so the
 * message is shown first: her window matches each reply to the thing said that it
 * answers, and one shown after the reply had started would be matched to the next reply
 * instead. A message she will not take (too many are already waiting) is never shown.
 */
export function takeAwayMessage(
  brain: Pick<Brain, "wouldTake" | "send"> | null | undefined,
  text: string,
  show: () => void,
): boolean {
  if (!brain?.wouldTake(text, { away: true })) return false;
  show();
  return brain.send(text, { away: true });
}
