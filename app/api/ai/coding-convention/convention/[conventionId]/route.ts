import { NextResponse } from 'next/server';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { resolveActiveProjectContext, mapCodeHealthError } from '../../_shared';

// PATCH /api/ai/coding-convention/convention/:conventionId — edit a PROPOSED
// draft's contentMd before approval (the human curates the AI draft). A standard /
// superseded target is a 409 from the boundary; a convention outside the active
// project is 404. Project-admin gated in the service.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ conventionId: string }> },
): Promise<Response> {
  const resolved = await resolveActiveProjectContext();
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const { conventionId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  const contentMd = (body as { contentMd?: unknown } | null)?.contentMd;
  if (typeof contentMd !== 'string' || contentMd.trim() === '') {
    return NextResponse.json(
      { code: 'INVALID_BODY', error: 'contentMd is required' },
      { status: 400 },
    );
  }

  try {
    const convention = await aiConventionService.editConvention(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      conventionId,
      contentMd,
    );
    return NextResponse.json(convention);
  } catch (err) {
    return mapCodeHealthError(err);
  }
}
