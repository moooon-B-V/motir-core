// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import {
  APPROVE_SLOW_AFTER_MS,
  PlanApproveProgress,
  type PlanApproveProgressView,
} from '@/components/planning/PlanApproveProgress';
import {
  PLAN_CONFIRM_BAR_HEIGHT,
  PlanChangeConfirmBar,
} from '@/components/planning/PlanChangeConfirmBar';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planDecisionErrorCode } from '@/lib/planning/planReview';
import { PlanRequestError } from '@/lib/planning/planReviewClient';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanGateView } from '@/lib/planning/planGateView';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// WHAT APPROVE SAYS WHILE IT RUNS (Subtask MOTIR-5249; design Part XXV of
// `design/ai-planning/design-notes.md`). The component is presentational, so each
// state is asserted by handing it the props; the two doors are asserted the same way,
// with the view the host derives.

const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TOGETHER = 'They all arrive together when it finishes.';
const SLOW = 'Still working — a large plan takes longer. There’s no need to press again.';
const TIMED_OUT_TITLE = 'Nothing was created — approving took too long.';
const TIMED_OUT_NEXT =
  'This plan still awaits your decision, unchanged. It’s safe to approve again.';

describe('PlanApproveProgress — the component, from its five props alone', () => {
  it('renders the creating line with the count, and fetches nothing', () => {
    renderWithIntl(<PlanApproveProgress state="running" count={3} kind="adds" place="rail" />);

    expect(screen.getByText('Adding 3 items to your backlog…')).toBeTruthy();
    expect(screen.getByText(TOGETHER)).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says "applying N changes" for a mixed plan, with the review count rather than the adds', () => {
    // A mixed plan: 2 adds, 1 modify, 1 remove — the review counts all four.
    const review = mixedReview();
    const index = indexPlanReview(review);
    expect(index.counts.added).toBe(2);
    expect(review.itemCount).toBe(4);

    renderWithIntl(
      <PlanApproveProgress
        state="running"
        count={review.itemCount}
        kind={index.counts.changed + index.counts.removed > 0 ? 'changes' : 'adds'}
        place="bar"
      />,
    );

    expect(screen.getByText('Applying 4 changes to your backlog…')).toBeTruthy();
    expect(screen.queryByText(/Adding/)).toBeNull();
  });

  it('swaps only the lower line at the §25.3 threshold — 8 000 ms, not 7 999', () => {
    vi.useFakeTimers();
    renderWithIntl(<PlanApproveProgress state="running" count={18} kind="changes" place="bar" />);
    const upper = 'Applying 18 changes to your backlog…';
    const spinnerBefore = screen
      .getByTestId('plan-approve-progress')
      .querySelector('.animate-spin');

    act(() => {
      vi.advanceTimersByTime(APPROVE_SLOW_AFTER_MS - 1);
    });
    expect(screen.getByText(TOGETHER)).toBeTruthy();
    expect(screen.queryByText(SLOW)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(SLOW)).toBeTruthy();
    expect(screen.queryByText(TOGETHER)).toBeNull();
    expect(screen.getByText(upper)).toBeTruthy();
    expect(screen.getByTestId('plan-approve-progress').querySelector('.animate-spin')).toBe(
      spinnerBefore,
    );
    expect(APPROVE_SLOW_AFTER_MS).toBe(8_000);
  });

  it('renders the timed-out band — alert, yellow, hidden glyph — and no running line', () => {
    renderWithIntl(<PlanApproveProgress state="timedOut" count={18} kind="changes" place="rail" />);

    const band = screen.getByRole('alert');
    expect(band.getAttribute('data-testid')).toBe('plan-approve-timed-out');
    expect(band.className).toContain('bg-(--el-tint-yellow)');
    expect(band.textContent).toContain(TIMED_OUT_TITLE);
    expect(band.textContent).toContain(TIMED_OUT_NEXT);
    expect(band.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText(/Applying|Adding/)).toBeNull();
    expect(screen.queryByText(TOGETHER)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a mirror instance is silent: no live region, hidden from assistive tech', () => {
    renderWithIntl(
      <PlanApproveProgress state="running" count={2} kind="adds" place="rail" announce={false} />,
    );
    const mirror = screen.getByTestId('plan-approve-progress');
    expect(mirror.getAttribute('role')).toBeNull();
    expect(mirror.getAttribute('aria-hidden')).toBe('true');
  });

  it('reduced motion: the spinner stops, every string is identical, and the swap still happens', () => {
    vi.useFakeTimers();
    const { container } = renderWithIntl(
      <PlanApproveProgress state="running" count={5} kind="adds" place="rail" />,
    );
    const spinner = container.querySelector('.animate-spin');
    expect(spinner?.className).toContain('motion-reduce:animate-none');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Adding 5 items to your backlog…')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(APPROVE_SLOW_AFTER_MS);
    });
    expect(screen.getByText(SLOW)).toBeTruthy();
  });

  it('renders the zh catalog', () => {
    renderWithIntl(<PlanApproveProgress state="running" count={4} kind="adds" place="rail" />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByText('正在将 4 个工作项加入待办列表…')).toBeTruthy();
    expect(screen.getByText('完成后它们会一起出现。')).toBeTruthy();
  });
});

describe('the timeout is discriminated, not lumped', () => {
  it('maps PLAN_APPROVE_TIMED_OUT to its own key, and leaves the other refusals alone', () => {
    expect(planDecisionErrorCode(new PlanRequestError(503, 'PLAN_APPROVE_TIMED_OUT'))).toBe(
      'timedOut',
    );
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_REVISION_IN_FLIGHT'))).toBe(
      'held',
    );
    expect(planDecisionErrorCode(new PlanRequestError(500, 'BOOM'))).toBe('APPROVE_ERROR');
  });
});

