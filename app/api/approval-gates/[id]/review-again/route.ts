import { NextResponse } from 'next/server';
import {
  ReviewAgainForbiddenError,
  ReviewAgainGateNotFoundError,
  ReviewAgainNotOfferedError,
} from '@/lib/agentReview/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { agentReviewStartService } from '@/lib/services/agentReviewStartService';

// POST /api/approval-gates/[id]/review-again (Story MOTIR-1626 · MOTIR-6820;
// `approval-gates.md` §12.6) — *Review again* on an `agent_review` gate whose review
// COULD NOT RUN: clear its `reviewUnavailableReason` and request ONE new hosted review run
// for the same gate and version. There is no automatic retry; this press is the only one.
//
// SESSION-AUTHED, like the decide door one directory over: the press is a person's, the
// one the review is routed to (assignee → reporter, or `approval:decide_any`), at the
// kind's `work_item:edit` floor — the authority *Continue without the review* takes.
//
// Answers: 202 `{ gateId }` — the request is queued, the run starts in the background;
// 404 — no such review the caller can see (never a 403 that leaks existence); 403 — a
// member who is not the routed person; 409 `REVIEW_AGAIN_NOT_OFFERED` with `reason`
// (`not_awaiting` · `no_reason` · `run_in_flight`).
//
// Thin HTTP layer (CLAUDE.md § 4-layer): session gate → ONE service call → map errors.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const gateId = id.trim();
  if (gateId === '') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A gate id is required.' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await agentReviewStartService.reviewAgain(gateId, gate.ctx);
    return NextResponse.json(result, { status: 202, headers: NO_STORE });
  } catch (err) {
    if (err instanceof ReviewAgainGateNotFoundError) {
      return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    if (err instanceof ReviewAgainForbiddenError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: 403, headers: NO_STORE },
      );
    }
    if (err instanceof ReviewAgainNotOfferedError) {
      return NextResponse.json(
        { code: err.code, reason: err.reason, error: err.message },
        { status: 409, headers: NO_STORE },
      );
    }
    throw err;
  }
}
