import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { reportsService } from '@/lib/services/reportsService';
import { parsePositiveInt, parseReportScope } from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';

// GET /api/reports/filter-results (Story 6.3 · Subtask 6.3.2) — the
// paginated issue table behind the filter-results widget (6.3.5). Scope =
// `?projectId=` XOR `?savedFilterId=`; `?page=` / `?pageSize=` ride the
// EXISTING 2.5.8/2.5.12 list read (a widget page exactly matches the /items
// List for the same filter), with the verified ≤ 50/page gadget cap clamped
// server-side. Returns the `ReportWidgetResultDto` envelope: `ok` with the
// page, or the typed `no_access` / `stale` widget states.
//
// Thin HTTP transport per CLAUDE.md: resolve workspace context, parse
// params, ONE service call, map the typed config errors. No db here.
//
// Typed errors → status codes:
//   InvalidReportScopeError → 422
export async function GET(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const result = await reportsService.getFilterResultsPage(
      scope,
      {
        page: parsePositiveInt(searchParams.get('page')),
        pageSize: parsePositiveInt(searchParams.get('pageSize')),
      },
      ctx,
    );
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
