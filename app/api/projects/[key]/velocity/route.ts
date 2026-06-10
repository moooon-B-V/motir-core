import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { reportsService } from '@/lib/services/reportsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/projects/[key]/velocity (Story 4.6 · Subtask 4.6.4) — the
// cross-sprint VELOCITY read: the last `?lastN` (default 7) COMPLETED sprints
// with committed (the 4.4.2 baseline) vs completed (the 4.3.3 done-category
// roll-up) + the average, the data behind the 4.6.6 sprint-report velocity
// chart. The project is addressed by its workspace-unique `key` (the `PROD`
// identifier) — the convention every project route uses (rung-2 shipped
// convention; the card's `[id]` reads as that key) — resolved to the internal id
// via `projectsService.getByKey`, which tenant- + access-gates it (a missing /
// unbrowsable project is a 404, no existence leak — finding #26).
//
// Thin HTTP transport per CLAUDE.md: resolve workspace context, parse `lastN`,
// resolve the project, ONE service call, map the typed error. No db / no
// transaction here. A bad `?lastN=` is not an error — the service clamps it to a
// sensible default.
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
  const lastNParam = new URL(req.url).searchParams.get('lastN');
  const lastN = lastNParam === null ? undefined : Number(lastNParam);

  try {
    const project = await projectsService.getByKey(key, ctx);
    const velocity = await reportsService.getVelocity({ projectId: project.id, lastN }, ctx);
    return NextResponse.json(velocity);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
