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

/** One connected repository's index status (Story MOTIR-8246 · MOTIR-8768),
 *  derived by `deriveMigrateIndexRepoState` from the pointer-plus-ledger facts:
 *  `indexed` = a succeeded `system.code-graph-index` run carries this repo's
 *  `output.repoRef`; `indexing` = the repo's `indexingRunId` names a `running`
 *  row; `failed` = that pointer names a `failed` / `abandoned` row, or the repo
 *  was refused for size; `queued` = anything else (enqueued, not yet claimed, or
 *  paused for catch-up). */
export type MigrateIndexRepoStatusDto = 'queued' | 'indexing' | 'indexed' | 'failed';

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
 * aggregate, not per-repo). `allIndexed` is true once every connected repo is
 * indexed. `failedCount` of them read `failed` (MOTIR-8768).
 */
export interface MigrateIndexStatusDto {
  repos: MigrateIndexRepoDto[];
  indexedCount: number;
  failedCount: number;
  total: number;
  hasRunning: boolean;
  allIndexed: boolean;
}

/**
 * The plan a migrate run's generate step drafted (MOTIR-8254, design
 * `design/onboarding-migrate/` § Revision 6, Panel 6c) — what the wizard's
 * "A few questions" step reads to say the plan is ready, how many items it
 * proposes, and where "Review your plan" goes. `planId` is null until the
 * generation job has opened its plan; `status` is the plan's own status
 * (`generating` while it is still being drafted).
 */
export interface MigrateGeneratedPlanDto {
  planId: string | null;
  status: string | null;
  itemCount: number;
}

/**
 * What the migrate wizard's CONNECT step should say about its own world
 * (Story MOTIR-8241 · MOTIR-8472) — ONE value, computed server-side, which the
 * step renders rather than re-deriving from the fields beside it.
 *
 * A CLOSED union, and every member has a different remedy, which is why the
 * classifier that produces it has no default arm:
 *   - `already_connected` — usable repositories, and the person did not leave
 *     for GitHub from this step: continue.
 *   - `connected` — usable repositories, and the person DID leave from this step
 *     (a valid `before` snapshot came back): continue.
 *   - `no_repositories_selected` — an installation is bound to the organisation
 *     but no usable repository came with it: change the selection on GitHub.
 *   - `install_cancelled` — nothing bound and no repositories, but the person
 *     left from this step and came back: install again.
 *   - `not_started` — nothing bound, no repositories, never left: install.
 *
 * There is deliberately NO pending-owner member: the producer of that state is
 * the setup callback's `?github=` report, which no row this read can see records,
 * and a direct report outranks anything derived here.
 */
export type MigrateConnectOutcome =
  | 'already_connected'
  | 'connected'
  | 'no_repositories_selected'
  | 'install_cancelled'
  | 'not_started';

/** One GitHub installation bound to the run's organisation. */
export interface MigrateConnectInstallationAccountDto {
  /** The provider's installation id (`github_installation.installation_id`),
   *  never Motir's internal row id. */
  installationRef: string;
  accountLogin: string;
  accountType: string;
}

/** One repository Motir can use for this run, as the connect step lists it. */
export interface MigrateConnectRepositoryDto {
  provider: string;
  /** `owner/name`. */
  repoRef: string;
  defaultBranch: string;
}

/**
 * The connect step's live read (`GET /api/onboarding/migrate/[id]/connect-state`,
 * MOTIR-8472). Two tenancy tiers sit side by side here ON PURPOSE, and each
 * field names its own:
 */
export interface MigrateConnectStateDto {
  /** ORGANISATION tier — the owning organisation of the run's workspace,
   *  resolved from the workspace row (`resolveOrganizationId`), never from the
   *  request. It is what the org-scoped connect-flow routes take. */
  organizationId: string;
  /** ORGANISATION tier — the GitHub installations bound to `organizationId`:
   *  the rows stamped with it UNION its `github_installation_org_link` rows
   *  (`githubInstallationService.listBoundInstallationsForOrganization`). A row
   *  whose organisation is null (Motir's shared provisioning installation) never
   *  counts. `bound` is `accounts.length > 0`. */
  installation: {
    bound: boolean;
    accounts: MigrateConnectInstallationAccountDto[];
  };
  /** The repositories the CONNECT exit gate reads — the SAME call, so the step's
   *  "connected" and the gate's `ready: true` are one fact. Always an array:
   *  the resolver's `undefined` (nothing connected) arrives as `[]`. */
  repositories: MigrateConnectRepositoryDto[];
  /** The one value the step renders. */
  outcome: MigrateConnectOutcome;
  /** An opaque, run-scoped token the step echoes back as `?before=` when it
   *  returns from GitHub, to witness that the person left from this step. It
   *  carries no copy of the world and is not a secret. */
  snapshot: string;
}
