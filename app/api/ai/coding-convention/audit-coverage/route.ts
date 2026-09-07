import { NextResponse } from 'next/server';
import { auditCoverageService } from '@/lib/services/auditCoverageService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../_shared';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// GET /api/ai/coding-convention/audit-coverage — how many of the ACTIVE project's
// connected repos have no derived code-health audit (MOTIR-2248).
//
// A small state endpoint a nudge fetches for ITSELF, following the shipped
// `app/api/ready/nudge` shape: the planning overlay never blocks on N boundary
// reads to decide whether to draw a banner. Project-manage gated in the service,
// so the capability lives on the server and not only in the component.
//
// `no-store` for the same reason the ready nudge uses it: the answer changes the
// moment an audit lands, and a cached "1 repo un-audited" outlives the fix.
// NOT rate-limited, deliberately (MOTIR-2597): this reads audit coverage back, so no model job
// is submitted and no provider money is spent on this path. The AI ceiling guards the doors that
// SUBMIT; adding one here would only cap a database read.
export async function GET(): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;

  try {
    const coverage = await auditCoverageService.getCoverage(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(coverage, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    return mapCodeHealthError(err);
  }
}
