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

// ── THE RETRYABLE REFUSAL CONTRACT (MOTIR-8600) ─────────────────────────────
// Every rate-limit refusal an agent can meet carries a whole-number
// `retryAfterSeconds` in a field a client reads WITHOUT parsing a sentence, and
// every HTTP refusal also sends `Retry-After` with the same number. The number
// always comes from `retryAfterSeconds(decision)` (floored at 1); no surface
// recomputes it. The four surfaces, and where each carries it:
//
//   - MCP transport 429 (`mcpRateLimitedResponse`, `lib/rateLimit/mcpGuard.ts`):
//     `error.data = { code: 'RATE_LIMITED', retryAfterSeconds, … }`.
//   - A billable MCP tool's `isError` result (`billableToolDenial`,
//     `lib/mcp/rateLimitGate.ts`): `structuredContent = { code: 'RATE_LIMITED',
//     retryAfterSeconds }`.
//   - An app-level 429, the job-token routes included (`rateLimitedResponse`,
//     below): `{ code: 'RATE_LIMITED', error, retryAfterSeconds }`.
//   - `/api/v1` 429 (`withV1Route`): `{ code: 'RATE_LIMIT_EXCEEDED', error,
//     retryAfterSeconds }`. v1 KEEPS its published code — changing a v1 `code`
//     is breaking under `public-api-conventions.md` §8, and the field and header
//     are the additive halves §8 permits (ADR §6, 2026-10-14 amendment).
//
// The prose sentences stay for the person watching; nothing may parse them.
// The upload throttle (`RateLimitError`, `lib/blob/errors.ts`) is deliberately
// outside this contract: it carries `RATE_LIMITED` and no seconds, so a client
// treats a `RATE_LIMITED` without `retryAfterSeconds` as retryable after its own
// default.

/** The machine-read half of every app-level rate-limit refusal (MOTIR-8600). */
export interface RateLimitRefusalFields {
  code: typeof RATE_LIMITED_CODE;
  retryAfterSeconds: number;
}

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

/**
 * The 429 itself — `{ code, error, retryAfterSeconds }` + `Retry-After` +
 * `X-RateLimit-*`. The body's `retryAfterSeconds` and the `Retry-After` header
 * are the same number (MOTIR-8600).
 */
export function rateLimitedResponse(
  decision: RateLimitDecision,
  extraHeaders?: Record<string, string>,
): NextResponse {
  const retryAfter = retryAfterSeconds(decision);
  const fields: RateLimitRefusalFields = { code: RATE_LIMITED_CODE, retryAfterSeconds: retryAfter };
  return NextResponse.json(
    {
      code: fields.code,
      error: `Too many requests. Retry in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
      retryAfterSeconds: fields.retryAfterSeconds,
    },
    {
      status: 429,
      // `Retry-After` is re-stated from the SAME computed value as the body
      // field, so a second boundary ticking between two reads of the clock
      // cannot make the header and the field disagree.
      headers: {
        ...extraHeaders,
        ...rateLimitResponseHeaders(decision),
        'Retry-After': String(retryAfter),
      },
    },
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
  const { refused, tightest: worst } = await spendLimbs(limbs);
  return {
    response: refused ? rateLimitedResponse(refused) : null,
    headers: rateLimitResponseHeaders(worst),
  };
}

/**
 * Spend every limb CONCURRENTLY and return the raw decisions' verdict: the
 * first refusing limb (or `null`) and the tightest limb, whose numbers the
 * `X-RateLimit-*` headers report.
 *
 * Extracted from {@link enforceRateLimit} (MOTIR-8601) for the surfaces that
 * shape their OWN refusal — the MCP transport's JSON-RPC 429 and `/api/v1`'s
 * typed error — and so need the decisions rather than a `NextResponse`. Every
 * limb is spent even when another refuses, for the reason the limb type states.
 */
export async function spendLimbs(
  limbs: RateLimitLimb[],
): Promise<{ refused: RateLimitDecision | null; tightest: RateLimitDecision }> {
  const decisions = await Promise.all(
    limbs.map((limb) => consumeSharedRateLimit(limb.key, limb.budget)),
  );
  return { refused: decisions.find((d) => !d.allowed) ?? null, tightest: tightest(decisions) };
}

/** Copy `headers` onto a response the handler produced, without replacing it. */
export function stampRateLimitHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
