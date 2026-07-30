// Typed errors for the project REPOSITORY SET (Story MOTIR-1775 · MOTIR-1780).
// Kept in their own file so the route handlers a later card adds (the establish-step
// API behind MOTIR-1782's UI) can import them without pulling in the Prisma client
// (the `lib/<domain>/errors.ts` convention). The service throws these; the route
// layer translates the stable `code` to an HTTP status — the suggested mapping is
// on each class.

/** A set ROW does not resolve in this workspace (wrong id, or another tenant's
 *  row — RLS + the workspace-scoped read make those indistinguishable, which is
 *  the point). → 404, never 403: no cross-tenant existence leak. */
export class ProjectRepoNotFoundError extends Error {
  readonly code = 'PROJECT_REPO_NOT_FOUND' as const;
  constructor(ref: string) {
    super(`Project repository row ${ref} was not found.`);
    this.name = 'ProjectRepoNotFoundError';
  }
}

/**
 * The project's set already holds a row with this repo NAME. The DB's
 * `(project_id, name)` unique index is the real guard — this is both the
 * pre-check (which also catches a CASE-VARIANT, since git-host repo names are
 * case-insensitive and `acme-web` / `Acme-Web` are one repository) and the
 * translation of a lost P2002 race. → 409
 */
export class ProjectRepoNameTakenError extends Error {
  readonly code = 'PROJECT_REPO_NAME_TAKEN' as const;
  constructor(
    readonly name_: string,
    projectId: string,
  ) {
    super(`Project ${projectId} already has a repository row named "${name_}".`);
    this.name = 'ProjectRepoNameTakenError';
  }
}

/**
 * The realized `GithubRepo` is already claimed by ANOTHER project's set row. This
 * is the corruption the `github_repo_id` unique index exists to prevent — a repo
 * created for project A being recorded as project B's — surfaced as a typed error
 * rather than a raw P2002. → 409
 */
export class RealizedRepoAlreadyClaimedError extends Error {
  readonly code = 'REALIZED_REPO_ALREADY_CLAIMED' as const;
  constructor(githubRepoId: string) {
    super(`Connected repository ${githubRepoId} is already claimed by another project's set.`);
    this.name = 'RealizedRepoAlreadyClaimedError';
  }
}

/**
 * An illegal hop in the ADR §4.1 establish machine (e.g. `created → skipped`, or
 * `proposed → created` skipping `creating`). Names the legal targets so a caller
 * self-corrects — the same self-correcting shape `transition_status` uses for a
 * work item. This is ALSO the lost-race guard: the row is locked and its state
 * re-read inside the transaction, so a concurrent transition's loser observes the
 * already-moved state and lands here. → 409
 */
export class ProjectRepoStateTransitionError extends Error {
  readonly code = 'PROJECT_REPO_ILLEGAL_TRANSITION' as const;
  constructor(
    ref: string,
    readonly from: string,
    readonly to: string,
    readonly allowed: readonly string[],
  ) {
    super(
      allowed.length === 0
        ? `Project repository row ${ref} is ${from}, a settled state with no legal transition (attempted ${to}).`
        : `Project repository row ${ref} cannot move ${from} → ${to}. Allowed: ${allowed.join(', ')}.`,
    );
    this.name = 'ProjectRepoStateTransitionError';
  }
}

/**
 * A row's field was given a value the shape rules reject — a blank name, a name
 * over the host's length limit, or a blank failure reason on a `failed` hop. The
 * service validates SHAPE (the column carries no CHECK constraint, matching how
 * every other settings-ish column in this schema is validated); WHETHER a name is
 * available on the host is a GitHub mechanic the creation primitive learns
 * (MOTIR-1781, and MOTIR-1777 (d) for how). → 422
 */
export class ProjectRepoInvalidFieldError extends Error {
  readonly code = 'PROJECT_REPO_INVALID_FIELD' as const;
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Project repository "${field}" is invalid: ${reason}`);
    this.name = 'ProjectRepoInvalidFieldError';
  }
}
