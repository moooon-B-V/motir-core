// A motir-core-side copy of `extractScopeBoundary`'s algorithm, as a TEST helper,
// because motir-core cannot import motir-ai. SOURCE IT MIRRORS: `motir-ai`
// `src/llm/authorSession.ts` (`SCOPE_BOUNDARY_HEADING` + `extractScopeBoundary`) —
// case-insensitive, any heading level, running to the next heading of the same or
// higher level.
const SCOPE_BOUNDARY_HEADING = 'Scope BOUNDARY';

export function extractScopeBoundary(body: string | null | undefined): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  const lines = body.split('\n');
  const wanted = SCOPE_BOUNDARY_HEADING.trim().toLowerCase();
  let depth = 0;
  let from = -1;
  for (const [i, line] of lines.entries()) {
    const head = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!head) continue;
    const level = head[1]!.length;
    if (from < 0) {
      if (head[2]!.toLowerCase() === wanted) {
        depth = level;
        from = i + 1;
      }
      continue;
    }
    if (level <= depth) return lines.slice(from, i).join('\n').trim() || null;
  }
  return from < 0 ? null : lines.slice(from).join('\n').trim() || null;
}
