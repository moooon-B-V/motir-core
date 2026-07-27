import { describe, expect, it } from 'vitest';
import {
  changedFields,
  diffStateForItem,
  indexPlanDelta,
  isProposedNodeId,
  proposedAddsForLevel,
} from '@/lib/planning/planChangeDiff';
import type { PlanDelta } from '@/lib/ai/planDelta';

// The placement rules behind the IN-CANVAS diff (Subtask MOTIR-1730). The canvas
// renders one level at a time, so the whole question this module answers is
// "which of the delta's ops belong on the level in focus, and what state does each
// existing item take?". Pure input → output, no React.

function delta(operations: PlanDelta['operations']): PlanDelta {
  return { operations };
}

describe('indexPlanDelta', () => {
  it('is empty for a null / no-op delta (an empty operations list is valid)', () => {
    expect(indexPlanDelta(null).isEmpty).toBe(true);
    expect(indexPlanDelta(delta([])).isEmpty).toBe(true);
    expect(indexPlanDelta(delta([])).counts).toEqual({ added: 0, changed: 0 });
  });

  it('counts adds and changes separately and keys updates by their target', () => {
    const index = indexPlanDelta(
      delta([
        { op: 'create', kind: 'story', fields: { title: 'Recurring invoices' } },
        { op: 'create', kind: 'subtask', fields: { title: 'Monthly schedule' } },
        { op: 'update', targetKey: 'PAY-21', fields: { title: 'Email reminders' } },
      ]),
    );

    expect(index.counts).toEqual({ added: 2, changed: 1 });
    expect(index.updatesByKey.get('PAY-21')?.fields.title).toBe('Email reminders');
    expect(index.adds.every((a) => isProposedNodeId(a.nodeId))).toBe(true);
  });

  it('resolves a parentRef to the earlier create it names, and flags that parent drillable', () => {
    const index = indexPlanDelta(
      delta([
        { op: 'create', ref: 'recurring', kind: 'story', fields: { title: 'Recurring' } },
        { op: 'create', parentRef: 'recurring', kind: 'subtask', fields: { title: 'Monthly' } },
      ]),
    );

    const [parent, child] = index.adds;
    expect(child!.parentNodeId).toBe(parent!.nodeId);
    expect(child!.parentKey).toBeNull();
    expect(parent!.hasChildren).toBe(true);
    expect(child!.hasChildren).toBe(false);
  });

  it('keeps an UNRESOLVABLE parentRef as a root proposal instead of dropping the node', () => {
    const index = indexPlanDelta(
      delta([{ op: 'create', parentRef: 'ghost', kind: 'story', fields: { title: 'Orphan' } }]),
    );

    expect(index.adds).toHaveLength(1);
    expect(index.adds[0]!.parentNodeId).toBeNull();
  });
});

describe('proposedAddsForLevel', () => {
  const index = indexPlanDelta(
    delta([
      {
        op: 'create',
        ref: 'recurring',
        parentKey: 'PAY-3',
        kind: 'story',
        fields: { title: 'Recurring' },
      },
      { op: 'create', parentRef: 'recurring', kind: 'subtask', fields: { title: 'Monthly' } },
      { op: 'create', kind: 'epic', fields: { title: 'Reporting' } },
    ]),
  );

  it('puts a parentless proposal on the TOP level', () => {
    const top = proposedAddsForLevel(index, { focusNodeId: null, focusKey: null });
    expect(top.map((a) => a.op.fields.title)).toEqual(['Reporting']);
  });

  it('puts a parentKey proposal on the level of the existing item it names', () => {
    const level = proposedAddsForLevel(index, { focusNodeId: 'wi-3', focusKey: 'PAY-3' });
    expect(level.map((a) => a.op.fields.title)).toEqual(['Recurring']);
  });

  it('puts a parentRef proposal under its PROPOSED parent when that node is the focus', () => {
    const parent = index.adds[0]!;
    const level = proposedAddsForLevel(index, { focusNodeId: parent.nodeId, focusKey: null });
    expect(level.map((a) => a.op.fields.title)).toEqual(['Monthly']);
  });

  it('shows nothing on a level whose work-item key is not known yet', () => {
    expect(proposedAddsForLevel(index, { focusNodeId: 'wi-9', focusKey: null })).toEqual([]);
  });
});

describe('diffStateForItem', () => {
  const index = indexPlanDelta(
    delta([{ op: 'update', targetKey: 'PAY-21', fields: { priority: 'high' } }]),
  );

  it('marks an item the proposal updates as CHANGED', () => {
    expect(diffStateForItem(index, { identifier: 'PAY-21', status: 'todo' })).toBe('change');
  });

  it('leaves an untouched item undecorated', () => {
    expect(diffStateForItem(index, { identifier: 'PAY-22', status: 'todo' })).toBeNull();
  });

  it('LOCKS finished work — the same terminal rule the approve enforces server-side', () => {
    expect(diffStateForItem(index, { identifier: 'PAY-12', status: 'done' })).toBe('locked');
    expect(diffStateForItem(index, { identifier: 'PAY-13', status: 'cancelled' })).toBe('locked');
  });

  it('LOCKS wins over a proposed change on the same item (the approve would reject it)', () => {
    expect(diffStateForItem(index, { identifier: 'PAY-21', status: 'done' })).toBe('locked');
  });
});

describe('changedFields', () => {
  it('names every field the update touches, including a null-ing one', () => {
    expect(
      changedFields({
        op: 'update',
        targetKey: 'PAY-21',
        fields: { title: 'x', type: null, estimateMinutes: 30 },
      }),
    ).toEqual(['title', 'type', 'estimate']);
  });

  it('is empty for an update that sets nothing', () => {
    expect(changedFields({ op: 'update', targetKey: 'PAY-21', fields: {} })).toEqual([]);
  });
});
