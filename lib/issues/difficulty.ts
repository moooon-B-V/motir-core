// A leaf's DIFFICULTY — how hard the work is to REASON about (Story MOTIR-6016 ·
// MOTIR-6096). The SINGLE SOURCE OF TRUTH for the scale's members and their
// order, read by the service's validation, the REST / MCP schemas, the filter
// facet and the pickers alike.
//
// WHY A SEPARATE PURE MODULE (the executorDefaults.ts precedent). It is typed
// against the DTO string union, not the Prisma enum, so the client-side picker
// and the filter builder can import it without dragging the generated Prisma client into
// their module graphs. The Prisma enum is named below as a TYPE-ONLY import,
// which the compiler erases — it exists here for the totality check alone.
//
// Leaf-only is NOT decided here: it is `isTypeableKind` (executorDefaults.ts),
// the same predicate `type` and `executor` use, so every leaf field agrees on
// which rows may carry it.

import type { WorkItemDifficulty } from '@/generated/prisma/client';

import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';

/**
 * Every `WorkItemDifficulty` member, easiest first — the order every picker
 * and filter facet renders.
 */
export const WORK_ITEM_DIFFICULTIES = [
  'low',
  'medium',
  'high',
] as const satisfies readonly WorkItemDifficultyDto[];

// TOTALITY, both ways, at compile time: the list covers every DTO member, and
// the DTO union is exactly the Prisma enum. Adding a member on either side
// without the others fails `pnpm typecheck` on one of the two constants.
type ListedDifficulty = (typeof WORK_ITEM_DIFFICULTIES)[number];
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _listCoversDto: Exactly<ListedDifficulty, WorkItemDifficultyDto> = true;
const _dtoMatchesPrisma: Exactly<WorkItemDifficultyDto, WorkItemDifficulty> = true;
void _listCoversDto;
void _dtoMatchesPrisma;

/** Narrow an unknown value (a query param, a JSON body) to a difficulty. */
export function isWorkItemDifficulty(value: unknown): value is WorkItemDifficultyDto {
  return typeof value === 'string' && (WORK_ITEM_DIFFICULTIES as readonly string[]).includes(value);
}
