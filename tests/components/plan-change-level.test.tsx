// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { decoratePlanChangeLevel } from '@/components/planning/planChangeLevel';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// The DIFF layered onto a roadmap level (Subtask MOTIR-1730; design panel 4 —
// the review surface is the CANVAS). These assert the decoration, not the canvas:
// the level goes in as the SHIPPED work-item level and comes out with the diff
// chrome on the nodes the proposal touches, plus the proposed nodes themselves.

const LEVEL: RoadmapLevelData = {
  items: [
    {
      id: 'wi-12',
      parentId: null,
      identifier: 'PAY-12',
      title: 'Invoice model',
      kind: 'story',
      status: 'done',
      hasChildren: false,
    },
    {
      id: 'wi-21',
      parentId: null,
      identifier: 'PAY-21',
      title: 'Payment reminders',
      kind: 'task',
      status: 'todo',
      hasChildren: false,
    },
    {
      id: 'wi-14',
      parentId: null,
      identifier: 'PAY-14',
      title: 'Send invoice',
      kind: 'task',
      status: 'in_progress',
      hasChildren: false,
    },
  ],
  edges: [],
  offLevelBlockers: [],
};

const REVIEW: PlanReviewDto = planReview([
  planReviewItem({
    planItemId: 'pi_1',
    nodeId: 'pi_1',
    kind: 'story',
    title: 'Recurring invoices',
  }),
  planReviewItem({
    planItemId: 'pi_2',
    op: 'modify',
    nodeId: 'wi-21',
    identifier: 'PAY-21',
    title: 'Email reminders',
    changes: [{ field: 'title', from: 'Payment reminders', to: 'Email reminders' }],
  }),
  planReviewItem({
    planItemId: 'pi_3',
    op: 'remove',
    nodeId: 'wi-14',
    identifier: 'PAY-14',
    title: 'Send invoice',
  }),
]);

function decorate(review: PlanReviewDto | null) {
  return decoratePlanChangeLevel(buildWorkItemLevel(LEVEL), LEVEL, indexPlanReview(review), null);
}

afterEach(cleanup);

