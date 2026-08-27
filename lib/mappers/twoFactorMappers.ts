import type { Verification } from '@/generated/prisma/client';
import type { TrustedDeviceDTO, TwoFactorMethod, TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

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
 *
 * ⚠️ `passkey` (Story MOTIR-1214) BREAKS THE SYMMETRY, and this function is
 * where it breaks. Both existing methods are answers to a challenge, so both are
 * gated on `enabled` and `primaryMethod` could simply be `methods[0]`. A passkey
 * is neither: it is a PRIMARY credential that mints a session outright, so
 *
 *   - it belongs in `methods` on `passkeyCount >= 1` REGARDLESS of `enabled` —
 *     the passkey plugin never touches `user.twoFactorEnabled`, so gating it
 *     would report a genuinely multi-factor account as having nothing; and
 *   - it may NEVER be `primaryMethod`, because there is no challenge for it to
 *     be offered at.
 *
 * That is why `primaryMethod` is now derived from its own list rather than from
 * `methods[0]`. Collapsing the two back into one expression is the regression to
 * watch for: it reads as a simplification and it silently starts telling the
 * challenge screen to offer a passkey.
 */
export function toTwoFactorStatusDTO(args: {
  enabled: boolean;
  enrolment: { verified: boolean } | null;
  passkeyCount: number;
  backupCodesRemaining: number;
  backupCodesTotal: number;
}): TwoFactorStatusDTO {
  // The challenge-answerable methods, in the order the challenge offers them.
  // `primaryMethod` reads THIS list and nothing else.
  const challengeMethods: TwoFactorMethod[] = [];
  if (args.enabled) {
    if (args.enrolment?.verified) challengeMethods.push('totp');
    challengeMethods.push('email');
  }

  // What the account is ENROLLED in — the challenge methods plus the passkey,
  // which is enrolled-but-not-challengeable.
  const methods: TwoFactorMethod[] = [...challengeMethods];
  if (args.passkeyCount >= 1) methods.push('passkey');

  return {
    enabled: args.enabled,
    methods,
    primaryMethod: challengeMethods[0] ?? null,
    backupCodesRemaining: args.backupCodesRemaining,
    backupCodesTotal: args.backupCodesTotal,
  };
}

/**
 * A `verification` trusted-device row → its DTO.
 *
 * Dates cross as ISO strings, not `Date`s: this shape is serialised into a
 * Server Component's props and returned from a JSON route, and a `Date` survives
 * neither trip intact.
 */
export function toTrustedDeviceDTO(row: Verification): TrustedDeviceDTO {
  return {
    id: row.id,
    trustedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
