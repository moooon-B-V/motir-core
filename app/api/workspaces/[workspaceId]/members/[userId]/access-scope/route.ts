import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceRoleErrorResponse } from '@/lib/workspaces/roleErrorResponse';

// PATCH /api/workspaces/:workspaceId/members/:userId/access-scope — set a
// member's ACCESS SCOPE: `{ accessScope: 'full' | 'limited' }`.
//
// Story MOTIR-6169 · MOTIR-6545. Manager-only (the service asserts it, by the
// role setter's gate). 200 the member's scope · 400 an unknown scope · 403 not
// a Manager · 404 not visible / not a member · 409 a Manager target (the org
// Owner or an Admin included), whose scope does not apply.

interface RouteParams {
  params: Promise<{ workspaceId: string; userId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId, userId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !('accessScope' in body)) {
    return NextResponse.json(
      { error: 'An "accessScope" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const member = await workspacesService.setMemberAccessScope({
      actorUserId: ctx.userId,
      workspaceId,
      targetUserId: userId,
      scope: (body as { accessScope: unknown }).accessScope,
    });
    return NextResponse.json(member);
  } catch (err) {
    const mapped = workspaceRoleErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
