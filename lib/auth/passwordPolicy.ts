import { WeakPasswordError } from '@/lib/users/errors';

// Single source of truth for the password-strength policy. The sign-up
// (app/(auth)/sign-up) and reset-password-new (app/(auth)/reset-password/new)
// CLIENT forms each hard-code `password.length < 8` for instant feedback;
// this module is the SERVER-side gate (client validation is UX, not security)
// and pins the same minimum so the in-app change-password path (Subtask
// 8.8.23) rejects weak passwords before they are hashed.
//
// Better-Auth's own default minPasswordLength is also 8, so the two layers
// agree — but we validate here BEFORE handing the password to argon2 so the
// failure comes back as a typed WeakPasswordError, not a framework error.

export const MIN_PASSWORD_LENGTH = 8;

// Better-Auth caps password length at 128 by default; mirror it so an
// over-long input fails our policy rather than the framework's, keeping the
// error typed and consistent.
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Validate a proposed password against the strength policy. Returns silently
 * when the password is acceptable; throws {@link WeakPasswordError} (with a
 * human-safe reason) otherwise.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}
