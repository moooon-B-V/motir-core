import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { planSessionScopeBodySchema, presentPlanJobHandle } from '@/lib/api/v1/workLoop/schema';
import { resolvePlanScope } from '@/lib/api/v1/workLoop/planScope';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';

// POST /api/v1/projects/{projectKey}/plan-session/submissions (Story 11.7 ·
// Subtask 11.7.6 — MOTIR-2240) — send the thread's accumulated intent to the
// planner.
//
// ── 202, and a handle with no field a RESULT could arrive in ────────────────
// The SAME shape the expansion submit returns (ADR Amendment 6 Q3): every turn
// on the thread goes out as ONE change, and this returns the moment motir-ai
// accepts the job. What eventually appears is a Plan of PROPOSALS, and approval
// in Motir is the only path from a proposal to a work item.
//
// ── The thread SURVIVES a failed submit ─────────────────────────────────────
// Nothing here clears or consumes the turns: a submit that fails leaves the
// thread exactly as it was and re-submittable, which is the behaviour a client
// on a flaky link depends on. Asserted directly rather than assumed.
//
// ── An EMPTY thread is refused by the SERVICE ───────────────────────────────
// `PLAN_CHANGE_EMPTY_INTENT` → 422. Not checked here: a check in the route would
// be a second opinion about what "empty" means, and the service already owns the
// accumulation.
//
// `work_items:write` — this is the act that SPENDS the owner's AI credits.

export const POST = withV1Route<{ projectKey: string }>(
  { scope: 'work_items:write' },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, planSessionScopeBodySchema);
    const { pctx, scope } = await resolvePlanScope(
      ctx.params.projectKey,
      body.targetKeys,
      ctx.service,
    );

    const result = await planChangeSessionsService.submit(pctx, scope.scopeKey);

    return NextResponse.json(presentPlanJobHandle(result), { status: 202 });
  },
);
