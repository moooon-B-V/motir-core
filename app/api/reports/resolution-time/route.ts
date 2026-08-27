import { NextResponse } from 'next/server';
import { reportsService } from '@/lib/services/reportsService';
import { parseDaysBack, parsePeriod, parseReportScope } from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/reports/resolution-time (Story 8.8 · Subtask 8.8.13) — the
// average days-to-resolve data behind the report page (8.8.7) and the
// `resolution_time` dashboard widget. Scope = `?projectId=` XOR
// `?savedFilterId=`; config = `?period=` + `?daysBack=`. Returns the
// `ReportWidgetResultDto` envelope. Thin HTTP transport per CLAUDE.md.
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const config = {
      period: parsePeriod(searchParams.get('period')),
      daysBack: parseDaysBack(searchParams.get('daysBack')),
    };
    const result = await reportsService.getResolutionTime(scope, config, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
