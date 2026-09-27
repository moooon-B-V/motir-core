// The obsolescence NOTE's first line (Story MOTIR-6574 · MOTIR-6582, moved here by
// MOTIR-6632). PURE and import-free on purpose: the MCP text blocks print it
// (`lib/mcp/obsolescence.ts` re-exports it), and the plan review's list row and
// canvas card draw it in the browser (`design/ai-planning/design-notes.md` Part XXIV
// §24.6) — a module that pulls in the Prisma client cannot ship to a client bundle,
// so the one definition lives where both can reach it.

/** The note's first non-blank line, trimmed — what a text block prints and what a
 *  one-line surface shows. `null` for a null or all-blank note. */
export function firstLine(noteMd: string | null): string | null {
  if (noteMd === null) return null;
  const line = noteMd
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? null;
}
