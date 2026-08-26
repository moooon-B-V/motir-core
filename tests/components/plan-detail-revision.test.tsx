// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// Story MOTIR-3595 · Subtask MOTIR-3601 — the revision affordance on the plan
// review surface (`design/ai-planning/design-notes.md` Part XII).
//
// What is pinned here is what only this island can be wrong about:
//
//  * the affordance is PRESENT where the asset places it and ABSENT where a
//    revision is impossible — the criterion that a reviewer is never offered a
//    verb that will be refused;
//  * a submit reaches the `revise_plan` route and returns the reader to a
//    clearly IN-FLIGHT state, with Approve HELD and the reason in real text;
//  * ⚠️ the ASYNC LANDING routes each surface to its own mechanism — the
//    island's own state through a REFETCH, the server-rendered surfaces through
//    `router.refresh()`. Assuming the refresh covers both is the recurring bug
//    the page-state contract exists to prevent, and a client island seeded by
//    `useState(initialProps)` is exactly what it cannot reach;
//  * a REFUSED revision surfaces the reason in place and leaves the plan
//    readable and approvable.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  approvePlanRequest: vi.fn(async () => ({})),
  declinePlanRequest: vi.fn(async () => ({})),
  fetchPlanReview: vi.fn(),
  revisePlanRequest: vi.fn(async () => ({ jobId: 'job_1', planId: 'plan_1' })),
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
    revisePlanRequest: mocks.revisePlanRequest,
  };
});

vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="plan-review-canvas" />,
}));
vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: () => <div data-testid="repository-set-step" />,
}));

import { PlanDetail } from '@/components/planning/PlanDetail';
import { PlanRequestError } from '@/lib/planning/planReviewClient';

const RUNNING = {
  heldBy: 'Motir AI',
  expiresAt: '2026-08-26T10:10:00.000Z',
  startedAt: '2026-08-26T10:00:00.000Z',
};

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return planReview([planReviewItem({ title: 'The second story' })], over);
}

function render(over: Partial<PlanReviewDto> = {}) {
  return renderWithIntl(<PlanDetail initialReview={review(over)} projectKey="MOTIR" />);
}

function composer(): HTMLInputElement {
  return screen.getByPlaceholderText('Ask Motir to change this plan…') as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPlanReview.mockResolvedValue(review());
});
afterEach(cleanup);

