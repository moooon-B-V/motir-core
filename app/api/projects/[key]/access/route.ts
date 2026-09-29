import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// PATCH /api/projects/[key]/access (Story 6.4 · Subtask 6.4.4; Story MOTIR-6169 ·
// MOTIR-6544) — set who may ENTER the project. Body: `{ accessMode }` (workspace /
// members / public). The legacy `{ accessLevel }` body retired in MOTIR-6692: no
// in-tree caller sent it, and a body without a string `accessMode` — that one
// included — is a 400 naming the field to send. `project:manage_access` gated.
// Nobody is added to the project by a mode change. Thin HTTP transport per
// CLAUDE.md: parse, one service call, map typed errors.

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
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
  const accessMode =
    body && typeof body === 'object' ? (body as Record<string, unknown>).accessMode : undefined;
  if (typeof accessMode !== 'string' || !accessMode) {
    return NextResponse.json(
      { error: 'An "accessMode" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const access = await projectMembersService.setAccessMode({
      key,
      actorUserId: ctx.userId,
      ctx,
      mode: accessMode,
    });
    return NextResponse.json({ access });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
