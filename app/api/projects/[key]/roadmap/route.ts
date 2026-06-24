import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/projects/[key]/roadmap (Story 7.19 · Subtask 7.19.2) — the project
// ROADMAP read: the whole non-archived issue forest (epics → stories →
// subtasks) with per-container done/total progress roll-ups, the data the
// planning-canvas roadmap (7.19.3) renders and its virtualized view windows
// over. ONE recursive-CTE forest read + an in-memory roll-up pass (no N+1,
// finding #57). The project is addressed by its workspace-unique `key` (the
// `PROD` identifier — the convention every project route uses; the card's
// `[id]` reads as that key), resolved to the internal id via
// `projectsService.getByKey`, which tenant- + access-gates it (a missing /
// unbrowsable project is a 404, no existence leak — finding #26).
//
// Thin HTTP transport per CLAUDE.md: resolve workspace context, resolve the
// project, ONE service call, map the typed error. No db / no transaction here.
//
// Typed errors → status codes:
//   ProjectNotFoundError → 404
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const roadmap = await workItemsService.getProjectRoadmap(project.id, ctx);
    return NextResponse.json(roadmap);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
