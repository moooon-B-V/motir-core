import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// PATCH /api/projects/[key]/access (Story 6.4 · Subtask 6.4.4; Story MOTIR-6169 ·
// MOTIR-6544) — set who may ENTER the project. Body: `{ accessMode }` (workspace /
// members / public), or the legacy `{ accessLevel }` for the one release in which
// the shipped UI still sends a level (mapped by the service's adapter). A body
// carrying BOTH is refused — which one would win is not a question a route should
// answer silently. `project:manage_access` gated. Nobody is added to the project
// by a mode change. Thin HTTP transport per CLAUDE.md: parse, one service call,
// map typed errors.

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
  const field = (name: 'accessMode' | 'accessLevel'): string | null | undefined => {
    if (!body || typeof body !== 'object' || !(name in body)) return undefined;
    const value = (body as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : null;
  };
  const accessMode = field('accessMode');
  const accessLevel = field('accessLevel');
  if (accessMode !== undefined && accessLevel !== undefined) {
    return NextResponse.json(
      { error: 'Send "accessMode" or "accessLevel", not both.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }
  if (!accessMode && !accessLevel) {
    return NextResponse.json(
      { error: 'An "accessMode" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const access = accessMode
      ? await projectMembersService.setAccessMode({
          key,
          actorUserId: ctx.userId,
          ctx,
          mode: accessMode,
        })
      : await projectMembersService.setAccessLevel({
          key,
          actorUserId: ctx.userId,
          ctx,
          level: accessLevel!,
        });
    return NextResponse.json({ access });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
