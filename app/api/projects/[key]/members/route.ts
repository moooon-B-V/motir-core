import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';

// /api/projects/[key]/members (Story 6.4 · Subtask 6.4.4)
//   GET  — list the project's members (any workspace member; read-only for
//          non-admins in the 6.4.5 UI).
//   POST — add a workspace member to the project with a role (project-admin
//          gated). Body: { userId, role }.
//
// Thin HTTP transport: read the workspace context (session), parse the request,
// call ONE service method, map typed domain errors to status codes. No `db` /
// no `$transaction` here (CLAUDE.md 4-layer rule). The `[key]` is the project's
// `identifier` ("PROD"); the service resolves it within the actor's workspace,
// so a cross-tenant key is a 404 (no existence leak, PRODECT_FINDINGS #26).

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key } = await params;

  try {
    const members = await projectMembersService.listMembers({
      key,
      actorUserId: ctx.userId,
      ctx,
    });
    return NextResponse.json({ members });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const userId =
    body && typeof body === 'object' && 'userId' in body && typeof body.userId === 'string'
      ? body.userId
      : null;
  const role =
    body && typeof body === 'object' && 'role' in body && typeof body.role === 'string'
      ? body.role
      : null;
  if (!userId || !role) {
    return NextResponse.json(
      { error: 'Both "userId" and "role" are required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const member = await projectMembersService.addMember({
      key,
      actorUserId: ctx.userId,
      ctx,
      targetUserId: userId,
      role,
    });
    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
