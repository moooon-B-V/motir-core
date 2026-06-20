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
