import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { planTurnBodySchema, presentPlanSession } from '@/lib/api/v1/workLoop/schema';
import { resolvePlanScope } from '@/lib/api/v1/workLoop/planScope';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';

// POST /api/v1/projects/{projectKey}/plan-session/turns (Story 11.7 · Subtask
// 11.7.6 — MOTIR-2240) — add ONE turn to the thread.
//
// ── APPENDING IS NOT SUBMITTING, and that separation is the point ───────────
// The turn is persisted the moment this returns, so quitting can never lose it —
// and NO job starts, NO credits are spent and NO work item changes. Turns
// ACCUMULATE until the submit sends them to the planner as one coherent change,
// which is what lets a later turn REFINE an earlier one ("add auth to the
// billing epic", then "keep them under 3 points") rather than replace it. A
// client that assumes an append submitted will sit polling a job that was never
// created, so the description says so in as many words.
//
// The thread is get-or-created first, exactly as the MCP tool does: appending to
// a scope nobody has opened yet is a normal first turn, not an error.
//
// `work_items:write` — mirrored from `lib/mcp/scopes.ts`, whose entry reasons it
// out: a read-only token may look at a thread but never extend or fire one.

export const POST = withV1Route<{ projectKey: string }>(
  { scope: 'work_items:write' },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, planTurnBodySchema);
    const { pctx, scope } = await resolvePlanScope(
      ctx.params.projectKey,
      body.targetKeys,
      ctx.service,
    );

    await planChangeSessionsService.getOrCreateForScope(pctx, scope);
    const session = await planChangeSessionsService.appendTurn(body.body, pctx, scope.scopeKey);

    return NextResponse.json(presentPlanSession(session));
  },
);
