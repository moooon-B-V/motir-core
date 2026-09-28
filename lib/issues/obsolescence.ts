// A work item's OBSOLESCENCE — whether the card is still TRUE OF THE CODE (Story
// MOTIR-6574 · MOTIR-6579). The SINGLE SOURCE OF TRUTH for the scale's members
// and their order, read by the service's validation and, later, the REST / MCP
// schemas, the filter facet and the pickers alike.
//
// WHY A SEPARATE PURE MODULE (the `difficulty.ts` precedent). It is typed against
// the DTO string union, not the Prisma enum, so a client-side picker and the
// filter builder can import it without dragging the generated Prisma client into
// their module graphs. The Prisma enum is named below as a TYPE-ONLY import,
// which the compiler erases — it exists here for the totality check alone.
//
// NO kind predicate lives here, deliberately (the ONE difference from
// `difficulty`): the mark is kind-agnostic, so every KIND of card may carry it.
//
// ONE STATUS predicate does (`canCarryObsolescence`, MOTIR-6575 · MOTIR-6663):
// both marks are a FINISHED card's state, so either is settable only on a card
// whose workflow-status CATEGORY is `done`. It is defined HERE, once, and every
// door that sets a mark — the direct work-item doors (MOTIR-6575) and the plan
// path (`lib/plans/validateProposedObsolescence.ts`) — asks it, so the doors can
// never disagree about what counts as finished.

import type { WorkItemObsolescence } from '@/generated/prisma/client';

import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

/**
 * Every `WorkItemObsolescence` member, mildest first — the order every picker and
 * filter facet renders: `outdated` (the text no longer describes the code; the
 * capability lives on in another shape) before `deprecated` (retired or overturned
 * on purpose — do not build on it).
 */
export const WORK_ITEM_OBSOLESCENCES = [
  'outdated',
  'deprecated',
] as const satisfies readonly WorkItemObsolescenceDto[];

// TOTALITY, both ways, at compile time: the list covers every DTO member, and
// the DTO union is exactly the Prisma enum. Adding a member on either side
// without the others fails `pnpm typecheck` on one of the two constants.
type ListedObsolescence = (typeof WORK_ITEM_OBSOLESCENCES)[number];
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _listCoversDto: Exactly<ListedObsolescence, WorkItemObsolescenceDto> = true;
const _dtoMatchesPrisma: Exactly<WorkItemObsolescenceDto, WorkItemObsolescence> = true;
void _listCoversDto;
void _dtoMatchesPrisma;

/** Narrow an unknown value (a query param, a JSON body) to an obsolescence. */
export function isWorkItemObsolescence(value: unknown): value is WorkItemObsolescenceDto {
  return (
    typeof value === 'string' && (WORK_ITEM_OBSOLESCENCES as readonly string[]).includes(value)
  );
}

/**
 * True when a card whose status sits in `statusCategory` may CARRY an
 * obsolescence mark — only the `done` category (so `done` and `cancelled` out of
 * the box, and any custom done-category status such as `shipped`). It reads the
 * CATEGORY, never a status key, because every project defines its own workflow.
 *
 * `null` / `undefined` — a status the project's workflow does not define — is
 * NOT finished: a card nobody can prove finished does not get a mark.
 */
export function canCarryObsolescence(
  statusCategory: StatusCategoryDto | null | undefined,
): boolean {
  return statusCategory === 'done';
}
