import { NextResponse } from 'next/server';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { mapDashboardError } from '@/lib/dashboards/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// /api/dashboards/[dashboardId]/widgets/[widgetId] (Story 6.3 · Subtask
// 6.3.1) — reconfigure / remove one widget (owner-only). PATCH body:
// { config? , savedFilterId? | projectId? } — config replaces the per-type
// settings (registry-validated); a provided source id replaces the data
// source (XOR'd + referent-verified; this is also how a STALE widget heals).
// The widget's TYPE is immutable (remove + add instead — the Jira gadget
// rule).
//
// Typed errors → status codes (mapDashboardError):
//   DashboardNotFoundError / DashboardWidgetNotFoundError → 404
//   DashboardForbiddenError                               → 403
//   InvalidDashboardWidgetConfigError /
//   DashboardWidgetSourceNotFoundError                    → 422

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ dashboardId: string; widgetId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { config, savedFilterId, projectId } = (body ?? {}) as Record<string, unknown>;
  if (config === undefined && savedFilterId === undefined && projectId === undefined) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: 'Provide `config` and/or a data source (`savedFilterId` or `projectId`).',
      },
      { status: 400 },
    );
  }

  const { dashboardId, widgetId } = await params;
  try {
    const widget = await dashboardsService.updateWidget(
      dashboardId,
      widgetId,
      {
        config,
        savedFilterId: savedFilterId as string | null | undefined,
        projectId: projectId as string | null | undefined,
      },
      ctx,
    );
    return NextResponse.json({ widget });
  } catch (err) {
    const mapped = mapDashboardError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ dashboardId: string; widgetId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { dashboardId, widgetId } = await params;
  try {
    await dashboardsService.removeWidget(dashboardId, widgetId, ctx);
    return new Response(null, { status: 204 });
  } catch (err) {
    const mapped = mapDashboardError(err);
    if (mapped) return mapped;
    throw err;
  }
}
