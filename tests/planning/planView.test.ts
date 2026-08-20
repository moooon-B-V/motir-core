import { describe, expect, it } from 'vitest';
import {
  PLAN_VIEW_PARAM,
  PLAN_VIEW_VALUES,
  defaultPlanView,
  planViewFromParam,
} from '@/lib/planning/planView';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// MOTIR-3239 — the plan-detail view vocabulary, its URL parsing, and THE SEAM.
//
// ⚠️ The seam is the point of this file. `defaultPlanView` exists as a named,
// exported symbol so MOTIR-3262 can replace its BODY with the conditional
// straddle rule Part IX specifies. A literal buried in the URL-derivation ternary
// would make that card a rewrite of this card's logic, and the two would then
// both own the same expression. So what is pinned here is that the derivation
// GOES THROUGH the seam — not what the seam currently answers, which is expected
// to change exactly once.

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: 'A plan',
    summary: null,
    itemCount: 0,
    createdAt: '2026-08-20T00:00:00.000Z',
    plannedAt: '2026-08-20T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    ...over,
  };
}

describe('planViewFromParam', () => {
  it('takes each member of the vocabulary', () => {
    for (const value of PLAN_VIEW_VALUES) {
      expect(planViewFromParam(value, review())).toBe(value);
    }
  });

  it('falls back to the DEFAULT for absent, empty, unknown and malformed values', () => {
    // The value comes from a URL a person can type; there is no reading on which
    // `?view=nonsense` is worth a failure.
    for (const raw of [undefined, null, '', 'nonsense', 'CANVAS', 'list ']) {
      expect(planViewFromParam(raw, review())).toBe(defaultPlanView(review()));
    }
  });

  it('resolves the fallback THROUGH the seam, not through a literal', () => {
    // The assertion MOTIR-3262 depends on: swapping the seam's body must move the
    // no-parameter answer with it. Driving it through the exported symbol is the
    // only way to state that without asserting today's answer as if it were the
    // contract.
    const plan = review();
    expect(planViewFromParam(null, plan)).toBe(defaultPlanView(plan));
    expect(planViewFromParam('nonsense', plan)).toBe(defaultPlanView(plan));
  });

  it('a `?view=` value always WINS over the default, in both directions', () => {
    const plan = review();
    expect(planViewFromParam('list', plan)).toBe('list');
    expect(planViewFromParam('canvas', plan)).toBe('canvas');
  });
});

describe('defaultPlanView — today, the canvas for every plan', () => {
  it('is the canvas, whatever the plan holds', () => {
    // Today's behaviour, unchanged by this card. MOTIR-3262 replaces this with
    // the straddle rule; until then the answer must not vary, or this card would
    // have changed which view a reader lands in without deciding to.
    expect(defaultPlanView(review())).toBe('canvas');
    expect(defaultPlanView(review({ status: 'generating' }))).toBe('canvas');
    expect(defaultPlanView(review({ status: 'approved', itemCount: 12 }))).toBe('canvas');
  });
});

describe('the parameter name', () => {
  it('is `view`', () => {
    // Pinned because it is a public URL surface: a link written today must keep
    // resolving after any later change to how the default is computed.
    expect(PLAN_VIEW_PARAM).toBe('view');
  });
});
