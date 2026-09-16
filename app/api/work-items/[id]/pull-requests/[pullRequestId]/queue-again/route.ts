import { NextResponse } from 'next/server';
import { ApprovalGateError } from '@/lib/approvalGates/errors';
import { APPROVAL_GATE_STATUS } from '@/lib/approvalGates/httpStatus';
import { QueueAgainRefusedError } from '@/lib/mergeQueue/errors';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/work-items/[id]/pull-requests/[pullRequestId]/queue-again (Story MOTIR-5461 ·
// MOTIR-5634; `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 5) — put a
// pull request the merge queue removed back into the queue, while its head is unchanged.
//
// ONE route for both merge modes, and the body says which door:
//   * `{ approvalGateId }` — a `manual` project: the card's DECIDED approval is reused
//     (`retryApproveAndMergeMember`). The answer is that member's outcome, and a host
//     refusal is a member outcome of a 200, exactly as the decide route reports one.
//   * `{}` — an `auto` project: a person's press re-sends the automatic merge for the
//     same head (`requeueAutoMember`).
//
// Thin HTTP layer (CLAUDE.md § 4-layer): session gate → parse → ONE service call → map
// typed errors. Session-authed for the decide route's reason: a person presses this.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; pullRequestId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { id, pullRequestId } = await params;

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim() !== '') body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const approvalGateId =
    typeof body.approvalGateId === 'string' && body.approvalGateId.trim() !== ''
      ? body.approvalGateId.trim()
      : null;

  try {
    if (approvalGateId) {
      const member = await pullRequestMergeService.retryApproveAndMergeMember(
        { approvalGateId, pullRequestId, noteMd: null, source: 'api' },
        ctx,
      );
      return NextResponse.json({ member }, { status: 200 });
    }
    const result = await pullRequestMergeService.requeueAutoMember(
      { workItemId: id, pullRequestId },
      ctx,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const gateError = workItemGateErrorResponse(err);
    if (gateError) return gateError;
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof QueueAgainRefusedError) {
      return NextResponse.json(
        { code: err.code, reason: err.reason, error: err.message },
        { status: 409 },
      );
    }
    if (err instanceof ApprovalGateError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: APPROVAL_GATE_STATUS[err.tag] },
      );
    }
    throw err;
  }
}