// ── the two doors ──────────────────────────────────────────────────────────────

const DECIDE: PlanGateView = { kind: 'decide' };

function running(announce: boolean): PlanApproveProgressView {
  return { state: 'running', count: 4, kind: 'changes', announce };
}
const TIMED_OUT: PlanApproveProgressView = { state: 'timedOut', count: 4, kind: 'changes' };

function renderBar(approveProgress: PlanApproveProgressView | null, view: PlanGateView = DECIDE) {
  const review = mixedReview();
  return renderWithIntl(
    <PlanChangeConfirmBar
      index={indexPlanReview(review)}
      deciding={approveProgress?.state === 'running'}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      view={view}
      approveProgress={approveProgress}
    />,
  );
}

describe('the confirm bar door', () => {
  it('while running, its contents ARE the progress, inside the same bar at its own height', () => {
    const { rerender } = renderBar(null);
    const bar = screen.getByTestId('plan-change-confirm-bar');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();

    rerender(
      <PlanChangeConfirmBar
        index={indexPlanReview(mixedReview())}
        deciding
        onApprove={vi.fn()}
        onDiscard={vi.fn()}
        view={DECIDE}
        approveProgress={running(true)}
      />,
    );

    const after = screen.getByTestId('plan-change-confirm-bar');
    expect(after).toBe(bar);
    expect(after.style.minHeight).toBe(PLAN_CONFIRM_BAR_HEIGHT);
    expect(after.querySelector('[data-testid="plan-approve-progress"]')).toBeTruthy();
    expect(screen.getByText('Applying 4 changes to your backlog…')).toBeTruthy();
    // No verb remains to press a second time.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('the ungated bar composes it too', () => {
    renderBar(running(true), { kind: 'ungated' });
    expect(screen.getByText('Applying 4 changes to your backlog…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve changes' })).toBeNull();
  });

  it('on a timeout the band stacks ABOVE the bar, and the verbs are back and live', () => {
    renderBar(TIMED_OUT);
    const band = screen.getByTestId('plan-approve-timed-out');
    const bar = screen.getByTestId('plan-change-confirm-bar');
    expect(band.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(band.getAttribute('role')).toBe('alert');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function railState(review: PlanReviewDto, extra: Partial<PlanChangeConversationState> = {}) {
  const state: PlanChangeConversationState = {
    phase: 'review',
    session: null,
    progress: null,
    review,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: null,
    planId: 'plan-1',
    approved: null,
    errorCode: null,
    outOfCredits: false,
    stopping: false,
    stopped: false,
    queued: [],
    earlier: null,
    reopened: null,
    readOnly: false,
    acts: [],
    ...extra,
  };
  return state;
}

function renderRail(
  approveProgress: PlanApproveProgressView | null,
  extra: Partial<PlanChangeConversationState> = {},
  gateView: PlanGateView = DECIDE,
) {
  const review = mixedReview();
  const state = railState(review, extra);
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      gateView={gateView}
      approveProgress={approveProgress}
    />,
  );
}

describe('the rail review-block door', () => {
  it('while running, the rail form replaces the verbs', () => {
    renderRail(running(true), { phase: 'deciding' });
    const review = screen.getByTestId('plan-change-review');
    expect(review.querySelector('[data-testid="plan-approve-progress"]')).toBeTruthy();
    expect(screen.getByText('Applying 4 changes to your backlog…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('the ungated block steps its verbs aside too', () => {
    renderRail(running(true), { phase: 'deciding' }, { kind: 'ungated' });
    expect(screen.getByText('Applying 4 changes to your backlog…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a timeout puts the band in the block, and NOT the generic failure bubble', () => {
    renderRail(TIMED_OUT, { errorCode: 'timedOut' });
    expect(screen.getByTestId('plan-change-review').textContent).toContain(TIMED_OUT_TITLE);
    expect(screen.queryByText(/That didn’t go through|That didn't go through/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('another refusal keeps the shipped generic failure and gets no band', () => {
    renderRail(null, { errorCode: 'APPROVE_ERROR' });
    expect(screen.queryByTestId('plan-approve-timed-out')).toBeNull();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

describe('both doors at once — one press is read once', () => {
  function renderBoth(pressed: 'bar' | 'rail') {
    renderBar(running(pressed === 'bar'));
    renderRail(running(pressed === 'rail'), { phase: 'deciding' });
  }

  it.each(['bar', 'rail'] as const)('pressed from the %s: exactly one live region', (pressed) => {
    renderBoth(pressed);
    const surfaces = screen.getAllByTestId('plan-approve-progress');
    expect(surfaces).toHaveLength(2);
    const live = surfaces.filter((el) => el.getAttribute('role') === 'status');
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute('data-place')).toBe(pressed);
    // The two doors read the same words for the same state.
    expect(screen.getAllByText('Applying 4 changes to your backlog…')).toHaveLength(2);
  });
});

function mixedReview(): PlanReviewDto {
  return planReview([
    planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Invoices' }),
    planReviewItem({ planItemId: 'pi_2', nodeId: 'pi_2', kind: 'subtask', title: 'Schedule' }),
    planReviewItem({
      planItemId: 'pi_3',
      op: 'modify',
      nodeId: 'wi_21',
      identifier: 'PAY-21',
      title: 'Email reminders',
      changes: [{ field: 'title', from: 'Payment reminders', to: 'Email reminders' }],
    }),
    planReviewItem({
      planItemId: 'pi_4',
      op: 'remove',
      nodeId: 'wi_24',
      identifier: 'PAY-24',
      title: 'SMS reminder',
    }),
  ]);
}
