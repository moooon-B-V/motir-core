// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { buildPlanForest } from '@/components/planning/planLevel';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// Component tests for the plan-detail op treatments (Subtask 7.4.5 / MOTIR-847)
// under happy-dom. The DTO assembly is covered by the real-DB
// planReviewService suite; here we assert the canvas node renders each `op`
// distinctly (add / modify-with-diff / remove) + the stale badge, and that the
// pure forest transform places nodes + edges correctly.

afterEach(cleanup);

function item(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    blockedByNodeIds: [],
    identifier: null,
    title: 'A proposed item',
    kind: 'task',
    status: null,
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
    targetMissing: false,
    ...over,
  };
}

describe('PlanItemNode', () => {
  it('renders an add with the add badge + "New" placeholder identifier', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add', title: 'Marketplace payouts' })} />);
    expect(screen.getByText('add')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Marketplace payouts')).toBeTruthy();
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('add');
  });

  it('renders a modify with the change badge + an old→new diff line', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_1',
          identifier: 'PROD-14',
          title: 'Seller onboarding',
          status: 'in_progress',
          changes: [
            { field: 'priority', from: 'medium', to: 'high' },
            { field: 'title', from: 'old', to: 'new' },
          ],
        })}
      />,
    );
    expect(screen.getByText('change')).toBeTruthy();
    expect(screen.getByTestId('diff-line')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    // A second change is summarised, not dumped.
    expect(screen.getByText('+1 more')).toBeTruthy();
  });

  it('renders a remove with a struck-through title + status pill', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'remove',
          nodeId: 'wi_2',
          identifier: 'PROD-19',
          title: 'Manual payout export',
          status: 'todo',
        })}
      />,
    );
    expect(screen.getByText('remove')).toBeTruthy();
    const title = screen.getByText('Manual payout export');
    expect(title.className).toContain('line-through');
  });

  it('shows a stale badge with the reasons in the tooltip', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          stale: true,
          staleReasons: [{ code: 'parent_removed', parentId: 'wi_9' }],
        })}
      />,
    );
    const badge = screen.getByTestId('stale-badge');
    expect(badge.getAttribute('title')).toContain('Parent removed');
  });
});

describe('buildPlanForest', () => {
  it('maps items to canvas nodes (parent placement + drillable) and proposed edges', () => {
    const items = [
      item({ planItemId: 'p1', nodeId: 'p1', op: 'add', hasChildren: true, title: 'Epic' }),
      item({
        planItemId: 'p2',
        nodeId: 'p2',
        op: 'add',
        parentNodeId: 'p1',
        blockedByNodeIds: ['p1'],
        title: 'Story',
      }),
      // An edge to a node OUTSIDE the forest is dropped (no ghost node).
      item({
        planItemId: 'p3',
        nodeId: 'p3',
        op: 'add',
        blockedByNodeIds: ['unknown'],
        title: 'Loose',
      }),
    ];
    const forest = buildPlanForest(items);

    expect(forest.nodes.map((n) => n.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(forest.nodes.find((n) => n.id === 'p1')!.drillable).toBe(true);
    expect(forest.nodes.find((n) => n.id === 'p2')!.parentId).toBe('p1');
    expect(forest.deps).toEqual([{ from: 'p1', to: 'p2', variant: 'pending' }]);
  });
});
