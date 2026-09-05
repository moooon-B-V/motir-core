import { NextResponse } from 'next/server';
import { codeContextService } from '@/lib/services/codeContextService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../coding-convention/_shared';

// GET /api/ai/code-context — the active project's CODE CONTEXT (Story
// MOTIR-1754 · MOTIR-1767): which repositories the planner can see, how current
// each graph is, and whether this project has implemented work but no connected
// repository. The single read behind both of the story's surfaces — the
// `/planning` code-context strip and the `/code-health` connect affordance.
//
// Browse-gated in the service (NOT `ai:configure` — this is the honest state of
// the planner's inputs, not AI configuration; see the service's own note).
//
// ⚠️ `no-store`. An index state read from a cache is worse than no index state at
// all: it is the one number on the surface whose whole purpose is to be current,
// and a stale "current" is exactly the silent degradation this story exists to
// end.
//
// NOT rate-limited, deliberately, for the same reason the coding-convention reads
// are not (MOTIR-2597): no model job is submitted and no provider money is spent —
// this is a database read plus one boundary read. The AI ceiling guards the doors
// that SUBMIT.
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
