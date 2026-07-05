import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError, parseOffsetParam } from '../_shared';

// GET /api/ai/coding-convention/audit — the active project's latest code-health
// audit summary + a page of findings (`?findingsOffset=`). Project-admin gated in
// the service; a project with no audit yet returns the empty surface.
export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const url = new URL(req.url);
  try {
    const audit = await aiConventionService.getAudit(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { findingsOffset: parseOffsetParam(url.searchParams.get('findingsOffset')) },
    );
    return NextResponse.json(audit);
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
