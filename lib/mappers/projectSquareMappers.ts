import type { ProjectSquareCardDto, ProjectSquareStatsDto } from '@/lib/dto/projectSquare';
import type { ProjectDirectoryRow } from '@/lib/repositories/projectRepository';

// Prisma row → DTO conversion for the PROJECT SQUARE directory (Story 6.13 ·
// Subtask 6.13.2). The card projection keeps every internal project field
// (workspace id, access level, estimation config, …) from crossing the public
// boundary — the `ProjectSquareCardDto` shape doesn't carry them, so this
// mapper physically cannot emit them. The projection is structural, not a
// runtime omission.

/** Max length of the card description snippet (a bounded, lightweight card read). */
const DESCRIPTION_SNIPPET_MAX = 200;

/**
 * Derive a bounded plain-text card snippet from the authored
 * `publicOverviewMd` (the only public-safe description field, 6.12.3). Collapses
 * all whitespace runs to single spaces and truncates to
 * {@link DESCRIPTION_SNIPPET_MAX} chars with an ellipsis. Returns null when the
 * project authored no overview (or it is blank) — the card then shows no
 * description rather than an empty line.
 */
export function toDescriptionSnippet(publicOverviewMd: string | null): string | null {
  if (publicOverviewMd === null) return null;
  const collapsed = publicOverviewMd.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= DESCRIPTION_SNIPPET_MAX) return collapsed;
  return `${collapsed.slice(0, DESCRIPTION_SNIPPET_MAX).trimEnd()}…`;
}

/**
 * Map a directory row + its computed public stats → the square card projection.
 * The org name/slug ride on the joined row; the stats (upvotes total +
 * recent-activity timestamp) are computed by the service over the page's
 * project ids (no per-card N+1) and passed in.
 */
export function toProjectSquareCardDto(
  row: ProjectDirectoryRow,
  stats: ProjectSquareStatsDto,
): ProjectSquareCardDto {
  return {
    identifier: row.identifier,
    name: row.name,
    org: { name: row.org.name, slug: row.org.slug },
    description: toDescriptionSnippet(row.publicOverviewMd),
    stats,
  };
}
