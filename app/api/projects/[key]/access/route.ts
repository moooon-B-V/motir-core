import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';

// PATCH /api/projects/[key]/access (Story 6.4 · Subtask 6.4.4)
// Set the project's browse-access level (open / limited / private). Body:
// { accessLevel }. Project-admin gated; going private seeds current workspace
// members as project members (handled in the service). Thin HTTP transport per
// CLAUDE.md: parse, one service call, map typed errors.

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
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
  const accessLevel =
    body &&
    typeof body === 'object' &&
    'accessLevel' in body &&
    typeof body.accessLevel === 'string'
      ? body.accessLevel
      : null;
  if (!accessLevel) {
    return NextResponse.json(
      { error: 'An "accessLevel" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const access = await projectMembersService.setAccessLevel({
      key,
      actorUserId: ctx.userId,
      ctx,
      level: accessLevel,
    });
    return NextResponse.json({ access });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
