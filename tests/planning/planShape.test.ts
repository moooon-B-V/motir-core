import { describe, expect, it } from 'vitest';
import { fullestContainer, planContainerCount, planContainers } from '@/lib/planning/planShape';
import { planReviewItem } from '../helpers/planReview';

// MOTIR-3260 — the pure container-spread module (`design/ai-planning/design-notes.md`
// Part IX §1 and §3).
//
// A plan is not a tree; it is a SCATTER of proposals across somebody else's tree.
// Two surfaces reason about that scatter — the canvas picks the level it most
// FILLS, and the plan detail asks whether it STRADDLES — and this module is the
// one implementation of both questions.
//
// ⚠️ THE CASE THIS FILE EXISTS FOR: a PROPOSED container counts. The shipped
// `arrivalLevel` skipped any item without a `parentIdentifier`, and
// `getPlanReview` sets that field to null for an intra-plan (`planItem:`) parent
// — deliberately — so the count discarded exactly the items the null describes.

/** A committed epic with one proposed story under it, and `n` subtasks under
 *  that story by intra-plan ref. The shape the whole card is about. */
function storyAndSubtasks(n: number) {
  const story = planReviewItem({
    planItemId: 'pi_story',
    nodeId: 'pi_story',
    op: 'add',
    title: 'Payout reconciliation',
    kind: 'story',
    // Committed parent — the epic.
    parentNodeId: 'wi_epic',
    parentIdentifier: 'MOTIR-653',
    parentTitle: 'Epic 8',
    parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
  });
  const subtasks = Array.from({ length: n }, (_, i) =>
    planReviewItem({
      planItemId: `pi_sub_${i}`,
      nodeId: `pi_sub_${i}`,
      op: 'add',
      title: `Subtask ${i}`,
      kind: 'subtask',
      // An intra-plan parent: `parentNodeId` populated, `parentIdentifier` NULL.
      parentNodeId: 'pi_story',
      parentIdentifier: null,
      parentTitle: null,
      parentTrail: [],
    }),
  );
  return [story, ...subtasks];
}

describe('planContainers — a PROPOSED container counts', () => {
  it('counts proposals under a proposed parent, which the shipped rule discarded', () => {
    const containers = planContainers(storyAndSubtasks(5));

    // Most-filled first: the proposed story holds five, the committed epic one.
    expect(containers[0]!.parentNodeId).toBe('pi_story');
    expect(containers[0]!.count).toBe(5);
    expect(containers[1]!.parentNodeId).toBe('wi_epic');
    expect(containers[1]!.count).toBe(1);
  });

  it('counts the TOP LEVEL as a container, keyed null', () => {
    // Part IX §3: a plan of pure roots has exactly ONE container, so it does not
    // straddle. That is only true if `null` is a key rather than skipped.
    const roots = [
      planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: null }),
      planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: null }),
    ];

    expect(planContainers(roots)).toEqual([{ parentNodeId: null, count: 2, depth: 0 }]);
    expect(planContainerCount(roots)).toBe(1);
  });

  it('an empty plan has no containers', () => {
    expect(planContainers([])).toEqual([]);
    expect(planContainerCount([])).toBe(0);
    expect(fullestContainer([])).toBeNull();
  });
});

