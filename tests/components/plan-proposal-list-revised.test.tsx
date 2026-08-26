// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PlanProposalList } from '@/components/planning/PlanProposalList';

// Story MOTIR-3595 · Subtask MOTIR-3601 — the *Revised* marker
// (`design/ai-planning/design-notes.md` Part XII §E).
//
// The decision this pins: WHAT CHANGED reads in the LIST, not on the canvas.
// Part IX's *Show changes* already rings every PROPOSAL on the canvas and means
// *which of these is proposed?*; a reviewer returning from a revision asks
// *which of these moved since I looked?* A second ring on the same canvas to
// mean a second thing gives one surface two highlight languages.

afterEach(cleanup);

describe('the Revised pill', () => {
  it('marks the rows the revision touched and leaves the others alone', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          planReviewItem({ planItemId: 'a', nodeId: 'a', title: 'Untouched', revised: false }),
          planReviewItem({ planItemId: 'b', nodeId: 'b', title: 'Moved', revised: true }),
        ]}
        decided={false}
      />,
    );
    expect(screen.getAllByText('Revised')).toHaveLength(1);
    const moved = screen.getByText('Moved').closest('li')!;
    expect(within(moved).getByText('Revised')).toBeTruthy();
    const untouched = screen.getByText('Untouched').closest('li')!;
    expect(within(untouched).queryByText('Revised')).toBeNull();
  });

  it('does NOT replace the op chip — op says WHICH change, the pill says THAT it moved', () => {
    renderWithIntl(
      <PlanProposalList
        items={[planReviewItem({ planItemId: 'b', nodeId: 'b', title: 'Moved', revised: true })]}
        decided={false}
      />,
    );
    const row = screen.getByText('Moved').closest('li')!;
    // Both are present, in the same cluster: they are orthogonal, exactly as
    // Part IX §L2 holds for the canvas's emphasis, and a build must not read
    // either as an alternative to the other.
    expect(within(row).getByText('Revised')).toBeTruthy();
    expect(within(row).getByText('add')).toBeTruthy();
  });

  it('carries its own WORD, so no row state is conveyed by colour alone', () => {
    renderWithIntl(
      <PlanProposalList
        items={[planReviewItem({ planItemId: 'b', nodeId: 'b', title: 'Moved', revised: true })]}
        decided={false}
      />,
    );
    expect(screen.getByText('Revised').textContent).toContain('Revised');
  });

  it('a plan nobody revised renders exactly as it did before this story', () => {
    renderWithIntl(
      <PlanProposalList
        items={[planReviewItem({ planItemId: 'a', nodeId: 'a', title: 'Untouched' })]}
        decided={false}
      />,
    );
    expect(screen.queryByText('Revised')).toBeNull();
  });
});
