import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { workspacesService } from '@/lib/services/workspacesService';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';

// GET /api/workspaces/current
// Thin HTTP transport: reads the session + workspace cookie, asks the
// service for the active workspace + the caller's membership, and returns
// the DTO. No db.* / $transaction here — the service owns all of that.
//
// 401 when unauthenticated. 404 when the (signed-in) user has no
// workspace at all; in practice the workspace-context resolver self-heals
// zero-membership users via ensureDefaultWorkspace, so a normal signed-in
// user always has one — but a hard delete of every membership would land
// here, and 404 is the honest answer.

export async function GET(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const cookieStore = await cookies();
  const preferredWorkspaceId = cookieStore.get(WORKSPACE_COOKIE_NAME)?.value ?? null;

  const result = await workspacesService.getActiveWorkspace(session.user.id, preferredWorkspaceId);
  if (!result) {
    return NextResponse.json(
      { error: 'No active workspace', code: 'NO_ACTIVE_WORKSPACE' },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
