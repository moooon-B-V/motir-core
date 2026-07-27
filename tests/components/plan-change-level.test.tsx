// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { decoratePlanChangeLevel } from '@/components/planning/planChangeLevel';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { indexPlanDelta } from '@/lib/planning/planChangeDiff';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { PlanDelta } from '@/lib/ai/planDelta';

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

const DELTA: PlanDelta = {
  operations: [
    { op: 'create', kind: 'story', fields: { title: 'Recurring invoices' } },
    { op: 'update', targetKey: 'PAY-21', fields: { title: 'Email reminders' } },
  ],
};

function decorate(delta: PlanDelta | null) {
  return decoratePlanChangeLevel(buildWorkItemLevel(LEVEL), LEVEL, indexPlanDelta(delta), {
    focusNodeId: null,
    focusKey: null,
  });
}

afterEach(cleanup);

describe('decoratePlanChangeLevel', () => {
  it('returns the level UNTOUCHED when nothing is proposed', () => {
    const base = buildWorkItemLevel(LEVEL);
    const out = decoratePlanChangeLevel(base, LEVEL, indexPlanDelta(null), {
      focusNodeId: null,
      focusKey: null,
    });
    expect(out).toBe(base);
  });

  it('appends the proposed item as its own node, drawn as an ADD', () => {
    const level = decorate(DELTA);

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
    const level = decorate(DELTA);
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
    const level = decorate(DELTA);
    const locked = level.nodes.find((n) => n.id === 'wi-12')!;

    renderWithIntl(<>{locked.content}</>);
    const node = screen.getByTestId('plan-change-diff-node');
    expect(node.getAttribute('data-diff-state')).toBe('locked');
    expect(node.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('locked')).toBeTruthy();
    expect(screen.getByText("can't change")).toBeTruthy();
  });

  it('leaves an untouched, unfinished item with no diff chrome at all', () => {
    const level = decorate(DELTA);
    const plain = level.nodes.find((n) => n.id === 'wi-14')!;

    renderWithIntl(<>{plain.content}</>);
    expect(screen.queryByTestId('plan-change-diff-node')).toBeNull();
    expect(screen.getByText('Send invoice')).toBeTruthy();
  });

  it('places a proposal parented on an EXISTING item on that item’s level only', () => {
    const index = indexPlanDelta({
      operations: [
        {
          op: 'create',
          parentKey: 'PAY-21',
          kind: 'subtask',
          fields: { title: 'Monthly schedule' },
        },
      ],
    });

    const top = decoratePlanChangeLevel(buildWorkItemLevel(LEVEL), LEVEL, index, {
      focusNodeId: null,
      focusKey: null,
    });
    expect(top.nodes).toHaveLength(3);

    const inside = decoratePlanChangeLevel(buildWorkItemLevel(LEVEL), LEVEL, index, {
      focusNodeId: 'wi-21',
      focusKey: 'PAY-21',
    });
    expect(inside.nodes).toHaveLength(4);
    expect(inside.nodes[3]!.parentId).toBe('wi-21');
  });
});
