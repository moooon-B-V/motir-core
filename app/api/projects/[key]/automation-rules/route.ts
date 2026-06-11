import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { mapAutomationError } from '@/lib/automation/errorResponse';

// /api/projects/[key]/automation-rules (Story 6.6 · Subtask 6.6.1) — the
// collection routes. `[key]` is the project identifier ("PROD"), resolved
// within the actor's workspace. The whole Automation surface is ADMIN-ONLY
// (the verified Jira scope): a non-browsable project reads 404, a browsable
// non-admin gets 403 — both from the service gate.
//
// GET  → 200 { rules: AutomationRuleDto[] } (admin-only; bounded by the
//        100-rule per-project cap)
// POST { name, triggerType, triggerConfig, condition, actions } →
//        201 { rule } — `condition` is the `?filter=v1:` param string (or null
//        for the always-match group); the registries TOTAL-validate the
//        trigger/action configs (a bad one is a 422, never a silent pass).

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  try {
    const rules = await automationRulesService.list(key, ctx);
    return NextResponse.json({ rules });
  } catch (err) {
    const mapped = mapAutomationError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;

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
    const rule = await automationRulesService.create(
      key,
      {
        name: name as string,
        triggerType: triggerType as string,
        triggerConfig: triggerConfig ?? {},
        conditionFilterParam: (condition as string | null) ?? null,
        actions,
      },
      ctx,
    );
    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) {
    const mapped = mapAutomationError(err);
    if (mapped) return mapped;
    throw err;
  }
}
