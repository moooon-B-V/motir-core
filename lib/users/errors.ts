// Typed errors for the users repository. Kept in their own file so callers
// (route handlers, server actions, server components) can import them without
// pulling in the Prisma client. The error shape mirrors what Story 1.1.5's
// sign-up form needs to render — a discriminating `code` plus a human-safe
// `message`.

export class DuplicateEmailError extends Error {
  readonly code = 'DUPLICATE_EMAIL' as const;
  constructor(email: string) {
    super(`A user with email ${email} already exists.`);
    this.name = 'DuplicateEmailError';
  }
}

export class UserNotFoundError extends Error {
  readonly code = 'USER_NOT_FOUND' as const;
  constructor(identifier: string) {
    super(`No user found for ${identifier}.`);
    this.name = 'UserNotFoundError';
  }
}

// ── Change-email flow (Subtask 8.8.22) ──────────────────────────────────────

/**
 * The requested new email is already taken by another account. Thrown by both
 * `requestEmailChange` (a concurrent request lost the `EmailChangeRequest.newEmail`
 * unique race → `P2002`, OR a confirmed user already owns it) and
 * `confirmEmailChange` (a fresh signup grabbed the address between request and
 * confirm → `P2002` on the `User.email` swap). A separate type from
 * `DuplicateEmailError` (which the sign-up form renders) so the change-email UI
 * can phrase it as "that address is in use" without coupling to signup copy.
 */
export class EmailTakenError extends Error {
  readonly code = 'EMAIL_TAKEN' as const;
  constructor(email: string) {
    super(`The email ${email} is already in use.`);
    this.name = 'EmailTakenError';
  }
}

/** The new email is the account's CURRENT email — nothing to change. */
export class SameEmailError extends Error {
  readonly code = 'SAME_EMAIL' as const;
  constructor() {
    super('The new email is the same as your current email.');
    this.name = 'SameEmailError';
  }
}

/** The supplied string is not a syntactically valid email address. */
export class InvalidEmailError extends Error {
  readonly code = 'INVALID_EMAIL' as const;
  constructor(email: string) {
    super(`"${email}" is not a valid email address.`);
    this.name = 'InvalidEmailError';
  }
}

/**
 * The confirm token is unknown, already used, or expired. One type for all
 * three so the confirm route never reveals WHICH (no token-probing oracle).
 */
export class InvalidEmailChangeTokenError extends Error {
  readonly code = 'INVALID_EMAIL_CHANGE_TOKEN' as const;
  constructor() {
    super('This email-change link is invalid or has expired.');
    this.name = 'InvalidEmailChangeTokenError';
  }
}

/** Too many change-email requests for this user in the rate-limit window. */
export class EmailChangeRateLimitedError extends Error {
  readonly code = 'EMAIL_CHANGE_RATE_LIMITED' as const;
  constructor() {
    super('Too many email-change requests. Please try again later.');
    this.name = 'EmailChangeRateLimitedError';
  }
}
