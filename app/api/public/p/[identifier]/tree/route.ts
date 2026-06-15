import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Public work-item TREE level endpoint (Story 6.14 · Subtask 6.14.10) — the
// lazy fetch behind the Tree tab: one level at a time (the project roots, or one
// parent's direct children on expand) + "Load more children" past the per-level
// page. NOT session-gated on READ: a logged-out visitor / crawler browses a
// public project. The service runs the anonymous public-browse gate — a
// non-public / unknown project throws ProjectNotFoundError → 404 (no existence
// leak) — and applies the epic-privacy exclusion (6.14.4) for a non-member, so a
// private epic's descendants never cross the wire. HTTP layer only: parse → one
// service call → map errors.
//
//   ?parentId=<id>   one parent's children (omit / empty → the project roots)
//   ?offset=<n>      the level's paging offset ("Load more children")

export async function GET(req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  const sp = new URL(req.url).searchParams;
  const parentId = sp.get('parentId') || null;
  const offsetRaw = Number(sp.get('offset'));
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  try {
    const level = await publicProjectsService.getProjectTreeLevel(
      identifier,
      parentId,
      actorUserId,
      offset,
    );
    return NextResponse.json(level);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
