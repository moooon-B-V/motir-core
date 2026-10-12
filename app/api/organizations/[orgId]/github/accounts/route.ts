import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { mapGithubLinkError } from '@/lib/github/linkErrorResponse';
import { githubInstallationService } from '@/lib/services/githubInstallationService';

// GET /api/organizations/[orgId]/github/accounts (Story MOTIR-8216 ·
// MOTIR-8220) — the GitHub accounts the Motir App is installed on that the
// ACTING ADMIN can see on GitHub, each with whether it is linked to this
// organisation. HTTP only: session, one service call, typed errors mapped.
//
//   200 { state: 'ok', accounts: [...] } | { state: 'identity_required' }
//   403 a member without org admin · 404 a non-member · 409 a closing org

type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  try {
    return NextResponse.json(
      await githubInstallationService.listAccountsForOrganization({
        organizationId: orgId,
        actorUserId: gate.session.user.id,
      }),
    );
  } catch (err) {
    const mapped = mapGithubLinkError(err) ?? mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
