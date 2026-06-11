import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { mapDashboardError } from '@/lib/dashboards/errorResponse';

// POST /api/dashboards/[dashboardId]/widgets/[widgetId]/move (Story 6.3 ·
// Subtask 6.3.1) — move a widget on the grid (owner-only). Body:
// { column, afterId?, beforeId? } — the client names the target column and
// the neighbours it dropped between; the SERVER computes the fractional
// index (the /api/board/move precedent: a client-minted position could race
// a concurrent move; the dashboard lock + server mint serialize instead).
//
// Typed errors → status codes (mapDashboardError):
//   DashboardNotFoundError / DashboardWidgetNotFoundError → 404
//   DashboardForbiddenError                               → 403
//   InvalidDashboardWidgetMoveError (column outside the layout, or
//   neighbour ids that don't bound a real slot)           → 422

export async function POST(
  req: Request,
  { params }: { params: Promise<{ dashboardId: string; widgetId: string }> },
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

  const { column, afterId, beforeId } = (body ?? {}) as Record<string, unknown>;
  if (typeof column !== 'number') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`column` is required (a number).' },
      { status: 400 },
    );
  }
  for (const [field, value] of Object.entries({ afterId, beforeId })) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: `\`${field}\` must be a string when provided.` },
        { status: 400 },
      );
    }
  }

  const { dashboardId, widgetId } = await params;
  try {
    const widget = await dashboardsService.moveWidget(
      dashboardId,
      widgetId,
      {
        column,
        afterId: afterId as string | null | undefined,
        beforeId: beforeId as string | null | undefined,
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
