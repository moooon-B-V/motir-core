import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError, parseOffsetParam } from '../_shared';

// GET /api/ai/coding-convention/audit — the active project's latest code-health
// audit summary + a page of findings (`?findingsOffset=`, `?repoKey=`). Per-repo
// scope per MOTIR-1662. Project-admin gated in the service.
export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const url = new URL(req.url);
  try {
    const audit = await aiConventionService.getAudit(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      {
        repoKey: url.searchParams.get('repoKey') ?? undefined,
        findingsOffset: parseOffsetParam(url.searchParams.get('findingsOffset')),
      },
    );
    return NextResponse.json(audit);
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
