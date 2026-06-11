import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { reportsService } from '@/lib/services/reportsService';
import {
  parseCumulative,
  parseDaysBack,
  parsePeriod,
  parseReportScope,
} from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';

// GET /api/reports/created-vs-resolved (Story 6.3 · Subtask 6.3.2) — the
// two-series difference/area data behind the report page (6.3.6) and the
// dashboard widget (6.3.5). Scope = `?projectId=` XOR `?savedFilterId=` (the
// verified gadget config pattern); config = `?period=day|week|month` +
// `?daysBack=N` + `?cumulative=true` (the verified Jira Created-vs-Resolved
// config). Returns the `ReportWidgetResultDto` envelope: `ok` with the
// series, or the typed `no_access` / `stale` widget states (per-VIEWER
// gating + degraded referents are DATA, not transport errors — one broken
// widget never errors a dashboard).
//
// Thin HTTP transport per CLAUDE.md: resolve workspace context, parse
// params, ONE service call, map the typed config errors. No db here.
//
// Typed errors → status codes:
//   InvalidReportScopeError / InvalidReportWindowError → 422
export async function GET(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const config = {
      period: parsePeriod(searchParams.get('period')),
      daysBack: parseDaysBack(searchParams.get('daysBack')),
      cumulative: parseCumulative(searchParams.get('cumulative')),
    };
    const result = await reportsService.getCreatedVsResolved(scope, config, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
