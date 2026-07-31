import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoEstablishService } from '@/lib/services/projectRepoEstablishService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { isProjectRepoRole } from '@/lib/projectRepos/vocabulary';
import type { AddProjectRepoInput } from '@/lib/dto/projectRepos';

// The project's REPOSITORY SET, as the establish step reads and grows it (Story
// MOTIR-1775 · MOTIR-1782).
//
//   GET  → 200 ProjectRepoEstablishViewDto — the whole step's read model in one
//          call: the set, the actor's GitHub login (grant 1) and the repositories
//          the workspace's installation grants (grant 2). This is also the POLL
//          the step runs while rows are being established: each row commits its
//          own outcome as it resolves (the primitive persists per row, never as
//          one transaction), so polling this read is what makes per-row progress
//          real rather than a spinner that guesses.
//   POST → 201 ProjectRepoDto — APPEND a row. The set-level "Add a repository",
//          which means only "the plan needs a part Motir didn't infer"; it is
//          never how an existing repository is used (that is the row-level
//          connect).
//
// `[key]` is the project's workspace-unique key ("MOTIR"), resolved + tenant-gated
// via `projectsService.getByKey` — the same two-step every project-scoped route
// under this tree uses. Thin HTTP transport per CLAUDE.md: resolve the workspace,
// resolve the project, ONE service call, map the typed error.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  try {
    const project = await projectsService.getByKey(key, ctx);
    const view = await projectRepoEstablishService.getEstablishView(project.id, ctx);
    return NextResponse.json(view);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  const body = (await req.json().catch(() => null)) as Partial<AddProjectRepoInput> | null;
  // The ROLE is validated here rather than in the service because it is the one
  // field whose wire value is a closed vocabulary the Prisma enum would reject
  // with a raw error — a 422 naming the field beats a 500 naming a constraint.
  if (!body || !isProjectRepoRole(body.role)) {
    return NextResponse.json(
      { code: 'PROJECT_REPO_INVALID_FIELD', error: 'A valid `role` is required.' },
      { status: 422 },
    );
  }

  const input: AddProjectRepoInput = {
    role: body.role,
    name: typeof body.name === 'string' ? body.name : '',
    ...(body.label !== undefined ? { label: body.label } : {}),
    ...(typeof body.seedSource === 'string' ? { seedSource: body.seedSource } : {}),
    // `proposalSignal` is deliberately NOT accepted from the wire: it records what
    // MOTIR's derivation inferred, and a hand-added row has no inference to
    // record. Letting a client supply one would attribute a user's decision to
    // Motir — the exact distinction the column exists to keep.
  };

  try {
    const project = await projectsService.getByKey(key, ctx);
    const row = await projectRepoSetService.addRow(project.id, input, ctx);
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
