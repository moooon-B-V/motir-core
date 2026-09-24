import { NextResponse } from 'next/server';

import { planDecisionService } from '@/lib/services/planDecisionService';
import { planDecisionRefusalResponse } from '@/lib/approvalGates/decisionRefusalResponse';
import { readPlanDecisionPress } from '@/lib/plans/decisionPress';
import { PlanNotFoundError, PlanNotInExpectedStatusError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/plans/[id]/decline — DECLINE = drop the proposals (Subtask 7.4.5 /
// MOTIR-847, calling the MOTIR-1336 substrate). The PlanItems are deleted; the
// work-item tree is NEVER touched (adds never materialized; modify/remove targets
// untouched). Status → `declined`.
//
// ⚠️ A `planned` PLAN IS DECLINED THROUGH ITS GATE (Story MOTIR-6012 · MOTIR-6038; ADR
// `approval-gates.md` §11.4, §11.8). `decline` is a gate verb: `planDecisionService`
// decides the plan's `awaiting` gate through the one decide door, with the stamp the
// reader was shown. Declining a plan NOBODY IS BEING ASKED ABOUT — `generating` (a
// discard) or `stale` (its question was superseded) — stays a plain write and records
// no gate decision (§11.8 item 5). Refusals answer as the approve route's do.
//
// JSON body (optional): `stamp` (the `PlanReviewDto.gate.stamp` shown), `noteMd`.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors. The service asserts `ai:decide_plan` (→ 403/404).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const press = await readPlanDecisionPress(req);
  try {
    const plan = await planDecisionService.decline(
      { planId: id, stamp: press.stamp, noteMd: press.noteMd, source: 'api' },
      ctx,
    );
    return NextResponse.json(plan);
  } catch (err) {
    // MOTIR-2291 — the shared project gate's two refusals (404 for a non-browser,
    // 403 naming the key). Without this arm they fall through to a 500.
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    // The decide door's refusals, and the entrance's own three (MOTIR-6038).
    const refusal = planDecisionRefusalResponse(err);
    if (refusal) return refusal;
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
