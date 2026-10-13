import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { InstallationNotLinkedError } from '@/lib/github/errors';
import { githubAccountDisconnectService } from '@/lib/services/githubAccountDisconnectService';

// DISCONNECT THE ORGANISATION FROM ONE GITHUB ACCOUNT (Story MOTIR-8216 ·
// MOTIR-8222). The organisation is the actor's workspace's, as on every
// `/api/organization/*` route.
//
//   DELETE → 200 { releasedRepos, clearedLinks, installationRemoved }
//            403 not an org admin · 404 installation_not_linked
//
// It removes ONLY this organisation's link and repositories; the App stays
// installed on GitHub, and every other organisation linked to the account is
// untouched. Org-admin is asserted in the service. Thin HTTP transport.

type Params = { params: Promise<{ installationId: string }> };

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { installationId } = await params;
  try {
    return NextResponse.json(
      await githubAccountDisconnectService.disconnectAccountFromOrganization({
        ...gate.ctx,
        installationId,
      }),
    );
  } catch (err) {
    if (err instanceof InstallationNotLinkedError) {
      return NextResponse.json(
        { code: 'installation_not_linked', error: err.message },
        { status: 404 },
      );
    }
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
