import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { mapDashboardError } from '@/lib/dashboards/errorResponse';

// /api/dashboards/[dashboardId]/widgets (Story 6.3 · Subtask 6.3.1) — add a
// widget to the grid (owner-only). Body: { type, savedFilterId? |
// projectId?, config? } — the registry validates the type, the per-type
// settings, and the data-source XOR; the service verifies the referent
// exists in this workspace and appends the widget to column 0 (the 6.3.5
// grid drags it into place). Returns 201 with the widget DTO.
//
// Typed errors → status codes (mapDashboardError):
//   DashboardNotFoundError                  → 404
//   DashboardForbiddenError                 → 403 (not the owner)
//   UnknownDashboardWidgetTypeError /
//   InvalidDashboardWidgetConfigError /
//   DashboardWidgetSourceNotFoundError /
//   DashboardWidgetCapError (the 21st add)  → 422

export async function POST(
  req: Request,
  { params }: { params: Promise<{ dashboardId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { type, savedFilterId, projectId, config } = (body ?? {}) as Record<string, unknown>;
  if (typeof type !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`type` is required.' },
      { status: 400 },
    );
  }

  const { dashboardId } = await params;
  try {
    const widget = await dashboardsService.addWidget(
      dashboardId,
      {
        type,
        savedFilterId: savedFilterId as string | null | undefined,
        projectId: projectId as string | null | undefined,
        config,
      },
      ctx,
    );
    return NextResponse.json({ widget }, { status: 201 });
  } catch (err) {
    const mapped = mapDashboardError(err);
    if (mapped) return mapped;
    throw err;
  }
}
