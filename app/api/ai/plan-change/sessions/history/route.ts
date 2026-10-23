import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { mapPlanChangeError, noActiveProject } from '../../_errors';

// /api/ai/plan-change/sessions/history — the planning overlay's History section
// (Story MOTIR-9218 · MOTIR-9306): the conversations the CALLER started in the
// active project, open or ended, newest activity first.
//
//   GET [?cursor=<opaque>&limit=<n>] → `PlanSessionListPageDto`, ten rows a page
//                                      by default. A cursor this read did not
//                                      mint is 400 `INVALID_PLAN_SESSION_CURSOR`.
//
// HTTP only (CLAUDE.md 4-layer): resolve the session + active project, call ONE
// service method, map typed errors.
// NOT rate-limited, deliberately (MOTIR-2597): a read submits no model job.
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const params = new URL(req.url).searchParams;
  const rawLimit = params.get('limit');
  try {
    const page = await planSessionsService.listOwnSessions(ctx.projectId, ctx, {
      cursor: params.get('cursor'),
      limit: rawLimit == null ? undefined : Number(rawLimit),
    });
    return NextResponse.json(page, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
