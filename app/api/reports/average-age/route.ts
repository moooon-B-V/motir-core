import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { reportsService } from '@/lib/services/reportsService';
import { parseDaysBack, parsePeriod, parseReportScope } from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';

// GET /api/reports/average-age (Story 8.8 · Subtask 8.8.13) — the point-in-time
// average-age data behind the report page (8.8.7) and the `average_age`
// dashboard widget. Scope = `?projectId=` XOR `?savedFilterId=`; config =
// `?period=day|week|month` + `?daysBack=N`. Returns the `ReportWidgetResultDto`
// envelope: `ok` with the buckets, or the typed `no_access` / `stale` states.
// Thin HTTP transport per CLAUDE.md: workspace context, parse, ONE service
// call, map typed config errors (InvalidReportScope/Window → 422). No db here.
export async function GET(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const config = {
      period: parsePeriod(searchParams.get('period')),
      daysBack: parseDaysBack(searchParams.get('daysBack')),
    };
    const result = await reportsService.getAverageAge(scope, config, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
