import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { reportsService } from '@/lib/services/reportsService';
import { parseMeasure, parseReportScope } from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';

// GET /api/reports/workload (Story 8.8 · Subtask 8.8.13) — open work per
// assignee behind the report page (8.8.7) and the `workload` dashboard widget.
// Scope = `?projectId=` XOR `?savedFilterId=`; config = `?measure=story_points
// |issue_count`. A snapshot read (no time window). Returns the
// `ReportWidgetResultDto` envelope. Thin HTTP transport per CLAUDE.md.
export async function GET(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const config = { measure: parseMeasure(searchParams.get('measure')) };
    const result = await reportsService.getWorkload(scope, config, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
