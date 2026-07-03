import { describe, expect, it } from 'vitest';
import {
  PREPLAN_STATUS_COMPLETE,
  isPreplanInProgress,
  resumeGateEnabled,
} from '@/lib/onboarding/resumeVisibility';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';

// Unit coverage for the "Resume onboarding" shown/hidden predicates (MOTIR-1533).
// Both must hold for the door to appear; each is tested in isolation.

function preplanState(session: { status: string } | null): PreplanStateDTO {
  return { session, docs: [], catalog: null } as unknown as PreplanStateDTO;
}

describe('resumeGateEnabled — the server-cheap gate', () => {
  const base = { aiPlanningConfigured: true, hasActiveProject: true, onboardingRanAt: null };

  it('is true when AI is configured, a project is active, and onboarding never finished', () => {
    expect(resumeGateEnabled(base)).toBe(true);
  });

  it('treats an undefined onboardingRanAt as never-finished (== null)', () => {
    expect(resumeGateEnabled({ ...base, onboardingRanAt: undefined })).toBe(true);
  });

  it('is false once onboarding has finished (onboardingRanAt set)', () => {
    expect(resumeGateEnabled({ ...base, onboardingRanAt: '2026-07-01T00:00:00.000Z' })).toBe(false);
  });

  it('is false when AI planning is not configured', () => {
    expect(resumeGateEnabled({ ...base, aiPlanningConfigured: false })).toBe(false);
  });

  it('is false when there is no active project', () => {
    expect(resumeGateEnabled({ ...base, hasActiveProject: false })).toBe(false);
  });
});

describe('isPreplanInProgress — the client signal', () => {
  it('is false for a null state (fetch failed / AI down)', () => {
    expect(isPreplanInProgress(null)).toBe(false);
    expect(isPreplanInProgress(undefined)).toBe(false);
  });

  it('is false when there is no session (project never started onboarding)', () => {
    expect(isPreplanInProgress(preplanState(null))).toBe(false);
  });

  it('is true for a live, un-finished session', () => {
    expect(isPreplanInProgress(preplanState({ status: 'active' }))).toBe(true);
    expect(isPreplanInProgress(preplanState({ status: 'scoping' }))).toBe(true);
  });

  it('is false for a session that has completed the tiers', () => {
    expect(isPreplanInProgress(preplanState({ status: PREPLAN_STATUS_COMPLETE }))).toBe(false);
  });
});