describe('the TIE-BREAK is the DEEPER level (Part IX §1.2)', () => {
  it('prefers the deeper container when two hold the same count', () => {
    // One story under an epic plus one subtask under that story is 1–1. The
    // shipped code kept whichever the `Map` yielded first — an accident of
    // insertion order. A reviewer wants to land where the work is.
    const items = storyAndSubtasks(1);

    expect(fullestContainer(items)!.parentNodeId).toBe('pi_story');
  });

  it('and does so REGARDLESS of insertion order', () => {
    // The assertion that stops it silently reverting to Map iteration order.
    const items = storyAndSubtasks(1);
    const reversed = [...items].reverse();

    expect(fullestContainer(reversed)!.parentNodeId).toBe('pi_story');
  });

  it('COUNT still outranks depth', () => {
    // Depth breaks a tie; it does not win one. A committed parent holding three
    // beats a proposed one holding two, however deep the second sits.
    const items = [
      ...storyAndSubtasks(2),
      planReviewItem({
        planItemId: 'x1',
        nodeId: 'x1',
        parentNodeId: 'wi_epic',
        parentIdentifier: 'MOTIR-653',
        parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
      }),
      planReviewItem({
        planItemId: 'x2',
        nodeId: 'x2',
        parentNodeId: 'wi_epic',
        parentIdentifier: 'MOTIR-653',
        parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
      }),
    ];

    // The epic now holds three (the story + x1 + x2), the proposed story two.
    expect(fullestContainer(items)!.parentNodeId).toBe('wi_epic');
  });
});

describe('depth walks the whole proposal chain', () => {
  it('a container nested TWO proposals deep is deeper than one nested one', () => {
    const epic = planReviewItem({
      planItemId: 'pi_epic',
      nodeId: 'pi_epic',
      op: 'add',
      parentNodeId: null,
      parentTrail: [],
    });
    const story = planReviewItem({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      parentNodeId: 'pi_epic',
      parentIdentifier: null,
      parentTrail: [],
    });
    const sub = planReviewItem({
      planItemId: 'pi_sub',
      nodeId: 'pi_sub',
      op: 'add',
      parentNodeId: 'pi_story',
      parentIdentifier: null,
      parentTrail: [],
    });

    const containers = planContainers([epic, story, sub]);
    const depthOf = (id: string | null) => containers.find((c) => c.parentNodeId === id)!.depth;

    expect(depthOf('pi_story')).toBeGreaterThan(depthOf('pi_epic'));
    expect(depthOf(null)).toBe(0);
  });

  it('a committed ancestor NOBODY names directly still terminates the walk', () => {
    // Reached when the chain climbs THROUGH a proposal into a committed
    // container that no item names as its own `parentNodeId` — the proposal
    // above it carries the trail instead. The walk must end with a depth rather
    // than looking for a namer that is not there.
    const story = planReviewItem({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      parentNodeId: 'wi_unnamed',
      parentIdentifier: null,
      parentTitle: null,
      parentTrail: [],
    });
    const sub = planReviewItem({
      planItemId: 'pi_sub',
      nodeId: 'pi_sub',
      op: 'add',
      parentNodeId: 'pi_story',
      parentIdentifier: null,
      parentTrail: [],
    });

    const containers = planContainers([story, sub]);
    const committed = containers.find((c) => c.parentNodeId === 'wi_unnamed')!;

    expect(committed.depth).toBeGreaterThan(0);
    expect(planContainerCount([story, sub])).toBe(2);
  });

  it('a cycle cannot hang the walk', () => {
    // The DTO cannot produce one, but a pure function that walks a graph should
    // not depend on that for termination.
    const a = planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: 'b' });
    const b = planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: 'a' });

    expect(() => planContainers([a, b])).not.toThrow();
  });
});

describe('planContainerCount — what MOTIR-3262 reads', () => {
  it('is ONE for a plan that lives under a single committed parent', () => {
    const items = [
      planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: 'wi_p' }),
      planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: 'wi_p' }),
    ];

    expect(planContainerCount(items)).toBe(1);
  });

  it('is TWO for a plan that straddles — the case the list view is the honest default for', () => {
    const items = [
      planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: 'wi_story' }),
      planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: 'wi_story' }),
      planReviewItem({ planItemId: 'c', nodeId: 'c', parentNodeId: 'wi_epic' }),
    ];

    expect(planContainerCount(items)).toBe(2);
  });
});

describe('fullestContainer', () => {
  it('is null for a plan that lives entirely at the TOP level', () => {
    // There is no level to arrive at — the canvas opens at the top, which is
    // where it already is.
    const roots = [planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: null })];

    expect(fullestContainer(roots)).toBeNull();
  });
});
