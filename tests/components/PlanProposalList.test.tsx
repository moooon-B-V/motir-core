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

    // The LABEL, not the wire name — see the field-label totality guard.
    expect(screen.getByText('Title')).toBeTruthy();
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

    expect(screen.getByText('Description')).toBeTruthy();
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

describe('the row’s remaining arms (MOTIR-3242 — the story gate’s top-up)', () => {
  it('falls back to the parent IDENTIFIER when the title is not carried', () => {
    renderWithIntl(
      <PlanProposalList
        items={[add({ parentNodeId: 'wi_p', parentIdentifier: 'MOTIR-653', parentTitle: null })]}
        decided={false}
      />,
    );

    expect(screen.getByText(/under MOTIR-653/)).toBeTruthy();
    // A committed parent is NOT marked proposed.
    expect(screen.queryByText('(proposed)')).toBeNull();
  });

  it('renders a row that carries a live STATUS', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          modify({
            status: 'in_progress',
            statusLabel: 'In Progress',
            statusCategory: 'in_progress',
          }),
        ]}
        decided={false}
      />,
    );

    expect(screen.getByText('In Progress')).toBeTruthy();
  });

  it('a change that REMOVES a value shows the em-dash, not an empty slot', () => {
    // `to: null` is the shape a `modify` takes when it clears a field. An empty
    // cell in a diff reads as a rendering failure.
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'priority', from: 'high', to: null }] })]}
        decided={false}
      />,
    );

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('a row with NO facts at all still renders', () => {
    // Every fact is optional on the DTO; a proposal with none must not produce an
    // empty separator line.
    renderWithIntl(
      <PlanProposalList
        items={[
          add({
            kind: '',
            type: null,
            storyPoints: null,
            estimateMinutes: null,
            targetRepo: null,
            parentNodeId: null,
            parentIdentifier: null,
            parentTitle: null,
          }),
        ]}
        decided={false}
      />,
    );

    expect(screen.getByText('A proposed story')).toBeTruthy();
  });

  it('every member of the op enum has a section — asserted at BUILD time', () => {
    // ⚠️ THE RUNTIME TEST THIS REPLACES WAS WRONG, and writing it is what found
    // the gap. It asserted that an unrecognised op "renders no chip rather than
    // throwing" — and the row does not render AT ALL, because the list is built
    // by iterating the three sections. A proposal that silently never appears,
    // under an item count that includes it, is precisely the self-contradiction
    // the three-section decision exists to prevent.
    //
    // So the guarantee is moved to the compiler: `AssertTotalListOps` in
    // `PlanProposalList.tsx` makes a fourth `PlanItemOpDto` member a BUILD error
    // rather than an invisible row. This test states that the three the enum has
    // today all reach a section, so the runtime half is covered too.
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} decided={false} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('an unknown KIND falls back to the task glyph rather than throwing', () => {
    renderWithIntl(<PlanProposalList items={[add({ kind: 'epicish' })]} decided={false} />);

    expect(screen.getByText('A proposed story')).toBeTruthy();
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

describe('the field LABEL, not the wire name (MOTIR-3242)', () => {
  it('renders the catalogue label for a camelCase wire field', () => {
    // `storyPoints` would otherwise read as STORYPOINTS — the shape that once put
    // `planReview.field_storyPoints` on the canvas in front of a reviewer.
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'storyPoints', from: '3', to: '5' }] })]}
        decided={false}
      />,
    );

    expect(screen.getByText('Story points')).toBeTruthy();
    expect(screen.queryByText('storyPoints')).toBeNull();
  });

  it('a field with NO copy degrades to the wire name rather than leaking a key path', () => {
    // `PlanItemChangeDto.field` is deliberately a plain `string`: a client bundle
    // can be older than the server that answered it, and a surface that cannot
    // represent an unknown field cannot fall back for one.
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'somethingNew', from: 'a', to: 'b' }] })]}
        decided={false}
      />,
    );

    expect(screen.getByText('somethingNew')).toBeTruthy();
    expect(screen.queryByText(/planReview\.field_/)).toBeNull();
  });
});
