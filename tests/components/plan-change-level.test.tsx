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
