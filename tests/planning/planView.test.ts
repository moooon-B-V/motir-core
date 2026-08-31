import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_LEVEL_MAX_NODES,
  PLAN_VIEW_PARAM,
  PLAN_VIEW_VALUES,
  defaultPlanView,
  planViewFromParam,
} from '@/lib/planning/planView';
import { TREE_LEVEL_MAX_TAKE } from '@/lib/planning/levelCaps';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { planContainerCount } from '@/lib/planning/planShape';
import { planReview, planReviewItem } from '../helpers/planReview';

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
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
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

// ── THE DERIVED DEFAULT, WIDENED (MOTIR-4024, design Part XIII §6) ────────────
//
// The shipped rule saw a plan SPREAD across containers and was blind to one
// CROWDED inside a single container — which looks identical to the reader and is
// worse, because the cards are somewhere on the level rather than honestly
// absent.
//
// ⚠️ THE NUMBER IS THE DESIGN'S. Part XIII §6 measured 24 arrival scales in
// Chromium and found that `ARRIVAL_MIN_SCALE = 0.80` is NOT REACHABLE on this
// surface at three of four viewports — the 22rem rail leaves the canvas 782px
// wide at 1440x900 against a 1000px world box, so a SIX-node level already
// arrives at 0.686. A predicate asking "does it clear the floor" answers *two
// nodes* and sends every plan to the list. 12 is the largest level still at the
// canvas's own ceiling at the tightest viewport.
describe('the ARRIVAL LEVEL’s size decides the default too (MOTIR-4024)', () => {
  const level = (size: number, over: Partial<PlanReviewDto> = {}) =>
    planReview([planReviewItem({ planItemId: 'a1', parentNodeId: 'epic-1' })], {
      arrivalLevelSize: size,
      arrivalLevelTotal: size,
      ...over,
    });

  it('opens on the CANVAS at the boundary — twelve nodes is still legible', () => {
    expect(defaultPlanView(level(ARRIVAL_LEVEL_MAX_NODES))).toBe('canvas');
  });

  it('opens on the LIST one node past it', () => {
    // A case on each side of the boundary, because a threshold off by one is
    // exactly what a coverage percentage cannot see.
    expect(defaultPlanView(level(ARRIVAL_LEVEL_MAX_NODES + 1))).toBe('list');
  });

  it('opens on the LIST when the level is TRUNCATED, whatever its drawn size', () => {
    // The second arm, and it is not about legibility at all: the level read sorts
    // key-ASCENDING and discards the HIGHEST keys — the most recently created
    // cards — and a `modify` / `remove` targets a committed work item, so the
    // cards a plan is most likely to be about are the ones truncation drops. The
    // drawn size is capped AT the cap, so only the total can say this happened.
    expect(
      defaultPlanView(
        level(TREE_LEVEL_MAX_TAKE, {
          arrivalLevelSize: TREE_LEVEL_MAX_TAKE,
          arrivalLevelTotal: TREE_LEVEL_MAX_TAKE + 1,
        }),
      ),
    ).toBe('list');
    // …and a level exactly AT the cap, untruncated, is only judged on its size.
    expect(
      defaultPlanView(
        level(TREE_LEVEL_MAX_TAKE, {
          arrivalLevelSize: TREE_LEVEL_MAX_TAKE,
          arrivalLevelTotal: TREE_LEVEL_MAX_TAKE,
        }),
      ),
    ).toBe('list'); // still a list — 200 nodes is far past the legibility arm
  });

  it('keeps Part IX §3’s container arm, unchanged and LAST', () => {
    // A plan spread across containers has no single level that can show it,
    // whatever any level's size is.
    const straddling = planReview(
      [
        planReviewItem({ planItemId: 'a1', parentNodeId: 'epic-1' }),
        planReviewItem({ planItemId: 'a2', parentNodeId: 'story-1' }),
      ],
      { arrivalLevelSize: 2, arrivalLevelTotal: 2 },
    );
    expect(defaultPlanView(straddling)).toBe('list');
  });

  it('is unchanged for a small, single-container plan — the case that must stay a canvas', () => {
    expect(defaultPlanView(level(3))).toBe('canvas');
  });
});
