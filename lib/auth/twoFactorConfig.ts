// The two-factor constants (Story MOTIR-1213 · Subtask MOTIR-1217).
//
// They live in their own module, NOT in lib/auth/index.ts, for one concrete
// reason: `lib/auth/index.ts` imports `next/headers` and the Prisma client, so
// importing it from a client component fails the build. The Security pane
// (MOTIR-1220) and the login-challenge step (MOTIR-1221) are client components
// that need to SAY these numbers — "10 recovery codes", "expires in 3 minutes",
// "don't ask again on this device for 30 days" — and a number a screen states
// must be the same number the server enforces, not a second copy of it.
//
// Pure values only: no imports, no env reads, no side effects.

/**
 * How many single-use recovery codes an enrolment mints. The standard shape
 * (GitHub / Atlassian / Google all use 10), and Better-Auth's own default —
 * pinned here so the pane can render "X of 10 remaining" from one source.
 */
export const TWO_FACTOR_BACKUP_CODE_COUNT = 10;

/**
 * How long an emailed one-time code stays valid, in MINUTES. Better-Auth's
 * `otpOptions.period` is expressed in minutes (its default is 3), and
 * `twoFactorOtpEmail`'s `expiresInMinutes` prop renders the same value — that
 * pairing is the whole reason this is a constant rather than two literals.
 */
export const TWO_FACTOR_OTP_PERIOD_MINUTES = 3;

/**
 * Digits in the emailed one-time code and in a TOTP code. Six is RFC 6238's
 * common case and what every authenticator app shows by default.
 */
export const TWO_FACTOR_OTP_DIGITS = 6;

/**
 * How many wrong emailed codes are accepted before the challenge is refused.
 * Better-Auth's default; pinned so the number is reviewable.
 */
export const TWO_FACTOR_OTP_ALLOWED_ATTEMPTS = 5;

/**
 * TOTP step, in seconds — RFC 6238's canonical 30, which is what every
 * authenticator app assumes when it scans an `otpauth://` URI that omits it.
 */
export const TWO_FACTOR_TOTP_PERIOD_SECONDS = 30;

/**
 * How long "don't ask again on this device" lasts, in SECONDS (30 days). The
 * story's own acceptance recipe names 30 days, so the copy and the cookie's
 * max-age are read from here rather than restated.
 */
export const TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The label an authenticator app shows above the code — the `issuer` half of
 * the `otpauth://totp/<issuer>:<account>` URI.
 */
export const TWO_FACTOR_ISSUER = 'Motir';
