// Typed errors for the public-project write path (Story 6.12 · Subtask 6.12.5).
// The route layer (`mapPublicProjectError`) maps each `code` to an HTTP status.
// The shared validation/access failures (a non-public project → 404, a denied
// grant → 403, a blank/over-long title, a bad kind) reuse the 6.11.4 triage
// intake errors + their mapper; these are the NEW failure modes the public,
// internet-facing submit path adds on top — the per-account throttle and the
// description size cap (the abuse guards the ADR §6 calls for).

/** The longest a public request body (Markdown) may be — the abuse-guard size
 *  cap for an internet-facing write (the title is bounded by the shared
 *  `MAX_TRIAGE_TITLE_LENGTH`). Generous enough for a real bug report, bounded
 *  enough that a single submission can't be a megabyte of spam. */
export const MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH = 10_000;

/**
 * The public submission body exceeded {@link MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH}.
 * A well-formed request whose body fails a domain bound → the route maps this to
 * 422.
 */
export class PublicRequestDescriptionTooLongError extends Error {
  readonly code = 'PUBLIC_REQUEST_DESCRIPTION_TOO_LONG' as const;
  constructor() {
    super(
      `A public request body must be at most ${MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH} characters.`,
    );
    this.name = 'PublicRequestDescriptionTooLongError';
  }
}

/**
 * The submitting account has exceeded the per-account submission throttle on a
 * public project (the ADR §6 abuse guard for an internet-facing write). The
 * route maps this to 429 (Too Many Requests). `retryAfterSeconds` is the
 * soonest the account may submit again — surfaced as a `Retry-After` header.
 */
export class PublicSubmissionRateLimitedError extends Error {
  readonly code = 'PUBLIC_SUBMISSION_RATE_LIMITED' as const;
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Too many submissions — please wait a moment before submitting again.');
    this.name = 'PublicSubmissionRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A public project has no resolvable OWNER to stand in as the intake reporter —
 * an invariant violation (every workspace is born with an owner), surfaced as a
 * typed error rather than a raw null-deref so the route maps it to a clean 409
 * instead of a 500. Should never fire in practice; kept so the failure is
 * legible if a workspace's owner is ever somehow removed.
 */
export class PublicProjectIntakeUnavailableError extends Error {
  readonly code = 'PUBLIC_PROJECT_INTAKE_UNAVAILABLE' as const;
  constructor(projectId: string) {
    super(`Public project ${projectId} has no owner to attribute the submission to.`);
    this.name = 'PublicProjectIntakeUnavailableError';
  }
}
