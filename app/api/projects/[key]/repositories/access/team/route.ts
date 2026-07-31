import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';

// TEAM code access to the project's repositories (Story MOTIR-1775 · MOTIR-1910)
// — the endpoints behind the team code-access surface (MOTIR-1945).
//
// Its own route rather than more verbs on `../access`, because it answers a
// DIFFERENT question about a different subject. `../access` is first-person —
// "get ME into my code" — and is what the establish step's connect return trip
// calls; this is the team matrix, which a project-settings surface reads and
// writes on behalf of everyone. Folding them together would give one endpoint two
// response shapes discriminated by a flag.
//
// GET → 200 ProjectRepoTeamAccessDto
//   Every candidate member × every repository of the set, each cell in its real
//   state. READ-ONLY — no GitHub round-trips — so a surface may poll it. Members
//   who CANNOT be invited are included with a `reason`, deliberately: a list that
//   omitted them would answer "who has access?" while hiding the people the reader
//   is most likely looking for.
//
// POST { rowId?, userId? } → 200 GrantTeamAccessResultDto
//   Invite the eligible members who have a connected GitHub account. `rowId`
//   narrows to one repository, `userId` to one member, and both together to
//   exactly one cell — which is what a per-row **Resend invitation** needs, since
//   rows and members are independent and re-sending one must not quietly re-send
//   its neighbours. Idempotent: GitHub treats a repeat on a pending invitation as
//   an update, so a double-submit cannot produce two.
//
//   `skippedNoIdentity > 0` is NOT an error — it is the honest count of members
//   Motir cannot invite because they have not connected GitHub, which is a state
//   only they can resolve (Motir cannot OAuth on anyone's behalf). The surface
//   renders it as an explanation on their row, never as a failure.
//
// EDIT-GATED, not browse-gated: handing someone push access to the project's code
// is a write, and being able to SEE a project must never be enough to grant it.
// The service asserts that itself, so both verbs inherit the same rule.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  try {
    const project = await projectsService.getByKey(key, ctx);
    const access = await projectRepoAccessService.listTeamAccess(project.id, ctx);
    return NextResponse.json(access);
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
  const body = (await req.json().catch(() => null)) as {
    rowId?: unknown;
    userId?: unknown;
  } | null;
  const rowId = typeof body?.rowId === 'string' && body.rowId.length > 0 ? body.rowId : undefined;
  const userId =
    typeof body?.userId === 'string' && body.userId.length > 0 ? body.userId : undefined;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const result = await projectRepoAccessService.grantTeamAccess(project.id, ctx, {
      ...(rowId !== undefined ? { rowId } : {}),
      ...(userId !== undefined ? { userId } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
