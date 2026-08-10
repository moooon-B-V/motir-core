import type { NextResponse } from 'next/server';
import { presentedBearerToken } from '@/lib/api/v1/bearer';
import { aiBudget } from '@/lib/rateLimit/budgets';
import { enforceRateLimit } from '@/lib/rateLimit/guard';
import { rateLimitKey, type RateLimitScope } from '@/lib/rateLimit/keys';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// App-level limiting for the AI surfaces (Subtask 8.5.9 / MOTIR-1165).
//
// ── KEYED ON USER + WORKSPACE, NEVER ON IP ───────────────────────────────────
// This is the one class where the resource being protected is MONEY: every call
// costs real tokens at a model provider, so one runaway loop is a bill rather
// than an outage. IP is the wrong axis for that in both directions — a whole
// office behind one NAT would share a budget they each paid for, and one user on
// a phone could double their spend by changing networks. Cost accrues to a
// WORKSPACE and is caused by a USER, so the key is both.
//
// Both surfaces reach the same key material from different credentials: the
// browser surface reads it from the session + active project, and
// `/api/internal/ai/*` reads it from the job token's claims (`sub`,
// `workspaceId`). Neither ever needs the request's IP, which is also why nothing
// here composes personal data into the key beyond the ids — hashed all the same,
// since the counter table holds no plaintext identifiers at all.

/**
 * Limit one AI call for `ctx`. Returns a 429 to return instead of submitting the
 * job, or null to proceed.
 *
 * Refusing BEFORE the job is submitted is the whole point: a 429 after the
 * provider call has been made would have already spent the money it exists to
 * protect.
 */
export async function enforceAiRateLimit(
  ctx: ServiceContext,
  scope: RateLimitScope = 'ai:chat',
): Promise<NextResponse | null> {
  const { response } = await enforceRateLimit([
    {
      scope,
      key: rateLimitKey(scope, ctx.workspaceId, ctx.userId),
      budget: aiBudget(),
    },
  ]);
  return response;
}

/**
 * The `/api/internal/ai/*` routes that are SERVICE-BEARER gated rather than
 * job-token gated (`live-projects`, `work-items`) — motir-ai acting as the Motir
 * system principal, with no tenant in the request at all.
 *
 * They cannot key on user + workspace because neither exists here, so they key on
 * the CREDENTIAL — the service bearer's sha-256 fingerprint, the same axis
 * `/api/v1` uses for the same reason. That keeps every route under
 * `/api/internal/ai/` limited rather than leaving two uncounted holes in the
 * class, and it still cannot be spent by anyone who does not hold the secret.
 *
 * Called AFTER the route's own bearer check, so an unauthenticated caller never
 * spends the real credential's budget (the ordering `/api/v1` pins).
 */
export async function enforceInternalServiceRateLimit(req: Request): Promise<NextResponse | null> {
  const presented = presentedBearerToken(req);
  // Unreachable from a route (the bearer check ran first and fails closed on an
  // absent header), but keyed rather than skipped so it can never read as
  // "unlimited" if that ordering ever changes.
  const { response } = await enforceRateLimit([
    {
      scope: 'ai:internal',
      key: rateLimitKey('ai:internal', 'service', presented ?? 'unknown'),
      budget: aiBudget(),
    },
  ]);
  return response;
}
