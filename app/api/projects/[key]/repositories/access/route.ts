import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';

// COLLABORATOR ACCESS to the project's repositories (Story MOTIR-1775 ·
// MOTIR-1900) — the endpoint behind the access step's **Connect GitHub** return
// trip and a row's **Resend invitation**.
//
// POST { rowId? } → 200 GrantAccessResult
//   Invite the acting member's connected GitHub account to the repositories Motir
//   created for this project. `rowId` narrows it to ONE row, which is exactly what
//   **Resend invitation** needs: rows are independent, so re-sending one must not
//   quietly re-send its siblings. Idempotent — GitHub treats a repeat on a pending
//   invitation as an update, so a double-submit cannot produce two.
//
//   A `login: null` response is NOT an error: it is the honest answer for a user
//   who has not connected GitHub, and it is what the connect prompt renders from.
//   That is the whole reason this is a step after approval rather than a gate
//   before it — nothing here can cost the user their plan or their code.
//
// GET → 200 ProjectRepoDto[]
//   Re-read GitHub for the PENDING invitations and settle the accepted ones.
//   Deliberately its own call rather than folded into `GET ../repositories`: that
//   read is the establish step's 1.5s POLL, and putting N host round-trips on it
//   would spend a request per row per tick to learn something that changes once.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  const body = (await req.json().catch(() => null)) as { rowId?: unknown } | null;
  const rowId = typeof body?.rowId === 'string' && body.rowId.length > 0 ? body.rowId : undefined;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const result = await projectRepoAccessService.grantAccess(
      project.id,
      ctx,
      rowId !== undefined ? { rowId } : {},
    );
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  try {
    const project = await projectsService.getByKey(key, ctx);
    const rows = await projectRepoAccessService.refreshAccess(project.id, ctx);
    return NextResponse.json(rows);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
