import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { mapDashboardError } from '@/lib/dashboards/errorResponse';

// /api/dashboards (Story 6.3 · Subtask 6.3.1) — the workspace-scoped
// dashboards collection. Thin HTTP layer over dashboardsService;
// session-required; the workspace comes from the server-resolved context
// (NEVER the client — finding #26). No db / no transaction here (CLAUDE.md).

// GET /api/dashboards — the bounded home/switcher list (mine +
// workspace-shared; private dashboards of others never appear).
export async function GET(): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const dashboards = await dashboardsService.listDashboards(ctx);
  return NextResponse.json({ dashboards });
}

// POST /api/dashboards — create a dashboard (any workspace member). Body:
// { name, access?, layout? } (defaults: private, two columns). Returns 201
// with the new dashboard's summary DTO.
//
// Typed errors → status codes (mapDashboardError):
//   InvalidDashboardName/Access/LayoutError → 422
export async function POST(req: Request): Promise<Response> {
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
  if (typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` is required.' },
      { status: 400 },
    );
  }
  if (access !== undefined && typeof access !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`access` must be a string.' },
      { status: 400 },
    );
  }
  if (layout !== undefined && typeof layout !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`layout` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const dashboard = await dashboardsService.create({ name, access, layout }, ctx);
    return NextResponse.json({ dashboard }, { status: 201 });
  } catch (err) {
    const mapped = mapDashboardError(err);
    if (mapped) return mapped;
    throw err;
  }
}
