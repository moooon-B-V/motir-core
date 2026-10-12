import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { getWorkspaceContext } from '@/lib/workspaces';

// GET /api/organizations/[orgId]/github/install-url (Story MOTIR-8216 ·
// MOTIR-8220) — the signed GitHub App install URL for "Install on another
// account". The state carries this organisation and returns to the Git room, so
// the setup round trip links the new account HERE rather than to whatever the
// installation row was first stamped with.
//
//   200 { url } (null when the App is not configured on this deployment)
//   403 a member without org admin · 404 a non-member · 409 a closing org

type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  const ctx = await getWorkspaceContext();
  try {
    const url = await githubInstallationService.installUrlForOrganization({
      organizationId: orgId,
      actorUserId: gate.session.user.id,
      ...(ctx ? { workspaceIdHint: ctx.workspaceId } : {}),
    });
    return NextResponse.json({ url });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
