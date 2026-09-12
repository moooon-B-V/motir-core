import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapMonitorError } from '@/lib/monitors/errorResponse';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { projectsService } from '@/lib/services/projectsService';

// The monitored projects this project COULD bind (Story MOTIR-4926 ·
// MOTIR-5260) — the picker's read.
//
//   GET → 200 AvailableMonitorProjectDto[] — the grant's organisation's projects,
//         each flagged `bound` when THIS project already binds it, so the picker
//         shows a taken row as taken rather than offering a bind the unique index
//         would refuse.
//
// It is the one read on this surface that CALLS THE PROVIDER, which is why it is
// its own route rather than a field on the view above: a degraded credential must
// not stop the room rendering the connections it already has.
//
// Thin HTTP transport per CLAUDE.md; the `integration:manage` gate is the
// service's.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key } = await params;
  try {
    const project = await projectsService.getByKey(key, ctx);
    return NextResponse.json(await monitorConnectionService.listAvailableProjects(project.id, ctx));
  } catch (err) {
    const mapped = mapMonitorError(err);
    if (mapped) return mapped;
    throw err;
  }
}
