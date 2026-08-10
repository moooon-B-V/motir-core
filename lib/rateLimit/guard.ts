import { NextResponse } from 'next/server';
import {
  rateLimitHeaders,
  retryAfterSeconds,
  type RateLimitBudget,
  type RateLimitDecision,
} from '@/lib/api/v1/rateLimit';
import { consumeSharedRateLimit } from '@/lib/rateLimit/limiter';
import type { RateLimitScope } from '@/lib/rateLimit/keys';

// The ROUTE-EDGE guard (Subtask 8.5.9 / MOTIR-1165) — what a limited route
// actually calls, and the one place the 429 is shaped.
//
// Per CLAUDE.md's 4-layer rule the limiter is route-edge concern, not service
// logic: it inspects the request, spends a budget, and either refuses or gets out
// of the way. It never reads the database directly and never contains business
// logic — the counter write goes Route → Service → Repository → Prisma like
// everything else.
//
// The 429 mirrors the shape already established by
// `lib/publicProjects/errorResponse.ts`: `{ code, error }` with a `Retry-After`
// header — plus the `X-RateLimit-*` triple `/api/v1` emits, because a client can
// only back off politely if it can see its budget BEFORE it hits the wall.
// Headers ride EVERY limited response, not only the refusals.

/** The code a rate-limited app-level response carries. */
export const RATE_LIMITED_CODE = 'RATE_LIMITED';

/**
 * Paths that are NEVER rate-limited, however they are reached.
 *
 * ⚠️ Both entries are load-bearing and both are about not blinding ourselves:
 *
 *   - **The Sentry tunnel** (`/monitoring`, Subtask 8.5.6 / MOTIR-1162) is the
 *     same-origin relay a browser posts error reports through. Limiting it would
 *     drop exactly the reports that arrive in a burst — which is what an incident
 *     looks like from the client side. The route does not exist yet; it is listed
 *     here NOW so it is excluded the day it lands rather than the day someone
 *     notices the gap.
 *   - **Health checks** are polled on a fixed interval by the platform. A 429 to
 *     a health probe reads as "the app is unhealthy" and can cost a machine.
 *
 * Matched by prefix, so a nested path under either is covered too.
 */
export const RATE_LIMIT_EXCLUDED_PATHS: readonly string[] = [
  '/monitoring',
  '/api/monitoring',
  '/api/health',
  '/api/healthz',
];

/** True when `pathname` is one of the never-limited surfaces. */
export function isRateLimitExcluded(pathname: string): boolean {
  return RATE_LIMIT_EXCLUDED_PATHS.some(
    (excluded) => pathname === excluded || pathname.startsWith(`${excluded}/`),
  );
}

/** The `X-RateLimit-*` triple plus `Retry-After` when the caller is over budget. */
export function rateLimitResponseHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = { ...rateLimitHeaders(decision) };
  if (!decision.allowed) headers['Retry-After'] = String(retryAfterSeconds(decision));
  return headers;
}

/** The 429 itself — `{ code, error }` + `Retry-After` + `X-RateLimit-*`. */
export function rateLimitedResponse(
  decision: RateLimitDecision,
  extraHeaders?: Record<string, string>,
): NextResponse {
  const retryAfter = retryAfterSeconds(decision);
  return NextResponse.json(
    {
      code: RATE_LIMITED_CODE,
      error: `Too many requests. Retry in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
    },
    { status: 429, headers: { ...extraHeaders, ...rateLimitResponseHeaders(decision) } },
  );
}

/**
 * One limb of a limit: a scope, the key it counts under, and the budget.
 *
 * A surface can pass SEVERAL — the auth endpoints spend both a per-IP and a
 * per-identifier budget — and every limb is spent before the verdict is read, so
 * a caller that trips one still counts against the other. Spending them all is
 * deliberate: skipping the remaining limbs on the first refusal would let an
 * attacker keep one bucket artificially cool by ensuring another always refuses
 * first.
 */
export interface RateLimitLimb {
  scope: RateLimitScope;
  key: string;
  budget: RateLimitBudget;
}

export interface RateLimitVerdict {
  /** The refusal to return, or null when every limb allowed the request. */
  response: NextResponse | null;
  /** Headers to stamp on a SUCCESSFUL response — the tightest limb's numbers. */
  headers: Record<string, string>;
}

/** The limb a client should be told about: the one with the least budget left. */
function tightest(decisions: RateLimitDecision[]): RateLimitDecision {
  return decisions.reduce((worst, d) => (d.remaining < worst.remaining ? d : worst));
}

/**
 * Spend every limb and report the verdict.
 *
 * Limbs are spent CONCURRENTLY: they are independent counters and a surface with
 * two of them should not pay two sequential round trips for one request.
 */
export async function enforceRateLimit(limbs: RateLimitLimb[]): Promise<RateLimitVerdict> {
  const decisions = await Promise.all(
    limbs.map((limb) => consumeSharedRateLimit(limb.key, limb.budget)),
  );
  const refused = decisions.find((d) => !d.allowed);
  const worst = tightest(decisions);
  return {
    response: refused ? rateLimitedResponse(refused) : null,
    headers: rateLimitResponseHeaders(worst),
  };
}

/** Copy `headers` onto a response the handler produced, without replacing it. */
export function stampRateLimitHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
