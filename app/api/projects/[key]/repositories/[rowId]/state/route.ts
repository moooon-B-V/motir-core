import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';

// The per-row ESTABLISH-STATE actions of the set (Story MOTIR-1775 · MOTIR-1782)
// — the three moves the establish step offers on a row, each one service call:
//
//   { to: 'skipped'   }                 → skipRow            — "Skip this one"
//   { to: 'connected', githubRepoId }   → attachRealizedRepo — "Use one of mine"
//   { to: 'proposed'  }                 → replanRow          — "Create it after
//                                         all" on a skipped row, "Let Motir host
//                                         it" on a connected one
//
// POST → 200 ProjectRepoDto (the row as it now stands).
//
// ONE route rather than three, mirroring `transition_status` for a work item: the
// client names the state it wants and an illegal move comes back as a typed 409
// naming what IS legal, so a caller self-corrects instead of guessing. Each branch
// still calls exactly one service method (CLAUDE.md).
//
// `creating` / `created` / `failed` are deliberately NOT reachable here. Those are
// the CREATION primitive's to write (MOTIR-1781, through the establish endpoint) —
// a client that could POST `created` could claim a repository exists that does
// not, which is the one thing the row state must never be able to lie about.

const CLIENT_REACHABLE = ['skipped', 'connected', 'proposed'] as const;
type ClientReachableState = (typeof CLIENT_REACHABLE)[number];

function isClientReachable(value: unknown): value is ClientReachableState {
  return (CLIENT_REACHABLE as readonly unknown[]).includes(value);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { rowId } = await params;
  const body = (await req.json().catch(() => null)) as {
    to?: unknown;
    githubRepoId?: unknown;
  } | null;

  if (!body || !isClientReachable(body.to)) {
    return NextResponse.json(
      {
        code: 'PROJECT_REPO_INVALID_FIELD',
        error: `\`to\` must be one of ${CLIENT_REACHABLE.join(', ')}.`,
      },
      { status: 422 },
    );
  }

  try {
    switch (body.to) {
      case 'skipped':
        return NextResponse.json(await projectRepoSetService.skipRow(rowId, ctx));
      case 'proposed':
        return NextResponse.json(await projectRepoSetService.replanRow(rowId, ctx));
      case 'connected': {
        if (typeof body.githubRepoId !== 'string' || body.githubRepoId.length === 0) {
          return NextResponse.json(
            {
              code: 'PROJECT_REPO_INVALID_FIELD',
              error: '`githubRepoId` is required to connect an existing repository.',
            },
            { status: 422 },
          );
        }
        return NextResponse.json(
          await projectRepoSetService.attachRealizedRepo(rowId, body.githubRepoId, ctx),
        );
      }
    }
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
