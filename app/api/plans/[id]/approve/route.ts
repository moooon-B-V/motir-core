import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';

import { plansService } from '@/lib/services/plansService';
import {
  PlanApproveTimedOutError,
  PlanGrammarError,
  PlanItemTargetMissingError,
  PlanItemUnknownTargetRepoError,
  PlanItemUnknownTargetRepoRoleError,
  PlanNotFoundError,
  PlanNotInExpectedStatusError,
  PlanRefGraphError,
  PlanTargetImmutableError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// POST /api/plans/[id]/approve — APPROVE = materialize (Subtask 7.4.5 / MOTIR-847,
// calling the MOTIR-1336 substrate). Adds become real work items, modifies apply
// to the same id (one logged revision), removes archive. The service is the atomic
// one-shot guard: a second concurrent approve observes `approved` and 409s.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors. `approvePlan` asserts `canEdit` (→ 403/404).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  // The provisional name an AI-onboarding draft is minted with (MOTIR-1486,
  // `startNewAiProjectAction`). Passed so approve can name the draft from the
  // plan's `productName` (MOTIR-1551) ONLY while the name is still this
  // placeholder — resolved here (i18n stays out of the service layer).
  const t = await getTranslations('shell');
  try {
    const plan = await plansService.approvePlan(id, ctx, {
      provisionalProjectName: t('project.untitled'),
    });
    return NextResponse.json(plan);
  } catch (err) {
    // MOTIR-2291 — the shared project gate's two refusals (404 for a non-browser,
    // 403 naming the key). Without this arm they fall through to a 500.
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    // The confirmation gate (7.12.5 · MOTIR-911) — the proposal set was rejected
    // BEFORE any write, so the tree is untouched. A malformed proposal is a 400
    // (never the DB trigger's raw SQLSTATE surfacing as a 500); a target that
    // reached a terminal status is a 409 (it moved under the proposal).
    if (err instanceof PlanGrammarError || err instanceof PlanRefGraphError) {
      return NextResponse.json(
        { code: err.code, reason: err.reason, planItemId: err.planItemId, error: err.message },
        { status: 400 },
      );
    }
    if (err instanceof PlanTargetImmutableError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, error: err.message },
        { status: 409 },
      );
    }
    // A proposal pinned to a repo outside the project's set (MOTIR-1884) — 422,
    // the same status the identical bad pin gets on the direct work-item write
    // path. Raised before the transaction opens, so nothing was written; the
    // `planItemId` says WHICH proposal to fix.
    if (err instanceof PlanItemUnknownTargetRepoError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, error: err.message },
        { status: 422 },
      );
    }
    // A proposal pinning a repo ROLE outside ADR §1.1's vocabulary (MOTIR-1912) —
    // 422 like the bad NAME above, and for the same reason: a malformed pin means
    // the same thing however it arrived. Also raised before the transaction opens,
    // so nothing was written.
    if (err instanceof PlanItemUnknownTargetRepoRoleError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, role: err.role, error: err.message },
        { status: 422 },
      );
    }
    // Materialize-time proposal failures the gate cannot pre-empt (a target
    // archived between the gate and the write). The transaction rolled back.
    if (err instanceof UnresolvedPlanRefError || err instanceof PlanItemTargetMissingError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    // The transaction budget was exhausted (Prisma P2028) — MOTIR-3396. 503, not
    // 500: the transaction rolled back, so the tree is byte-identical, the plan
    // is still `planned`, and a retry is a legitimate next move. Without this arm
    // it fell through to the rethrow below and the caller got a bare 500 with an
    // empty body — which reads as "something is broken" and led to Approve being
    // pressed three more times on the plan that produced this bug. `itemCount`
    // rides on the payload because "too large for one transaction" is only
    // actionable if the response says how large.
    if (err instanceof PlanApproveTimedOutError) {
      return NextResponse.json(
        { code: err.code, planId: err.planId, itemCount: err.itemCount, error: err.message },
        { status: 503 },
      );
    }
    throw err;
  }
}
