// Typed errors for the public FOLLOW path (Story 8.9 · Subtask 8.9.5). Same
// contract as `errors.ts` beside it: the service throws, the route maps `code`
// to a status.
//
// ⚠️ THE SET IS DELIBERATELY SMALL, AND WHAT IS ABSENT IS THE POINT. There is no
// AlreadyFollowingError and no NotFollowingError, because follow and unfollow
// are IDEMPOTENT: following twice is following, unfollowing something you do not
// follow is not following it. Both answer the state, not an error.
//
// More importantly there is no "that address is already subscribed" error
// either. Telling a caller whether an address already follows a project would
// make this endpoint an ENUMERATION ORACLE — feed it a list of addresses and it
// reports which of them care about your project. Every email opt-in therefore
// answers the same way whatever the truth was (ADR §7), which is why the only
// failures here are about the REQUEST rather than about the row.

/** The submitted address is not plausibly an address. */
export class InvalidFollowEmailError extends Error {
  readonly code = 'INVALID_FOLLOW_EMAIL' as const;
  constructor() {
    super('That does not look like an email address.');
    this.name = 'InvalidFollowEmailError';
  }
}

/**
 * A confirmation token that names no row, or names one whose window has closed.
 *
 * ONE error for both, deliberately: "expired" and "never existed" are different
 * facts, and distinguishing them for the caller would let an attacker test
 * tokens for existence. The landing page's copy says "expired or already
 * used — subscribe again", which is true of every case that reaches it.
 */
export class FollowTokenInvalidError extends Error {
  readonly code = 'FOLLOW_TOKEN_INVALID' as const;
  constructor() {
    super('That confirmation link is no longer valid.');
    this.name = 'FollowTokenInvalidError';
  }
}

/**
 * The digest cannot be offered on this deployment — no transactional-email
 * backend is configured (ADR §4, the self-host path).
 *
 * The UI does not surface this as a failure: it does not OFFER the email tiers
 * at all when `digestAvailable` is false, so this error only fires if a client
 * posts anyway. It exists so that path answers something honest rather than
 * queueing a mail nothing will send.
 */
export class FollowDigestUnavailableError extends Error {
  readonly code = 'FOLLOW_DIGEST_UNAVAILABLE' as const;
  constructor() {
    super('Email updates are not available on this deployment.');
    this.name = 'FollowDigestUnavailableError';
  }
}
