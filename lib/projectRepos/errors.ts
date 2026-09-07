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
 * The realized `GithubRepo` is already in THIS PROJECT's set — a second row in
 * one project claiming one repository. Surfaced as a typed error rather than a
 * raw P2002. → 409
 *
 * ⚠️ RE-AIMED, NOT RETIRED (Story MOTIR-4669 · MOTIR-4648). It used to read: *"the
 * realized `GithubRepo` is already claimed by ANOTHER project's set row … the
 * corruption the `github_repo_id` unique index exists to prevent — a repo created
 * for project A being recorded as project B's."* A repository belongs to the
 * ORGANISATION and a repository in two projects is the ordinary case, so that is
 * no longer corruption and no longer refused.
 *
 * What IS refused is a repository appearing twice in one project's set, which is
 * always a mistake — and it is still enforced in the database, by
 * `@@unique([projectId, githubRepoId])`. The error KEEPS its `code` and its
 * status: the same 409 the product already returned, asked at the grain the
 * product now has.
 */
export class RealizedRepoAlreadyClaimedError extends Error {
  readonly code = 'REALIZED_REPO_ALREADY_CLAIMED' as const;
  constructor(githubRepoId: string) {
    super(`Connected repository ${githubRepoId} is already in this project's repository set.`);
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

// ── The TAKE-IT-OVER saga (MOTIR-711) ───────────────────────────────────────

/**
 * The row is not Motir's to hand over. Two shapes, one answer:
 *
 *   * a `connected` row — the repository was ALREADY the user's and they merely
 *     pointed Motir at it, so a takeover is the already-yours NO-OP (ADR §3.5's
 *     only way a set mixes ownership), not an error the caller must recover from;
 *   * an unrealized row (`proposed` / `creating` / `skipped` / `failed`) — there
 *     is no repository on the host to move at all.
 *
 * Distinguished by `reason` so the surface can render "already yours" as the
 * calm state it is rather than as a failure. → 409
 */
export class ProjectRepoNotTransferableError extends Error {
  readonly code = 'PROJECT_REPO_NOT_TRANSFERABLE' as const;
  constructor(
    ref: string,
    readonly reason: 'already_yours' | 'not_realized',
  ) {
    super(
      reason === 'already_yours'
        ? `Project repository row ${ref} is a repository you already own — there is nothing to transfer.`
        : `Project repository row ${ref} has no repository on the host to transfer.`,
    );
    this.name = 'ProjectRepoNotTransferableError';
  }
}

/**
 * An illegal hop in the takeover machine — most often a SECOND takeover request
 * for a row whose handoff is already in flight or already `done`. This is also
 * the lost-race guard: the row is locked and its takeover state re-read inside
 * the transaction, so a concurrent request's loser observes the already-moved
 * state and lands here rather than issuing a second transfer for one repository.
 * Names the legal targets so a caller self-corrects. → 409
 */
export class ProjectRepoTakeoverStateError extends Error {
  readonly code = 'PROJECT_REPO_ILLEGAL_TAKEOVER' as const;
  constructor(
    ref: string,
    readonly from: string,
    readonly to: string,
    readonly allowed: readonly string[],
  ) {
    super(
      allowed.length === 0
        ? `Project repository row ${ref} takeover is ${from}, a settled state with no legal transition (attempted ${to}).`
        : `Project repository row ${ref} takeover cannot move ${from} → ${to}. Allowed: ${allowed.join(', ')}.`,
    );
    this.name = 'ProjectRepoTakeoverStateError';
  }
}

/**
 * The requesting user has no connected GitHub identity, so there is no account to
 * transfer the repository TO.
 *
 * A FIRST-CLASS typed error rather than a generic 422 because the surface's
 * correct response is not an error banner but MOTIR-1900's connect prompt — the
 * user is one OAuth hop from being able to do this, and telling them so is the
 * whole difference between a dead end and a next step. → 409
 */
export class GithubIdentityRequiredError extends Error {
  readonly code = 'GITHUB_IDENTITY_REQUIRED' as const;
  constructor() {
    super('Connect your GitHub account before taking a repository over.');
    this.name = 'GithubIdentityRequiredError';
  }
}

/**
 * GitHub refused the transfer itself (the target does not exist, Motir's App
 * cannot administer the repository, a name collision in the target account, a
 * rate limit). The row is left `failed` WITH this reason recorded, so the handoff
 * is re-promptable rather than mysterious. → 502 — the failure is upstream, and a
 * 4xx would blame the caller for something they cannot fix by changing the
 * request.
 */
export class RepoTransferRefusedError extends Error {
  readonly code = 'REPO_TRANSFER_REFUSED' as const;
  constructor(readonly detail: string) {
    super(`GitHub refused the repository transfer: ${detail}`);
    this.name = 'RepoTransferRefusedError';
  }
}

/**
 * Thrown when an org-level disconnect is attempted on a GITHUB repository
 * (Story MOTIR-4669 · MOTIR-4679).
 *
 * ⚠️ IT IS NOT A PERMISSION REFUSAL AND NOT A BUG — it is the product telling the
 * truth about who owns the act. Which repositories Motir may read is the GitHub
 * App's own install screen; a Motir-side "stop tracking" would delete the mirror
 * row while leaving the App's grant in place, and the repository would reappear
 * on the next installation reconcile. Two sources of truth for one fact.
 *
 * The surface answers it with the pre-link-out DISCLOSURE (`design/github` panel
 * 7): the org-wide consequence stated on the way out, then `Continue on GitHub`.
 * The removal then arrives through the `installation_repositories` webhook, which
 * already prunes the row and enqueues the windowed offboarding.
 */
export class GithubRemovalHappensOnGithubError extends Error {
  readonly code = 'GITHUB_REMOVAL_HAPPENS_ON_GITHUB' as const;
  constructor(readonly repoRef: string) {
    super(
      `${repoRef} is a GitHub repository: Motir cannot remove it. Change the Motir App's repository access on GitHub.`,
    );
    this.name = 'GithubRemovalHappensOnGithubError';
  }
}