describe('the ask — where it is, and where it is NOT', () => {
  it('renders in the rail on a `planned` plan, keyboard-reachable with an accessible name', () => {
    render();
    const field = composer();
    expect(field).toBeTruthy();
    // The accessible name TRACKS the prompt — the shipped composer's own
    // contract, so a screen reader hears the same ask the placeholder shows.
    expect(field.getAttribute('aria-label')).toBe('Ask Motir to change this plan…');
    expect(field.tagName).toBe('INPUT');
  });

  it('offers NO `@` target picker — a revision can only name proposals, which have no key', () => {
    render();
    expect(screen.queryByTestId('planning-target-trigger')).toBeNull();
    expect(screen.queryByTestId('planning-target-tray')).toBeNull();
    // And the role goes with it: a combobox that owns no popup and can never
    // expand promises an autocomplete this surface does not have.
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('is ABSENT on a DECIDED plan — never a verb that will be refused', () => {
    render({ status: 'approved', decidedAt: '2026-08-26T09:00:00.000Z' });
    expect(screen.queryByPlaceholderText('Ask Motir to change this plan…')).toBeNull();
    cleanup();
    render({ status: 'declined', decidedAt: '2026-08-26T09:00:00.000Z' });
    expect(screen.queryByPlaceholderText('Ask Motir to change this plan…')).toBeNull();
  });

  it('is ABSENT while the plan is still GENERATING — there is nothing to revise yet', () => {
    render({ status: 'generating' });
    expect(screen.queryByPlaceholderText('Ask Motir to change this plan…')).toBeNull();
  });

  it('says what Send does ONLY once the field carries an instruction', () => {
    render();
    expect(
      screen.queryByText(
        'Motir changes this plan. Nothing reaches your backlog until you approve.',
      ),
    ).toBeNull();
    fireEvent.change(composer(), { target: { value: 'Split the second story in two' } });
    expect(
      screen.getByText('Motir changes this plan. Nothing reaches your backlog until you approve.'),
    ).toBeTruthy();
  });
});

describe('submitting', () => {
  it('sends the instruction through the `revise_plan` route and clears the field', async () => {
    mocks.fetchPlanReview.mockResolvedValue(review({ revision: RUNNING }));
    render();
    fireEvent.change(composer(), { target: { value: '  Split the second story in two  ' } });
    fireEvent.submit(composer().closest('form')!);

    await waitFor(() => expect(mocks.revisePlanRequest).toHaveBeenCalled());
    expect(mocks.revisePlanRequest).toHaveBeenCalledWith('plan_1', 'Split the second story in two');
    await waitFor(() => expect(composer().value).toBe(''));
  });

  it('a REFUSED submit surfaces the reason in place, KEEPS the instruction, and leaves the plan approvable', async () => {
    mocks.revisePlanRequest.mockRejectedValueOnce(
      new PlanRequestError(409, 'PLAN_REVISION_IN_FLIGHT'),
    );
    render();
    fireEvent.change(composer(), { target: { value: 'Split it' } });
    fireEvent.submit(composer().closest('form')!);

    await waitFor(() =>
      expect(
        screen.getByText('A revision is changing this plan. Try again in a moment.'),
      ).toBeTruthy(),
    );
    // The instruction survives a refusal — the reviewer can press Send again
    // rather than retype what they asked for.
    expect(composer().value).toBe('Split it');
    // …and the plan is still readable and still approvable. (The proposal set
    // renders in the canvas, which this suite stubs — what matters here is that
    // the surface is intact rather than stranded in a pending state.)
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(screen.queryByTestId('plan-revision-running')).toBeNull();
    const approve = screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
  });
});

describe('IN FLIGHT — Approve is HELD, and the reason is real text', () => {
  it('draws the running band naming the harness, and disables both terminal verbs', () => {
    render({ revision: RUNNING });
    expect(screen.getByTestId('plan-revision-running').textContent).toContain('Motir AI');
    expect((screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // ⚠️ The reason is TEXT under the buttons, not only dimness — the same swap
    // the rail already performs for a `generating` plan.
    expect(screen.getByText('Approve unlocks when the revision lands.')).toBeTruthy();
    // And the composer itself is held: one revision at a time.
    expect(composer().disabled).toBe(true);
  });
});

describe('⚠️ the ASYNC LANDING — each surface routed to its own mechanism', () => {
  it('REFETCHES the island AND `router.refresh()`es the server surfaces, once, when it lands', async () => {
    vi.useFakeTimers();
    try {
      // Starts held…
      mocks.fetchPlanReview.mockResolvedValue(review({ revision: RUNNING }));
      render({ revision: RUNNING });
      expect(mocks.refresh).not.toHaveBeenCalled();

      // …and the next poll finds it landed, with the proposal marked revised.
      mocks.fetchPlanReview.mockResolvedValue(
        review({
          revision: null,
          items: [planReviewItem({ title: 'The second story', revised: true })],
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      // The island's OWN state came through the refetch — `router.refresh()`
      // cannot reach a `useState(initialProps)` seed, which is the whole reason
      // both mechanisms run. Asserted SYNCHRONOUSLY: `act` already flushed the
      // effects the tick queued, and `waitFor` runs on real timers, so mixing
      // the two is how this assertion hangs rather than fails.
      expect(screen.queryByTestId('plan-revision-running')).toBeNull();
      // …and the server-rendered surfaces came through the refresh.
      expect(mocks.refresh).toHaveBeenCalled();
      // Approve is live again.
      expect((screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT poll, and does NOT refresh, when no revision is running', async () => {
    vi.useFakeTimers();
    try {
      render();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(mocks.fetchPlanReview).not.toHaveBeenCalled();
      expect(mocks.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
