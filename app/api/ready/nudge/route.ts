import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  try {
    const nudge = await workItemsService.computeExpansionNudge(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(nudge, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err: unknown) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
