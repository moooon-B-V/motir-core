// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { followFromPlan, followFromTarget, followRequest } from '@/lib/planning/surfaceFollow';
import { planReview, planReviewItem } from '../helpers/planReview';

// THE FOLLOW-MOVE's TRIGGERS (MOTIR-6161, Story MOTIR-6154). The decision is a
// pure module precisely so the two triggers' precedence is one statement that can
// be ruled on, rather than an ordering that emerges from two effects.

const EPIC = { id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' };

describe('followFromTarget — the person ADDED a target', () => {
  it('turns the anchor read into a keyed request, through the arrival rule', () => {
    const req = followFromTarget({
      anchor: { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story', kind: 'story' },
      ancestors: [EPIC],
    });

    // The SAME rule the surface arrived by — not a second answer to "where does
    // this target put the canvas".
    expect(req?.trail.map((c) => c.id)).toEqual(['wi_1', 'wi_3']);
    // Keyed on the target, so re-deriving it cannot ask for a second move.
    expect(req?.key).toBe('target:wi_3');
  });

  it('asks for NOTHING when the target cannot be seen', () => {
    // The no-existence-leak answer. A target the viewer cannot see degrades to
    // the root silently at arrival, and to no move at all here — never an error,
    // and never a move to a level that would be empty.
    expect(followFromTarget(null)).toBeNull();
  });

  it('asks for NOTHING when the trail would be empty', () => {
    // A `subtask` at the root of what the reader can see produces no trail, and a
    // move to the root is not a move.
    expect(
      followFromTarget({
        anchor: { id: 'wi_9', identifier: 'MOTIR-9', title: 'A subtask', kind: 'subtask' },
        ancestors: [],
      }),
    ).toBeNull();
  });
});

describe('followFromPlan — the plan showed where it LANDS', () => {
  it('asks for the level the plan most fills, keyed on that level', () => {
    const review = planReview([
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_1',
        parentIdentifier: 'MOTIR-1',
        parentTitle: 'Refine AI planning',
        parentTrail: [{ id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' }],
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: 'wi_1',
        parentIdentifier: 'MOTIR-1',
        parentTitle: 'Refine AI planning',
        parentTrail: [{ id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' }],
      }),
    ]);

    const req = followFromPlan(review, 'New');
    expect(req?.key).toBe('plan:wi_1');
    expect(req?.trail.at(-1)?.id).toBe('wi_1');
  });

  it('asks for NOTHING before there is a plan', () => {
    expect(followFromPlan(null, 'New')).toBeNull();
  });

  it('asks for NOTHING when the plan proposes only roots', () => {
    // A plan that names no container lands at the top level, which is where a
    // target-less surface already is — so there is no move, and nothing to
    // announce. The canvas is not asked to "move" to where it stands.
    const review = planReview([planReviewItem({ op: 'add', nodeId: 'p1', parentNodeId: null })]);
    expect(followFromPlan(review, 'New')).toBeNull();
  });
});

describe('followRequest — the FIRST to fire wins', () => {
  const fromTarget = { key: 'target:wi_3', trail: [{ id: 'wi_3', label: 'MOTIR-3 · The story' }] };
  const fromPlan = { key: 'plan:wi_1', trail: [{ id: 'wi_1', label: 'MOTIR-1 · The epic' }] };

  it('prefers the person’s own act over an inference about it', () => {
    expect(followRequest(fromTarget, fromPlan)).toBe(fromTarget);
  });

  it('falls to the plan when no target was added', () => {
    expect(followRequest(null, fromPlan)).toBe(fromPlan);
  });

  it('asks for nothing when neither fired', () => {
    expect(followRequest(null, null)).toBeNull();
  });
});
