import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';

// /api/projects/[key]/members/[userId] (Story 6.4 · Subtask 6.4.4)
//   PATCH  — put a member on a role. Body: { role }, carrying a `RoleDTO.key` —
//            a built-in's enum value, or one of the project's own custom role
//            definitions' ids (MOTIR-2485). The service decides which it is and
//            404s a definition belonging to another project or workspace, under
//            the same no-existence-leak posture the key resolution takes.
//            Project-admin gated; guards the last admin.
//   DELETE — remove a member from the project. Project-admin gated; guards the
//            last admin.
//
// A per-member sub-resource (the userId in the path) addresses the target
// unambiguously, which is the idiomatic REST + App-Router shape — the card's
// "members (GET/POST/PATCH/DELETE)" collapsed the per-member mutations onto the
// collection line. Thin HTTP transport per CLAUDE.md: parse, one service call,
// map typed errors.

interface RouteParams {
  params: Promise<{ key: string; userId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key, userId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const role =
    body && typeof body === 'object' && 'role' in body && typeof body.role === 'string'
      ? body.role
      : null;
  if (!role) {
    return NextResponse.json(
      { error: 'A "role" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const member = await projectMembersService.setRole({
      key,
      actorUserId: ctx.userId,
      ctx,
      targetUserId: userId,
      role,
    });
    return NextResponse.json({ member });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key, userId } = await params;

  try {
    const member = await projectMembersService.removeMember({
      key,
      actorUserId: ctx.userId,
      ctx,
      targetUserId: userId,
    });
    return NextResponse.json({ removed: member });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
