import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Public work-items pagination endpoint (Story 6.12 · Subtask 6.12.4) — the
// "Load more" fetch behind the Work items tab's lazy list. NOT session-gated on
// READ: a logged-out visitor / crawler pages a public project. The service runs
// the anonymous public-browse gate (assertCanBrowsePublic) — a non-public /
// unknown project throws ProjectNotFoundError → 404 (no existence leak). HTTP
// layer only: parse → one service call → map errors.

export async function GET(req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;
  const cursor = new URL(req.url).searchParams.get('cursor') ?? undefined;

  try {
    const page = await publicProjectsService.getWorkItems(identifier, actorUserId, cursor);
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
