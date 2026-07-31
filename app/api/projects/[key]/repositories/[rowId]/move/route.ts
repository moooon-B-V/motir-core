import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';

// REORDER one row of the set (Story MOTIR-1775 · MOTIR-1782) — the endpoint behind
// the establish step's **Move up** / **Move down**.
//
// POST { direction: 'up' | 'down' } → 200 ProjectRepoDto
//
// Order is a DECISION, not a display preference: the first row is the project's
// primary repository (ADR §1.3), so moving a row is persisted like every other
// edit and survives a refresh. A row already at the edge it is asked to move
// toward is a 200 no-op — a double-press is not an error.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ rowId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { rowId } = await params;
  const body = (await req.json().catch(() => null)) as { direction?: unknown } | null;
  if (!body || (body.direction !== 'up' && body.direction !== 'down')) {
    return NextResponse.json(
      { code: 'PROJECT_REPO_INVALID_FIELD', error: '`direction` must be "up" or "down".' },
      { status: 422 },
    );
  }

  try {
    const row = await projectRepoSetService.moveRow(rowId, body.direction, ctx);
    return NextResponse.json(row);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
