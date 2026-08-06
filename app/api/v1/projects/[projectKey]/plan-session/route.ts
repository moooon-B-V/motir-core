import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { planSessionScopeBodySchema, presentPlanSession } from '@/lib/api/v1/workLoop/schema';
import { resolvePlanScope } from '@/lib/api/v1/workLoop/planScope';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';

// POST /api/v1/projects/{projectKey}/plan-session (Story 11.7 · Subtask 11.7.6
// — MOTIR-2240) — open, or RESUME, the planning conversation for a scope.
//
// ── A POST that is `read`-scoped, and both halves are deliberate ────────────
// It is a POST because get-or-create WRITES an empty row, and a GET must stay
// SAFE: a cache or a browser prefetch would otherwise perform that write. It is
// `read`-scoped because the SCOPE mirrors the capability, not the verb — ADR
// Amendment 6 Q2, and `lib/mcp/scopes.ts` reasons the entry out: the row is
// idempotent, spends no credit, opens no Plan and changes nothing about the plan
// or the tree. "Opening the door is not starting a conversation."
//
// ── SINGULAR, and never addressed by id ─────────────────────────────────────
// `plan-session`, not `plan-sessions` — the one exception ADR Amendment 6 Q1
// grants to §7's plural rule, because the resource genuinely has ONE member per
// scope (`@@unique([projectId, scopeKey])`). A plural noun invites
// `/plan-sessions/{id}`, which is exactly the addressing that would let two
// clients fork a second conversation about one anchor set.
//
// 200, never 201: the caller cannot tell an open from a resume, and the service
// itself only knows which after it answers — a 201 would be a lie half the time.

export const POST = withV1Route<{ projectKey: string }>({ scope: 'read' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, planSessionScopeBodySchema);
  const { pctx, scope } = await resolvePlanScope(
    ctx.params.projectKey,
    body.targetKeys,
    ctx.service,
  );

  const session = await planChangeSessionsService.getOrCreateForScope(pctx, scope);

  return NextResponse.json(presentPlanSession(session));
});
