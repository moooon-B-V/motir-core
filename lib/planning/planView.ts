import type { PlanReviewDto } from '@/lib/dto/planReview';
import { planContainerCount } from '@/lib/planning/planShape';

// WHICH BODY the plan-detail pane shows — the canvas or the list (MOTIR-3239,
// `design/ai-planning/design-notes.md` Part VIII).
//
// A canvas is the right way to see SHAPE: where a proposal lands, what it hangs
// under, what blocks what. It is a poor way to answer *"what exactly am I
// approving?"*, which is a question about a SET — these cards get created, these
// get changed, this one gets archived. The work-item detail already learned this
// and shipped a List ↔ Graph switcher on its Children section; the plan detail is
// the same reader asking the same question about a different tree.
//
// This module is deliberately PURE and separate from the island: it holds the
// vocabulary, the URL parsing, and — the reason it exists at all — the DEFAULT,
// as one named symbol.

export type PlanViewDto = 'canvas' | 'list';

/** The query parameter that carries the chosen view. */
export const PLAN_VIEW_PARAM = 'view';

export const PLAN_VIEW_VALUES = ['canvas', 'list'] as const satisfies readonly PlanViewDto[];

/**
 * WHICH VIEW a plan opens in when the URL says nothing — DERIVED from the plan's
 * own shape (MOTIR-3262, `design/ai-planning/design-notes.md` Part IX §3).
 *
 * **The canvas when the plan lives on one level; the LIST when its proposals sit
 * under MORE THAN ONE distinct container.**
 *
 * A straddling plan has no single canvas level that can show it — the canvas
 * draws one level at a time — so opening on it is the surface insisting on a view
 * that structurally cannot answer the question the reader came with. The list
 * already exists by then, and making it the default in that one case is the
 * cheapest of Part IX's three fixes and the one that admits the most.
 *
 * WHAT COUNTS AS A CONTAINER is `planShape`'s answer, not a second one: a
 * distinct `parentNodeId`, whether that parent is committed or itself proposed,
 * with **`null` — a root proposal — counting as ONE container, the top level**.
 * So a plan of pure roots has exactly one and opens on the canvas. There is no
 * second implementation of that question after this card.
 *
 * ⚠️ THIS IS A SEED, READ ONCE, and the island reads it on every render only
 * because the URL is the source of truth and this is its fallback. A `generating`
 * plan can cross the one-container threshold WHILE a reviewer is looking at it —
 * the detail re-fetches every 2.5s — and a reader must never be moved between
 * views by a poll tick. `PlanDetail` pins the first answer for that reason.
 *
 * The property that survives from MOTIR-3239 unchanged is the CLEAN URL: the
 * default writes no query parameter, whatever the default is, so every existing
 * `/plans/[id]` link stays byte-identical.
 */
export function defaultPlanView(review: PlanReviewDto): PlanViewDto {
  return planContainerCount(review.items) > 1 ? 'list' : 'canvas';
}

/**
 * The view a URL selects, falling back to a default the CALLER has already
 * resolved.
 *
 * ⚠️ IT TAKES THE RESOLVED DEFAULT, NOT THE REVIEW (MOTIR-3262). The default is a
 * SEED — the answer for the reader arriving — and a `generating` plan's item set
 * grows under a 2.5s poll, so recomputing it on every render would move a
 * reviewer between views mid-read. The island computes `defaultPlanView` ONCE at
 * mount and passes that value here, which makes "read once" structural rather
 * than a rule somebody has to remember.
 *
 * Unknown, absent and malformed values all take the default rather than erroring
 * — the value comes from a URL a person can type, and there is no reading on
 * which `?view=nonsense` is worth a failure.
 */
export function planViewFromParam(
  raw: string | null | undefined,
  fallback: PlanViewDto,
): PlanViewDto {
  return (PLAN_VIEW_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as PlanViewDto)
    : fallback;
}
