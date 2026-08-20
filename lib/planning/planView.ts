import type { PlanReviewDto } from '@/lib/dto/planReview';

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
 * WHICH VIEW a plan opens in when the URL says nothing.
 *
 * ⚠️ THIS IS A NAMED SEAM, AND THAT IS ITS WHOLE POINT (MOTIR-3239 → MOTIR-3262).
 * Today the answer is `canvas` for every plan — today's behaviour, unchanged.
 * MOTIR-3262 replaces THIS FUNCTION'S BODY with the conditional rule Part IX
 * specifies (the list when the plan's proposals straddle more than one distinct
 * container, the canvas otherwise), reading the container count from the pure
 * plan-shape module MOTIR-3260 ships.
 *
 * It takes the `review` it does not yet read for exactly that reason: a literal
 * buried in the URL-derivation ternary would make that card a rewrite of this
 * card's logic instead of a one-symbol swap, and the two cards would then both
 * own the same expression.
 *
 * The property that must survive the swap is the CLEAN URL: the default writes no
 * query parameter, whatever the default is, so every existing `/plans/[id]` link
 * stays byte-identical.
 */
export function defaultPlanView(_review: PlanReviewDto): PlanViewDto {
  return 'canvas';
}

/**
 * The view a URL selects, falling back to {@link defaultPlanView}.
 *
 * Unknown, absent and malformed values all take the default rather than erroring
 * — the value comes from a URL a person can type, and there is no reading on
 * which `?view=nonsense` is worth a failure.
 */
export function planViewFromParam(
  raw: string | null | undefined,
  review: PlanReviewDto,
): PlanViewDto {
  return (PLAN_VIEW_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as PlanViewDto)
    : defaultPlanView(review);
}
