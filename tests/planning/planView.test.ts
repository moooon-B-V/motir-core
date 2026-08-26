import { describe, expect, it } from 'vitest';
import {
  PLAN_VIEW_PARAM,
  PLAN_VIEW_VALUES,
  defaultPlanView,
  planViewFromParam,
} from '@/lib/planning/planView';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { planContainerCount } from '@/lib/planning/planShape';
import { planReviewItem } from '../helpers/planReview';

// MOTIR-3239 / MOTIR-3262 — the plan-detail view vocabulary, its URL parsing,
// and the DERIVED default.
//
// The seam MOTIR-3239 named is now filled: `defaultPlanView` answers Part IX §3's
// rule — the LIST when the plan's proposals sit under more than one distinct
// container, the canvas otherwise — reading the count from `planShape`, which is
// the one implementation of that question.
//
// ⚠️ `planViewFromParam` takes the RESOLVED default rather than the review, and
// that signature is the point: the default is a SEED for the arriving reader, and
// a `generating` plan's item set grows under a 2.5s poll. Passing a value the
// island pinned at mount makes "read once" structural instead of a rule somebody
// has to remember.

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
    revision: null,
    ...over,
  };
}

describe('planViewFromParam', () => {
  it('takes each member of the vocabulary', () => {
    for (const value of PLAN_VIEW_VALUES) {
      expect(planViewFromParam(value, 'canvas')).toBe(value);
    }
  });

  it('falls back to the DEFAULT for absent, empty, unknown and malformed values', () => {
    // The value comes from a URL a person can type; there is no reading on which
    // `?view=nonsense` is worth a failure.
    for (const raw of [undefined, null, '', 'nonsense', 'CANVAS', 'list ']) {
      expect(planViewFromParam(raw, 'list')).toBe('list');
      expect(planViewFromParam(raw, 'canvas')).toBe('canvas');
    }
  });

  it('a `?view=` value always WINS over the default, in both directions', () => {
    // Including against the default a straddling plan would otherwise get.
    expect(planViewFromParam('canvas', 'list')).toBe('canvas');
    expect(planViewFromParam('list', 'canvas')).toBe('list');
  });
});

describe('defaultPlanView — DERIVED from the plan’s shape (MOTIR-3262)', () => {
  const at = (id: string, parent: string | null) =>
    planReviewItem({ planItemId: id, nodeId: id, parentNodeId: parent });

  it('a plan under ONE container opens on the CANVAS', () => {
    expect(defaultPlanView(review({ items: [at('a', 'wi_p'), at('b', 'wi_p')] }))).toBe('canvas');
  });

  it('a plan that STRADDLES two containers opens on the LIST', () => {
    // No single canvas level can show it, and the canvas draws one level at a
    // time — opening on it would be the surface insisting on a view that
    // structurally cannot answer the question.
    expect(defaultPlanView(review({ items: [at('a', 'wi_story'), at('b', 'wi_epic')] }))).toBe(
      'list',
    );
  });

  it('a plan of PURE ROOTS opens on the canvas — the top level is ONE container', () => {
    // Part IX §3 settles this: `null` counts as a container rather than being
    // skipped, so a plan of roots does not read as straddling.
    expect(defaultPlanView(review({ items: [at('a', null), at('b', null)] }))).toBe('canvas');
  });

  it('a PROPOSED container counts too', () => {
    // A story under an epic plus subtasks under that story touches two
    // containers, one of which does not exist yet.
    const items = [
      planReviewItem({ planItemId: 's', nodeId: 's', parentNodeId: 'wi_epic' }),
      planReviewItem({ planItemId: 'x', nodeId: 'x', parentNodeId: 's', parentIdentifier: null }),
    ];
    expect(defaultPlanView(review({ items }))).toBe('list');
  });

  it('an EMPTY plan opens on the canvas', () => {
    expect(defaultPlanView(review({ items: [] }))).toBe('canvas');
  });

  it('reads the count from `planShape` rather than re-deriving it', () => {
    // The count has exactly one implementation after MOTIR-3262. Driving the two
    // through the same fixtures is what states that without asserting an
    // internal: they must agree for every shape.
    for (const items of [
      [at('a', 'wi_p')],
      [at('a', 'wi_p'), at('b', 'wi_q')],
      [at('a', null)],
      [],
    ]) {
      const expected = planContainerCount(items) > 1 ? 'list' : 'canvas';
      expect(defaultPlanView(review({ items }))).toBe(expected);
    }
  });
});

describe('the parameter name', () => {
  it('is `view`', () => {
    // Pinned because it is a public URL surface: a link written today must keep
    // resolving after any later change to how the default is computed.
    expect(PLAN_VIEW_PARAM).toBe('view');
  });
});
