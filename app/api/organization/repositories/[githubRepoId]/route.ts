import { NextResponse } from 'next/server';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { GithubRemovalHappensOnGithubError } from '@/lib/projectRepos/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// DISCONNECT A REPOSITORY FROM THE ORGANISATION (Story MOTIR-4669 · MOTIR-4680).
//
//   DELETE → 200 { clearedLinks, enqueued }
//
// ⚠️ IT REFUSES A GITHUB REPOSITORY WITH A 409, and that is a routing answer
// rather than a permission one. Motir cannot remove a GitHub repository —
// selection is the App's install screen — and a Motir-side "stop tracking" would
// delete the mirror row while leaving the grant in place, so the repository would
// reappear on the next installation reconcile. Two sources of truth for one fact.
// The surface answers it with the pre-link-out disclosure, and the removal
// arrives through the `installation_repositories` webhook.
//
// ORG-ADMIN, asserted in the SERVICE inside the transaction that performs it.
// Thin HTTP transport per CLAUDE.md.

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ githubRepoId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { githubRepoId } = await params;
  try {
    const result = await organizationRepoService.disconnectFromOrganisation(githubRepoId, ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GithubRemovalHappensOnGithubError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
