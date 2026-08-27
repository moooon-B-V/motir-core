import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

// Browser-safe Better-Auth client. Pair with lib/auth/index.ts which is the
// server instance — that file imports next/headers + Prisma and CANNOT be
// imported from a client component (importing it will fail the build with
// module-resolution errors). All client components doing sign-in / sign-up
// / signOut go through this file.
//
// baseURL: read from the public env var so the client can resolve the API
// origin in both browser and SSR contexts. Defaults to '' which Better-Auth
// resolves to the current origin at request time — works for local dev and
// for any single-origin deployment. Multi-origin setups must set
// NEXT_PUBLIC_BETTER_AUTH_URL explicitly. Note we deliberately don't read
// BETTER_AUTH_URL (the server var) — that one isn't exposed to the browser
// and would be undefined at runtime, silently falling back to current origin.

export const authClient = createAuthClient({
  baseURL: process.env['NEXT_PUBLIC_BETTER_AUTH_URL'] ?? '',
  // twoFactorClient (Story MOTIR-1213 · Subtask MOTIR-1217) is the browser half
  // of the server's `twoFactor` plugin: it types `authClient.twoFactor.*`
  // (enable / disable / verifyTotp / sendOtp / verifyOtp / verifyBackupCode /
  // generateBackupCodes) for the Security pane (MOTIR-1220) and the login
  // challenge (MOTIR-1221).
  //
  // It must be registered HERE and not per-surface: it also installs the
  // `twoFactorRedirect` handling that turns a sign-in answering
  // `{ twoFactorRedirect: true }` into the challenge step instead of a
  // successful session. A sign-in call made through a client without this
  // plugin would read that response as a plain success.
  //
  // No `redirect` / `twoFactorPage` option: the challenge is rendered inline by
  // the sign-in surface rather than at a route of its own, so the caller
  // branches on the response. MOTIR-1221 owns that screen.
  //
  // ── passkey ────────────────────────────────────────────────────────────────
  //
  // passkeyClient (Story MOTIR-1214 · Subtask MOTIR-3610) is the browser half of
  // the server's `passkey` plugin. It types `authClient.passkey.*` (addPasskey /
  // listUserPasskeys / updatePasskey / deletePasskey) for the Security pane's
  // passkeys section (MOTIR-3612) and `authClient.signIn.passkey` for the sign-in
  // affordance (MOTIR-3613).
  //
  // It must be registered HERE for the same reason `twoFactorClient` is, plus one
  // of its own: the two ceremonies are not fetches, they are calls into
  // `navigator.credentials` with the browser's own consent sheet in the middle,
  // and the plugin owns that choreography (options → `startRegistration` /
  // `startAuthentication` → verify). A surface that reached for the endpoints
  // through a plain client would have to re-implement it, and get the
  // ArrayBuffer/base64url encoding right by hand.
  plugins: [twoFactorClient(), passkeyClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;

/**
 * The two-factor client namespace — enable / disable / verify / regenerate.
 * Re-exported alongside the four above so a surface imports one name rather
 * than reaching into `authClient` for it.
 */
export const twoFactor = authClient.twoFactor;

/**
 * The passkey client namespace — add / list / rename / remove a credential.
 * Re-exported alongside `twoFactor` so a surface imports one name rather than
 * reaching into `authClient` for it. (The SIGN-IN half is
 * `authClient.signIn.passkey`, which rides the `signIn` export above.)
 */
export const passkey = authClient.passkey;
