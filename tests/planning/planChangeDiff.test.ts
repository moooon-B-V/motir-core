import { describe, expect, it } from 'vitest';
import {
  changedFields,
  diffStateForItem,
  indexPlanReview,
  isProposedNodeId,
  proposalForItem,
  proposedAddsForLevel,
} from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';

// The placement rules behind the IN-CANVAS diff (Subtask MOTIR-1730, re-pointed
// at the PLAN by MOTIR-1746). The canvas renders one level at a time, so the whole
// question this module answers is "which of the run's proposals belong on the
// level in focus, and what state does each existing item take?". Pure input →
// output, no React.

describe('indexPlanReview', () => {
  it('is empty for no plan / a plan with no proposals (both are valid no-ops)', () => {
    expect(indexPlanReview(null).isEmpty).toBe(true);
    expect(indexPlanReview(planReview([])).isEmpty).toBe(true);
    expect(indexPlanReview(planReview([])).counts).toEqual({ added: 0, changed: 0, removed: 0 });
  });

  it('counts each op separately and keys modify/remove by their TARGET work item', () => {
    const index = indexPlanReview(
      planReview([
        planReviewItem({ planItemId: 'pi_a', nodeId: 'pi_a', title: 'Recurring invoices' }),
        planReviewItem({ planItemId: 'pi_b', nodeId: 'pi_b', title: 'Monthly schedule' }),
        planReviewItem({
          planItemId: 'pi_c',
          op: 'modify',
          nodeId: 'wi_21',
          identifier: 'PAY-21',
          title: 'Email reminders',
          changes: [{ field: 'title', from: 'Reminders', to: 'Email reminders' }],
        }),
        planReviewItem({
          planItemId: 'pi_d',
          op: 'remove',
          nodeId: 'wi_24',
          identifier: 'PAY-24',
          title: 'SMS reminder',
        }),
      ]),
    );

    expect(index.counts).toEqual({ added: 2, changed: 1, removed: 1 });
    expect(index.changesById.get('wi_21')?.title).toBe('Email reminders');
    expect(index.removalsById.get('wi_24')?.identifier).toBe('PAY-24');
    // A proposed node is PREFIXED, so it can never collide with a work-item id —
    // which is what lets the canvas tell "drill a proposal" from "drill an item".
    expect(index.adds.every((a) => isProposedNodeId(a.nodeId))).toBe(true);
  });

  it('re-prefixes a parent that is ANOTHER proposal, and flags that parent drillable', () => {
    const index = indexPlanReview(
      planReview([
        planReviewItem({ planItemId: 'pi_p', nodeId: 'pi_p', title: 'Recurring' }),
        planReviewItem({
          planItemId: 'pi_c',
          nodeId: 'pi_c',
          parentNodeId: 'pi_p',
          title: 'Monthly',
        }),
      ]),
    );

    const [parent, child] = index.adds;
    expect(child!.parentNodeId).toBe(parent!.nodeId);
    expect(parent!.hasChildren).toBe(true);
    expect(child!.hasChildren).toBe(false);
  });

  it('leaves a parent that is an EXISTING work item as its real id (that IS its canvas node)', () => {
    const index = indexPlanReview(
      planReview([planReviewItem({ planItemId: 'pi_x', nodeId: 'pi_x', parentNodeId: 'wi_3' })]),
    );

    expect(index.adds[0]!.parentNodeId).toBe('wi_3');
  });
});

