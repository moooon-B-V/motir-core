// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { mergePlanLevel, proposalsAtLevel } from '@/components/planning/planLevel';
import type { PlanCanvasLevel } from '@/components/planning/planLevel';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// Component tests for the plan-detail op treatments (Subtask 7.4.5 / MOTIR-847)
// under happy-dom. The DTO assembly is covered by the real-DB
// planReviewService suite; here we assert the canvas node renders each `op`
// distinctly (add / modify-with-diff / remove) + the stale badge, and that the
// pure LEVEL transform merges a plan's proposals into the committed level the
// roadmap read returned (MOTIR-3083).

afterEach(cleanup);

function item(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    blockedByNodeIds: [],
    identifier: null,
    title: 'A proposed item',
    kind: 'task',
    priority: null,
    type: null,
    descriptionMd: null,
    explanationMd: null,
    explanationSource: null,
    storyPoints: null,
    estimateMinutes: null,
    targetRepo: null,
    targetRepoRole: null,
    executor: null,
    planningProvenance: null,
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

  // ⚠️ EDITING IS REMOVED (MOTIR-3084). MOTIR-1370's inline-edit pencil and its
  // modal are gone: a proposal is READ (the canvas peek) and changed by
  // re-planning, not hand-corrected. Guarded on ABSENCE, on every op — the
  // affordance must not come back on any of them.
  it('carries NO edit affordance on any op', () => {
    for (const op of ['add', 'modify', 'remove'] as const) {
      renderWithIntl(<PlanItemNode item={item({ op, nodeId: `wi_${op}`, title: op })} />);
      expect(screen.queryByTestId('edit-proposal')).toBeNull();
      cleanup();
    }
  });
});

describe('mergePlanLevel', () => {
  /** A committed level as the roadmap read returns it. */
  function committed(ids: string[], deps: PlanCanvasLevel['deps'] = []): PlanCanvasLevel {
    return {
      nodes: ids.map((id) => ({
        id,
        parentId: 'parent_1',
        searchText: id,
        crumbLabel: id,
        drillable: false,
        content: <span>{id}</span>,
      })),
      deps,
    };
  }

  it('keeps EVERY committed sibling — including one nothing depends on', () => {
    // The point of the level model: a sibling is on the canvas because it is a
    // CHILD of the focused parent, never because something depends on it.
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b', 'wi_c']),
      [item({ planItemId: 'p1', nodeId: 'p1', op: 'add', parentNodeId: 'parent_1' })],
      'parent_1',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_a', 'wi_b', 'wi_c', 'p1']);
    // No edge anywhere, and all three siblings still render.
    expect(level.deps).toEqual([]);
  });

  it('re-skins a modify/remove IN PLACE rather than adding a ghost node', () => {
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b']),
      [item({ planItemId: 'p1', nodeId: 'wi_b', op: 'remove', parentNodeId: 'parent_1' })],
      'parent_1',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_a', 'wi_b']);
  });

  it('keeps the committed edges and adds a proposal edge when both ends are at this level', () => {
    const level = mergePlanLevel(
      committed(['wi_a'], [{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]),
      [
        item({
          planItemId: 'p1',
          nodeId: 'p1',
          op: 'add',
          parentNodeId: 'parent_1',
          blockedByNodeIds: ['wi_a', 'off_level'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([
      { from: 'wi_a', to: 'wi_b', variant: 'firm' },
      // `off_level` has no node here, so its edge is dropped — the same rule the
      // committed roadmap applies to an off-level blocker.
      { from: 'wi_a', to: 'p1', variant: 'pending' },
    ]);
  });

  it('only merges the proposals that belong at THIS level', () => {
    const items = [
      item({ planItemId: 'p1', nodeId: 'p1', op: 'add', parentNodeId: 'parent_1' }),
      item({ planItemId: 'p2', nodeId: 'p2', op: 'add', parentNodeId: 'other_parent' }),
      item({ planItemId: 'p3', nodeId: 'p3', op: 'add', parentNodeId: null }),
    ];

    expect(proposalsAtLevel(items, 'parent_1').map((i) => i.nodeId)).toEqual(['p1']);
    expect(proposalsAtLevel(items, null).map((i) => i.nodeId)).toEqual(['p3']);
    expect(mergePlanLevel(committed([]), items, 'parent_1').nodes.map((n) => n.id)).toEqual(['p1']);
  });

  it('renders the proposals alone when the committed level is empty', () => {
    // The degraded path: a pre-project run, or a roadmap read that failed. The
    // surface still shows the plan rather than blanking.
    const level = mergePlanLevel(
      { nodes: [], deps: [] },
      [item({ planItemId: 'p1', nodeId: 'p1', op: 'add', hasChildren: true })],
      null,
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['p1']);
    expect(level.nodes[0]!.drillable).toBe(true);
  });
});
