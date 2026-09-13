import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapMonitorError } from '@/lib/monitors/errorResponse';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { projectsService } from '@/lib/services/projectsService';

// DISCONNECT one monitored project from this Motir project (Story MOTIR-4926 ·
// MOTIR-5260).
//
//   DELETE → 200 { removedGrant } — the binding is gone, and `removedGrant` says
//            whether it was the LAST one and took the stored credential with it.
//            The caller is told, because "your connection is gone" and "that
//            project is no longer bound" are different things to render.
//
// Thin HTTP transport per CLAUDE.md; the `integration:manage` gate and the
// no-orphaned-credential rule are the service's.

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string; connectionId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, connectionId } = await params;
  try {
    const project = await projectsService.getByKey(key, ctx);
    return NextResponse.json(
      await monitorConnectionService.disconnect(project.id, connectionId, ctx),
    );
  } catch (err) {
    const mapped = mapMonitorError(err);
    if (mapped) return mapped;
    throw err;
  }
}
