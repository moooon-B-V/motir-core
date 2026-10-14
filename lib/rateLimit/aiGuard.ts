import type { NextResponse } from 'next/server';
import { presentedBearerToken } from '@/lib/api/v1/bearer';
import { aiBudget, aiGenerateBudget, aiInternalBudget } from '@/lib/rateLimit/budgets';
import { enforceRateLimit } from '@/lib/rateLimit/guard';
import { rateLimitKey, type RateLimitScope } from '@/lib/rateLimit/keys';
import { agentWorkspaceLimb } from '@/lib/rateLimit/workspaceCeiling';
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
// The browser surface reads that key material from the session + active
// project. Nothing here ever needs the request's IP, which is also why nothing
// composes personal data into the key beyond the ids — hashed all the same,
// since the counter table holds no plaintext identifiers at all.
//
// ── JOB READ-BACKS ARE VOLUME, KEYED PER JOB (MOTIR-8604) ────────────────────
// `/api/internal/ai/*`'s job-token reads used to share this axis: one
// `(workspace, user)` bucket for every planning job a person ran. They are not
// money — a job's credits already stop the provider spend — they are VOLUME,
// so `enforceJobReadRateLimit` below keys them per JOB (the token's `jobKey`)
// and spends the workspace's shared agent ceiling beside it. A token minted
// before the `jobKey` claim keeps the old user-keyed bucket. The money surfaces
// keep user + workspace.

/**
 * Limit one AI call for `ctx`. Returns a 429 to return instead of submitting the
 * job, or null to proceed.
 *
 * Refusing BEFORE the job is submitted is the whole point: a 429 after the
 * provider call has been made would have already spent the money it exists to
 * protect.
 *
 * `ai:generate` (MOTIR-2597) draws its own, tighter budget: same guard, same
 * store, same key axis — a generation simply costs several chat turns, so it
 * cannot be metered by the chat allowance. Every other scope keeps `aiBudget()`.
 */
export async function enforceAiRateLimit(
  ctx: ServiceContext,
  scope: RateLimitScope = 'ai:chat',
): Promise<NextResponse | null> {
  const { response } = await enforceRateLimit([
    {
      scope,
      key: rateLimitKey(scope, ctx.workspaceId, ctx.userId),
      budget: scope === 'ai:generate' ? aiGenerateBudget() : aiBudget(),
    },
  ]);
  return response;
}

/**
 * Limit one job-token read-back (`/api/internal/ai/*`) — MOTIR-8604.
 *
 * Two limbs, spent together through `enforceRateLimit` (so a refusal carries the
 * retryable contract `rateLimitedResponse` writes):
 *
 *   - the per-JOB limb: `ai:job` on the token's `jobKey`, at
 *     `aiInternalBudget()`. ⚠️ A keyless token (minted before MOTIR-8599, or
 *     whose claim was malformed) falls back to the pre-change
 *     `ai:internal` `(workspace, user)` bucket at the same budget — never
 *     unlimited, and never sharing a keyed job's bucket;
 *   - the workspace's shared agent ceiling (`agentWorkspaceLimb`), the SAME
 *     bucket MCP and `/api/v1` spend, so submitting more jobs buys no more of it.
 */
export async function enforceJobReadRateLimit(auth: {
  ctx: ServiceContext;
  jobKey: string | null;
}): Promise<NextResponse | null> {
  const { ctx, jobKey } = auth;
  const { response } = await enforceRateLimit([
    jobKey === null
      ? {
          scope: 'ai:internal',
          key: rateLimitKey('ai:internal', ctx.workspaceId, ctx.userId),
          budget: aiInternalBudget(),
        }
      : {
          scope: 'ai:job',
          key: rateLimitKey('ai:job', ctx.workspaceId, jobKey),
          budget: aiInternalBudget(),
        },
    agentWorkspaceLimb(ctx.workspaceId),
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
