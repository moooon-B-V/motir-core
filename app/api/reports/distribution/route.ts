import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { reportsService } from '@/lib/services/reportsService';
import { parseReportScope } from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';
import { InvalidReportScopeError } from '@/lib/reports/errors';

// GET /api/reports/distribution (Story 6.3 · Subtask 6.3.2) — the donut data
// behind the status-distribution report page (6.3.6) and widget (6.3.5).
// Scope = `?projectId=` XOR `?savedFilterId=`; `?statistic=` is an id from
// the TOTAL statistic-type registry (kind / status / priority / assignee /
// reporter / sprint / label / component / `cf:<fieldId>` — the verified Jira
// "Statistic Type" vocabulary). Returns the `ReportWidgetResultDto`
// envelope: `ok` with segments (counts + percentages, count-descending), or
// the typed `no_access` / `stale` widget states.
//
// Thin HTTP transport per CLAUDE.md: resolve workspace context, parse
// params, ONE service call, map the typed config errors. No db here.
//
// Typed errors → status codes:
//   InvalidReportScopeError / UnknownStatisticTypeError → 422
export async function GET(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const statistic = searchParams.get('statistic');
    if (!statistic) throw new InvalidReportScopeError('statistic is required');
    const result = await reportsService.getDistribution(scope, statistic, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
