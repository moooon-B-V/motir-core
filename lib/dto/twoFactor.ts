// DTOs for the account two-factor surface (Story MOTIR-1213 · Subtask
// MOTIR-1218) — what crosses `/api/account/two-factor/*` to the Security pane
// (MOTIR-1220) and the login challenge (MOTIR-1221).
//
// NOTHING SECRET CROSSES EXCEPT ONCE, ON PURPOSE. The TOTP seed and the stored
// recovery codes never appear in `TwoFactorStatusDTO` — the pane renders a
// COUNT, not the set. The one shape that carries plaintext is
// `BackupCodeSetDTO`, returned exactly once by a regenerate, because
// "shown once, never again" is the whole contract of a recovery code and the
// only way to honour it is to hand it back at the moment it is minted.

/** The 2FA methods a user can hold. `passkey` is added by Story MOTIR-1214. */
export type TwoFactorMethod = 'totp' | 'email';

/**
 * The Security pane's read: what is on, what is available, and how much
 * recovery is left. Derived, never stored — `enabled` is `user.twoFactorEnabled`
 * and the counts come from decoding the enrolment row.
 */
export interface TwoFactorStatusDTO {
  /** Whether a second factor is required at sign-in for this account. */
  enabled: boolean;
  /**
   * The methods this account can actually answer a challenge with, in the order
   * the pane lists them. `totp` appears only once an authenticator enrolment has
   * been CONFIRMED (the plugin's `verified` flag); `email` is available to any
   * enrolled account because it needs no per-user setup.
   */
  methods: TwoFactorMethod[];
  /**
   * Which method the challenge screen offers FIRST. `totp` whenever it is
   * available — email is a fallback and is labelled as the lower-security one
   * (NIST 800-63B: an email account is not a strong possession factor) — else
   * `email`, else `null` when 2FA is off.
   */
  primaryMethod: TwoFactorMethod | null;
  /**
   * Unspent recovery codes. `0` with `enabled: true` is a real and dangerous
   * state (every code used, no authenticator to hand), which is why the pane
   * renders "X of N" rather than a boolean.
   */
  backupCodesRemaining: number;
  /** How many the last mint produced — the N in "X of N remaining". */
  backupCodesTotal: number;
}

/**
 * A freshly minted recovery-code set, handed back ONCE at the moment it is
 * created. Never read back: the stored form is encrypted and the pane can only
 * ever ask for the count again.
 */
export interface BackupCodeSetDTO {
  /** The plaintext codes, in mint order. Display + download, then discard. */
  codes: string[];
  /** Equal to `codes.length`; carried so a caller need not recount. */
  remaining: number;
}

/**
 * One browser the reader told Motir to stop asking.
 *
 * ⚠️ IT HAS NO NAME, and that is the row's shape rather than an omission. A
 * trusted device is a `verification` row carrying an opaque identifier, the
 * owner's id and an expiry — no user-agent, no IP, no label. So this DTO says
 * WHEN and UNTIL WHEN, and a surface that wants "Chrome on macOS" would need
 * Motir to start recording it at the moment of trust, which nothing does today.
 */
export interface TrustedDeviceDTO {
  /** The `verification` row id — what a revoke addresses. Opaque to the reader. */
  id: string;
  /** When the reader ticked "don't ask again". */
  trustedAt: string;
  /** When the grant lapses on its own. */
  expiresAt: string;
}
