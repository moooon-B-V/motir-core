// THE second-factor predicate (Story MOTIR-1215 · Subtask MOTIR-3645).
//
// `lib/dto/twoFactor.ts` decided this in prose when Story MOTIR-1214 shipped
// passkeys: *"the second-factor test is `methods.length > 0`, NOT `enabled` —
// that is the contract Story MOTIR-1215 reads."* This module is where that
// prose becomes a function, so the enforcement gate and the Security pane can
// never answer it differently.
//
// ⚠️ WHY IT IS NOT `twoFactorService.getStatus().methods.length > 0`.
// `getStatus` is three reads deep and decrypts the recovery-code column to
// produce a count, and this predicate runs on every signed-in page load
// (MOTIR-3648) and every gated API call (MOTIR-3653). So the cheap path reads
// two scalars and calls THIS; the pane keeps calling `getStatus`; and
// `tests/twoFactorHasSecondFactor.test.ts` asserts the two agree across the
// whole input space rather than trusting that they will.

/** The two facts the predicate is a function of. Nothing else is read. */
export interface SecondFactorInput {
  /**
   * `user.twoFactorEnabled` — Better-Auth's own column. TRUE means a challenge
   * is asked for at sign-in, which the account answers with an authenticator
   * code or an email OTP. Email needs no per-user enrolment, so an enabled
   * account always holds at least one challenge method.
   */
  enabled: boolean;
  /**
   * How many passkeys the account has registered. A passkey is registered with
   * `userVerification: 'required'`, so producing an assertion proves the human
   * unlocked the authenticator — it IS a second factor, and the passkey plugin
   * never touches `twoFactorEnabled`.
   */
  passkeyCount: number;
}

/**
 * Does this account hold at least one second factor?
 *
 * ⚠️ `enabled: false, passkeyCount: 1` is TRUE, and that case is the entire
 * reason this predicate exists. It is exactly the account MOTIR-1214 made the
 * most secure — passwordless, hardware-bound — and it is the one a naive
 * `user.twoFactorEnabled` check locks out of the product.
 *
 * `enrolment.verified` is deliberately NOT an input: an enabled account can
 * always answer the email OTP whether or not it ever confirmed an
 * authenticator, so a half-finished TOTP enrolment does not change the answer.
 * `tests/twoFactorHasSecondFactor.test.ts` asserts that over
 * `enabled × verified × passkeyCount`.
 */
export function hasSecondFactor(input: SecondFactorInput): boolean {
  return input.enabled || input.passkeyCount >= 1;
}
