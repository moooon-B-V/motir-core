import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../_shared';

// GET /api/ai/coding-convention/convention — the active project's per-repo
// convention (derived, auto-used — read-only per MOTIR-1660/1663). Accepts
// `?repoKey=` to scope to a single repo; omit for the first repo / empty
// surface. Project-admin gated in the service.
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
    return mapCodeHealthError(err);
  }
}
