import type { TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// The one client-side rule about `'passkey'` in a status DTO (Story MOTIR-1214 ·
// Subtask MOTIR-3612).
//
// ── Why this is a MODULE and not three inline expressions ──────────────────
// Three places on the Security pane rebuild a `TwoFactorStatusDTO` locally, and
// all three predate passkeys: `TwoFactorManager`'s disable handler writes
// `methods: []`, its confirm-enrolment handler writes `methods: ['totp','email']`,
// and `PasskeyManager` changes the passkey count. Left alone, the first two
// SILENTLY DROP a registered passkey from the account's method set — the island
// would show a person with a working passkey as having no second factor until
// they reloaded, which is precisely the answer Story 8.13 is about to read.
//
// So the rule lives in one pure function instead: rebuild whatever you like, then
// pass it through here with the fact you know about passkeys.

/**
 * Return `status` with `'passkey'` present iff `hasPasskey`.
 *
 * ⚠️ IT NEVER TOUCHES `primaryMethod`, and that is the whole subtlety. `methods`
 * answers *what is this account enrolled in*; `primaryMethod` answers *what will
 * the CHALLENGE ask for* — and a passkey mints a session outright, so it can
 * never be the answer to the second question. `lib/mappers/twoFactorMappers.ts`
 * makes the same split on the server; this is its client-side twin, and the two
 * must not drift.
 *
 * Idempotent, and it preserves the order the server sends (`totp`, `email`, then
 * `passkey`), so a status that already agrees comes back unchanged.
 */
export function withPasskeyMethod(
  status: TwoFactorStatusDTO,
  hasPasskey: boolean,
): TwoFactorStatusDTO {
  const present = status.methods.includes('passkey');
  if (present === hasPasskey) return status;
  return {
    ...status,
    methods: hasPasskey
      ? [...status.methods, 'passkey']
      : status.methods.filter((m) => m !== 'passkey'),
  };
}

/**
 * Whether the account holds at least one passkey, read off the method set.
 *
 * A one-line helper because the alternative — threading the passkey COUNT into
 * `TwoFactorManager` beside the status it already has — would give the pane two
 * answers to one question, which is the defect this module exists to prevent.
 */
export function hasPasskeyMethod(status: TwoFactorStatusDTO): boolean {
  return status.methods.includes('passkey');
}
