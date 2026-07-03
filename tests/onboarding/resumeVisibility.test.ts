import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_RESUME_PATH,
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

  it('is true for any live session — the plan has not materialised yet', () => {
    expect(isPreplanInProgress(preplanState({ status: 'active' }))).toBe(true);
    expect(isPreplanInProgress(preplanState({ status: 'scoping' }))).toBe(true);
  });

  it('is true even after the tiers are complete (MOTIR-1556 — still resumable)', () => {
    // The tiers are done but the plan is not materialised (onboardingRanAt still
    // null, enforced by resumeGateEnabled), so onboarding is not finished.
    expect(isPreplanInProgress(preplanState({ status: 'tiers_complete' }))).toBe(true);
  });
});

describe('ONBOARDING_RESUME_PATH', () => {
  it('targets the discovery surface (resumes the session), not the entrance fork', () => {
    expect(ONBOARDING_RESUME_PATH).toBe('/onboarding/discovery');
  });
});
