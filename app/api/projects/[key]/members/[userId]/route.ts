import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// /api/projects/[key]/members/[userId] (Story 6.4 · Subtask 6.4.4)
//   PATCH  — RETIRED, 410 Gone: roles live on the workspace (Story MOTIR-6168 ·
//            MOTIR-6464), so a project membership has no role to set.
//   DELETE — remove a member from the project (`member:manage` gated). There is
//            no last-admin guard any more: there is no project admin to protect.
//
// A per-member sub-resource (the userId in the path) addresses the target
// unambiguously, which is the idiomatic REST + App-Router shape — the card's
// "members (GET/POST/PATCH/DELETE)" collapsed the per-member mutations onto the
// collection line. Thin HTTP transport per CLAUDE.md: parse, one service call,
// map typed errors.

interface RouteParams {
  params: Promise<{ key: string; userId: string }>;
}

/**
 * Retired (Story MOTIR-6168 · MOTIR-6464): a project membership carries no role,
 * so there is nothing to set here. Kept as a 410 rather than deleted so a stale
 * client learns where the role went instead of reading a 404.
 */
export async function PATCH(): Promise<Response> {
  return NextResponse.json(
    {
      error:
        "Project roles are retired: a person's role is set once, on the workspace, and holds in " +
        'every project. Change it with PATCH /api/workspaces/{workspaceId}/members/{userId}.',
      code: 'role_retired',
    },
    { status: 410 },
  );
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  // The 2FA hold (MOTIR-3653) — inserted after this route's own no-context
  // arm rather than folded into `requireCompliantWorkspaceContext`, because
  // that arm carries a body of its own that must not change.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

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
