import { describe, it, expect } from 'vitest';
import { resolvePlanningHostGate } from '@/lib/planning/workspaceHost';

// The established-project host's GATE (Subtask MOTIR-1729) — the decision the
// `/planning` Server Component makes before it renders the workspace, extracted
// as a pure function so it is testable without a route (the `toIssueRows`
// pattern the /items page test uses).
//
// The load-bearing property is the INTERACTION with the onboarding gates: the
// host does NOT weaken them. `/onboarding` redirects an onboarded project away
// and owns a never-onboarded one (the first-run entrance, the MOTIR-1259
// existing-item router, the MOTIR-1725 migrate hand-off); the host is the
// mirror image, off the SAME immutable marker — so exactly one surface owns a
// given project and neither has to know the other's internals.

const ONBOARDED = new Date('2026-07-01T10:00:00Z');

describe('resolvePlanningHostGate', () => {
  it('opens the workspace for an established (onboarded) project', () => {
    expect(
      resolvePlanningHostGate({
        hasActiveProject: true,
        canBrowse: true,
        onboardingRanAt: ONBOARDED,
      }),
    ).toBe('workspace');
  });

  it('forwards a never-onboarded project to onboarding — the gate is not bypassed', () => {
    expect(
      resolvePlanningHostGate({ hasActiveProject: true, canBrowse: true, onboardingRanAt: null }),
    ).toBe('onboarding');
    expect(
      resolvePlanningHostGate({
        hasActiveProject: true,
        canBrowse: true,
        onboardingRanAt: undefined,
      }),
    ).toBe('onboarding');
  });

  it('hints at the switcher when there is no active project', () => {
    expect(
      resolvePlanningHostGate({
        hasActiveProject: false,
        canBrowse: false,
        onboardingRanAt: ONBOARDED,
      }),
    ).toBe('no-project');
  });

  it('checks access BEFORE the onboarding marker (no state leak to a non-browser)', () => {
    // A project made private while pinned: the actor must be told "no access",
    // never forwarded into onboarding — which would leak that it never planned.
    expect(
      resolvePlanningHostGate({ hasActiveProject: true, canBrowse: false, onboardingRanAt: null }),
    ).toBe('no-access');
    expect(
      resolvePlanningHostGate({
        hasActiveProject: true,
        canBrowse: false,
        onboardingRanAt: ONBOARDED,
      }),
    ).toBe('no-access');
  });

  it('splits ownership with /onboarding on the same marker — never both, never neither', () => {
    // `/onboarding` (both the entrance and the discovery hub) redirects away iff
    // `onboardingRanAt` is set. The host opens the workspace iff it is set. So
    // for a browsable project, exactly one of the two surfaces owns it.
    for (const marker of [null, ONBOARDED]) {
      const gate = resolvePlanningHostGate({
        hasActiveProject: true,
        canBrowse: true,
        onboardingRanAt: marker,
      });
      const onboardingKeepsIt = marker === null;
      expect(gate === 'onboarding').toBe(onboardingKeepsIt);
      expect(gate === 'workspace').toBe(!onboardingKeepsIt);
    }
  });
});
