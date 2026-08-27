import { NextResponse } from 'next/server';
import { requireCompliantSession, refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';

export async function GET(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  // The 2FA hold (MOTIR-3653) — placed AFTER the no-project arm, which keeps
  // its own answer. `ctx.userId` is the session user `getWorkspaceContext`
  // already resolved, so this costs one policy query and no second auth trip.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  try {
    const nudge = await workItemsService.computeExpansionNudge(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(nudge, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err: unknown) {
    // MOTIR-2291 — the shared project gate's two refusals (404 for a non-browser,
    // 403 naming the key). Without this arm they fall through to a 500.
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
