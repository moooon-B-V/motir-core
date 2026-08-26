import { db } from '@/lib/db';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { currentLocale } from '@/lib/i18n/serverLocale';
import { userRepository } from '@/lib/repositories/userRepository';
import { twoFactorRepository } from '@/lib/repositories/twoFactorRepository';
import { toTwoFactorStatusDTO } from '@/lib/mappers/twoFactorMappers';
import type { BackupCodeSetDTO, TwoFactorStatusDTO } from '@/lib/dto/twoFactor';
import {
  TWO_FACTOR_BACKUP_CODE_COUNT,
  TWO_FACTOR_OTP_PERIOD_MINUTES,
} from '@/lib/auth/twoFactorConfig';
import {
  countBackupCodes,
  decodeBackupCodes,
  encodeBackupCodes,
  generateBackupCodes,
} from '@/lib/twoFactor/backupCodes';
import { InvalidBackupCodeError, TwoFactorNotEnabledError } from '@/lib/twoFactor/errors';
import { UserNotFoundError } from '@/lib/users/errors';

// The two-factor business layer (Story MOTIR-1213 · Subtask MOTIR-1218).
//
// ⚠️ READ THIS BEFORE ADDING A METHOD: WHAT THIS SERVICE OWNS, AND WHAT IT
// DELIBERATELY DOES NOT.
//
// Better-Auth's `twoFactor` plugin owns every AUTHENTICATION CEREMONY — enable,
// disable-with-password, TOTP verify, OTP send/verify, backup-code verify at the
// challenge. Those are reached as `/api/auth/two-factor/*` and are called from
// the browser through `authClient.twoFactor.*`. They are not proxied here, and
// they must not be: each of them ends by MINTING OR ROTATING A SESSION COOKIE
// through Better-Auth's own cookie machinery, which a Motir service standing
// outside the request has no way to do. A method here that "wrapped" one would
// be a method that silently could not complete a sign-in.
//
// What is left over is real and is what this file is:
//
//   1. THE STATUS READ. The pane needs "is it on, which methods, how many
//      recovery codes are left" and the plugin exposes no such thing. Counting
//      the codes requires decrypting the column, so it is service work, not a
//      Prisma query.
//   2. THE RECOVERY-CODE SET, from the SIGNED-IN side — regenerate, and spend.
//      The plugin spends a code at the CHALLENGE (it must; it mints the
//      session); Motir spends one from an already-authenticated surface, and
//      mints new sets. Both write the same column, which is why the codec lives
//      in lib/twoFactor/backupCodes.ts and is byte-compatible with the plugin's.
//   3. DISABLE, as a STATE change. `authClient.twoFactor.disable` is the
//      user-facing path (it re-checks the password and rotates the session);
//      `disable` here is the administrative / cleanup half that guarantees the
//      flag and the row move together.
//
// Layer rules (CLAUDE.md): this file owns every `$transaction`, threads `tx`
// into each repository write, and returns DTOs.

