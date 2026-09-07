import { NextResponse } from 'next/server';
import { projectsService } from '@/lib/services/projectsService';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// THE PICKER'S FIRST SEGMENT (Story MOTIR-4669 · MOTIR-4678).
//
//   GET → 200 OrgRepoOptionDto[] — the ORGANISATION's connected repositories,
//         minus the ones this project already holds. Every row is free to pick:
//         the repository is connected and indexed at the org, so linking it is
//         one row and nothing re-indexes.
//
// Org-SCOPED, so the list spans every workspace of the organisation — which is
// the story's whole point and the reason this is not a variant of
// `/repositories`. Thin HTTP transport per CLAUDE.md: resolve the workspace,
// resolve the project, ONE service call, map the typed error.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key } = await params;
  try {
    const project = await projectsService.getByKey(key, ctx);
    const options = await organizationRepoService.listAvailableForProject(project.id, ctx);
    return NextResponse.json(options);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
