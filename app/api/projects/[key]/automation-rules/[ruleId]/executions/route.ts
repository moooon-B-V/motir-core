import { NextResponse } from 'next/server';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { mapAutomationError } from '@/lib/automation/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// /api/projects/[key]/automation-rules/[ruleId]/executions (Story 6.6 · Subtask
// 6.6.6) — the per-rule audit-log read (admin-only). A rule not owned by this
// project reads 404 (indistinguishable from missing), the same hide-gate the
// sibling single-rule routes use.
//
// GET ?page=N (default 1) → 200 { executions, total, page, pageSize } — one
//   bounded page of the rule's execution history, newest-first. NO load-all
//   (finding #57): the page size is the service's fixed window.

type Params = { params: Promise<{ key: string; ruleId: string }> };

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key, ruleId } = await params;
  const pageParam = new URL(req.url).searchParams.get('page');
  const parsed = pageParam == null ? 1 : Number.parseInt(pageParam, 10);
  const page = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;

  try {
    const result = await automationRulesService.listExecutions(key, ruleId, { page }, ctx);
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapAutomationError(err);
    if (mapped) return mapped;
    throw err;
  }
}
