import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { projectsService } from '@/lib/services/projectsService';
import { workbenchWindowService } from '@/lib/services/workbenchWindowService';
import { parseWorkbenchTab } from '@/lib/workbench/tab';
import { parsePage } from '@/lib/issues/issueListView';

// GET /api/workbench/window?tab=<tab>&page=<n> (Story MOTIR-8539 · Subtask
// MOTIR-8573) — the active tab's window and every strip count, in ONE request,
// from ONE server read (`workbenchWindowService.read`, the page's own pairing).
//
// It is what lets a client applier re-read the Workbench in place of a route
// refresh without the strip and the list ever disagreeing (§ 21 / § 26).
//
// ⚠️ AN UNKNOWN TAB IS A 400, never the page's landing redirect: a client asked
// for a specific window, and answering with a different one would be a silent
// wrong answer rather than a visible error.
//
// ⚠️ `no-store`: a cached answer is exactly the stale list this read exists to
// replace.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const params = new URL(req.url).searchParams;
  const tab = parseWorkbenchTab(params.get('tab') ?? undefined);
  if (tab === null) {
    return NextResponse.json(
      { code: 'INVALID_TAB', error: 'Unknown Workbench tab.' },
      { status: 400, headers: NO_STORE },
    );
  }
  const page = parsePage(params.get('page') ?? undefined);

  const project = await projectsService.getActiveProject(ctx.userId, ctx.workspaceId);
  if (!project) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project for this reader.' },
      { status: 404, headers: NO_STORE },
    );
  }
  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };

  const read = await workbenchWindowService.read(actor, { tab, page });
  return NextResponse.json(read, { headers: NO_STORE });
}
