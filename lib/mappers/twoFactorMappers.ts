import type { TwoFactorMethod, TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// Prisma rows → the two-factor DTOs (Story MOTIR-1213 · Subtask MOTIR-1218).
//
// The mapper is where the pane's DERIVED facts are computed, so there is one
// answer to "which methods can this account use?" rather than one per surface.

/**
 * Build the Security pane's status.
 *
 * `enrolment` is null when the account has no `two_factor` row at all. Note the
 * two states that are NOT the same and both occur:
 *
 *   - **enabled with no confirmed TOTP** — the user started an authenticator
 *     enrolment, never entered the confirming code, but has 2FA on by another
 *     route. `totp` is withheld, exactly as the plugin withholds it at the
 *     challenge (it offers `totp` only when `verified !== false`).
 *   - **a row present with 2FA off** — a stale enrolment left by an
 *     abandoned enable. `methods` is empty, because nothing will be asked for.
 *
 * `email` is offered to any ENABLED account and needs no per-user setup: the
 * plugin's OTP arm is server-level, available the moment a `sendOTP` hook is
 * configured (it is — lib/auth/index.ts). It is second in the list and second
 * in `primaryMethod` because an email inbox is not a strong possession factor
 * (NIST 800-63B), so it is the fallback and the pane labels it as one.
 */
export function toTwoFactorStatusDTO(args: {
  enabled: boolean;
  enrolment: { verified: boolean } | null;
  backupCodesRemaining: number;
  backupCodesTotal: number;
}): TwoFactorStatusDTO {
  const methods: TwoFactorMethod[] = [];
  if (args.enabled) {
    if (args.enrolment?.verified) methods.push('totp');
    methods.push('email');
  }
  return {
    enabled: args.enabled,
    methods,
    primaryMethod: methods[0] ?? null,
    backupCodesRemaining: args.backupCodesRemaining,
    backupCodesTotal: args.backupCodesTotal,
  };
}
