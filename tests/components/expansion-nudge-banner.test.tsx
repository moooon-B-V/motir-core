// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

// The `/ready` expansion nudge (MOTIR-904), moved off the dead `planDelta` onto
// the run's PLAN by MOTIR-1747.
//
// The bug in one sentence: motir-ai's `expand_item` handler returns
// `planDelta: { operations: [] }` and writes its real output as PlanItem
// proposals, so a banner polling the job result for `create` ops could NEVER
// leave "Expanding…" — it proposed nothing, every time, while the proposals sat
// unread in the Plan. So the first test drives exactly that shape: a run whose
// job result carries an empty delta, whose Plan carries real proposals.

const { submitExpand, fetchReview, approve, decline } = vi.hoisted(() => ({
  submitExpand: vi.fn(),
  fetchReview: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn(),
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return { ...actual, submitExpandJob: submitExpand };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    approvePlanRequest: approve,
    declinePlanRequest: decline,
  };
});

import { ExpansionNudgeBanner } from '@/app/(authed)/ready/_components/ExpansionNudgeBanner';

const NUDGE = {
  nominatedKey: 'MOTIR-7',
  nominatedTitle: 'Billing',
  readyCount: 1,
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => NUDGE })) as unknown as typeof fetch,
  );
  sessionStorage.clear();
  // The banner polls the plan on an interval; fake timers make the poll a step
  // the test takes rather than a race it waits out.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  cleanup();
});

/** Click Expand and let the banner's poll tick once. */
async function expandAndPoll(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Expand' }));
  await tick();
}

/** Advance past one poll interval, flushing the effects it schedules. */
async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
}

async function click(name: string): Promise<void> {
  const button = await screen.findByRole('button', { name });
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('ExpansionNudgeBanner', () => {
  it('renders the run’s PROPOSALS where the empty delta rendered none', async () => {
    submitExpand.mockResolvedValue({ jobId: 'job_1', planId: 'plan_1' });
    fetchReview.mockResolvedValue(
      planReview([
        planReviewItem({ planItemId: 'pi_1', title: 'Session cookies', kind: 'subtask' }),
        planReviewItem({ planItemId: 'pi_2', title: 'Token rotation', kind: 'subtask' }),
      ]),
    );

    renderWithIntl(<ExpansionNudgeBanner />);
    await expandAndPoll();

    expect(await screen.findByText('Proposed children')).toBeTruthy();
    expect(screen.getByText('Session cookies')).toBeTruthy();
    expect(screen.getByText('Token rotation')).toBeTruthy();
    expect(fetchReview).toHaveBeenCalledWith('plan_1', undefined);
  });

  it('names a proposal that CHANGES or REMOVES existing work, not just the additions', async () => {
    // Approving persists everything in the plan; the delta contract had no
    // `remove` op at all, so a run that proposed one showed the user nothing.
    submitExpand.mockResolvedValue({ jobId: 'job_2', planId: 'plan_2' });
    fetchReview.mockResolvedValue(
      planReview([
        planReviewItem({ planItemId: 'pi_1', op: 'modify', title: 'Rename the epic' }),
        planReviewItem({ planItemId: 'pi_2', op: 'remove', title: 'Stale spike' }),
      ]),
    );

    renderWithIntl(<ExpansionNudgeBanner />);
    await expandAndPoll();

    expect(await screen.findByText('change')).toBeTruthy();
    expect(screen.getByText('remove')).toBeTruthy();
  });

  it('APPROVE confirms through the plans approve route and says what landed', async () => {
    submitExpand.mockResolvedValue({ jobId: 'job_3', planId: 'plan_3' });
    fetchReview.mockResolvedValue(planReview([planReviewItem({ title: 'Session cookies' })]));
    approve.mockResolvedValue({
      items: [{ id: 'pi_1', op: 'add', workItemId: 'wi_1' }],
    } as unknown as PlanWithItemsDto);

    renderWithIntl(<ExpansionNudgeBanner />);
    await expandAndPoll();
    await click('Approve');

    await waitFor(() => expect(approve).toHaveBeenCalledWith('plan_3'));
    expect(await screen.findByText('1 child created')).toBeTruthy();
  });

  it('DECLINE decides the plan — the waved-away run is not left pending', async () => {
    // Without this, the plan sits at `planned` forever and the auto-plan pause
    // (MOTIR-1740) reads it as a proposal awaiting review, indefinitely.
    submitExpand.mockResolvedValue({ jobId: 'job_4', planId: 'plan_4' });
    fetchReview.mockResolvedValue(planReview([planReviewItem()]));
    decline.mockResolvedValue({ id: 'plan_4', status: 'declined' });

    renderWithIntl(<ExpansionNudgeBanner />);
    await expandAndPoll();
    await click('Decline');

    await waitFor(() => expect(decline).toHaveBeenCalledWith('plan_4'));
    expect(approve).not.toHaveBeenCalled();
  });

  it('keeps polling while the plan is still generating', async () => {
    submitExpand.mockResolvedValue({ jobId: 'job_5', planId: 'plan_5' });
    fetchReview
      .mockResolvedValueOnce(planReview([], { status: 'generating' }))
      .mockResolvedValue(planReview([planReviewItem({ title: 'Arrived late' })]));

    renderWithIntl(<ExpansionNudgeBanner />);
    await expandAndPoll();
    expect(screen.queryByText('Arrived late')).toBeNull();

    await tick();
    expect(await screen.findByText('Arrived late')).toBeTruthy();
  });
});