describe('decoratePlanChangeLevel', () => {
  it('returns the level UNTOUCHED when nothing is proposed', () => {
    const base = buildWorkItemLevel(LEVEL);
    const out = decoratePlanChangeLevel(base, LEVEL, indexPlanReview(null), null);
    expect(out).toBe(base);
  });

  it('appends the proposed item as its own node, drawn as an ADD', () => {
    const level = decorate(REVIEW);

    expect(level.nodes).toHaveLength(4);
    const proposed = level.nodes[3]!;
    expect(proposed.viewable).toBe(false);
    expect(proposed.searchText).toContain('Recurring invoices');

    renderWithIntl(<>{proposed.content}</>);
    expect(screen.getByTestId('plan-change-diff-node').getAttribute('data-diff-state')).toBe('add');
    expect(screen.getByText('Recurring invoices')).toBeTruthy();
    expect(screen.getByText('added')).toBeTruthy();
  });

  it('marks the updated item CHANGED and names what changed', () => {
    const level = decorate(REVIEW);
    const changed = level.nodes.find((n) => n.id === 'wi-21')!;

    renderWithIntl(<>{changed.content}</>);
    expect(screen.getByTestId('plan-change-diff-node').getAttribute('data-diff-state')).toBe(
      'change',
    );
    // Not colour alone: a glyph + the WORD, plus the field that moved.
    expect(screen.getByText('changed')).toBeTruthy();
    expect(screen.getByTestId('plan-change-fields').textContent).toBe('title');
    // The real shipped node is still what renders underneath — never redrawn.
    expect(screen.getByText('Payment reminders')).toBeTruthy();
  });

  it('LOCKS finished work, says why, and marks it aria-disabled', () => {
    const level = decorate(REVIEW);
    const locked = level.nodes.find((n) => n.id === 'wi-12')!;

    renderWithIntl(<>{locked.content}</>);
    const node = screen.getByTestId('plan-change-diff-node');
    expect(node.getAttribute('data-diff-state')).toBe('locked');
    expect(node.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('locked')).toBeTruthy();
    expect(screen.getByText("can't change")).toBeTruthy();
  });

  it('marks a REMOVED item with the danger frame, the word, and what happens on approve', () => {
    // The engine really emits `remove` proposals (`expandItem` / `replan`); the
    // delta contract this surface used to read had no op for them, so an item the
    // run proposed dropping was drawn as if untouched (design panel 4 draws it).
    const level = decorate(REVIEW);
    const removed = level.nodes.find((n) => n.id === 'wi-14')!;

    renderWithIntl(<>{removed.content}</>);
    expect(screen.getByTestId('plan-change-diff-node').getAttribute('data-diff-state')).toBe(
      'remove',
    );
    expect(screen.getByText('removed')).toBeTruthy();
    expect(screen.getByTestId('plan-change-fields').textContent).toBe('goes on approve');
    // The real shipped node still renders underneath — struck, never redrawn.
    expect(screen.getByText('Send invoice')).toBeTruthy();
  });

  it('leaves an untouched, unfinished item with no diff chrome at all', () => {
    const level = decoratePlanChangeLevel(
      buildWorkItemLevel(LEVEL),
      LEVEL,
      indexPlanReview(planReview([planReviewItem({ nodeId: 'pi_only' })])),
      null,
    );
    const plain = level.nodes.find((n) => n.id === 'wi-14')!;

    renderWithIntl(<>{plain.content}</>);
    expect(screen.queryByTestId('plan-change-diff-node')).toBeNull();
    expect(screen.getByText('Send invoice')).toBeTruthy();
  });

  it('places a proposal parented on an EXISTING item on that item’s level only', () => {
    const index = indexPlanReview(
      planReview([
        planReviewItem({
          planItemId: 'pi_9',
          nodeId: 'pi_9',
          parentNodeId: 'wi-21',
          kind: 'subtask',
          title: 'Monthly schedule',
        }),
      ]),
    );

    const top = decoratePlanChangeLevel(buildWorkItemLevel(LEVEL), LEVEL, index, null);
    expect(top.nodes).toHaveLength(3);

    const inside = decoratePlanChangeLevel(buildWorkItemLevel(LEVEL), LEVEL, index, 'wi-21');
    expect(inside.nodes).toHaveLength(4);
    expect(inside.nodes[3]!.parentId).toBe('wi-21');

    // …and the CHILDLESS item it hangs under becomes drillable, or the proposal
    // would be unreachable — "propose work under an existing story" is the
    // commonest thing the engine does.
    expect(top.nodes.find((n) => n.id === 'wi-21')!.drillable).toBe(true);
    expect(top.nodes.find((n) => n.id === 'wi-14')!.drillable).toBeFalsy();
  });
});

// ── MOTIR-3162 (bug MOTIR-3154) — ONE decided language across BOTH canvases ──
//
// The workspace canvas draws through `decoratePlanChangeLevel` and the plan
// detail through `mergePlanLevel`; they are different paths to the same product
// promise. `ProposedAddNode` already reuses the shipped `PlanItemNode`, so
// threading the outcome makes the two agree BY CONSTRUCTION rather than by a
// second implementation that has to be kept in step.
describe('decoratePlanChangeLevel — the decided outcome', () => {
  const withProposal = indexPlanReview(
    planReview([
      planReviewItem({
        planItemId: 'pi_new',
        nodeId: 'pi_new',
        parentNodeId: null,
        title: 'A proposed card',
      }),
      planReviewItem({
        planItemId: 'pi_mod',
        nodeId: 'wi-21',
        op: 'modify',
        identifier: 'PAY-21',
        title: 'Payment reminders',
      }),
    ]),
  );

  it('draws NOTHING decided while the plan is still pending', () => {
    const level = decoratePlanChangeLevel(buildWorkItemLevel(LEVEL), LEVEL, withProposal, null);
    const proposed = level.nodes.find((n) => n.id.endsWith('pi_new'))!;
    renderWithIntl(<>{proposed.content}</>);
    expect(screen.queryByTestId('plan-change-outcome')).toBeNull();
    expect(screen.queryByTestId('plan-item-outcome')).toBeNull();
  });

  it.each(['accepted', 'declined'] as const)(
    'names the %s outcome on a PROPOSED add',
    (outcome) => {
      const level = decoratePlanChangeLevel(
        buildWorkItemLevel(LEVEL),
        LEVEL,
        withProposal,
        null,
        outcome,
      );
      const proposed = level.nodes.find((n) => n.id.endsWith('pi_new'))!;
      renderWithIntl(<>{proposed.content}</>);

      // The frame says it AND the node inside says it — and the node's chip is the
      // SHIPPED `PlanItemNode` one from MOTIR-3161, reused verbatim. That is what
      // makes "one language across both canvases" true rather than asserted.
      expect(screen.getByTestId('plan-change-outcome').textContent).toBe(outcome);
      expect(screen.getByTestId('plan-item-outcome').textContent).toBe(outcome);
    },
  );

  it('names the outcome on a CHANGED committed node too', () => {
    const level = decoratePlanChangeLevel(
      buildWorkItemLevel(LEVEL),
      LEVEL,
      withProposal,
      null,
      'accepted',
    );
    const changed = level.nodes.find((n) => n.id === 'wi-21')!;
    renderWithIntl(<>{changed.content}</>);
    expect(screen.getByTestId('plan-change-outcome').textContent).toBe('accepted');
  });
});

