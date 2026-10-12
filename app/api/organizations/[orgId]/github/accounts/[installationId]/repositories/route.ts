import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { mapGithubLinkError } from '@/lib/github/linkErrorResponse';
import { githubInstallationService } from '@/lib/services/githubInstallationService';

// GET /api/organizations/[orgId]/github/accounts/[installationId]/repositories
// (Story MOTIR-8216 · MOTIR-8220) — one account's repositories, each marked
// `available`, `connected_here` or `connected_elsewhere`. A repository another
// organisation owns carries no identifier of that organisation.
//
//   200 { repos, counts } · 403 not an admin, or installation_not_accessible
//   404 a non-member · 409 a closing org

type Params = { params: Promise<{ orgId: string; installationId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId, installationId } = await params;
  try {
    return NextResponse.json(
      await githubInstallationService.listRepositoriesForAccount({
        organizationId: orgId,
        actorUserId: gate.session.user.id,
        installationId,
      }),
    );
  } catch (err) {
    const mapped = mapGithubLinkError(err) ?? mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
