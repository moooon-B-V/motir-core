import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../../../_shared';

// POST /api/ai/coding-convention/convention/:conventionId/approve — flip a proposed
// convention to the project's STANDARD (recording the approving user); demotes the
// prior standard to history. Idempotent on an already-standard target. Project-admin
// gated in the service — approving the standard that drives every dispatched prompt
// is a manager action, not every member.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ conventionId: string }> },
): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const { conventionId } = await params;
  try {
    const convention = await aiConventionService.approveConvention(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      conventionId,
    );
    return NextResponse.json(convention);
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
