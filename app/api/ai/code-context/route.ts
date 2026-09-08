import { NextResponse } from 'next/server';
import { codeContextService } from '@/lib/services/codeContextService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../coding-convention/_shared';

// GET /api/ai/code-context — the active project's CODE CONTEXT (Story
// MOTIR-1754 · MOTIR-1767): which repositories THIS PROJECT is configured with,
// and how current each one's code graph is. The single read behind the story's
// planning surfaces.
//
// Browse-gated in the service (NOT `ai:configure` — this is the honest state of
// the planner's inputs, not AI configuration; see the service's own note).
//
// ⚠️ `no-store`. An index state read from a cache is worse than no index state at
// all: it is the one value on the surface whose whole purpose is to be current,
// and a stale "indexed" is exactly the silent degradation this story exists to
// end.
//
// NOT rate-limited, deliberately, for the same reason the coding-convention reads
// are not (MOTIR-2597): no model job is submitted and no provider money is spent.
// ⚠️ AND THERE IS NO BOUNDARY READ HERE AT ALL. The first revision of this route
// called `motir-ai` for per-repo freshness; MOTIR-4724 put every fact it needed
// into motir-core's own columns, so this is a pure database read. Do not
// re-introduce a round-trip to fetch something the schema already holds.
export async function GET(): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  try {
    const context = await codeContextService.getCodeContext(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(context, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
