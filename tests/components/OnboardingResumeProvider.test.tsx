// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';
import {
  OnboardingResumeProvider,
  useOnboardingResume,
} from '@/app/(authed)/_components/OnboardingResumeProvider';

// The provider is the one client island behind the "Resume onboarding" door
// (MOTIR-1533): it reads /api/ai/pre-plan ONCE (only when `enabled`) and shares
// the in-progress boolean. These tests drive the fetch → context outcome.

function Probe() {
  return <span data-testid="signal">{useOnboardingResume() ? 'show' : 'hide'}</span>;
}

function preplanState(session: { status: string } | null): PreplanStateDTO {
  return { session, docs: [], catalog: null } as unknown as PreplanStateDTO;
}

function mockFetch(state: PreplanStateDTO | null, ok = true) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 502,
      json: () => Promise.resolve(state),
    } as Response),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OnboardingResumeProvider', () => {
  it('does not fetch and stays hidden when the gate is closed', () => {
    mockFetch(preplanState({ status: 'active' }));
    render(
      <OnboardingResumeProvider enabled={false}>
        <Probe />
      </OnboardingResumeProvider>,
    );
    expect(screen.getByTestId('signal').textContent).toBe('hide');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the door for a live, un-finished session', async () => {
    mockFetch(preplanState({ status: 'active' }));
    render(
      <OnboardingResumeProvider enabled>
        <Probe />
      </OnboardingResumeProvider>,
    );
    expect(await screen.findByText('show')).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith('/api/ai/pre-plan', expect.anything());
  });

  it('stays hidden when the project never started onboarding (session null)', async () => {
    mockFetch(preplanState(null));
    render(
      <OnboardingResumeProvider enabled>
        <Probe />
      </OnboardingResumeProvider>,
    );
    // let the mount fetch resolve, then assert it never flipped to show
    await Promise.resolve();
    expect(screen.getByTestId('signal').textContent).toBe('hide');
  });

  it('stays hidden for a finished (tiers_complete) session', async () => {
    mockFetch(preplanState({ status: 'tiers_complete' }));
    render(
      <OnboardingResumeProvider enabled>
        <Probe />
      </OnboardingResumeProvider>,
    );
    await Promise.resolve();
    expect(screen.getByTestId('signal').textContent).toBe('hide');
  });

  it('stays hidden when the pre-plan read fails', async () => {
    mockFetch(null, false);
    render(
      <OnboardingResumeProvider enabled>
        <Probe />
      </OnboardingResumeProvider>,
    );
    await Promise.resolve();
    expect(screen.getByTestId('signal').textContent).toBe('hide');
  });
});
