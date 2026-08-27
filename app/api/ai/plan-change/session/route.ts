import { NextResponse } from 'next/server';

import { requireCompliantSession, refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { mapPlanChangeError, noActiveProject } from '../_errors';

// POST /api/ai/plan-change/session — open the active project's plan-change
// CONVERSATION, or RESUME the existing one (Story 7.30 · MOTIR-1728). The rail
// calls this on mount; the response carries the full ordered thread, so a
// reopened workspace continues the conversation instead of starting over.
//
// POST (not GET) because it get-or-CREATEs; it is idempotent — there is one
// thread per project and a second call returns the same one.
//
// HTTP only (CLAUDE.md 4-layer): resolve the session + active project, call ONE
// service method, map typed errors.
// NOT rate-limited, deliberately (MOTIR-2597): this opens a conversation row in our own
// database, so no model job is submitted and no provider money is spent on this path. The AI
// ceiling guards the doors that SUBMIT; adding one here would only cap a database read.
export async function POST(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  // The 2FA hold (MOTIR-3653) — placed AFTER the no-project arm, which keeps
  // its own answer. `ctx.userId` is the session user `getWorkspaceContext`
  // already resolved, so this costs one policy query and no second auth trip.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  try {
    const result = await planChangeSessionsService.getOrCreateForProject(ctx);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
