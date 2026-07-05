import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../_shared';

// GET /api/ai/coding-convention/convention — the active project's latest proposed +
// standard convention (with provenance) + cursor-paginated version history
// (`?versionsCursor=`). Project-admin gated in the service.
export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const url = new URL(req.url);
  const versionsCursor = url.searchParams.get('versionsCursor') ?? undefined;
  try {
    const convention = await aiConventionService.getConvention(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { versionsCursor },
    );
    return NextResponse.json(convention);
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
