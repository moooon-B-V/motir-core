// The passkey constants (Story MOTIR-1214 · Subtask MOTIR-3610).
//
// They live in their own module, NOT in lib/auth/index.ts, for the same concrete
// reason `twoFactorConfig.ts` does: `lib/auth/index.ts` imports `next/headers`
// and the Prisma client, so importing it from a client component fails the
// build. The passkeys section on the Security pane (MOTIR-3612) and the
// "Sign in with a passkey" affordance (MOTIR-3613) are client components that
// need to SAY these numbers — "that took too long, try again" after five
// minutes, "at most 64 characters" on the rename field — and a number a screen
// states must be the same number the server enforces, not a second copy of it.
//
// Pure values only: no imports, no env reads, no side effects.

/**
 * How long the WebAuthn challenge stays valid, in SECONDS.
 *
 * This is NOT ours to choose: the plugin keeps the challenge in a cookie
 * (`advanced.webAuthnChallengeCookie`, default `better-auth-passkey`) and hard-codes
 * `MAX_AGE_IN_SECONDS = 300` when it mints it. Mirrored here so the pane can
 * explain a `CHALLENGE_NOT_FOUND` refusal in the user's own units rather than
 * showing them the plugin's error code.
 */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 300;

/**
 * The same window in MINUTES — the unit the copy actually uses ("that took more
 * than 5 minutes, try again"). Derived rather than restated so the two can never
 * disagree.
 */
export const PASSKEY_CHALLENGE_TTL_MINUTES = PASSKEY_CHALLENGE_TTL_SECONDS / 60;

/**
 * How long a passkey's display name may be.
 *
 * OURS, not the plugin's — `name` is a free `string?` in its schema with no
 * length check anywhere in the registration or update path, so nothing enforces
 * a bound unless we do. 64 is the same ceiling the rest of the product puts on a
 * short human label; the name exists only to tell two passkeys apart in a list,
 * and a row that wraps to three lines tells them apart less well.
 */
export const PASSKEY_NAME_MAX_LENGTH = 64;

/**
 * The human-readable relying-party name — what the operating system's own
 * passkey prompt shows above the fingerprint reader. The `rpName` half of the
 * WebAuthn ceremony; the `rpID` half is derived from `lib/baseUrl.ts` and is
 * deliberately NOT a constant (it differs per deployment).
 */
export const PASSKEY_RP_NAME = 'Motir';

/**
 * `userVerification: 'required'` — and it is the whole reason a passkey counts
 * as a second factor here.
 *
 * SimpleWebAuthn (which the plugin builds its options with) defaults to
 * `'preferred'`, which lets an authenticator hand back an assertion with no PIN,
 * no fingerprint and no face — one factor, possession only. `'required'` makes
 * the authenticator prove the human unlocked it, so the credential is
 * possession + inherence/knowledge in one gesture (NIST SP 800-63B), which is
 * what lets Story 8.13 (MOTIR-1215) count `passkey` towards a require-2FA policy.
 */
export const PASSKEY_USER_VERIFICATION = 'required' as const;

/**
 * `residentKey: 'preferred'` — ask for a discoverable credential, do not demand
 * one.
 *
 * A discoverable (resident) credential is what makes the passwordless sign-in on
 * the EMAIL step possible at all: the browser can offer the account without
 * being told which one to look for. `'preferred'` rather than `'required'`
 * because a security key with no room left for one still registers fine and is
 * still a perfectly good second factor — it just cannot start the sign-in, which
 * is a smaller loss than refusing the registration outright.
 */
export const PASSKEY_RESIDENT_KEY = 'preferred' as const;
