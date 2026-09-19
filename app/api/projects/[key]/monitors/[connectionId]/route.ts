import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapMonitorError } from '@/lib/monitors/errorResponse';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { projectsService } from '@/lib/services/projectsService';

// ONE bound monitored project (Story MOTIR-4926 · MOTIR-5260; the PATCH is
// Story MOTIR-4929 · MOTIR-5579).
//
//   PATCH  → 200 MonitorConnectionDto — body: any NON-EMPTY subset of
//              `minimumLevel: string | null` — the binding's minimum level
//                (`null` = every level). Lowering rewinds the poll's watermark so
//                the newly admitted issues are read again (MOTIR-5579);
//              `resolveOnDone: boolean` — resolve the linked issue when its bug
//                is done (Motir → monitor, Story MOTIR-4931 · MOTIR-5706);
//              `syncAssignee: boolean` — take a provider-side assignment onto
//                the bug (monitor → Motir, MOTIR-5706).
//            Applied in ONE transaction. An unknown level is 400
//            `INVALID_MONITOR_LEVEL` (and so is a body carrying none of the three
//            keys); a non-boolean switch is 400 `INVALID_MONITOR_SYNC_DIRECTION`;
//            a binding in another project is 404. The response is the SAME DTO
//            the room's read returns, so the room renders the write's own answer.
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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string; connectionId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, connectionId } = await params;
  // A body that is not JSON carries nothing — `null` reaches the service and is
  // refused there, so there is one place that decides what a valid body is.
  const body: unknown = await req.json().catch(() => null);
  try {
    const project = await projectsService.getByKey(key, ctx);
    return NextResponse.json(
      await monitorConnectionService.updateConnection(project.id, connectionId, body, ctx),
    );
  } catch (err) {
    const mapped = mapMonitorError(err);
    if (mapped) return mapped;
    throw err;
  }
}