describe('proposedAddsForLevel', () => {
  const index = indexPlanReview(
    planReview([
      planReviewItem({
        planItemId: 'pi_r',
        nodeId: 'pi_r',
        parentNodeId: 'wi_3',
        title: 'Recurring',
      }),
      planReviewItem({
        planItemId: 'pi_m',
        nodeId: 'pi_m',
        parentNodeId: 'pi_r',
        title: 'Monthly',
      }),
      planReviewItem({ planItemId: 'pi_top', nodeId: 'pi_top', title: 'Reporting' }),
    ]),
  );

  it('puts a parentless proposal on the TOP level', () => {
    expect(proposedAddsForLevel(index, null).map((a) => a.item.title)).toEqual(['Reporting']);
  });

  it('puts a proposal on the level of the EXISTING item it is parented on', () => {
    expect(proposedAddsForLevel(index, 'wi_3').map((a) => a.item.title)).toEqual(['Recurring']);
  });

  it('puts a proposal under its PROPOSED parent when that node is the focus', () => {
    const parent = index.adds[0]!;
    expect(proposedAddsForLevel(index, parent.nodeId).map((a) => a.item.title)).toEqual([
      'Monthly',
    ]);
  });

  it('shows nothing on a level nothing is proposed under', () => {
    expect(proposedAddsForLevel(index, 'wi_9')).toEqual([]);
  });
});

describe('diffStateForItem', () => {
  const index = indexPlanReview(
    planReview([
      planReviewItem({
        planItemId: 'pi_m',
        op: 'modify',
        nodeId: 'wi_21',
        changes: [{ field: 'priority', from: 'medium', to: 'high' }],
      }),
      planReviewItem({ planItemId: 'pi_r', op: 'remove', nodeId: 'wi_24' }),
    ]),
  );

  it('marks an item the proposal modifies as CHANGED', () => {
    expect(diffStateForItem(index, { id: 'wi_21', status: 'todo' })).toBe('change');
  });

  it('marks an item the proposal removes as REMOVE — a state the engine really emits', () => {
    // `expandItem` / `replan` append `remove` proposals; the delta contract this
    // surface used to read had no op for them, so they were invisible before.
    expect(diffStateForItem(index, { id: 'wi_24', status: 'todo' })).toBe('remove');
  });

  it('leaves an untouched item undecorated', () => {
    expect(diffStateForItem(index, { id: 'wi_22', status: 'todo' })).toBeNull();
  });

  it('LOCKS finished work — the same terminal rule the approve enforces server-side', () => {
    expect(diffStateForItem(index, { id: 'wi_12', status: 'done' })).toBe('locked');
    expect(diffStateForItem(index, { id: 'wi_13', status: 'cancelled' })).toBe('locked');
  });

  it('LOCKED wins over a proposed change or removal (the approve would reject it)', () => {
    expect(diffStateForItem(index, { id: 'wi_21', status: 'done' })).toBe('locked');
    expect(diffStateForItem(index, { id: 'wi_24', status: 'done' })).toBe('locked');
  });

  it('hands back the proposal behind the state, so the node can name what changed', () => {
    expect(proposalForItem(index, 'wi_21')?.op).toBe('modify');
    expect(proposalForItem(index, 'wi_24')?.op).toBe('remove');
    expect(proposalForItem(index, 'wi_99')).toBeUndefined();
  });
});

describe('changedFields', () => {
  it('names every field the modify touches, mapping the wire name to the copy key', () => {
    expect(
      changedFields(
        planReviewItem({
          op: 'modify',
          changes: [
            { field: 'title', from: 'a', to: 'b' },
            { field: 'type', from: 'code', to: null },
            { field: 'estimateMinutes', from: '20', to: '30' },
            { field: 'storyPoints', from: '2', to: '3' },
            { field: 'links', from: null, to: '+1' },
          ],
        }),
      ),
    ).toEqual(['title', 'type', 'estimate', 'points', 'links']);
  });

  it('DROPS a field it has no copy for, rather than rendering a missing key', () => {
    // The whitelist is the point: a diffable field added server-side must not be
    // able to crash the canvas on a translation that has not landed yet.
    expect(
      changedFields(
        planReviewItem({ op: 'modify', changes: [{ field: 'sprint', from: null, to: 'S3' }] }),
      ),
    ).toEqual([]);
  });

  it('is empty for a modify that carries no diff', () => {
    expect(changedFields(planReviewItem({ op: 'modify' }))).toEqual([]);
  });
});
