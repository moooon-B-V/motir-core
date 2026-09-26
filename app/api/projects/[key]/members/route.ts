import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// /api/projects/[key]/members (Story 6.4 · Subtask 6.4.4)
//   GET  — list the project's members (any workspace member; read-only for
//          non-admins in the 6.4.5 UI).
//   POST — add a workspace member to the project (`member:manage` gated).
//          Body: { userId }. A `role` is REFUSED — 400 `role_retired` — because
//          roles live on the workspace (Story MOTIR-6168 · MOTIR-6464): being
//          added to a project grants nothing of its own.
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
  // The 2FA hold (MOTIR-3653) — inserted after this route's own no-context
  // arm rather than folded into `requireCompliantWorkspaceContext`, because
  // that arm carries a body of its own that must not change.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

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
  // The 2FA hold (MOTIR-3653) — inserted after this route's own no-context
  // arm rather than folded into `requireCompliantWorkspaceContext`, because
  // that arm carries a body of its own that must not change.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

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
  if (body && typeof body === 'object' && 'role' in body) {
    return NextResponse.json(
      {
        error:
          'Project roles are retired: a person has one role in the workspace, the same in every ' +
          "project. Add them here without a role, and set their role on the workspace's Members " +
          'page (/settings/workspace).',
        code: 'role_retired',
      },
      { status: 400 },
    );
  }
  if (!userId) {
    return NextResponse.json(
      { error: 'A "userId" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const member = await projectMembersService.addMember({
      key,
      actorUserId: ctx.userId,
      ctx,
      targetUserId: userId,
    });
    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
