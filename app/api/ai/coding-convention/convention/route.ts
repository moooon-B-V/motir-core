import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../_shared';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// GET /api/ai/coding-convention/convention — the active project's per-repo
// convention (derived, auto-used — read-only per MOTIR-1660/1663). Accepts
// `?repoKey=` to scope to a single repo; omit for the first repo / empty
// surface. Project-admin gated in the service.
// NOT rate-limited, deliberately (MOTIR-2597): this reads the stored convention back, so no
// model job is submitted and no provider money is spent on this path. The AI ceiling guards the
// doors that SUBMIT; adding one here would only cap a database read.
export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const url = new URL(req.url);
  const repoKey = url.searchParams.get('repoKey') ?? undefined;
  const versionsCursor = url.searchParams.get('versionsCursor') ?? undefined;
  try {
    const convention = await aiConventionService.getConvention(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { repoKey, versionsCursor },
    );
    return NextResponse.json(convention);
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    return mapCodeHealthError(err);
  }
}
