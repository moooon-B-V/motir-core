import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { parsePage } from '@/lib/issues/issueListView';
import { workbenchPlanningService } from '@/lib/services/workbenchPlanningService';
import type { WorkbenchPlanningPageDto } from '@/lib/dto/home';

// GET /api/workbench/planning?page= (Story MOTIR-7820 · MOTIR-7828) — the reader's
// plans being written, as one page of `WorkbenchPlanningPageDto`. The read the
// Workbench's Planning tab polls so a row's progress moves and a finished plan
// leaves; the tab decides the cadence, this route adds none.
//
// HTTP only (CLAUDE.md § the 4-layer architecture): the session gate, the same
// active-project context the Workbench page builds, `parsePage`, ONE service call.
// The project and workspace come from that context, never from the client.

export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const page = parsePage(new URL(req.url).searchParams.get('page') ?? undefined);
  const body: WorkbenchPlanningPageDto = await workbenchPlanningService.listMyPlansBeingWritten(
    ctx,
    { page },
  );
  return NextResponse.json(body);
}
