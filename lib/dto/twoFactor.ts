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

/**
 * The second-factor methods an account can hold.
 *
 * `totp` and `email` are answers to a CHALLENGE — they exist only in the step
 * between the password and the session. `passkey` (Story MOTIR-1214) is not: it
 * is a primary credential that mints a session outright, and it counts as a
 * second factor because it is registered with `userVerification: 'required'`, so
 * producing an assertion means the authenticator proved the human unlocked it.
 * That difference is why the two fields below stopped having the same answer.
 */
export type TwoFactorMethod = 'totp' | 'email' | 'passkey';

/**
 * The Security pane's read: what is on, what is available, and how much
 * recovery is left. Derived, never stored — `enabled` is `user.twoFactorEnabled`
 * and the counts come from decoding the enrolment row.
 */
export interface TwoFactorStatusDTO {
  /** Whether a second factor is required at sign-in for this account. */
  enabled: boolean;
  /**
   * What this account is ENROLLED in, in the order the pane lists them.
   *
   * ⚠️ THIS IS NOT "what the challenge will ask for" — that is `primaryMethod`,
   * and the two are different questions. `totp` appears only once an
   * authenticator enrolment has been CONFIRMED (the plugin's `verified` flag)
   * and `email` is available to any ENABLED account because it needs no per-user
   * setup, so both of those are gated on `enabled`. **`passkey` is NOT**: it
   * appears whenever the account holds at least one registered passkey, even
   * with `enabled: false`. The passkey plugin never touches
   * `user.twoFactorEnabled`, so a person can hold a passkey, be genuinely
   * multi-factor, and have that flag off — and gating the entry behind it would
   * report exactly that person as having no second factor.
   *
   * ⚠️ SO THE SECOND-FACTOR TEST IS `methods.length > 0`, NOT `enabled`. That is
   * the contract Story MOTIR-1215 (2FA enforcement) reads, and it is written
   * here rather than in a decision record because this is where it is decided.
   */
  methods: TwoFactorMethod[];
  /**
   * Which method the CHALLENGE screen offers first — a question only about the
   * step between the password and the session.
   *
   * `totp` whenever it is available — email is a fallback and is labelled as the
   * lower-security one (NIST 800-63B: an email account is not a strong
   * possession factor) — else `email`, else `null` when 2FA is off.
   *
   * ⚠️ NEVER `'passkey'`, under any input. A passkey sign-in mints a session
   * directly (`verifyPasskeyAuthentication`), so by the time a challenge screen
   * could appear the passkey's moment has passed — there is nothing for it to be
   * offered as. An account holding three passkeys with 2FA off reads
   * `methods: ['passkey'], primaryMethod: null`, and both halves of that are
   * correct.
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
