// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// MOTIR-3240 — a `generating` plan CAN be ended, and this rail was the only thing
// saying otherwise. `plansService.declinePlan` has accepted `generating` since
// MOTIR-3189 (recording `decisionReason: 'discarded'`) and the route adds no
// guard of its own; the rail's `disabled={!planned}` was written when the service
// DID refuse and stayed correct-looking after it stopped. So the valve had no
// handle, and a plan nobody was producing any more sat at the top of the Plans
// list with a spinner and no action.
//
// Built to `design/ai-planning/design-notes.md` Part VIII §4 and
// `plan-detail-list-view.mock.html` panel 4.
//
// ⚠️ EVERY TEST HERE ASSERTS THE APPROVE SIDE TOO. Widening the decline path is
// exactly the change that could quietly widen the approve path, and `approvePlan`
// refuses anything but `planned` — so a rail that offered Approve on a
// `generating` plan would be offering a button the server will reject.

afterEach(cleanup);

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: 'Stripe Connect payouts',
    summary: null,
    itemCount: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    plannedAt: '2026-08-19T00:00:00.000Z',
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
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    revision: null,
    ...over,
  };
}

function renderRail(over: Partial<PlanReviewDto> = {}, onDecline = () => {}) {
  return renderWithIntl(
    <PlanReviewRail
      review={review(over)}
      onApprove={() => {}}
      onDecline={onDecline}
      busy={false}
      errorCode={null}
    />,
  );
}

const approveButton = () => screen.queryByRole('button', { name: /Approve/ });

describe('the rail while a plan is GENERATING (MOTIR-3240)', () => {
  it('offers an ENABLED discard control', () => {
    renderRail({ status: 'generating', plannedAt: null });

    const discard = screen.getByRole('button', { name: 'Discard this plan' });
    expect(discard.hasAttribute('disabled')).toBe(false);
  });

  it('keeps APPROVE disabled — nothing here widens what may be materialized', () => {
    renderRail({ status: 'generating', plannedAt: null });

    // `approvePlan` refuses anything but `planned`; a live Approve here would be
    // a button the server rejects.
    expect(approveButton()!.hasAttribute('disabled')).toBe(true);
  });

  it('replaces the `reviewLocked` hint rather than removing it', () => {
    renderRail({ status: 'generating', plannedAt: null });

    // The old hint was true of BOTH buttons and is now true of one. A hint under
    // two buttons that describes only one is how the live control reads as
    // disabled too.
    expect(screen.queryByText(/Review unlocks when generation completes/)).toBeNull();
    expect(screen.getByText(/Discarding ends it now/)).toBeTruthy();
  });

  it('calls back when pressed — the confirm is the page island’s, not the rail’s', () => {
    const onDecline = vi.fn();
    renderRail({ status: 'generating', plannedAt: null }, onDecline);

    fireEvent.click(screen.getByRole('button', { name: 'Discard this plan' }));

    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('says DISCARD, not Decline', () => {
    renderRail({ status: 'generating', plannedAt: null });

    // The copy is a decision (Part VIII §4): declining is what you do to a
    // finished proposal you have read; a plan that never finished is being ENDED,
    // and `decisionReason` already tells the two apart on the row.
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard this plan' })).toBeTruthy();
  });
});

describe('the other three statuses are unchanged (MOTIR-3240)', () => {
  it('`planned` still shows Approve + Decline, both enabled, with its own hint', () => {
    renderRail();

    expect(approveButton()!.hasAttribute('disabled')).toBe(false);
    const decline = screen.getByRole('button', { name: 'Decline' });
    expect(decline.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Discard this plan' })).toBeNull();
    expect(screen.getByText(/Approve materializes the proposals/)).toBeTruthy();
  });

  it.each(['approved', 'declined'] as const)(
    'a %s plan shows the decided outcome and NO decision control',
    (status) => {
      renderRail({ status, decidedAt: '2026-08-19T01:00:00.000Z' });

      expect(approveButton()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Discard this plan' })).toBeNull();
    },
  );

  it('a DISCARDED plan reads its own outcome line, not the generic declined one', () => {
    // The reason-specific line is the whole point of MOTIR-3189 one layer down:
    // three endings share `declined`, and rendering them identically is the
    // defect that card fixed. A discard produced from this rail must land on the
    // discarded sentence.
    renderRail({
      status: 'declined',
      decidedAt: '2026-08-19T01:00:00.000Z',
      decisionReason: 'discarded',
    });

    expect(screen.getByText(/Plan discarded before it finished/)).toBeTruthy();
    expect(screen.queryByText(/Plan declined — your tree was left untouched/)).toBeNull();
  });

  it('a REVIEWED decline still reads the generic declined line', () => {
    renderRail({
      status: 'declined',
      decidedAt: '2026-08-19T01:00:00.000Z',
      decisionReason: 'reviewed',
    });

    expect(screen.getByText(/Plan declined — your tree was left untouched/)).toBeTruthy();
  });
});

describe('busy', () => {
  it('the discard control is disabled while an action is in flight', () => {
    renderWithIntl(
      <PlanReviewRail
        review={review({ status: 'generating', plannedAt: null })}
        onApprove={() => {}}
        onDecline={() => {}}
        busy
        errorCode={null}
      />,
    );

    expect(screen.getByRole('button', { name: 'Discard this plan' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
