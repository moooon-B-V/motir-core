// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PlanProposalList } from '@/components/planning/PlanProposalList';

// MOTIR-3239 — the plan detail's LIST body, built to
// `design/ai-planning/design-notes.md` Part VIII §3 and
// `plan-detail-list-view.mock.html` panel 2.
//
// The canvas answers where a proposal LANDS. This answers what exactly is being
// approved, which is a question about a SET — and the two properties worth
// pinning are the ones a screenshot would agree with while being wrong: that
// ALL THREE ops are shown, and that a `modify`'s diff is spelled out rather than
// signalled.

afterEach(cleanup);

const add = (over = {}) =>
  planReviewItem({
    planItemId: 'a1',
    op: 'add',
    title: 'A proposed story',
    kind: 'story',
    ...over,
  });
const modify = (over = {}) =>
  planReviewItem({
    planItemId: 'm1',
    op: 'modify',
    identifier: 'MOTIR-812',
    title: 'Payout ledger',
    changes: [{ field: 'title', from: 'Payout ledger', to: 'Payout ledger + reconciliation' }],
    ...over,
  });
const remove = (over = {}) =>
  planReviewItem({
    planItemId: 'r1',
    op: 'remove',
    identifier: 'MOTIR-851',
    title: 'Legacy CSV export',
    ...over,
  });

describe('the list shows ALL THREE ops (MOTIR-3239)', () => {
  it('renders Adds, Updates AND Archives, each as its own section', () => {
    // ⚠️ THE LOAD-BEARING ONE. A list showing two ops under a row whose item
    // count includes three is a surface arguing with itself — and that count is
    // on the row that got the reader here. `remove` is rare, not excluded.
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} decided={false} />);

    expect(screen.getByText('Adds')).toBeTruthy();
    expect(screen.getByText('Updates')).toBeTruthy();
    expect(screen.getByText('Archives')).toBeTruthy();
    expect(screen.getByText('Legacy CSV export')).toBeTruthy();
    // The row CHIP says panel B's word, not the header's — the header names a
    // group, the chip names what happens to this card.
    // These are the SHIPPED canvas badge strings, reused rather than restated —
    // `remove`, not a fourth word for the same op.
    expect(screen.getByText('add')).toBeTruthy();
    expect(screen.getByText('change')).toBeTruthy();
    expect(screen.getByText('remove')).toBeTruthy();
  });

  it('a section with nothing in it does not render', () => {
    renderWithIntl(<PlanProposalList items={[add()]} decided={false} />);

    expect(screen.getByText('Adds')).toBeTruthy();
    expect(screen.queryByText('Updates')).toBeNull();
    expect(screen.queryByText('Archives')).toBeNull();
  });

  it('each section carries its own count', () => {
    renderWithIntl(
      <PlanProposalList
        items={[add(), add({ planItemId: 'a2', title: 'Another' }), modify()]}
        decided={false}
      />,
    );

    const adds = screen.getByText('Adds').closest('h3')!;
    expect(within(adds).getByText('2')).toBeTruthy();
  });
});

describe('the row (MOTIR-3239)', () => {
  it('an `add` has NO KEY and says so rather than leaving a gap', () => {
    // `identifier` is null until approve materializes it. An empty slot in a
    // column of keys reads as a missing value; this reads as the fact it is.
    renderWithIntl(<PlanProposalList items={[add()]} decided={false} />);

    expect(screen.getByText('no key yet')).toBeTruthy();
  });

  it('a `modify` shows its key, and a `remove` strikes its title', () => {
    renderWithIntl(<PlanProposalList items={[modify(), remove()]} decided={false} />);

    expect(screen.getByText('MOTIR-812')).toBeTruthy();
    expect(screen.getByText('Legacy CSV export').className).toContain('line-through');
  });

  it('carries the facts a reviewer decides on', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          add({ type: 'code', storyPoints: 5, estimateMinutes: 90, targetRepo: 'motir-core' }),
        ]}
        decided={false}
      />,
    );

    expect(screen.getByText(/story · code · 5 pts · 90 min · motir-core/)).toBeTruthy();
  });

  it('names WHERE it lands, and marks an intra-plan parent as proposed', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          add({ parentNodeId: 'pi_0', parentIdentifier: null, parentTitle: 'A proposed story' }),
        ]}
        decided={false}
      />,
    );

    // The container does not exist yet either, and a reader deciding on this row
    // should know that.
    expect(screen.getByText(/under A proposed story/)).toBeTruthy();
    expect(screen.getByText('(proposed)')).toBeTruthy();
  });

  it('flags a stale proposal', () => {
    renderWithIntl(
      <PlanProposalList
        items={[add({ stale: true, staleReasons: ['parent_removed'] })]}
        decided={false}
      />,
    );

    expect(screen.getByText('may be out of date')).toBeTruthy();
  });
});

describe('a `modify`’s diff is SPELLED OUT, not signalled (MOTIR-3239)', () => {
  it('shows the field, the old value struck through, and the new one', () => {
    // The canvas's overlay answers *this node is changing* inside a ~280px card:
    // it is a SIGNAL. The list answers *changing to WHAT*, at pane width, for a
    // reader deciding whether to approve.
    renderWithIntl(<PlanProposalList items={[modify()]} decided={false} />);

    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.getByText('Payout ledger + reconciliation')).toBeTruthy();
    // The TITLE is also 'Payout ledger', so pick the one inside the diff line.
    const old = screen.getAllByText('Payout ledger').find((n) => n.closest('dd') != null)!;
    expect(old.className).toContain('line-through');
  });

  it('a BODY-valued field is NAMED, not quoted', () => {
    // A rewritten description is not a diff a review list can carry, and a
    // truncated one is worse than a pointer.
    renderWithIntl(
      <PlanProposalList
        items={[
          modify({
            changes: [{ field: 'description', from: 'old body…', to: 'a completely new body…' }],
          }),
        ]}
        decided={false}
      />,
    );

    expect(screen.getByText('rewritten — open the card to read it')).toBeTruthy();
    expect(screen.queryByText(/a completely new body/)).toBeNull();
  });

  it('a change with no OLD value shows only the new one', () => {
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'priority', from: null, to: 'high' }] })]}
        decided={false}
      />,
    );

    expect(screen.getByText('high')).toBeTruthy();
  });
});

describe('the states (MOTIR-3239)', () => {
  it('EMPTY — a plan that proposes nothing says what approving it would do', () => {
    renderWithIntl(<PlanProposalList items={[]} decided={false} />);

    expect(screen.getByText('No proposals')).toBeTruthy();
    expect(screen.getByText(/Nothing will change if you approve it/)).toBeTruthy();
  });

  it('DECIDED — the list is a RECORD, in the past tense', () => {
    // Part VI made this pane a record of what was accepted. The list is the same
    // pane's other body, so it says the same thing in the same tense.
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} decided />);

    // The SECTION headers move to the past tense…
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Applied')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.queryByText('Adds')).toBeNull();
    // …and so do the row CHIPS, which carry panel B's vocabulary rather than the
    // header's.
    expect(screen.getByText('created')).toBeTruthy();
    expect(screen.queryByText('add')).toBeNull();
  });
});