export const twoFactorService = {
  /**
   * The Security pane's read (MOTIR-1220).
   *
   * READ-ONLY, so no transaction and no lock: a count that is one spend stale
   * is a display artifact the next render corrects, and taking a row lock to
   * paint a number would serialise every page load behind every challenge.
   * Everything that ACTS on the set locks (`consumeBackupCode`,
   * `regenerateBackupCodes`).
   */
  async getStatus(userId: string): Promise<TwoFactorStatusDTO> {
    const user = await userRepository.findById(userId);
    if (!user) throw new UserNotFoundError(userId);

    const enrolment = await twoFactorRepository.findByUserId(userId);
    const remaining = enrolment ? await countBackupCodes(enrolment.backupCodes) : 0;

    return toTwoFactorStatusDTO({
      enabled: user.twoFactorEnabled,
      enrolment: enrolment ? { verified: enrolment.verified } : null,
      backupCodesRemaining: remaining,
      // The mint size is a configuration constant, not a stored one — nothing
      // records how many the last mint produced. Reporting the configured count
      // as N is right for every set minted under the current config and is the
      // only honest answer available for an older one.
      backupCodesTotal: TWO_FACTOR_BACKUP_CODE_COUNT,
    });
  },

  /**
   * Spend ONE recovery code, from an already-authenticated surface.
   *
   * ⚠️ THE LOCK IS THE POINT OF THIS METHOD. Spending is a read-derived write
   * over a set that lives in a single column: decrypt → remove one member →
   * re-encrypt → write the whole column back. Without the row lock, two
   * concurrent spends of the SAME code both read the full set, both find their
   * code present, and both write a set missing only their own — so the second
   * write puts the first's code back and a single-use credential is usable
   * twice. `findByUserIdForUpdate` takes `SELECT … FOR UPDATE` inside this
   * transaction, so the loser blocks until the winner commits and then re-reads
   * the already-shortened set, where its code is gone — and it gets
   * `InvalidBackupCodeError`, a typed domain error, never a raw Prisma code.
   *
   * A LOST RACE IS `InvalidBackupCodeError`, ON PURPOSE, and it is not a
   * conflict to retry. From where the caller stands "somebody else just spent
   * this code" and "you typed a code that was already spent" are the same fact:
   * the code is gone. Distinguishing them would tell an attacker their guess
   * had been real.
   *
   * Returns the remaining count so a caller can warn on the last code without a
   * second read.
   */
  async consumeBackupCode(userId: string, code: string): Promise<{ remaining: number }> {
    return db.$transaction(async (tx) => {
      const enrolment = await twoFactorRepository.findByUserIdForUpdate(userId, tx);
      if (!enrolment) throw new TwoFactorNotEnabledError();

      // Re-read INSIDE the lock — the whole point. A set decoded before the
      // lock was taken is exactly the stale value this method exists to avoid.
      const codes = await decodeBackupCodes(enrolment.backupCodes);
      const remaining = codes.filter((candidate) => candidate !== code);
      if (remaining.length === codes.length) throw new InvalidBackupCodeError();

      await twoFactorRepository.updateBackupCodes(
        enrolment.id,
        await encodeBackupCodes(remaining),
        tx,
      );
      return { remaining: remaining.length };
    });
  },

  /**
   * Mint a fresh recovery-code set, replacing whatever is there.
   *
   * The plaintext is returned ONCE, here, and never again — the stored form is
   * encrypted and `getStatus` can only ever answer a count. The caller shows and
   * offers it for download, then discards it.
   *
   * Locks for a different reason than `consumeBackupCode`: the set it replaces
   * is not read, so there is no stale-read hazard, but a regenerate racing a
   * spend must not interleave. Without the lock the spend can commit between
   * this mint and its write, and the spend's shortened set is then overwritten
   * by codes the user never saw — losing a code the user had already used and,
   * worse, silently discarding the mint the user is looking at. Serialising them
   * makes the outcome whichever ordering actually happened.
   *
   * ⚠️ Behind a step-up check — the CALLER's job, not this method's. Every 2FA
   * management action sits behind a recent-auth re-check (the story's own
   * shape); this service is reached only from a session-gated route, and the
   * step-up prompt belongs to the pane (MOTIR-1220).
   */
  async regenerateBackupCodes(userId: string): Promise<BackupCodeSetDTO> {
    const codes = generateBackupCodes(TWO_FACTOR_BACKUP_CODE_COUNT);

    return db.$transaction(async (tx) => {
      const enrolment = await twoFactorRepository.findByUserIdForUpdate(userId, tx);
      if (!enrolment) throw new TwoFactorNotEnabledError();

      await twoFactorRepository.updateBackupCodes(enrolment.id, await encodeBackupCodes(codes), tx);
      return { codes, remaining: codes.length };
    });
  },

  /**
   * Turn 2FA off: drop every enrolment row and clear the flag, in ONE
   * transaction.
   *
   * The atomicity is the requirement. The two halves live in different tables,
   * and either partial state is a real failure: a cleared flag with a surviving
   * row leaves credentials for an account that no longer challenges, and a
   * surviving flag with no row leaves an account that demands a second factor
   * it cannot produce — a lockout, from a half-applied disable.
   *
   * Idempotent: disabling an account that is already off writes `false` over
   * `false`, deletes nothing, and returns normally. A user clicking twice, or a
   * retry, must not error.
   */
  /**
   * ENQUEUE the emailed one-time code (Story MOTIR-1213 · Subtask MOTIR-1218).
   *
   * Called from Better-Auth's `otpOptions.sendOTP` hook (lib/auth/index.ts)
   * with a code the plugin has ALREADY generated and ALREADY persisted as a
   * hashed challenge through its own adapter. So by construction this runs
   * AFTER the durable write, and it is the "side effects outside the
   * transaction" rule in its normal shape rather than an exception to it.
   *
   * ⚠️ IT ENQUEUES; IT DOES NOT SEND. `sendEvent` publishes an `email.send`
   * event and returns — the provider call happens later, inside the durable
   * job, with retries. That is what keeps a slow or down provider off the
   * request the user is waiting on at the challenge screen, and it is why a
   * PROVIDER failure cannot roll anything back or fail the challenge: by then
   * the request is long finished and the job is the thing retrying. The
   * password-reset hook above it makes exactly the same call for exactly the
   * same reason.
   *
   * ⚠️ AN ENQUEUE FAILURE IS SWALLOWED, AND THAT IS `sendEvent`'s CONTRACT
   * RATHER THAN THIS METHOD'S CHOICE — read it before assuming otherwise, as
   * this comment originally did. `dispatchToLanes` catches a transport failure
   * on BOTH lanes and logs it, because every other caller emits after a
   * committed mutation and a throw there would turn a saved change into a 500
   * with a reverting optimistic UI. The strict door
   * (`dispatchSystemEvent`) is `system.*`-only.
   *
   * The consequence HERE is worse than it is for those callers and is worth
   * naming: there is no committed mutation for the user to keep, so a dropped
   * enqueue means the challenge screen says "check your email" and no code
   * ever arrives — recoverable only by a retry that fails the same silent way.
   * Filed as its own bug rather than absorbed into this card, because making
   * `sendEvent` strict for one event is a change to a contract every emitter
   * depends on.
   *
   * Lives here rather than inline in the auth config because composing an
   * email's inputs and dispatching it is service work (CLAUDE.md: no email
   * logic in the wiring layer), and because a hook buried in a config literal
   * is a hook no test can reach.
   */
  async dispatchOtpEmail(args: { userId: string; email: string; name: string; otp: string }) {
    await sendEvent('email.send', {
      // A sign-in is identity-scoped, and the user has not chosen a workspace
      // yet — the challenge runs BEFORE the session exists. Same call as the
      // password-reset send.
      workspaceId: null,
      // The issuance itself: a double-submitted "email me a code" that re-fires
      // the SAME code collapses to one delivery, while pressing "resend" mints a
      // new code, a new key, and a second mail — which is what the user means.
      idempotencyKey: `two-factor-otp:${args.userId}:${args.otp}`,
      to: args.email,
      template: 'two-factor-otp',
      data: {
        recipientName: args.name || 'there',
        code: args.otp,
        expiresInMinutes: TWO_FACTOR_OTP_PERIOD_MINUTES,
        locale: await currentLocale(),
      },
    });
  },

  async disable(userId: string): Promise<void> {
    await db.$transaction(async (tx) => {
      // Lock first even though nothing is derived from the read: it serialises
      // this against a concurrent spend or regenerate, so a disable cannot
      // interleave with a write to a row it is about to delete.
      await twoFactorRepository.findByUserIdForUpdate(userId, tx);
      await twoFactorRepository.deleteByUserId(userId, tx);
      await userRepository.setTwoFactorEnabled(userId, false, tx);
    });
  },
};
