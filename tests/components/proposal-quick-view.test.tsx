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
