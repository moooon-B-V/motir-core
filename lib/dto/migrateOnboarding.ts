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
  | 'audit_convention'
  | 'discovery'
  | 'generate'
  | 'review'
  | 'done';

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
  createdAt: string;
  updatedAt: string;
}

/** Input to `migrateOnboardingService.startMigration`. The connect step's repo
 *  ref may be supplied at start (a run that begins with a repo already picked)
 *  or left null and set as the connect step completes. */
export interface StartMigrateOnboardingInput {
  connectedRepoRef?: string | null;
}
