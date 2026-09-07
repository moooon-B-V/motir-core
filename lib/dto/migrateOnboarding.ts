// DTO types for the migrate-existing-codebase onboarding state machine
// ("Workflow B", Story 7.15 · MOTIR-1499). The shape that crosses the API
// boundary — no Prisma row leaks: the Prisma `MigrateOnboardingKind` /
// `MigrateOnboardingStep` / `MigrateOnboardingStatus` enums become string
// unions and every `Date` becomes an ISO string. The wiring slice (MOTIR-931)
// and the wizard UI (MOTIR-934) bind to these.

/** Wire form of the Prisma `MigrateOnboardingKind` enum. */
export type MigrateOnboardingKindDto = 'migrate';

/** Wire form of the Prisma `MigrateOnboardingStep` enum — the six working steps
 *  plus the terminal `done`. */
export type MigrateOnboardingStepDto =
  | 'connect'
  | 'index'
  | 'import'
  | 'audit_convention'
  | 'discovery'
  | 'generate'
  | 'review'
  | 'done';

/**
 * Every step, as a runtime list — the enum's own membership, in the machine's
 * order (MOTIR-4759).
 *
 * ⚠️ `done` IS IN IT because it is a member of the enum, and this list exists to
 * VALIDATE a wire value against the enum. Whether a step is one anybody RUNS is a
 * different question, answered where a kept set is built rather than here.
 */
export const MIGRATE_ONBOARDING_STEPS: readonly MigrateOnboardingStepDto[] = [
  'connect',
  'index',
  'import',
  'audit_convention',
  'discovery',
  'generate',
  'review',
  'done',
];

/** Is `value` a step this product has? Total, and narrows. */
export function isMigrateOnboardingStep(value: unknown): value is MigrateOnboardingStepDto {
  return (
    typeof value === 'string' && (MIGRATE_ONBOARDING_STEPS as readonly string[]).includes(value)
  );
}

/** Wire form of the Prisma `MigrateOnboardingStatus` enum. */
export type MigrateOnboardingStatusDto = 'active' | 'completed' | 'failed';

/**
 * The migrate-onboarding run as it crosses the API boundary. Mirrors the
 * persisted record (Dates → ISO strings, enums → unions). `connectedRepoRef` /
 * `discoveryJobId` / `generateJobId` are opaque refs (a connected-repo handle, a
 * motir-ai job token); `codeGraphReady` / `conventionApprovedAt` are the
 * per-step OUTPUTS the transitions gate on — carried here so the resumed wizard
 * renders exactly where the run stopped.
 */
export interface MigrateOnboardingDto {
  id: string;
  projectId: string;
  kind: MigrateOnboardingKindDto;
  step: MigrateOnboardingStepDto;
  status: MigrateOnboardingStatusDto;
  connectedRepoRef: string | null;
  codeGraphReady: boolean;
  conventionApprovedAt: string | null;
  discoveryJobId: string | null;
  generateJobId: string | null;
  importSkipped: boolean;
  importCompleted: boolean;
  /**
   * WHICH STEPS THIS RUN ACTUALLY RUNS — the planner's answer, carried here by
   * the routing verdict that sent the user to this wizard (MOTIR-4759).
   *
   * ⚠️ EMPTY MEANS *EVERY STEP*, which is what a run reached by any other door
   * has. It is also the RECORD of how a step was satisfied: one absent from a
   * non-empty set was answered by the project's own substrate rather than by the
   * user, which is what the rail's collapsed row and the provenance line say.
   */
  keptSteps: MigrateOnboardingStepDto[];
  createdAt: string;
  updatedAt: string;
}

/** Input to `migrateOnboardingService.startMigration`. The connect step's repo
 *  ref may be supplied at start (a run that begins with a repo already picked)
 *  or left null and set as the connect step completes. */
export interface StartMigrateOnboardingInput {
  connectedRepoRef?: string | null;
  /**
   * The planner's KEPT SET (MOTIR-4759), when the routing verdict sent this user
   * here. Omitted → `[]` → every step runs, exactly as before this existed.
   *
   * ⚠️ IT IS ONLY READ AT CREATE. The set describes the verdict that OPENED this
   * run; letting a later write re-scope a journey in flight would mean a stale
   * address could change which questions a user is asked half-way through one.
   */
  keptSteps?: MigrateOnboardingStepDto[];
}

/** One connected repository's index status, as the wizard's Index step renders
 *  it. `indexed` = a succeeded `system.code-graph-index` run matches this repo's
 *  `output.repoRef`; `pending` = not yet (queued or in flight — the ledger cannot
 *  distinguish per-repo, see `MigrateIndexStatusDto.hasRunning`). */
export type MigrateIndexRepoStatusDto = 'indexed' | 'pending';

/** One row in the Index step's per-repo list. */
export interface MigrateIndexRepoDto {
  provider: string;
  repoRef: string;
  status: MigrateIndexRepoStatusDto;
}

/**
 * The migrate-onboarding Index step's live progress (Story 7.15 · MOTIR-934) —
 * the per-repo view the wizard polls (`GET /api/onboarding/migrate/[id]/index-status`).
 * `repos` is the workspace's connected set (`resolveCodeContext`); `indexedCount`
 * of them have a succeeded index run; `hasRunning` is the aggregate "an index is
 * in flight right now" flag (a running `system.code-graph-index` row exists — the
 * ledger cannot tie a running row to a specific repo, so the in-flight state is
 * aggregate, not per-repo). `allIndexed` gates the wizard's Next button.
 */
export interface MigrateIndexStatusDto {
  repos: MigrateIndexRepoDto[];
  indexedCount: number;
  total: number;
  hasRunning: boolean;
  allIndexed: boolean;
}
