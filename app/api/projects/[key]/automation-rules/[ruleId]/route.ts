import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { mapAutomationError } from '@/lib/automation/errorResponse';

// /api/projects/[key]/automation-rules/[ruleId] (Story 6.6 · Subtask 6.6.1) —
// the single-rule routes (admin-only). A rule not owned by this project reads
// 404 (indistinguishable from missing).
//
// GET    → 200 { rule } — the editor read (decoded condition, typed degraded
//          state, the failure tally)
// PATCH  { name, triggerType, triggerConfig, condition, actions } → 200 — a
//          full content replace. `enabled` is NOT changed here — the toggle is
//          the dedicated /enabled route (enabling resets the failure counter).
// DELETE → 204 — the execution audit log cascades.

type Params = { params: Promise<{ key: string; ruleId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, ruleId } = await params;
  try {
    const rule = await automationRulesService.get(key, ruleId, ctx);
    return NextResponse.json({ rule });
  } catch (err) {
    const mapped = mapAutomationError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, ruleId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { name, triggerType, triggerConfig, condition, actions } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (condition !== undefined && condition !== null && typeof condition !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`condition` must be a string or null when present.' },
      { status: 400 },
    );
  }

  try {
    const rule = await automationRulesService.update(
      key,
      ruleId,
      {
        name: name as string,
        triggerType: triggerType as string,
        triggerConfig: triggerConfig ?? {},
        conditionFilterParam: (condition as string | null) ?? null,
        actions,
      },
      ctx,
    );
    return NextResponse.json({ rule });
  } catch (err) {
    const mapped = mapAutomationError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key, ruleId } = await params;
  try {
    await automationRulesService.delete(key, ruleId, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapAutomationError(err);
    if (mapped) return mapped;
    throw err;
  }
}