// ── A MATERIALIZED add lands ON its card (bug MOTIR-3206) ───────────────────
//
// MOTIR-3162 made the overlay outlive the decision, and this module kept keying
// every `add` as a synthetic `proposed:` node — an id that can never match a
// work item. So the level read returned the newly created card AND the overlay
// appended a keyless copy of it: every accepted card drawn twice, which is the
// duplicate `design/ai-planning/design-notes.md` Part VI §3 rules out in the
// same sentence that gives an accepted add its real key.
describe('decoratePlanChangeLevel — a DECIDED add', () => {
  // The level AFTER the approve: `materialize` created the card, so the
  // per-level read now returns it beside the ones that were already there.
  const LEVEL_AFTER: RoadmapLevelData = {
    ...LEVEL,
    items: [
      ...LEVEL.items,
      {
        id: 'wi-90',
        parentId: null,
        identifier: 'PAY-90',
        title: 'Recurring invoices',
        kind: 'story',
        status: 'todo',
        hasChildren: false,
      },
    ],
  };

  /** The re-read review: `getPlanReview` keys the materialized add by the work
   *  item it became and fills in its identifier (MOTIR-3160). */
  const ACCEPTED: PlanReviewDto = planReview([
    planReviewItem({
      planItemId: 'pi_1',
      nodeId: 'wi-90',
      identifier: 'PAY-90',
      kind: 'story',
      title: 'Recurring invoices',
      status: 'todo',
    }),
  ]);

  it('merges onto the committed node instead of drawing a second copy', () => {
    const level = decoratePlanChangeLevel(
      buildWorkItemLevel(LEVEL_AFTER),
      LEVEL_AFTER,
      indexPlanReview(ACCEPTED),
      null,
      'accepted',
    );

    // FOUR nodes, not five: the card is on the canvas exactly once.
    expect(level.nodes).toHaveLength(4);
    expect(level.nodes.filter((n) => n.id.startsWith('proposed:'))).toHaveLength(0);
    expect(level.nodes.filter((n) => n.searchText.includes('Recurring invoices'))).toHaveLength(1);
  });

  it('wears the add frame and the accepted word, over the REAL card', () => {
    const level = decoratePlanChangeLevel(
      buildWorkItemLevel(LEVEL_AFTER),
      LEVEL_AFTER,
      indexPlanReview(ACCEPTED),
      null,
      'accepted',
    );
    const merged = level.nodes.find((n) => n.id === 'wi-90')!;
    // It keeps the committed node's own affordances — it IS a work item now.
    expect(merged.viewable).toBe(true);

    renderWithIntl(<>{merged.content}</>);
    expect(screen.getByTestId('plan-change-diff-node').getAttribute('data-diff-state')).toBe('add');
    expect(screen.getByTestId('plan-change-outcome').textContent).toBe('accepted');
    // The real key is what Part VI §3 calls the strongest accepted signal, and
    // it is on screen because the node underneath is the shipped work-item one.
    expect(screen.getByText('PAY-90')).toBeTruthy();
  });

  it('leaves a DECLINED add as a ghost — it never became anything', () => {
    // A decline materializes nothing, so the review keeps a null identifier and
    // the add must stay a synthetic node: inventing a key for it would assert a
    // work item that does not exist (Part VI §3).
    const level = decoratePlanChangeLevel(
      buildWorkItemLevel(LEVEL),
      LEVEL,
      indexPlanReview(REVIEW),
      null,
      'declined',
    );
    expect(level.nodes.filter((n) => n.id.startsWith('proposed:'))).toHaveLength(1);
  });
});
