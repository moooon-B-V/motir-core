// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { GenerationPhase, UsePlanGeneration } from '@/lib/hooks/usePlanGeneration';

// The 7.4 generation ENTRY surface (Subtask 7.4.9 / MOTIR-1396). It drives the
// generation lifecycle via `usePlanGeneration` and renders each phase: the live
// reveal (Panel C — REUSES the shipped PlanReviewCanvas, not redrawn) and the
// terminal states it OWNS because Plan.status can't encode them (Panel D — failed
// / out-of-credits / empty). On success it hands off to the 847 review surface.
// The hook + heavy canvas are stubbed — orchestration is unit-tested separately.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="plan-review-canvas" />,
}));

const start = vi.fn();
const stop = vi.fn();
let hookReturn: UsePlanGeneration;
vi.mock('@/lib/hooks/usePlanGeneration', () => ({
  usePlanGeneration: () => hookReturn,
}));

import { GenerationFlow } from '@/components/planning/GenerationFlow';

function setPhase(phase: GenerationPhase, over: Partial<UsePlanGeneration> = {}) {
  hookReturn = { phase, planId: null, items: [], version: 0, start, stop, ...over };
}

beforeEach(() => {
  push.mockClear();
  start.mockClear();
  stop.mockClear();
});
afterEach(cleanup);

describe('GenerationFlow (MOTIR-1396)', () => {
  it('auto-starts generation when it mounts (the hand-off "Generate" click is the trigger)', () => {
    setPhase('submitting');
    renderWithIntl(<GenerationFlow onExit={vi.fn()} />);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('GENERATING: reveals the canvas + an aria-live status, and Stop calls stop()', () => {
    setPhase('generating', { items: [] });
    renderWithIntl(<GenerationFlow onExit={vi.fn()} />);

    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(screen.getByText('Generating your plan…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('OUT OF CREDITS: shows the credits prompt with a top-up link (not a generic error)', () => {
    setPhase('out_of_credits');
    renderWithIntl(<GenerationFlow onExit={vi.fn()} />);

    expect(screen.getByText('You’re out of planning credits')).toBeTruthy();
    const topUp = screen.getByRole('link', { name: 'Top up credits' });
    expect(topUp.getAttribute('href')).toBe('/settings/organization/billing');
    // It must NOT collapse into the generic failure copy.
    expect(screen.queryByText('Generation didn’t finish')).toBeNull();
  });

  it('FAILED: shows the failure state; Retry restarts, Discard exits', () => {
    const onExit = vi.fn();
    setPhase('failed');
    renderWithIntl(<GenerationFlow onExit={onExit} />);

    expect(screen.getByText('Generation didn’t finish')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(start).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard partial' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('EMPTY: offers the discovery chat (no-docs) + retry', () => {
    setPhase('empty');
    renderWithIntl(<GenerationFlow onExit={vi.fn()} />);

    expect(screen.getByText('No plan to review')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open discovery chat' }).getAttribute('href')).toBe(
      '/direction',
    );
  });

  it('PLANNED: hands off to the 847 review surface (/plans/:id), never approving here', () => {
    setPhase('planned', { planId: 'plan_42' });
    renderWithIntl(<GenerationFlow onExit={vi.fn()} />);

    expect(push).toHaveBeenCalledWith('/plans/plan_42');
    // No approve/decline controls — those live on the 847 detail.
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
});
