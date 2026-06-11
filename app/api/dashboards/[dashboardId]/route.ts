import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { mapDashboardError } from '@/lib/dashboards/errorResponse';

// /api/dashboards/[dashboardId] (Story 6.3 · Subtask 6.3.1) — one
// dashboard: the grid read + the owner-only mutations. Thin HTTP layer over
// dashboardsService; workspace from the server context (finding #26).
//
// Typed errors → status codes (mapDashboardError):
//   DashboardNotFoundError  → 404 (missing, cross-tenant, or a private
//                             dashboard the actor may not see)
//   DashboardForbiddenError → 403 (visible but mutate is owner-only)
//   InvalidDashboardName/Access/LayoutError → 422

// GET — the full grid (widgets in render order, source names decorated).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ dashboardId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { dashboardId } = await params;
  try {
    const dashboard = await dashboardsService.getDashboard(dashboardId, ctx);
    return NextResponse.json({ dashboard });
  } catch (err) {
    const mapped = mapDashboardError(err);
    if (mapped) return mapped;
    throw err;
  }
}

// PATCH — rename / access-change / relayout (owner-only; at least one of
// { name, access, layout }). A layout shrink reflows orphaned widgets into
// the new last column server-side.
export async function PATCH(
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

  const { name, access, layout } = (body ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries({ name, access, layout })) {
    if (value !== undefined && typeof value !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: `\`${field}\` must be a string.` },
        { status: 400 },
      );
    }
  }
  if (name === undefined && access === undefined && layout === undefined) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Provide at least one of `name`, `access`, `layout`.' },
      { status: 400 },
    );
  }

  const { dashboardId } = await params;
  try {
    const dashboard = await dashboardsService.update(
      dashboardId,
      { name, access, layout } as { name?: string; access?: string; layout?: string },
      ctx,
    );
    return NextResponse.json({ dashboard });
  } catch (err) {
    const mapped = mapDashboardError(err);
    if (mapped) return mapped;
    throw err;
  }
}

// DELETE — owner-only; widgets cascade with the row.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ dashboardId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { dashboardId } = await params;
  try {
    await dashboardsService.delete(dashboardId, ctx);
    return new Response(null, { status: 204 });
  } catch (err) {
    const mapped = mapDashboardError(err);
    if (mapped) return mapped;
    throw err;
  }
}
