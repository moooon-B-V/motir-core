import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceRoleErrorResponse } from '@/lib/workspaces/roleErrorResponse';

// PATCH /api/workspaces/:workspaceId/members/:userId — change a member's
// WORKSPACE role: `{ role: 'manager' | 'member' | 'viewer' }`, or
// `{ roleDefinitionId }` for one of the workspace's custom roles.
//
// Story MOTIR-6168 · MOTIR-6463. Manager-only (the service asserts it).
// 403 not a Manager · 404 not visible / not a member / foreign custom role ·
// 409 the last Manager, or an org-managed member · 422 an unknown role value.

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
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: 'A JSON object is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  const patch = body as { role?: unknown; roleDefinitionId?: unknown };
  if (patch.roleDefinitionId !== undefined && typeof patch.roleDefinitionId !== 'string') {
    return NextResponse.json(
      { error: '"roleDefinitionId" must be a string.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const member = await workspacesService.setMemberRole({
      actorUserId: ctx.userId,
      workspaceId,
      targetUserId: userId,
      role: patch.role,
      roleDefinitionId: patch.roleDefinitionId ?? null,
    });
    return NextResponse.json(member);
  } catch (err) {
    const mapped = workspaceRoleErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
