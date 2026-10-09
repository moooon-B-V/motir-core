// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanReviewDto, PlanReviewGateDto } from '@/lib/dto/planReview';

// THE PLAN PAGE DECIDES AN ASKED PLAN TOO (Story MOTIR-6012 · MOTIR-6037; design Part XXII
// §22.4–§22.5, `plan-review--decide.mock.html` Panel 8). Its existing CTA IS the gate's
// Approve and its ghost Decline IS the gate's Decline; what an asked plan adds is the
// decline's confirm band with an OPTIONAL reason and the stale refusal in the design's
// words. (The no-conversation notice it once added was retired by Story MOTIR-7883.)

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  approvePlanRequest: vi.fn(async () => ({})),
  declinePlanRequest: vi.fn(async () => ({})),
  fetchPlanReview: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
  usePathname: () => '/plans/plan_1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    approvePlanRequest: mocks.approvePlanRequest,
    declinePlanRequest: mocks.declinePlanRequest,
    fetchPlanReview: mocks.fetchPlanReview,
  };
});
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="plan-review-canvas" />,
}));
vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: () => null,
}));

const { PlanDetail } = await import('@/components/planning/PlanDetail');
const { PlanRequestError } = await import('@/lib/planning/planReviewClient');

const GATE: PlanReviewGateDto = {
  id: 'gate_1',
  state: 'awaiting',
  stamp: 'stamp_1',
  held: null,
  canDecide: true,
  routedToName: 'Dana Ortiz',
};

function asked(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return planReview([planReviewItem({ title: 'Invoices' })], {
    title: 'Split invoicing out of billing',
    gate: GATE,
    conversation: { sessionId: 's_1', hasTurns: true, targetKeys: [] },
    ...over,
  });
}

beforeEach(() => {
  mocks.fetchPlanReview.mockImplementation(async () => asked());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Decline confirms once, with an OPTIONAL reason (Panel 8)', () => {
  it('the ghost Decline puts the band up in its place, and sends nothing yet', () => {
    renderWithIntl(<PlanDetail initialReview={asked()} projectKey="ACME" />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    const band = screen.getByTestId('plan-decline-confirm');
    expect(band.textContent).toContain('Declining this plan will:');
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    // The existing CTA is unmoved.
    expect(screen.getByRole('button', { name: /Approve — add 1 item/ })).toBeTruthy();
    expect(mocks.declinePlanRequest).not.toHaveBeenCalled();
  });

  it('declines with the stamp and the reason the reader gave', async () => {
    renderWithIntl(<PlanDetail initialReview={asked()} projectKey="ACME" />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.change(screen.getByLabelText('Why are you declining it?'), {
      target: { value: 'Not this quarter' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    });
    await waitFor(() =>
      expect(mocks.declinePlanRequest).toHaveBeenCalledWith(
        'plan_1',
        'stamp_1',
        'Not this quarter',
      ),
    );
  });

  it('declines with an EMPTY field too — no reason is sent', async () => {
    renderWithIntl(<PlanDetail initialReview={asked()} projectKey="ACME" />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    });
    await waitFor(() => expect(mocks.declinePlanRequest).toHaveBeenCalledWith('plan_1', 'stamp_1'));
  });

  it('Cancel restores Decline and decides nothing', () => {
    renderWithIntl(<PlanDetail initialReview={asked()} projectKey="ACME" />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('plan-decline-confirm')).toBeNull();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(mocks.declinePlanRequest).not.toHaveBeenCalled();
  });

  it('an UNASKED planned plan still declines on one press — that path is unchanged', async () => {
    renderWithIntl(<PlanDetail initialReview={asked({ gate: null })} projectKey="ACME" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    });
    expect(screen.queryByTestId('plan-decline-confirm')).toBeNull();
    await waitFor(() => expect(mocks.declinePlanRequest).toHaveBeenCalledWith('plan_1', null));
  });
});

describe('REFUSED AS STALE — in the design’s words (§22.5)', () => {
  it('a stale approve re-reads the plan and says it changed, as an alert', async () => {
    mocks.approvePlanRequest.mockRejectedValueOnce(
      new PlanRequestError(409, 'APPROVAL_GATE_STALE_SUBJECT'),
    );
    renderWithIntl(<PlanDetail initialReview={asked()} projectKey="ACME" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve — add 1 item/ }));
    });
    const band = await screen.findByTestId('plan-decide-stale');
    expect(band.getAttribute('role')).toBe('alert');
    expect(band.textContent).toContain('This plan changed while you were reading it.');
    expect(mocks.fetchPlanReview).toHaveBeenCalled();
  });

  it('a question raised under a plain press reads the same', async () => {
    mocks.approvePlanRequest.mockRejectedValueOnce(new PlanRequestError(409, 'PLAN_GATE_AWAITING'));
    renderWithIntl(<PlanDetail initialReview={asked({ gate: null })} projectKey="ACME" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve — add 1 item/ }));
    });
    expect(await screen.findByTestId('plan-decide-stale')).toBeTruthy();
  });
});

// HISTORY. Story MOTIR-6043 · MOTIR-6045 (design Part XXI §21.6) narrowed this block's
// notice from three causes (an agent's plan, a cadence plan, an earlier plan — all of
// which HAVE sessions and open the planning surface) to one: a plan whose `sessionId` is
// null, with the sentence *"There is no conversation on record for this plan."*
//
// ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7885). Every plan has a session now
// (`createPlan` attaches one; MOTIR-6020 backfilled the rest), so the null is an
// invariant breach, and the notice — a sanctioned second road to deciding a plan outside
// the overlay — is gone. What stays is its DETECTOR: nothing renders for that state.
describe('NO SESSION — the page renders no reason (retired by Story MOTIR-7883)', () => {
  it('an asked plan with NO session renders no notice and no old copy, whatever wrote it', () => {
    for (const over of [
      { conversation: null },
      { conversation: null, authorSource: 'mcp' as const, authorHarness: 'Claude Code' },
      { conversation: null, origin: 'cadence' as const },
    ]) {
      const { container, unmount } = renderWithIntl(
        <PlanDetail initialReview={asked(over)} projectKey="ACME" />,
      );
      expect(screen.queryByTestId('plan-no-conversation')).toBeNull();
      expect(container.textContent).not.toContain('no conversation on record');
      unmount();
    }
  });
});
