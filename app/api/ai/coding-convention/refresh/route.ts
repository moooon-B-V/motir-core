import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../_shared';

// POST /api/ai/coding-convention/refresh — the "Re-audit now" trigger of the
// "Deepen this audit" affordance (MOTIR-1592) over the MOTIR-928 refresh seam.
// Re-runs the audit + propose for the ACTIVE project so a freshly configured
// external scanner is detected/ingested and the report refreshes. Project-admin
// gated in the service; returns the two queued job ids (the durable effect lands
// async, so the client polls the audit surface until the new audit appears).
export async function POST(): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  try {
    const result = await aiConventionService.reaudit(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      ctx.project.identifier,
    );
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
