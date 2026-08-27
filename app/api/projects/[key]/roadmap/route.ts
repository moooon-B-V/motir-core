import { NextResponse } from 'next/server';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/projects/[key]/roadmap?parentId=<id>&scope=sprint (Subtask 7.20.4
// re-plan, MOTIR-1010; sprint scope MOTIR-1381) — ONE LEVEL of the project
// roadmap: the roots (omit `parentId`) or one parent's direct children, each with
// a lazy `hasChildren` drill flag, plus the `is_blocked_by` edges from that level.
// The canvas (MOTIR-1194) shows one level at a time and fetches the next on drill
// — so this is a PER-LEVEL read, not a whole-tree round-trip (mistake #91). The
// project is addressed by its workspace-unique `key` (the `PROD` identifier),
// resolved + tenant/access-gated via `projectsService.getByKey` (a missing /
// unbrowsable project is a 404).
//
// `scope=sprint` narrows every level to the active sprint's member-or-ancestor
// set (no active sprint → an empty roadmap); absent / `scope=project` is the
// whole-project read.
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
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key } = await params;
  const search = new URL(req.url).searchParams;
  const parentId = search.get('parentId') || null;
  const scope = search.get('scope') === 'sprint' ? 'sprint' : 'project';
  // `all=1` — the level's "Show all", asked for only after its truncation tile
  // has told the reader rows were dropped (MOTIR-3490). Any other value, and its
  // absence, is the ordinary capped read; the service owns the ceiling it raises
  // to, so a forged value cannot widen the read past it.
  const all = search.get('all') === '1';

  try {
    const project = await projectsService.getByKey(key, ctx);
    const roadmap = await workItemsService.getProjectRoadmap(project.id, parentId, ctx, {
      scope,
      all,
    });
    return NextResponse.json(roadmap);
  } catch (err) {
    // MOTIR-2291 — the shared project gate's two refusals (404 for a non-browser,
    // 403 naming the key). Without this arm they fall through to a 500.
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
