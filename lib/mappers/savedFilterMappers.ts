import type { SavedFilter } from '@prisma/client';
import type { BuiltinFilterDef } from '@/lib/savedFilters/builtins';
import { builtinFilterId } from '@/lib/savedFilters/builtins';
import type { BuiltinFilterSummaryDto, SavedFilterSummaryDto } from '@/lib/dto/savedFilters';

// Prisma → DTO converters for saved filters (Story 6.2 · Subtask 6.2.1).
// Drops workspaceId/projectId (implicit in the route), nameLower (a server-
// side uniqueness key), and the raw astEnvelope (the resolve read decodes it
// — list rows never ship the envelope; finding #57 keeps list payloads lean).

/** The repository's list/detail row shape: the row plus the SQL-aggregated
 * star facts (`_count` over stars + the actor's own star, fetched in the
 * same query — never a JS aggregation over all rows). */
export interface SavedFilterWithStars extends SavedFilter {
  owner: { id: string; name: string };
  _count: { stars: number };
  stars: Array<{ userId: string }>;
}

export function toSavedFilterSummaryDto(row: SavedFilterWithStars): SavedFilterSummaryDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    owner: { id: row.owner.id, name: row.owner.name },
    starCount: row._count.stars,
    starredByMe: row.stars.length > 0,
    builtin: false,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toBuiltinFilterSummaryDto(def: BuiltinFilterDef): BuiltinFilterSummaryDto {
  return { id: builtinFilterId(def.slug), name: def.name, builtin: true };
}
