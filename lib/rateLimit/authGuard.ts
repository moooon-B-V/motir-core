import { NextResponse } from 'next/server';
import {
  authBudget,
  oauthRegisterBudget,
  oauthTokenBudget,
  passwordResetBudget,
} from '@/lib/rateLimit/budgets';
import { enforceRateLimit, isRateLimitExcluded, type RateLimitLimb } from '@/lib/rateLimit/guard';
import { clientIp, rateLimitKey, type RateLimitScope } from '@/lib/rateLimit/keys';

// App-level limiting for the AUTH surface (Subtask 8.5.9 / MOTIR-1165).
//
// `/api/auth/[...all]` is Better-Auth's catch-all, so there is no per-endpoint
// route file to wrap: the classification happens here, off the request path.
//
// ── WHAT IS LIMITED, AND WHY ONLY THESE ──────────────────────────────────────
// Only the credential-bearing POSTs. Sign-out, session reads, OAuth callbacks and
// the CLI's device-code poll are deliberately untouched: the device grant polls on
// a 5s interval BY DESIGN and has its own `slow_down` throttle (see the note in
// `lib/auth/index.ts`), so an IP-keyed limiter there would break the normal flow
// rather than an attack.
//
// ── TWO KEYS PER REQUEST ─────────────────────────────────────────────────────
// Per IP AND per identifier, because the two attacks are different shapes:
//   * CREDENTIAL STUFFING walks a list of stolen (email, password) pairs — many
//     identifiers from one origin. The per-IP limb catches it.
//   * A TARGETED attack works one account from many origins (a botnet, a proxy
//     pool). The per-identifier limb catches that, because the account being
//     attacked is the one thing that cannot change.
// Both limbs are always spent (`enforceRateLimit`), so tripping one does not
// leave the other artificially cool.
//
// ⚠️ Better-Auth ALREADY rate-limits internally (`lib/auth/index.ts`) and this
// layers ON TOP rather than replacing it. The two do not conflict: Better-Auth's
// is per-IP over a short window with its own 429, ours is the shared
// multi-instance ceiling. Whichever refuses first wins, and both refuse with a
// 429 + `Retry-After`.

/** The Better-Auth sub-paths that spend a credential budget, longest-first. */
const LIMITED_AUTH_PATHS: ReadonlyArray<{ suffix: string; scope: RateLimitScope }> = [
  { suffix: '/sign-in/email', scope: 'auth:sign-in' },
  { suffix: '/sign-in/username', scope: 'auth:sign-in' },
  { suffix: '/sign-up/email', scope: 'auth:sign-up' },
  // Better-Auth has carried both names across versions; limit either.
  { suffix: '/request-password-reset', scope: 'auth:password-reset' },
  { suffix: '/forget-password', scope: 'auth:password-reset' },
  { suffix: '/reset-password', scope: 'auth:password-reset' },
  // The OAuth server (MOTIR-6982). Registration is unauthenticated by design
  // (RFC 7591 — an MCP client registers before anyone signs in), so it is the
  // one write here a script can repeat without holding anything. The token POST
  // carries a code or refresh token rather than an email, so both are keyed by
  // IP alone. Authorize is a browser GET and revoke needs a live token: neither
  // is limited here.
  { suffix: '/oauth2/register', scope: 'auth:oauth-register' },
  { suffix: '/oauth2/token', scope: 'auth:oauth-token' },
];

/** The scopes keyed per IP only — their bodies name no person to key on. */
const IP_ONLY_SCOPES: ReadonlySet<RateLimitScope> = new Set([
  'auth:oauth-register',
  'auth:oauth-token',
]);

function budgetFor(scope: RateLimitScope) {
  switch (scope) {
    case 'auth:password-reset':
      return passwordResetBudget();
    case 'auth:oauth-register':
      return oauthRegisterBudget();
    case 'auth:oauth-token':
      return oauthTokenBudget();
    default:
      return authBudget();
  }
}

/** The scope a request maps to, or null when this path is not limited. */
export function classifyAuthRequest(pathname: string): RateLimitScope | null {
  const match = LIMITED_AUTH_PATHS.find(
    ({ suffix }) => pathname === `/api/auth${suffix}` || pathname.endsWith(suffix),
  );
  return match?.scope ?? null;
}

/**
 * The identifier the request is about, lower-cased — the email on a sign-in /
 * sign-up / reset body.
 *
 * ⚠️ Reads a CLONE. Consuming the original body would leave Better-Auth's
 * handler with an already-used stream, which is a 500 on every limited endpoint —
 * the one way this guard could break the auth surface it protects. A body that is
 * absent, not JSON, or carries no email yields null, and the request is then
 * limited by IP alone.
 */
export async function authIdentifier(req: Request): Promise<string | null> {
  if (!req.body) return null;
  try {
    const body: unknown = await req.clone().json();
    const email = (body as { email?: unknown } | null)?.email;
    return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Limit one Better-Auth request. Returns a 429 to send instead of calling the
 * handler, or null to proceed.
 */
export async function enforceAuthRateLimit(req: Request): Promise<NextResponse | null> {
  const { pathname } = new URL(req.url);
  if (isRateLimitExcluded(pathname)) return null;

  const scope = classifyAuthRequest(pathname);
  if (!scope) return null;

  // A password-reset REQUEST sends an email, so it carries the tighter budget;
  // the OAuth endpoints carry their own (sized for a shared origin); everything
  // else takes the sign-in/sign-up one.
  const budget = budgetFor(scope);

  const limbs: RateLimitLimb[] = [{ scope, key: rateLimitKey(scope, clientIp(req)), budget }];
  const identifier = IP_ONLY_SCOPES.has(scope) ? null : await authIdentifier(req);
  if (identifier) {
    limbs.push({ scope, key: rateLimitKey(scope, 'id', identifier), budget });
  }

  const { response } = await enforceRateLimit(limbs);
  return response;
}
