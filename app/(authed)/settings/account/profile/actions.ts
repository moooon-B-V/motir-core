'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, getSession } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import {
  InvalidAvatarUrlError,
  InvalidProfileNameError,
  NoCredentialPasswordError,
  WeakPasswordError,
  WrongCurrentPasswordError,
} from '@/lib/users/errors';
import { consumeRateLimit } from '@/lib/rateLimit/fixedWindow';

// Server Actions for the Account › Profile pane (Story 8.8). Transport only (per
// CLAUDE.md, Server Actions are the route-layer equivalent): resolve the session,
// call ONE service method (or the Better-Auth framework primitive), translate
// typed errors into the discriminated RESULT the pane maps to its copy.
//
// - updateProfileNameAction (8.8.24, the scaffold) — the name inline-edit on the
//   Profile card, over usersService.updateProfile.
// - changePasswordAction / sendSetPasswordLinkAction (8.8.23) — the security
//   controls, rate-limited and branched by password capability.
//
// Two paths, branched by `usersService.getPasswordCapability` on the read side
// (8.8.21 / the pane SSR):
//   - credential users (hasPassword) → changePasswordAction (verify current,
//     set new).
//   - OAuth-only users (!hasPassword) → sendSetPasswordLinkAction, which
//     REUSES the shipped request-password-reset flow (the reset email +
//     /reset-password/new confirm already exist) so they can set an initial
//     password; Better-Auth's resetPassword creates the credential account on
//     confirm.
//
// Rate limiting is keyed by the AUTHENTICATED user id (not IP): more precise
// for a signed-in action and not spoofable from the client. The limiter is the
// same in-memory class the shipped Better-Auth reset limiter uses (see
// lib/rateLimit/fixedWindow.ts).

const CHANGE_PASSWORD_MAX = 5;
const CHANGE_PASSWORD_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const SET_LINK_MAX = 3;
const SET_LINK_WINDOW_MS = 60 * 60 * 1000; // 1 hour (mirrors /request-password-reset)

async function requireSession() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  return session;
}

// ── Update display name (the Profile card's inline edit, 8.8.24) ───────────

export type UpdateProfileNameResult =
  | { ok: true; name: string }
  | { ok: false; code: 'INVALID_NAME'; message: string };

/**
 * Persist the session user's display name from the Profile card's inline edit.
 * Delegates validation (non-empty, length bound) to `usersService.updateProfile`
 * and maps its typed `InvalidProfileNameError` to a field-level result the card
 * renders beside the input. Returns the canonical (trimmed) name so the optimistic
 * cell shows exactly what was stored. No rate limit: a name edit is a benign,
 * idempotent own-account write (unlike the password paths).
 */
export async function updateProfileNameAction(name: string): Promise<UpdateProfileNameResult> {
  const session = await requireSession();
  try {
    const profile = await usersService.updateProfile(session.user.id, { name });
    return { ok: true, name: profile.name };
  } catch (err) {
    if (err instanceof InvalidProfileNameError) {
      return { ok: false, code: 'INVALID_NAME', message: err.message };
    }
    throw err;
  }
}

// ── Update avatar (the Profile card's Photo row, 8.8.24a) ──────────────────

export type UpdateProfileAvatarResult =
  | { ok: true; image: string | null }
  | { ok: false; code: 'INVALID_AVATAR' };

/**
 * Persist (or clear) the session user's avatar from the Profile card's Photo
 * row. `AvatarField` uploads the file to `POST /api/upload/avatar` first (which
 * returns the stored blob URL), then calls this with that URL to set it — or
 * with `null` to remove it. Delegates the own-upload-URL validation and the
 * old-blob GC to `usersService.updateProfile`, mapping its typed
 * `InvalidAvatarUrlError` to a result the field surfaces as a toast. Returns the
 * canonical stored value so the optimistic avatar shows exactly what persisted.
 * No rate limit: setting your own avatar is a benign, idempotent own-account
 * write (the upload route itself gates size + MIME).
 */
export async function updateProfileAvatarAction(
  image: string | null,
): Promise<UpdateProfileAvatarResult> {
  const session = await requireSession();
  try {
    const profile = await usersService.updateProfile(session.user.id, { image });
    return { ok: true, image: profile.image };
  } catch (err) {
    if (err instanceof InvalidAvatarUrlError) {
      return { ok: false, code: 'INVALID_AVATAR' };
    }
    throw err;
  }
}

// ── Change password (credential users) ───────────────────────────────────

export type ChangePasswordResult =
  | { ok: true; revokedSessions: number }
  | { ok: false; code: 'WEAK_PASSWORD'; message: string }
  | { ok: false; code: 'WRONG_CURRENT_PASSWORD' | 'NO_CREDENTIAL_PASSWORD' | 'RATE_LIMITED' };

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}

export async function changePasswordAction(
  input: ChangePasswordInput,
): Promise<ChangePasswordResult> {
  const session = await requireSession();

  const limit = consumeRateLimit(
    `change-password:${session.user.id}`,
    CHANGE_PASSWORD_MAX,
    CHANGE_PASSWORD_WINDOW_MS,
  );
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  try {
    const { revokedSessions } = await usersService.changePassword({
      userId: session.user.id,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      currentSessionToken: session.session.token,
      revokeOtherSessions: input.revokeOtherSessions ?? false,
    });
    return { ok: true, revokedSessions };
  } catch (err) {
    if (err instanceof WeakPasswordError) {
      return { ok: false, code: 'WEAK_PASSWORD', message: err.message };
    }
    if (err instanceof WrongCurrentPasswordError) {
      return { ok: false, code: 'WRONG_CURRENT_PASSWORD' };
    }
    if (err instanceof NoCredentialPasswordError) {
      return { ok: false, code: 'NO_CREDENTIAL_PASSWORD' };
    }
    throw err;
  }
}

// ── Set a password (OAuth-only users — send the reset link) ───────────────

export type SendSetPasswordLinkResult =
  | { ok: true }
  | { ok: false; code: 'ALREADY_HAS_PASSWORD' | 'RATE_LIMITED' };

export async function sendSetPasswordLinkAction(): Promise<SendSetPasswordLinkResult> {
  const session = await requireSession();

  // Gate: a user who already has a password should use the change form, not
  // the set-link path. (The UI branches on `hasPassword`; this is the
  // server-side backstop.)
  const { hasPassword } = await usersService.getPasswordCapability(session.user.id);
  if (hasPassword) return { ok: false, code: 'ALREADY_HAS_PASSWORD' };

  const limit = consumeRateLimit(
    `set-password-link:${session.user.id}`,
    SET_LINK_MAX,
    SET_LINK_WINDOW_MS,
  );
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  // Reuse the SHIPPED request-password-reset flow: same Verification-table
  // token storage, the same `sendResetPassword` hook (which enqueues the
  // password-reset email), and the same /reset-password/new confirm page. The
  // redirectTo origin must be a trusted origin (lib/auth/index.ts trustedOrigins);
  // we build it from the incoming request headers, matching the reset page's
  // `${window.location.origin}/reset-password/new`.
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host');
  const origin = h.get('origin') ?? (host ? `${proto}://${host}` : 'http://localhost:3000');

  await auth.api.requestPasswordReset({
    headers: h,
    body: {
      email: session.user.email,
      redirectTo: `${origin}/reset-password/new`,
    },
  });

  return { ok: true };
}
