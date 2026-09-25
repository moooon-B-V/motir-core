import { describe, expect, it } from 'vitest';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';

// The placement rules behind the IN-CANVAS diff (Subtask MOTIR-1730, re-pointed
// at the PLAN by MOTIR-1746): where each of the run's proposals is PARENTED on the
// canvas, and the counts the confirm bar reads. Pure input → output, no React.
//
// MOTIR-6342 deleted the per-level helpers this file used to pin
// (`proposedAddsForLevel`, `proposalForItem`, `changedFields`, `touchedByProposal`,
// `isProposedNodeId`) with the second level builder that called them (MOTIR-6299).
// The placement they read is the `parentNodeId` / `nodeId` each `add` carries,
// asserted directly below; the level builder that consumes it is `mergePlanLevel`,
// held by `plan-level-op-treatments.test.tsx`.

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
    // A proposed node is PREFIXED, so it can never collide with a work-item id.
    expect(index.adds.map((a) => a.nodeId)).toEqual(['proposed:pi_a', 'proposed:pi_b']);
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

  it('parents a parentless proposal on the TOP level', () => {
    const index = indexPlanReview(
      planReview([planReviewItem({ planItemId: 'pi_t', nodeId: 'pi_t' })]),
    );

    expect(index.adds[0]!.parentNodeId).toBeNull();
  });

  it('keys a MATERIALIZED add by the work item it became, and parents its children on that id', () => {
    // A decided add IS the committed card (MOTIR-3160): prefixing it would draw a
    // second, keyless copy beside it (MOTIR-3206), and a child pointing at the
    // prefixed id would hang off a node that is not on the canvas.
    const index = indexPlanReview(
      planReview([
        planReviewItem({ planItemId: 'pi_d', nodeId: 'wi_new', identifier: 'PAY-30' }),
        planReviewItem({ planItemId: 'pi_k', nodeId: 'pi_k', parentNodeId: 'wi_new' }),
      ]),
    );

    const [decided, child] = index.adds;
    expect(decided!.nodeId).toBe('wi_new');
    expect(child!.parentNodeId).toBe('wi_new');
    expect(decided!.hasChildren).toBe(true);
  });
});
