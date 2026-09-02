// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ProposalQuickView } from '@/components/planning/ProposalQuickView';
import { planReviewItem } from '../helpers/planReview';

// The proposal READ view (MOTIR-3084, design Part V §3). happy-dom.
//
// What matters here is what the surface SHOWS a person before they approve —
// MOTIR-3070's finding was that the review surface rendered less than the
// proposal carries. So these assert the two bodies and the decision fields, and
// the ABSENCE of any write path.

afterEach(cleanup);

const full = () =>
  planReviewItem({
    op: 'add',
    title: 'A proposal READ view',
    kind: 'subtask',
    type: 'code',
    priority: 'high',
    descriptionMd: 'A detail surface for **one proposal**.',
    explanationMd: 'The second body is carried, diffed and materialized.',
    explanationSource: 'ai_drafted',
    storyPoints: 5,
    estimateMinutes: 120,
    targetRepo: 'moooon-B-V/motir-core',
    executor: 'coding_agent',
    parentIdentifier: 'MOTIR-3070',
  });

describe('ProposalQuickView', () => {
  it('renders BOTH bodies — the WHY is what the review surface used to drop', () => {
    renderWithIntl(<ProposalQuickView item={full()} onClose={vi.fn()} />);

    // `Modal`'s `srTitle` renders the title as a screen-reader heading as well as
    // the visible one, so both carry the name — assert at least one, not exactly one.
    expect(screen.getAllByRole('heading', { name: 'A proposal READ view' }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/A detail surface for/)).toBeTruthy();
    // The body `git grep -c explanationMd` over the review surface used to
    // return 0 for.
    expect(screen.getByText(/The second body is carried/)).toBeTruthy();
    // Markdown is RENDERED, not dumped as source: the bold survives as an element.
    expect(screen.getByText('one proposal').tagName.toLowerCase()).toBe('strong');
  });

  it('shows the fields approval will write — sizing, repo pin, executor, parent', () => {
    renderWithIntl(<ProposalQuickView item={full()} onClose={vi.fn()} />);

    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('120 min')).toBeTruthy();
    // The repo pin routes dispatch and was invisible at the one moment a person
    // could still correct it.
    expect(screen.getByText('moooon-B-V/motir-core')).toBeTruthy();
    expect(screen.getByText('Coding agent')).toBeTruthy();
    expect(screen.getByText('MOTIR-3070')).toBeTruthy();
  });

  it('carries NO write path — read-only, and no edit affordance anywhere', () => {
    renderWithIntl(<ProposalQuickView item={full()} onClose={vi.fn()} />);

    // Guarded on ABSENCE (MOTIR-3084): the proposal edit modal is removed, so no
    // surface may offer a way back into it.
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    // And no "Open full page" — a proposal has no page to open.
    expect(screen.queryByTestId('quick-view-open-full')).toBeNull();
  });

  it('renders nothing when closed', () => {
    renderWithIntl(<ProposalQuickView item={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId('proposal-quick-view')).toBeNull();
  });

  it('a proposal carrying no fields shows the surface without empty rows', () => {
    // The empty case: a bare `add` still opens and reads, with the rail absent
    // rather than a column of dashes.
    renderWithIntl(
      <ProposalQuickView
        item={planReviewItem({ op: 'add', title: 'Bare proposal' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('heading', { name: 'Bare proposal' }).length).toBeGreaterThan(0);
    expect(screen.getByText('No description yet.')).toBeTruthy();
    expect(screen.getByText('No explanation yet.')).toBeTruthy();
    expect(screen.queryByText('Repository')).toBeNull();
  });
});

// ── OPENED ON A `modify` / `remove` (bug MOTIR-4134) ─────────────────────────
//
// This component was written when a proposal quick view could only ever be
// opened on an `add`: the canvas's View pill mounted it, and a `modify` /
// `remove` node peeked its LIVE target through `WorkItemQuickView` instead
// (design Part V §3). MOTIR-4022 made a LIST ROW open this same modal — and the
// list's Updates and Archives sections are exactly the two ops the head's
// hard-coded `New` / `not yet created` is false of.
//
// ⚠️ THE CONSUMER HALF OF A SEAM. Neither half was wrong on its own: the service
// returned what its own documentation promised, the component rendered what it
// was designed to render, and the parity suite held the FIELD LIST with no
// opinion about the op axis. So these assert the RENDER, and
// `tests/integration/plans/planReviewService.test.ts` asserts that the real
// service produces the DTOs they are given — a modify carrying a non-null
// identifier and two non-null bodies. Either half alone passes over the defect.
const modified = (over: Partial<Parameters<typeof planReviewItem>[0]> = {}) =>
  planReviewItem({
    op: 'modify',
    identifier: 'MOTIR-4056',
    title: 'The MAY-I-START rule',
    kind: 'subtask',
    status: 'blocked',
    descriptionMd: 'The **rewritten** WHAT the patch carries.',
    explanationMd: 'The rewritten WHY the patch carries.',
    ...over,
  });

describe('ProposalQuickView — a proposal about a card that ALREADY EXISTS', () => {
  it('names the TARGET and says the plan will change it — not `New` / `not yet created`', () => {
    renderWithIntl(<ProposalQuickView item={modified()} onClose={vi.fn()} />);

    // Asserted on the identity slot itself rather than by text: `MOTIR-4056`
    // can legitimately appear in the rail as a PARENT, and a defect that put the
    // right key in the wrong place would pass a bare `getByText`.
    expect(screen.getByTestId('proposal-quick-view-identity').textContent).toBe('MOTIR-4056');
    expect(screen.getByTestId('proposal-quick-view-op').textContent).toBe('change');
    // The four false statements this bug is named for, asserted absent.
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.queryByText('not yet created')).toBeNull();
    expect(screen.queryByText('No description yet.')).toBeNull();
    expect(screen.queryByText('No explanation yet.')).toBeNull();
  });

  it('renders BOTH bodies the patch proposes — asserted per body, not as a pair', () => {
    // Per body deliberately: a test covering only `descriptionMd` leaves the
    // explanation regressing unseen, which is the exact history of this surface
    // (MOTIR-3070 — carried, diffed, materialized, and read by nothing).
    renderWithIntl(<ProposalQuickView item={modified()} onClose={vi.fn()} />);

    // Matched on the tail rather than the whole sentence: `getNodeText` joins a
    // node's DIRECT text children only, so the `<strong>` splits the paragraph
    // and a regex spanning it can never match. The file's `add` case takes the
    // leading half for the same reason.
    expect(screen.getByText(/WHAT the patch carries/)).toBeTruthy();
    expect(screen.getByText(/The rewritten WHY the patch carries/)).toBeTruthy();
    // Markdown is RENDERED here as it is for an `add`, not dumped as source.
    expect(screen.getByText('rewritten').tagName.toLowerCase()).toBe('strong');
  });

  it('a modify touching NEITHER body shows the target’s CURRENT bodies, not the empty state', () => {
    // "Nothing changes here" and "there is nothing here" are different facts and
    // only one of them is true. The service supplies the live bodies for this
    // case; the component must not have a second opinion about it.
    renderWithIntl(
      <ProposalQuickView
        item={modified({
          descriptionMd: 'The live WHAT, unchanged by this patch.',
          explanationMd: 'The live WHY, unchanged by this patch.',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/The live WHAT, unchanged/)).toBeTruthy();
    expect(screen.getByText(/The live WHY, unchanged/)).toBeTruthy();
    expect(screen.queryByText('No description yet.')).toBeNull();
  });

  it('a REMOVE names its target and says it is being removed — the third op', () => {
    // The op no criterion about `add` or `modify` would otherwise reach, and the
    // one whose body is the only thing that makes the archive legible to whoever
    // is being asked to approve it.
    renderWithIntl(
      <ProposalQuickView
        item={modified({ op: 'remove', descriptionMd: 'What the archive deletes.' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('proposal-quick-view-identity').textContent).toBe('MOTIR-4056');
    expect(screen.getByTestId('proposal-quick-view-op').textContent).toBe('remove');
    expect(screen.getByText(/What the archive deletes/)).toBeTruthy();
  });

  it('renders the RAIL a modify will leave behind — every field, not just the parent (MOTIR-4143)', () => {
    // ⚠️ THE REPORTED SHAPE, and the reason the assertion is per FIELD. The rail
    // mounts on the UNION of these values being non-null and draws each row on
    // its own test, so `getByTestId('proposal-quick-view')` finding a rail — or
    // a single Parent row rendering — is exactly what the defect looked like:
    // *"the fields are not displaying. I only see parent on the right side."*
    renderWithIntl(
      <ProposalQuickView
        item={modified({
          type: 'test',
          priority: 'highest',
          storyPoints: 8,
          estimateMinutes: 65,
          targetRepo: 'moooon-B-V/motir-core',
          executor: 'coding_agent',
          parentIdentifier: 'MOTIR-3942',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('test')).toBeTruthy();
    expect(screen.getByText('highest')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.getByText('65 min')).toBeTruthy();
    expect(screen.getByText('moooon-B-V/motir-core')).toBeTruthy();
    expect(screen.getByText('Coding agent')).toBeTruthy();
    // The one field that was NEVER gated, asserted beside the six that were —
    // it is what made the empty rail render as a rail at all.
    expect(screen.getByText('MOTIR-3942')).toBeTruthy();
  });

  it('the `add` arm still says New · not yet created — the fix is not a swap', () => {
    // Guarded explicitly, because the cheapest way to make every assertion above
    // pass is to invert the constant rather than read the model.
    renderWithIntl(
      <ProposalQuickView
        item={planReviewItem({ op: 'add', title: 'A brand new card' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('proposal-quick-view-identity').textContent).toBe('New');
    expect(screen.getByTestId('proposal-quick-view-op').textContent).toBe('not yet created');
  });
});
