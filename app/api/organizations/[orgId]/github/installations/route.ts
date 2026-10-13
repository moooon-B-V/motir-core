import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { mapGithubLinkError } from '@/lib/github/linkErrorResponse';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { getWorkspaceContext } from '@/lib/workspaces';

// POST /api/organizations/[orgId]/github/installations (Story MOTIR-8216 ·
// MOTIR-8220) — link a GitHub account the App is already installed on to this
// organisation, claiming the chosen repositories. `repoIds` is REQUIRED here
// (only the install round trip may omit it). The installation id in the body is
// never trusted on its own: the service checks the actor can see it on GitHub.
//
//   200 { installation, claimed, released }
//   400 a malformed body · 403 not an admin, or installation_not_accessible
//   404 a non-member · 409 repository_owned_by_other_organization, or a closing
//   org · 422 repository_not_visible

type Params = { params: Promise<{ orgId: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { installationId, repoIds } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof installationId !== 'string' ||
    installationId.length === 0 ||
    !Array.isArray(repoIds) ||
    repoIds.length === 0 ||
    !repoIds.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: '`installationId` and a non-empty `repoIds` string array are required.',
      },
      { status: 400 },
    );
  }

  const ctx = await getWorkspaceContext();
  try {
    return NextResponse.json(
      await githubInstallationService.linkExistingInstallation({
        organizationId: orgId,
        actorUserId: gate.session.user.id,
        installationId,
        repoIds: repoIds as string[],
        via: 'picker',
        ...(ctx ? { workspaceIdHint: ctx.workspaceId } : {}),
      }),
    );
  } catch (err) {
    const mapped = mapGithubLinkError(err) ?? mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
