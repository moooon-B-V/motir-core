import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { workspacesService } from '@/lib/services/workspacesService';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { WorkspaceNotFoundError } from '@/lib/workspaces/errors';

// /api/organizations/[orgId]/workspaces/[workspaceId] (MOTIR-6309) — REMOVE a
// workspace at the org tier, the one interactive door onto deleting one.
// Session-gated (401), then one service call. The service owns every gate: the
// org-Admin capability (404 non-member / 403 Member), and that the workspace is
// this org's (a workspace addressed through another org's URL reads as 404).
// The actor needs NO membership in the workspace itself.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; workspaceId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { orgId, workspaceId } = await params;

  try {
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId,
      organizationId: orgId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
