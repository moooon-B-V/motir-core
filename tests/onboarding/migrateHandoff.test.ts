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
    // ⚠️ EMPTY MEANS EVERY STEP (MOTIR-4759). A run no routing verdict reached
    // walks the whole wizard, which is what every case in this file is.
    keptSteps: [],
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
  // ⚠️ THE TABLE, ROW FOR ROW (MOTIR-4756). The predicate decides on BOTH inputs
  // now, and only ONE row moves — which is the whole claim this suite has to
  // pin, because a change that moved a second row would be a routing change
  // nobody asked for and every other case here would still pass.
  it.each([
    // items · repository · expected · what it is
    [0, false, false, 'the FLOOR — nothing to plan from, so start-fresh is right'],
    [0, true, true, 'THE ROW THAT MOVES — a repository and no work items yet'],
    [12, false, true, 'a tree and no repository — unchanged (MOTIR-1259)'],
    [12, true, true, 'both — unchanged'],
  ] as const)(
    'items=%s repository=%s → %s (%s)',
    (itemCount, repositoryConnected, expected, _what) => {
      expect(shouldRouteToMigrateWizard({ itemCount, repositoryConnected, run: null })).toBe(
        expected,
      );
    },
  );

  it('stays TRUE for an existing tree with no migrate run (the MOTIR-1259 contract)', () => {
    // Regression guard for `tests/e2e/onboarding-ran-gate.spec.ts` — the inbound
    // router must keep sending a seeded/manually-built project to the wizard.
    expect(
      shouldRouteToMigrateWizard({ itemCount: 12, repositoryConnected: false, run: null }),
    ).toBe(true);
  });

  it('stays TRUE while the run is still in set-up — a half-finished wizard resumes', () => {
    expect(
      shouldRouteToMigrateWizard({
        itemCount: 12,
        repositoryConnected: false,
        run: makeRun({ step: 'index' }),
      }),
    ).toBe(true);
  });

  it('is FALSE once the wizard handed off to planning — the MOTIR-1725 fix', () => {
    expect(
      shouldRouteToMigrateWizard({
        itemCount: 142,
        repositoryConnected: false,
        run: makeRun({ step: 'discovery' }),
      }),
    ).toBe(false);
  });

  // ⚠️ THE DIRECTIONAL GUARD MUST STILL WIN ON THE NEW ROW. Widening the entry
  // condition without this would re-open MOTIR-1725 for exactly the projects
  // MOTIR-4756 adds: repository connected, tree still empty, wizard already
  // handed off to planning — and the bounce would be back.
  it.each(MIGRATE_PLANNING_STEPS)(
    'is FALSE at planning step %s even on the repository-only row',
    (step) => {
      expect(
        shouldRouteToMigrateWizard({
          itemCount: 0,
          repositoryConnected: true,
          run: makeRun({ step }),
        }),
      ).toBe(false);
    },
  );

  it('is false for a negative/absent count with no repository, not just zero', () => {
    expect(
      shouldRouteToMigrateWizard({ itemCount: -1, repositoryConnected: false, run: null }),
    ).toBe(false);
  });
});
