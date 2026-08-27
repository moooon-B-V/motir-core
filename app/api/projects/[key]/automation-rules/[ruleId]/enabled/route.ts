import { NextResponse } from 'next/server';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { mapAutomationError } from '@/lib/automation/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// /api/projects/[key]/automation-rules/[ruleId]/enabled (Story 6.6 · Subtask
// 6.6.1) — the enable/disable toggle (admin-only), its own route so the editor
// content-PATCH and the list-row toggle stay separate concerns. Enabling RESETS
// the consecutive-failure counter (the verified Jira rule); disabling leaves it.
//
// PUT { enabled: boolean } → 200 { rule }

type Params = { params: Promise<{ key: string; ruleId: string }> };

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

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
  const { enabled } = (body ?? {}) as Record<string, unknown>;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`enabled` must be a boolean.' },
      { status: 400 },
    );
  }

  try {
    const rule = await automationRulesService.setEnabled(key, ruleId, enabled, ctx);
    return NextResponse.json({ rule });
  } catch (err) {
    const mapped = mapAutomationError(err);
    if (mapped) return mapped;
    throw err;
  }
}
