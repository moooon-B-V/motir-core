// Typed errors for the two-factor domain (Story MOTIR-1213 · Subtask
// MOTIR-1218). In their own file so a route handler or a Server Component can
// import them without pulling in Prisma, matching lib/users/errors.ts.
//
// The discriminator is `code`, and every one of these exists so that a raw
// Prisma error code never escapes the service (CLAUDE.md § concurrency paths
// translate raw DB races to typed errors).

/** The account has no two-factor enrolment at all. */
export class TwoFactorNotEnabledError extends Error {
  readonly code = 'TWO_FACTOR_NOT_ENABLED' as const;
  constructor() {
    super('Two-factor authentication is not enabled for this account.');
    this.name = 'TwoFactorNotEnabledError';
  }
}

/**
 * The submitted recovery code is not in the account's unspent set — either it
 * was never issued, or it has already been used. The two are deliberately
 * INDISTINGUISHABLE to the caller: telling them apart would let an attacker
 * probe which codes exist.
 */
export class InvalidBackupCodeError extends Error {
  readonly code = 'INVALID_BACKUP_CODE' as const;
  constructor() {
    super('That recovery code is not valid.');
    this.name = 'InvalidBackupCodeError';
  }
}

/**
 * The stored recovery-code column could not be decoded — the ciphertext does
 * not decrypt under the current `BETTER_AUTH_SECRET`, or it is not the JSON
 * array the encoder writes.
 *
 * This is NOT a user error and must not be reported as one: the honest cause is
 * a rotated or mistyped secret, and telling a locked-out user "wrong code" for
 * an operator's configuration mistake sends them to support with the wrong
 * story. Its own type so a route can answer 500 rather than 401.
 */
export class BackupCodesUnreadableError extends Error {
  readonly code = 'BACKUP_CODES_UNREADABLE' as const;
  constructor(cause?: unknown) {
    super('The stored recovery codes could not be read.');
    this.name = 'BackupCodesUnreadableError';
    if (cause !== undefined) this.cause = cause;
  }
}
