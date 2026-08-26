// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// THE FIFTH `PlanStatus` MEMBER on the two surfaces that ask *is this decided?*
// (Bug MOTIR-3560 · Subtask MOTIR-3578), drawn to
// `design/ai-planning/design-notes.md` Part XI §5 and decided by
// `docs/decisions/agent-authored-plans.md` AMENDMENT 9 D6.
//
// ⚠️ WHY `decided` IS THE PREDICATE MOST WORTH ASSERTING. `PlanReviewRail` and
// `PlanDetail` each compute it as `status === 'approved' || status === 'declined'`
// — two components, two copies, no shared source. Both keep answering FALSE for
// the new status, and that is not a detail: read as decided, the rail swaps its
// controls for the read-only outcome block, so the reviewer of the one plan the
// system has just flagged would be shown a summary and no way to act. The
// neighbouring failure has happened once already — `PlanDetail`'s own comment
// records a declined plan falling into the empty state and SHADOWING the rail's
// outcome line (MOTIR-1377).

afterEach(cleanup);

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'stale',
    title: 'Rework the seller settings pane',
    summary: null,
    itemCount: 11,
    createdAt: '2026-08-23T00:00:00.000Z',
    plannedAt: '2026-08-23T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    ...over,
  };
}

function renderRail(over: Partial<PlanReviewDto> = {}) {
  return renderWithIntl(
    <PlanReviewRail
      review={review(over)}
      onApprove={() => {}}
      onDecline={() => {}}
      busy={false}
      errorCode={null}
    />,
  );
}

describe('the review rail — `stale` is LIVE, not decided', () => {
  it('keeps the CONTROLS rather than swapping in the decided outcome block', () => {
    renderRail();
    // The decided block renders the approved/declined outcome and no buttons at
    // all. Its absence, plus a real Approve, is what says `decided` stayed false.
    expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(screen.queryByText(/your tree was left untouched/)).toBeNull();
    expect(screen.queryByText(/Added .* to your backlog/)).toBeNull();
  });

  it('states the outcome line the design wrote — what happened AND what is left', () => {
    renderRail();
    // ⚠️ NOT `declined`'s line, which is an ENDING. This one has to say what
    // happened and what the reader can still do, and it must not offer a repair
    // that does not exist: AMENDMENT 9 D4 established there is no
    // `stale -> generating` edge (Part XI §5).
    expect(screen.getByTestId('plan-stale-outcome').textContent).toContain('Plan out of date');
    expect(screen.getByText(/Approve is unavailable/)).toBeTruthy();
    expect(screen.getByText(/wait in case the work reopens/)).toBeTruthy();
  });

  it('DISABLES approve — the button the reviewer came for is visibly the unavailable one', () => {
    renderRail();
    // `approvePlan` refuses anything but `planned`, so an enabled Approve here
    // would be offering a button the server rejects. Drawn disabled rather than
    // hidden, so the reader can see WHICH affordance is gone (Part XI §5).
    expect(screen.getByRole('button', { name: /Approve/ }).hasAttribute('disabled')).toBe(true);
  });

  it('ENABLES decline — one of the status’s only two exits', () => {
    renderRail();
    // `declinePlan` accepts `stale` as a legal origin (MOTIR-3579), and the two
    // ship together so the rail never offers a button the service rejects. A
    // disabled control here would make the status a dead end wearing a live
    // face — the shape MOTIR-3240 found on `generating`.
    expect(screen.getByRole('button', { name: /Decline/ }).hasAttribute('disabled')).toBe(false);
  });

  it('does not render the `generating` discard control', () => {
    renderRail();
    expect(screen.queryByTestId('plan-discard')).toBeNull();
  });

  it('a PLANNED plan is unchanged — the widening touched only the new status', () => {
    renderRail({ status: 'planned' });
    expect(screen.queryByTestId('plan-stale-outcome')).toBeNull();
    expect(screen.getByRole('button', { name: /Approve/ }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/Approve materializes the proposals/)).toBeTruthy();
  });

  it('a DECIDED plan still shows its outcome block — `decided` still answers true', () => {
    renderRail({ status: 'declined', decidedAt: '2026-08-24T00:00:00.000Z' });
    expect(screen.getByText(/your tree was left untouched/)).toBeTruthy();
    expect(screen.queryByTestId('plan-stale-outcome')).toBeNull();
  });
});
