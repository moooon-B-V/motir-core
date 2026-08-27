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

// ── Profile errors (Subtask 8.8.21 — the Account › Profile pane) ───────────

/**
 * The submitted display name is empty (after trimming) or longer than the
 * bound (Story 8.8 · Subtask 8.8.21 — the Profile pane's name field). The
 * Profile form renders `message` inline beside the field; the route maps it to
 * a 400.
 */
export class InvalidProfileNameError extends Error {
  readonly code = 'INVALID_PROFILE_NAME' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProfileNameError';
  }
}

/**
 * The submitted avatar `image` URL is not one of OUR Vercel-Blob uploads under
 * the caller's own `avatars/<userId>/` prefix (Story 8.8 · Subtask 8.8.21). A
 * client must upload through the avatar route (which returns a qualifying URL)
 * rather than pass an arbitrary/foreign URL — the gate that prevents pointing
 * an avatar at someone else's blob or hotlinking an external image. → 400.
 */
export class InvalidAvatarUrlError extends Error {
  readonly code = 'INVALID_AVATAR_URL' as const;
  constructor() {
    super('That avatar image is not a valid upload.');
    this.name = 'InvalidAvatarUrlError';
  }
}

// ── Password-management errors (Subtask 8.8.23) ───────────────────────────
// Thrown by usersService.changePassword and the account-security server
// actions so the UI (8.8.24) renders distinct copy from a discriminating
// `code`, never a raw Better-Auth / Prisma error string.

/**
 * The supplied current password did not verify against the stored argon2id
 * hash. Returned as a field-level error on the "current password" input —
 * deliberately indistinguishable from other change failures in timing so it
 * can't be used to confirm a password by side channel.
 */
export class WrongCurrentPasswordError extends Error {
  readonly code = 'WRONG_CURRENT_PASSWORD' as const;
  constructor() {
    super('The current password is incorrect.');
    this.name = 'WrongCurrentPasswordError';
  }
}

/**
 * The proposed new password fails the strength policy (see
 * lib/auth/passwordPolicy.ts). Carries a human-safe reason for the field.
 */
export class WeakPasswordError extends Error {
  readonly code = 'WEAK_PASSWORD' as const;
  constructor(message = 'The new password does not meet the minimum requirements.') {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/**
 * The user has no credential (`providerId="credential"`) Account row with a
 * password — i.e. an OAuth-only account. They cannot CHANGE a password they
 * never set; the UI must route them to the set-password (reset-link) path
 * instead. A backstop: the UI branches on `hasPassword` before ever calling
 * changePassword, so this should not normally surface.
 */
export class NoCredentialPasswordError extends Error {
  readonly code = 'NO_CREDENTIAL_PASSWORD' as const;
  constructor() {
    super('This account signs in with Google and has no password to change.');
    this.name = 'NoCredentialPasswordError';
  }
}

/**
 * The inverse of {@link NoCredentialPasswordError}: a credential user (who
 * already has a password) hit the OAuth-only "send a set-password link" path.
 * They should use the change-password form instead.
 */
export class AlreadyHasPasswordError extends Error {
  readonly code = 'ALREADY_HAS_PASSWORD' as const;
  constructor() {
    super('This account already has a password; use change password instead.');
    this.name = 'AlreadyHasPasswordError';
  }
}

/**
 * The caller exceeded the per-user rate limit on a password operation.
 */
export class PasswordRateLimitedError extends Error {
  readonly code = 'RATE_LIMITED' as const;
  constructor() {
    super('Too many attempts. Please wait a moment and try again.');
    this.name = 'PasswordRateLimitedError';
  }
}

// ── Account-deletion errors (Story 8.4 · Subtask MOTIR-3700) ───────────────
// The WRITE half of `Data › Data & privacy`. Design of record:
// `design/settings/design-notes.md` → `Data & privacy` → DECISION 4 (deletion
// SCHEDULES, it does not fire) and DECISION 5 (the block is the organization).
//
// ⚠️ THESE EXIST SO THAT NO PRISMA ERROR REACHES A CALLER. Scheduling races on
// a partial unique index and cancelling races on a row lock, so both paths have
// a losing arm that arrives as a `P2002` or as a status that moved under the
// reader. Every one of them is translated here: the pane has to render a
// sentence, and `Unique constraint failed on the fields: (user_id)` is not one.

/**
 * The reader is the last owner of an organization other people belong to, so
 * the account cannot be closed (DECISION 5 — `assertNotLastOwner`'s condition,
 * read through the impact preview rather than caught from a delete attempt).
 *
 * Carries the organization's NAME because the refusal is only actionable with
 * it: the pane's way out is *"hand the owner role over in `Organization ›
 * Members`"*, and a reader who owns three organizations needs to know which.
 */
export class AccountDeletionBlockedError extends Error {
  readonly code = 'ACCOUNT_DELETION_BLOCKED' as const;
  constructor(readonly organizationName: string) {
    super(
      `This account owns ${organizationName} and is its only owner. ` +
        `Hand the owner role to somebody else before deleting the account.`,
    );
    this.name = 'AccountDeletionBlockedError';
  }
}

/**
 * A deletion is already scheduled for this account.
 *
 * ⚠️ RAISED FROM TWO PLACES THAT LOOK DIFFERENT AND MEAN THE SAME THING: the
 * in-transaction `FOR UPDATE` read that found an open row, and the `P2002` on
 * `account_deletion_request_open_per_user_key` when two requests raced past
 * that read together (the lock cannot serialise the FIRST insert — it locks a
 * predicate matching zero rows). One error type, because the caller's question
 * is *"is my account already being deleted?"* and the answer is yes either way.
 */
export class AccountDeletionAlreadyScheduledError extends Error {
  readonly code = 'ACCOUNT_DELETION_ALREADY_SCHEDULED' as const;
  constructor() {
    super('This account already has a deletion scheduled.');
    this.name = 'AccountDeletionAlreadyScheduledError';
  }
}

/**
 * There is nothing to cancel — the account has no `scheduled` request. Covers
 * "never asked" and "already cancelled" alike: both leave the reader in the
 * state the cancel was reaching for, so the pane renders the same thing.
 */
export class NoOpenAccountDeletionRequestError extends Error {
  readonly code = 'NO_OPEN_ACCOUNT_DELETION_REQUEST' as const;
  constructor() {
    super('This account has no scheduled deletion to cancel.');
    this.name = 'NoOpenAccountDeletionRequestError';
  }
}

/**
 * The erasure has already run. Deliberately NOT folded into
 * {@link NoOpenAccountDeletionRequestError}: *"nothing to cancel"* and *"the
 * data is gone"* are opposite answers to the reader, and a cancel that arrives
 * one second after the sweep committed must not be reported as though the
 * window were still open.
 */
export class AccountDeletionAlreadyCompletedError extends Error {
  readonly code = 'ACCOUNT_DELETION_ALREADY_COMPLETED' as const;
  constructor() {
    super('This account has already been erased and cannot be restored.');
    this.name = 'AccountDeletionAlreadyCompletedError';
  }
}
