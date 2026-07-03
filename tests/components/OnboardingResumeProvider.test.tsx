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
      <OnboardingResumeProvider enabled={false} activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    expect(screen.getByTestId('signal').textContent).toBe('hide');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the door for a live, un-finished session', async () => {
    mockFetch(preplanState({ status: 'active' }));
    render(
      <OnboardingResumeProvider enabled activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    expect(await screen.findByText('show')).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith('/api/ai/pre-plan', expect.anything());
  });

  it('stays hidden when the project never started onboarding (session null)', async () => {
    mockFetch(preplanState(null));
    render(
      <OnboardingResumeProvider enabled activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    // let the mount fetch resolve, then assert it never flipped to show
    await Promise.resolve();
    expect(screen.getByTestId('signal').textContent).toBe('hide');
  });

  it('still shows after the tiers are complete (MOTIR-1556 — plan not materialised yet)', async () => {
    mockFetch(preplanState({ status: 'tiers_complete' }));
    render(
      <OnboardingResumeProvider enabled activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    expect(await screen.findByText('show')).toBeTruthy();
  });

  it('stays hidden when the pre-plan read fails', async () => {
    mockFetch(null, false);
    render(
      <OnboardingResumeProvider enabled activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    await Promise.resolve();
    expect(screen.getByTestId('signal').textContent).toBe('hide');
  });

  // MOTIR-1560: the door must re-evaluate on an IN-PLACE active-project switch
  // (a `router.refresh()` that leaves the server `enabled` gate open), not only
  // when the gate flips. Before the fix the effect keyed on `[enabled]` alone, so
  // switching between two in-shell projects that both have `onboardingRanAt == null`
  // never re-fetched and the door showed the STALE project's session.
  it('re-reads the live session when the active project changes (no longer stale on an in-place switch)', async () => {
    // Project A has a live, un-finished session → the door shows.
    mockFetch(preplanState({ status: 'active' }));
    const { rerender } = render(
      <OnboardingResumeProvider enabled activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    expect(await screen.findByText('show')).toBeTruthy();

    // Switch to project B (only the active-project id changes; the gate stays
    // open). A fresh fetch spy returns a null session → the door must HIDE, and
    // the new spy must have fired (the effect re-ran for the switch).
    mockFetch(preplanState(null));
    rerender(
      <OnboardingResumeProvider enabled activeProjectId="project-b">
        <Probe />
      </OnboardingResumeProvider>,
    );
    await screen.findByText('hide');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/api/ai/pre-plan', expect.anything());
  });

  // The flip side of the key: an unrelated re-render that changes NEITHER the
  // gate nor the active project must NOT re-fetch (the read stays keyed, so it
  // doesn't add a motir-ai round-trip on every authed re-render).
  it('does not re-read when neither the gate nor the active project changed', async () => {
    mockFetch(preplanState({ status: 'active' }));
    const { rerender } = render(
      <OnboardingResumeProvider enabled activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    expect(await screen.findByText('show')).toBeTruthy();
    const callsAfterMount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    rerender(
      <OnboardingResumeProvider enabled activeProjectId="project-a">
        <Probe />
      </OnboardingResumeProvider>,
    );
    await Promise.resolve();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount);
  });
});
