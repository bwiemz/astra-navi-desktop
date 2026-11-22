import type { Memory, MemoryKind } from "./memory.ts";

const HEADINGS: readonly [MemoryKind, string][] = [
  ["profile", "About you"],
  ["preference", "How you like things"],
  ["project", "What you are working on"],
  ["topic", "What you two talk about"],
  ["skill", "What she has learned to do for you"],
  ["fact", "Facts about your computer and your world"],
  ["episode", "Things you did together"],
];

/**
 * Everything she has in long-term memory as a page a person can read, so nothing she
 * learns by herself is hidden. Each note carries the id that deletes it.
 */
export function describeLearned(memories: readonly Memory[], memoryFile: string): string {
  const lines = [
    "# What AI-chan has learned",
    "",
    "Everything here is stored only on this computer. Notes marked _(picked up by herself)_ were written after a conversation went quiet, not at your request.",
    "",
    'To remove a note, tell her "forget" with the code in brackets, for example "forget a1b2c3d4". To change or remove several, close the app and edit the file below.',
    "",
    `File: \`${memoryFile}\``,
  ];
  if (memories.length === 0) lines.push("", "Nothing yet. This is a brand-new friendship.");
  for (const [kind, heading] of HEADINGS) {
    const group = memories
      .filter((memory) => memory.kind === kind)
      .sort((a, b) => b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt));
    if (group.length === 0) continue;
    lines.push("", `## ${heading}`, "");
    for (const memory of group) {
      const when = memory.updatedAt.slice(0, 10);
      const byHerself = memory.tags.includes("learned") ? " _(picked up by herself)_" : "";
      if (kind === "topic" || kind === "skill") {
        const count =
          kind === "skill"
            ? `done ${memory.hits} time${memory.hits === 1 ? "" : "s"}`
            : `came up ${memory.hits} time${memory.hits === 1 ? "" : "s"}`;
        lines.push(`- **${memory.text}** [${memory.id}] (${count}, last on ${when})`);
        for (const point of memory.points) lines.push(`  - ${point}`);
      } else {
        lines.push(`- ${memory.text} [${memory.id}] (${when})${byHerself}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
