import { describe, it, expect } from 'vitest';

import type { MigrateOnboardingDto } from '@/lib/dto/migrateOnboarding';
import {
  MIGRATE_PLANNING_STEPS,
  migrateRunReachedPlanning,
  shouldRouteToMigrateWizard,
} from '@/lib/onboarding/migrateHandoff';

// The migrate-wizard hand-off gate (bug MOTIR-1725). Pure predicates over an
// already-read DTO, so this suite needs no database — the E2E repro in
// `tests/e2e/acceptance-onboarding-migrate.spec.ts` covers the wired behaviour.
//
// The defect these lock down: MOTIR-1259's existing-item router fired on the way
// OUT of the migrate wizard as well as on the way in, so "Plan my project now"
// bounced back into the wizard and planning was unreachable for any project with
// a tree.

function makeRun(overrides: Partial<MigrateOnboardingDto> = {}): MigrateOnboardingDto {
  return {
    id: 'run-1',
    projectId: 'proj-1',
    kind: 'migrate',
    step: 'connect',
    status: 'active',
    connectedRepoRef: null,
    codeGraphReady: false,
    conventionApprovedAt: null,
    discoveryJobId: null,
    generateJobId: null,
    importSkipped: false,
    importCompleted: false,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('migrateRunReachedPlanning', () => {
  it('is false with no run at all', () => {
    expect(migrateRunReachedPlanning(null)).toBe(false);
  });

  it.each(['connect', 'index', 'import', 'audit_convention'] as const)(
    'is false at the set-up step %s — the user has not chosen to plan yet',
    (step) => {
      expect(migrateRunReachedPlanning(makeRun({ step }))).toBe(false);
    },
  );

  it.each(MIGRATE_PLANNING_STEPS)('is true at the planning step %s', (step) => {
    expect(migrateRunReachedPlanning(makeRun({ step }))).toBe(true);
  });

  it('is false at `done` — a finished run must not permanently disarm the router', () => {
    expect(migrateRunReachedPlanning(makeRun({ step: 'done' }))).toBe(false);
  });

  it.each(['completed', 'failed'] as const)(
    'is false when the run is %s, even mid-planning — only an in-flight hand-off counts',
    (status) => {
      expect(migrateRunReachedPlanning(makeRun({ step: 'discovery', status }))).toBe(false);
    },
  );
});

describe('shouldRouteToMigrateWizard', () => {
  it('is false for an empty project — the start-fresh path is correct there', () => {
    expect(shouldRouteToMigrateWizard({ itemCount: 0, run: null })).toBe(false);
  });

  it('stays TRUE for an existing tree with no migrate run (the MOTIR-1259 contract)', () => {
    // Regression guard for `tests/e2e/onboarding-ran-gate.spec.ts` — the inbound
    // router must keep sending a seeded/manually-built project to the wizard.
    expect(shouldRouteToMigrateWizard({ itemCount: 12, run: null })).toBe(true);
  });

  it('stays TRUE while the run is still in set-up — a half-finished wizard resumes', () => {
    expect(shouldRouteToMigrateWizard({ itemCount: 12, run: makeRun({ step: 'index' }) })).toBe(
      true,
    );
  });

  it('is FALSE once the wizard handed off to planning — the MOTIR-1725 fix', () => {
    expect(
      shouldRouteToMigrateWizard({ itemCount: 142, run: makeRun({ step: 'discovery' }) }),
    ).toBe(false);
  });

  it('is false for a negative/absent count, not just zero', () => {
    expect(shouldRouteToMigrateWizard({ itemCount: -1, run: null })).toBe(false);
  });
});
