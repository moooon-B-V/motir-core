import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectRepoTakeoverService } from '@/lib/services/projectRepoTakeoverService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';

// TAKE IT OVER — the per-row handoff to the user's own GitHub (Story MOTIR-1775 ·
// MOTIR-711).
//
//   POST { newOwner }  → 200 { row, state, transferAccepted }  — start the saga
//   POST { }           → 200 ProjectRepoDto                    — re-probe whether
//                        the App has since been installed on the new owner
//
// Two verbs on one route because they are the same user intention at two moments
// ("take this over" / "…did my re-install land yet?"), and the second is what the
// surface polls while the row sits in `awaiting_reinstall`. Each branch still
// calls exactly one service method (CLAUDE.md).
//
// The account/org PICKER is NOT here: this endpoint accepts the chosen
// `newOwner` as an input. Offering the choice — the user's personal account or
// one of their orgs, with its loading and unavailable states — is MOTIR-1939's
// surface, gated by MOTIR-1938's design.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { rowId } = await params;
  const body = (await req.json().catch(() => null)) as { newOwner?: unknown } | null;

  try {
    // No target named → the completion probe. A row that is not awaiting a
    // re-install comes back untouched, so polling it is free and safe.
    if (!body || body.newOwner === undefined) {
      return NextResponse.json(await projectRepoTakeoverService.completeIfReinstalled(rowId, ctx));
    }

    if (typeof body.newOwner !== 'string' || body.newOwner.trim().length === 0) {
      return NextResponse.json(
        {
          code: 'PROJECT_REPO_INVALID_FIELD',
          error: '`newOwner` must be the GitHub login to transfer the repository to.',
        },
        { status: 422 },
      );
    }

    return NextResponse.json(
      await projectRepoTakeoverService.requestTakeover(rowId, body.newOwner, ctx),
    );
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
