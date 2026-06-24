import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/projects/[key]/roadmap?parentId=<id> (Subtask 7.20.4 re-plan,
// MOTIR-1010) — ONE LEVEL of the project roadmap: the roots (omit `parentId`) or
// one parent's direct children, each with a lazy `hasChildren` drill flag, plus
// the `is_blocked_by` edges from that level. The canvas (MOTIR-1194) shows one
// level at a time and fetches the next on drill — so this is a PER-LEVEL read, not
// a whole-tree round-trip (mistake #91). The project is addressed by its
// workspace-unique `key` (the `PROD` identifier), resolved + tenant/access-gated
// via `projectsService.getByKey` (a missing / unbrowsable project is a 404).
//
// Thin HTTP transport per CLAUDE.md: resolve workspace context, resolve the
// project, ONE service call, map the typed error. No db / no transaction here.
//
// Typed errors → status codes:
//   ProjectNotFoundError → 404
export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  const parentId = new URL(req.url).searchParams.get('parentId') || null;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const roadmap = await workItemsService.getProjectRoadmap(project.id, parentId, ctx);
    return NextResponse.json(roadmap);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
