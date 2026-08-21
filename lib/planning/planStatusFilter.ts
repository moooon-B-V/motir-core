import { PLAN_STATUS_DTO_VALUES, type PlanStatusDto } from '@/lib/dto/plans';

// WHICH TAB the Plans list is showing — the query parameter and its parser
// (MOTIR-3241, `design/ai-planning/design-notes.md` Part VII §4).
//
// ⚠️ IT LIVES HERE, NOT IN `PlanStatusTabs.tsx`, AND THAT IS A CORRECTNESS
// CONSTRAINT RATHER THAN TIDINESS (MOTIR-3243). `PlanStatusTabs.tsx` is a
// `'use client'` module, and the boundary is a property of the MODULE, not of
// the declaration: every export of a client module becomes a client REFERENCE,
// so a Server Component that imports even a pure `string → string` function
// from one gets a proxy and dies on call —
//
//   Attempted to call planStatusFromParam() from the server but
//   planStatusFromParam is on the client.
//
// — which is a 500 on `/plans`, on every request, for a page whose whole job is
// to read this parameter. It is invisible to a component test (which imports the
// module directly, with no boundary in play) and to a type-check, and it was
// found by the story's own browser E2E.
//
// `lib/planning/planView.ts` is the precedent and the pattern: the plan detail's
// `?view=` vocabulary is a pure module for exactly this reason, consumed by both
// sides. This is the same decision, one surface over.
//
// THE URL IS THE SINGLE SOURCE OF TRUTH for the tab in view, exactly as
// `ChildPanel`'s `?children=` is — the page derives it on every render, so a deep
// link, a reload and browser Back/forward all agree, and no local state can
// disagree with the address bar.

/** The query parameter that carries the chosen status. */
export const PLAN_STATUS_PARAM = 'status';

/**
 * The tab a URL selects.
 *
 * `planned` — the plans awaiting a decision — is the DEFAULT, and it writes a
 * CLEAN url with no parameter, so every existing link to `/plans` stays
 * byte-identical and the two spellings are never two addresses for one view.
 *
 * Unknown / absent / malformed → the default, never an error: the value comes
 * from a URL a person can type, and there is no reading on which
 * `?status=nonsense` is worth a failure.
 */
export function planStatusFromParam(raw: string | null | undefined): PlanStatusDto {
  return (PLAN_STATUS_DTO_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as PlanStatusDto)
    : 'planned';
}
