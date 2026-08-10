import { positiveIntEnv, type RateLimitBudget } from '@/lib/api/v1/rateLimit';

// The app-level BUDGETS (Subtask 8.5.9 / MOTIR-1165) — how many requests each
// surface class gets per window.
//
// ⚠️ ONE STORE, SEVERAL BUDGETS. `/api/v1` keeps its own
// `MOTIR_API_V1_RATE_LIMIT` / `_WINDOW_MS`; the surfaces below get their own
// names. Sharing the counter table is not sharing the ceiling — an internal
// service-to-service caller and an anonymous public writer have nothing in
// common except the mechanism (ADR §6).
//
// Every budget is env-configurable so a self-hoster's ceiling need not be Motir
// Cloud's, and so a test can shrink the window instead of waiting a minute. A
// malformed value falls back to the documented default rather than disabling the
// limiter (`positiveIntEnv`) — a limiter that a typo can switch off is not a
// limiter.
//
// The defaults are chosen to be invisible to a human and obstructive to a
// script. They are first-line abuse guards, not capacity planning: Better-Auth
// keeps its own tighter per-endpoint rules on top (`lib/auth/index.ts`), and the
// two layers are additive by design.

/** Sign-in / sign-up: a person mistypes a password a few times, a script does not. */
export const DEFAULT_AUTH_RATE_LIMIT = 20;
export const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Password reset: tighter and over a much longer window, because each accepted
 * request sends an EMAIL. The cost of abuse here is our sending reputation, not
 * just CPU, and nobody legitimately needs five reset links an hour.
 */
export const DEFAULT_PASSWORD_RESET_RATE_LIMIT = 5;
export const DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS = 3_600_000;

/** Unauthenticated public writes: tighter than auth — no account stands behind them. */
export const DEFAULT_PUBLIC_WRITE_RATE_LIMIT = 10;
export const DEFAULT_PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * AI: a distinct budget because the resource being protected is MONEY, not
 * capacity — every call costs real tokens at a model provider, so one runaway
 * loop is a bill rather than an outage.
 */
export const DEFAULT_AI_RATE_LIMIT = 30;
export const DEFAULT_AI_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * GENERATION: the same money, a much bigger unit of it (MOTIR-2597).
 *
 * A chat turn is one sentence in and one reply out. A plan generation, a story
 * expansion, a re-plan, a repository audit is a long job at many times the token
 * cost — so the two cannot honestly share a ceiling. Sharing `ai:chat`'s 30/min
 * would mean the expensive door's allowance is set by what is comfortable for the
 * cheap one.
 *
 * A third of the chat budget, over the same window: a person triggering ten
 * generations in a minute is already going faster than any of them can finish
 * (each takes tens of seconds and the UI streams it), while a loop pointed at
 * `plan/generate` is stopped at ten rather than at whatever the provider will
 * sell. Env-configurable like every other budget, and over the SAME shared
 * counter — a separate scope is a separate bucket, not a separate store (ADR §6).
 */
export const DEFAULT_AI_GENERATE_RATE_LIMIT = 10;
export const DEFAULT_AI_GENERATE_RATE_LIMIT_WINDOW_MS = 60_000;

function budget(
  limitEnv: string,
  windowEnv: string,
  limitDefault: number,
  windowDefault: number,
): RateLimitBudget {
  return {
    limit: positiveIntEnv(limitEnv, limitDefault),
    windowMs: positiveIntEnv(windowEnv, windowDefault),
  };
}

/** Sign-in and sign-up, keyed per IP and per submitted identifier. */
export function authBudget(): RateLimitBudget {
  return budget(
    'MOTIR_AUTH_RATE_LIMIT',
    'MOTIR_AUTH_RATE_LIMIT_WINDOW_MS',
    DEFAULT_AUTH_RATE_LIMIT,
    DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
  );
}

/** Password-reset REQUESTS (the email-sending ones). */
export function passwordResetBudget(): RateLimitBudget {
  return budget(
    'MOTIR_PASSWORD_RESET_RATE_LIMIT',
    'MOTIR_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS',
    DEFAULT_PASSWORD_RESET_RATE_LIMIT,
    DEFAULT_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS,
  );
}

/** Internet-facing writes on public projects and public requests. */
export function publicWriteBudget(): RateLimitBudget {
  return budget(
    'MOTIR_PUBLIC_WRITE_RATE_LIMIT',
    'MOTIR_PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS',
    DEFAULT_PUBLIC_WRITE_RATE_LIMIT,
    DEFAULT_PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS,
  );
}

/** The AI surfaces — `/api/ai/*` (per user + workspace) and `/api/internal/ai/*`. */
export function aiBudget(): RateLimitBudget {
  return budget(
    'MOTIR_AI_RATE_LIMIT',
    'MOTIR_AI_RATE_LIMIT_WINDOW_MS',
    DEFAULT_AI_RATE_LIMIT,
    DEFAULT_AI_RATE_LIMIT_WINDOW_MS,
  );
}

/** The job-SUBMITTING `/api/ai/*` surfaces — generation, expansion, re-plan, audit. */
export function aiGenerateBudget(): RateLimitBudget {
  return budget(
    'MOTIR_AI_GENERATE_RATE_LIMIT',
    'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS',
    DEFAULT_AI_GENERATE_RATE_LIMIT,
    DEFAULT_AI_GENERATE_RATE_LIMIT_WINDOW_MS,
  );
}
