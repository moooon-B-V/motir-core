import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import type { BindMonitorProjectInput } from '@/lib/dto/monitors';
import { mapMonitorError } from '@/lib/monitors/errorResponse';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { projectsService } from '@/lib/services/projectsService';

// The project's MONITOR CONNECTIONS (Story MOTIR-4926 · MOTIR-5260).
//
//   GET  → 200 MonitorConnectionViewDto — the grant (if any) and this project's
//          bindings, which is everything the Monitoring room renders.
//   POST → 201 MonitorConnectionDto — BIND one monitored project. The second act
//          of a connect: the grant arrives from the provider's install flow, and
//          this is a person choosing which of its projects belong to THIS Motir
//          project. That split is why the callback binds nothing (see the
//          service's `completeGrant`).
//
// `[key]` is the project's workspace-unique key, resolved + tenant-gated via
// `projectsService.getByKey` — the same two-step every project-scoped route under
// this tree uses. Thin HTTP transport per CLAUDE.md: resolve the workspace,
// resolve the project, ONE service call, map the typed error. The
// `integration:manage` gate is the service's.

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
    return NextResponse.json(await monitorConnectionService.getView(project.id, ctx));
  } catch (err) {
    const mapped = mapMonitorError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key } = await params;
  const body = (await req.json().catch(() => null)) as Partial<BindMonitorProjectInput> | null;
  // Validated HERE because these two are the whole request and a missing one
  // would otherwise reach Prisma as a null column — a 422 naming the field beats
  // a 500 naming a constraint.
  if (
    !body ||
    typeof body.externalProjectId !== 'string' ||
    body.externalProjectId.length === 0 ||
    typeof body.externalProjectSlug !== 'string' ||
    body.externalProjectSlug.length === 0
  ) {
    return NextResponse.json(
      {
        code: 'MONITOR_INVALID_FIELD',
        error: 'Both `externalProjectId` and `externalProjectSlug` are required.',
      },
      { status: 422 },
    );
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    const created = await monitorConnectionService.bindProject(
      project.id,
      { externalProjectId: body.externalProjectId, externalProjectSlug: body.externalProjectSlug },
      ctx,
    );
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    const mapped = mapMonitorError(err);
    if (mapped) return mapped;
    throw err;
  }
}
