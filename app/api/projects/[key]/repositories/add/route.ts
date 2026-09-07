import { NextResponse } from 'next/server';
import { projectsService } from '@/lib/services/projectsService';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { isProjectRepoRole } from '@/lib/projectRepos/vocabulary';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// ADD AND LINK — ONE action, two inputs (Story MOTIR-4669 · MOTIR-4678).
//
//   POST → 201 ProjectRepoDto
//     { githubRepoId }                  → PICK an organisation-connected
//                                         repository. Links it. Enqueues NOTHING.
//     { installationId, providerRepoId } → CONNECT a new one: the organisation
//                                         connection AND the project link, in one
//                                         act. The only path that costs an index.
//
// ⚠️ ONE ROUTE, NOT TWO, and that is the shape rather than a convenience. `Add
// repository` is a single act as far as anyone using it is concerned; splitting
// the transport would invite a UI that presents two buttons and a decision
// nobody should have to make. Which segment a request came from is an input, not
// an endpoint.
//
// Both arms are ORG-ADMIN, asserted in the SERVICE and inside its transaction —
// this room's own `repository:manage` is a PROJECT permission, so a gate here
// would be a gate a second caller walks around.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key } = await params;
  const body = (await req.json().catch(() => null)) as {
    githubRepoId?: unknown;
    installationId?: unknown;
    providerRepoId?: unknown;
    role?: unknown;
    name?: unknown;
    label?: unknown;
  } | null;

  // `role` is validated here rather than in the service for the reason the sibling
  // POST gives: it is a closed vocabulary the Prisma enum would reject with a raw
  // error, and a 422 naming the field beats a 500 naming a constraint.
  if (!body || !isProjectRepoRole(body.role)) {
    return NextResponse.json(
      { code: 'PROJECT_REPO_INVALID_FIELD', error: 'A valid `role` is required.' },
      { status: 422 },
    );
  }
  const optional = {
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
    ...(typeof body.label === 'string' ? { label: body.label } : {}),
  };

  const isPick = typeof body.githubRepoId === 'string' && body.githubRepoId.length > 0;
  const isConnect =
    typeof body.installationId === 'string' &&
    body.installationId.length > 0 &&
    typeof body.providerRepoId === 'string' &&
    body.providerRepoId.length > 0;

  // Exactly one of the two, never both: a request naming a repository to pick AND
  // an install to perform describes two different acts, and guessing which one
  // the caller meant is how the free path silently becomes the expensive one.
  if (isPick === isConnect) {
    return NextResponse.json(
      {
        code: 'PROJECT_REPO_INVALID_FIELD',
        error:
          'Send either `githubRepoId` (pick an organisation repository) or `installationId` + `providerRepoId` (connect a new one) — exactly one.',
      },
      { status: 422 },
    );
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    const row = isPick
      ? await organizationRepoService.linkExistingRepo(
          project.id,
          { githubRepoId: body.githubRepoId as string, role: body.role, ...optional },
          ctx,
        )
      : await organizationRepoService.connectAndLink(
          project.id,
          {
            installationId: body.installationId as string,
            providerRepoId: body.providerRepoId as string,
            role: body.role,
            ...optional,
          },
          ctx,
        );
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
