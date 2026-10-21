import { NextResponse } from 'next/server';
import { reportsService } from '@/lib/services/reportsService';
import { parseDaysBack, parseMeasure, parsePeriod, parseReportScope } from '@/lib/reports/params';
import { reportConfigErrorResponse } from '@/lib/reports/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/reports/workload (Story 8.8 · Subtask 8.8.13) — open work per
// assignee behind the report page (8.8.7) and the `workload` dashboard widget.
// Scope = `?projectId=` XOR `?savedFilterId=`; config = `?measure=story_points
// |issue_count`, plus an optional window `?period=&daysBack=` (either present
// → both are parsed; both absent → the open-now snapshot the gadget reads).
// Returns the `ReportWidgetResultDto` envelope. Thin HTTP transport per CLAUDE.md.
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { searchParams } = new URL(req.url);
  try {
    const scope = parseReportScope(searchParams);
    const measure = parseMeasure(searchParams.get('measure'));
    const windowed = searchParams.has('period') || searchParams.has('daysBack');
    const config = windowed
      ? {
          measure,
          window: {
            period: parsePeriod(searchParams.get('period')),
            daysBack: parseDaysBack(searchParams.get('daysBack')),
          },
        }
      : { measure };
    const result = await reportsService.getWorkload(scope, config, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return reportConfigErrorResponse(err);
  }
}
