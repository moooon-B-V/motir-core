// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { decorateTargetLevel } from '@/components/planning/PlanningTargetNode';
import { decoratePlanChangeLevel } from '@/components/planning/planChangeLevel';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// The TARGET ring layered onto a roadmap level (Subtask MOTIR-1491; design
// `target-picker.mock.html` panels 3 + 5 — "the canvas highlights the target").
// Like the diff decoration it wraps the SHIPPED node rather than redrawing one,
// so these assert the layering, not the canvas.

const LEVEL: RoadmapLevelData = {
  items: [
    {
      id: 'wi-812',
      parentId: null,
      identifier: 'PAY-812',
      title: 'Billing — invoicing',
      kind: 'story',
      status: 'todo',
      hasChildren: true,
    },
    {
      id: 'wi-511',
      parentId: null,
      identifier: 'PAY-511',
      title: 'Auth module',
      kind: 'story',
      status: 'done',
      hasChildren: false,
    },
  ],
  edges: [],
  offLevelBlockers: [],
};

const REVIEW: PlanReviewDto = planReview([
  planReviewItem({
    op: 'modify',
    nodeId: 'wi-812',
    identifier: 'PAY-812',
    title: 'Billing — invoices',
    changes: [{ field: 'title', from: 'Billing — invoicing', to: 'Billing — invoices' }],
  }),
]);

function renderNode(nodeId: string, targetIds: string[], review: PlanReviewDto | null = null) {
  const base = decoratePlanChangeLevel(
    buildWorkItemLevel(LEVEL),
    LEVEL,
    indexPlanReview(review),
    null,
  );
  const level = decorateTargetLevel(base, targetIds);
  const node = level.nodes.find((n) => n.id === nodeId)!;
  return { node, ...renderWithIntl(<>{node.content}</>) };
}

afterEach(cleanup);

describe('the canvas shows what the planner is pointed at', () => {
  it('rings a targeted node and NAMES it — not colour alone', () => {
    renderNode('wi-812', ['wi-812']);

    expect(screen.getByTestId('planning-target-node')).toBeTruthy();
    // The word is real text, so the state is audible as well as visible.
    expect(screen.getByText('Target')).toBeTruthy();
    // The shipped node is still the thing being rendered — wrapped, not replaced.
    expect(screen.getByText('Billing — invoicing')).toBeTruthy();
  });

  it('leaves every other node on the level untouched', () => {
    renderNode('wi-511', ['wi-812']);

    expect(screen.queryByTestId('planning-target-node')).toBeNull();
    expect(screen.getByText('Auth module')).toBeTruthy();
  });

  it('is a no-op when nothing is targeted — the plain roadmap render', () => {
    const base = decoratePlanChangeLevel(
      buildWorkItemLevel(LEVEL),
      LEVEL,
      indexPlanReview(null),
      null,
    );
    expect(decorateTargetLevel(base, [])).toBe(base);
  });

  it('marks EVERY target that is on this level, not only the first', () => {
    const base = decoratePlanChangeLevel(
      buildWorkItemLevel(LEVEL),
      LEVEL,
      indexPlanReview(null),
      null,
    );
    const level = decorateTargetLevel(base, ['wi-812', 'wi-511']);

    // A target the user has not drilled to simply is not on this level — the
    // canvas is a dependency graph and stays scoped, per the design; it is never
    // relocated onto a level it does not belong to.
    expect(level.nodes.filter((n) => n.searchText?.includes('target'))).toHaveLength(2);
    expect(level.nodes).toHaveLength(base.nodes.length);
  });

  it('joins the search text, so the canvas’s own search-to-locate finds the target', () => {
    const { node } = renderNode('wi-812', ['wi-812']);
    expect(node.searchText).toContain('target');
    // …without losing what was searchable before.
    expect(node.searchText).toContain('PAY-812');
  });

  it('COMPOSES with the diff frame — a targeted node the proposal also changes shows both', () => {
    renderNode('wi-812', ['wi-812'], REVIEW);

    expect(screen.getByTestId('planning-target-node')).toBeTruthy();
    expect(screen.getByTestId('plan-change-diff-node')).toBeTruthy();
    expect(screen.getByText('Target')).toBeTruthy();
    expect(screen.getByText('changed')).toBeTruthy();
  });
});
