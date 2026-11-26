import type { Memory, MemoryKind, MemorySource } from "./memory.ts";

const HEADINGS: readonly [MemoryKind, string][] = [
  ["profile", "About you"],
  ["preference", "How you like things"],
  ["project", "What you are working on"],
  ["topic", "What you two talk about"],
  ["skill", "What she has learned to do for you"],
  ["fact", "Facts about your computer and your world"],
  ["episode", "Things you did together"],
];

const ALWAYS_LOADED_KINDS: ReadonlySet<MemoryKind> = new Set(["profile", "preference"]);

export interface MemoryManagerEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  points: string[];
  tags: string[];
  pinned: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  hits: number;
  alwaysInPrompt: boolean;
  whyRemembered: string;
  sourceExcerpt: string | null;
}

export interface MemoryManagerSnapshot {
  memoryFile: string;
  stats: {
    total: number;
    pinned: number;
    explicit: number;
    learned: number;
    userEdited: number;
    alwaysInPrompt: number;
  };
  entries: MemoryManagerEntry[];
}

/** Resolves how a memory originally entered storage, inferring cleanly for legacy notes. */
export function inferMemorySource(memory: Memory): MemorySource {
  if (memory.source) return memory.source;
  if (memory.tags.includes("learned") || memory.kind === "topic" || memory.kind === "skill") {
    return "learned";
  }
  return "explicit";
}

/**
 * Produces a transparent, plain-English answer to "Why do you remember this?"
 * covering origin, timestamps, recall frequency, prompt inclusion, and optional excerpt.
 */
export function explainWhyRemembered(memory: Memory): string {
  const source = inferMemorySource(memory);
  const created = memory.createdAt.slice(0, 10);
  const updated = memory.updatedAt.slice(0, 10);
  const parts: string[] = [];

  if (memory.reason?.trim()) {
    parts.push(memory.reason.trim());
  } else if (source === "user-edited") {
    parts.push("Created or corrected directly by you in Memory Manager.");
  } else if (source === "learned") {
    parts.push("Picked up automatically after a quiet pause in conversation.");
  } else if (source === "imported") {
    parts.push("Imported from a local profile backup or memory file.");
  } else {
    parts.push("Saved when you asked her to remember this in conversation.");
  }

  parts.push(
    created === updated
      ? `Recorded on ${created}.`
      : `First recorded on ${created}, last updated on ${updated}.`,
  );

  if (memory.hits > 0) {
    parts.push(
      memory.kind === "skill"
        ? `Used ${memory.hits} time${memory.hits === 1 ? "" : "s"}.`
        : `Came up or recalled ${memory.hits} time${memory.hits === 1 ? "" : "s"}.`,
    );
  }

  if (memory.pinned) {
    parts.push("Pinned by you: always included at the top of her working prompt.");
  } else if (ALWAYS_LOADED_KINDS.has(memory.kind)) {
    parts.push(`Always included in her working prompt because it is a ${memory.kind} note.`);
  } else {
    parts.push("Stored locally on disk and retrieved on demand when relevant.");
  }

  if (memory.sourceExcerpt?.trim()) {
    parts.push(`Context snippet: "${memory.sourceExcerpt.trim()}"`);
  }

  return parts.join(" ");
}

/** Builds a structured, editable memory-ownership snapshot for Settings and Workbench UIs. */
export function buildMemoryManagerSnapshot(
  memories: readonly Memory[],
  memoryFile: string,
): MemoryManagerSnapshot {
  const sorted = [...memories].sort(
    (a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      b.hits - a.hits,
  );

  const entries: MemoryManagerEntry[] = sorted.map((memory) => {
    const source = inferMemorySource(memory);
    const pinned = Boolean(memory.pinned);
    return {
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
      points: [...memory.points],
      tags: [...memory.tags],
      pinned,
      source,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      hits: memory.hits,
      alwaysInPrompt: pinned || ALWAYS_LOADED_KINDS.has(memory.kind),
      whyRemembered: explainWhyRemembered(memory),
      sourceExcerpt: memory.sourceExcerpt?.trim() || null,
    };
  });

  return {
    memoryFile,
    stats: {
      total: entries.length,
      pinned: entries.filter((e) => e.pinned).length,
      explicit: entries.filter((e) => e.source === "explicit").length,
      learned: entries.filter((e) => e.source === "learned").length,
      userEdited: entries.filter((e) => e.source === "user-edited").length,
      alwaysInPrompt: entries.filter((e) => e.alwaysInPrompt).length,
    },
    entries,
  };
}

/**
 * Everything she has in long-term memory as a Markdown export a person can read or back up,
 * showing pin markers and provenance so nothing she learns by herself is hidden.
 */
export function describeLearned(memories: readonly Memory[], memoryFile: string): string {
  const lines = [
    "# What Astra Navi has learned",
    "",
    "Everything here is stored 100% locally on this computer and owned by you. You can pin, correct, forget, or inspect why each note is remembered directly inside **Settings → Memory**.",
    "",
    'You can also remove a note in chat by saying "forget" with its code, for example "forget a1b2c3d4".',
    "",
    `File: \`${memoryFile}\``,
  ];
  if (memories.length === 0) lines.push("", "Nothing yet. This is a brand-new friendship.");
  for (const [kind, heading] of HEADINGS) {
    const group = memories
      .filter((memory) => memory.kind === kind)
      .sort(
        (a, b) =>
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          b.hits - a.hits ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    if (group.length === 0) continue;
    lines.push("", `## ${heading}`, "");
    for (const memory of group) {
      const when = memory.updatedAt.slice(0, 10);
      const pinBadge = memory.pinned ? "[PINNED] " : "";
      const source = inferMemorySource(memory);
      const byHerself = source === "learned" ? " _(picked up by herself)_" : "";
      if (kind === "topic" || kind === "skill") {
        const count =
          kind === "skill"
            ? `done ${memory.hits} time${memory.hits === 1 ? "" : "s"}`
            : `came up ${memory.hits} time${memory.hits === 1 ? "" : "s"}`;
        lines.push(`- ${pinBadge}**${memory.text}** [${memory.id}] (${count}, last on ${when})`);
        for (const point of memory.points) lines.push(`  - ${point}`);
      } else {
        lines.push(`- ${pinBadge}${memory.text} [${memory.id}] (${when})${byHerself}`);
      }
      lines.push(`  - _Why:_ ${explainWhyRemembered(memory)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
