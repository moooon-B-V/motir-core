// Typed errors for the migrate-existing-codebase onboarding state machine
// ("Workflow B", Story 7.15 · MOTIR-1499). Kept in their own file so route
// handlers (wired in MOTIR-931) can import them without pulling in the Prisma
// client (the lib/<domain>/errors.ts convention). The service throws these; the
// route layer translates the stable `code` to an HTTP status.

/** The migrate-onboarding run does not resolve (by id or by project) in this
 *  workspace. → 404 (never 403 — no cross-tenant existence leak). */
export class MigrateOnboardingNotFoundError extends Error {
  readonly code = 'MIGRATE_ONBOARDING_NOT_FOUND' as const;
  constructor(ref: string) {
    super(`Migrate onboarding ${ref} was not found.`);
    this.name = 'MigrateOnboardingNotFoundError';
  }
}

/** A project already has a migrate-onboarding run (there is at most ONE per
 *  project — the resumable single run; the DB unique index is the real guard,
 *  this is the pre-check + the P2002-race translation). → 409 */
export class MigrateOnboardingExistsError extends Error {
  readonly code = 'MIGRATE_ONBOARDING_EXISTS' as const;
  constructor(projectId: string) {
    super(`A migrate onboarding already exists for project ${projectId}.`);
    this.name = 'MigrateOnboardingExistsError';
  }
}

/**
 * A step transition was called from the wrong step. The sequence is
 * connect → index → audit_convention → discovery → generate → review → done;
 * each hop is legal only from its predecessor. This is BOTH the illegal-order
 * guard AND the resumability / lost-race guard: the run row is locked + its step
 * re-read, so a double-advance (or a concurrent loser) observes the already-
 * advanced step and lands here. → 409
 */
export class MigrateOnboardingStepError extends Error {
  readonly code = 'MIGRATE_ONBOARDING_WRONG_STEP' as const;
  constructor(ref: string, actual: string, expected: string) {
    super(
      `Migrate onboarding ${ref} is at step ${actual}; this transition requires step ${expected}.`,
    );
    this.name = 'MigrateOnboardingStepError';
  }
}

/**
 * The current step's EXIT CONDITION is not yet satisfied, so the run cannot
 * advance (e.g. no repo connected at `connect`, code graph not ready at `index`,
 * convention not approved at `audit_convention`). The exit checks are the seams
 * MOTIR-931 deepens; the scaffold gates on the persisted per-step output. → 409
 */
export class MigrateOnboardingExitConditionError extends Error {
  readonly code = 'MIGRATE_ONBOARDING_EXIT_CONDITION_UNMET' as const;
  constructor(step: string, reason: string) {
    super(`The migrate-onboarding "${step}" step cannot advance: ${reason}`);
    this.name = 'MigrateOnboardingExitConditionError';
  }
}
